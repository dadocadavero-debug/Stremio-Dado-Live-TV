const express = require("express");
const sharp = require("sharp");
const crypto = require("crypto");
const {AsyncLocalStorage}=require("async_hooks");
const http = require("http");
const https = require("https");
const { Resolver } = require("dns").promises;
const { isIP } = require("net");

sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });

const app = express();
app.use(express.json());
app.use((req,res,next)=>{
  res.set("Access-Control-Allow-Origin","*");
  res.set("Access-Control-Allow-Methods","GET, HEAD, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS")return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;

const STREMVERSE =
"https://stremverse1.alwaysdata.net/1q1YqqVKyUgp3DFGqBQA";

const HIGHFLY =
  "https://sports.highfly.to/eyJpbmNsdWRlU3BvcnRzIjpbImZvb3RiYWxsIl0sImZyZWVVc2VySWQiOiI5ZTQ1YzZkNC1mMzBkLTQ3MTQtYmJjMy0wNzhjNmFiOTU1NzIuM2FkYzViYTE3YTE0NmUyMiJ9";

const HIGHFLY_BACKUPS = [
  "https://sportsfree.highfly.to/eyJpbmNsdWRlU3BvcnRzIjpbImZvb3RiYWxsIl19",
  "https://sportsfree-us2.highfly.to/eyJpbmNsdWRlU3BvcnRzIjpbImZvb3RiYWxsIl19"
];

let preferredHighflyBase = HIGHFLY;

// Keep the configured manifest (which may include proxy credentials) out of Git.
const EASYSPORTS_MANIFEST_URL = process.env.EASYSPORTS_MANIFEST_URL || "";
const esCaches=new Map(),esPending=new Map(),scope=new AsyncLocalStorage();

function legacyEasySportsBase() {
  if (!EASYSPORTS_MANIFEST_URL) return null;
  try {
    const url = new URL(EASYSPORTS_MANIFEST_URL);
    if (url.protocol !== "https:" ||
        url.hostname !== "easysports.realbestia.com" ||
        !url.pathname.endsWith("/manifest.json") ||
        url.search || url.hash) return null;
    return url.href.slice(0, -"/manifest.json".length);
  } catch {
    return null;
  }
}



function easySportsBase(){const p=scope.getStore();return p?p.base:legacyEasySportsBase();}
function profileKey(){return scope.getStore()?.key||"legacy";}
function proxyURL(v){try{if(typeof v!=="string"||v.length>400)return "";const u=new URL(v.trim());return ["http:","https:"].includes(u.protocol)&&u.hostname&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==="/"?u.origin:"";}catch{return "";}}
function proxyTemplate(){
  try{
    const u=new URL(legacyEasySportsBase()),parts=u.pathname.split("/").filter(Boolean),matches=[];
    for(let i=0;i<parts.length;i++){
      try{
        const cfg=JSON.parse(Buffer.from(decodeURIComponent(parts[i]),"base64url").toString("utf8"));
        if(!cfg||typeof cfg!=="object"||Array.isArray(cfg))continue;
        const fields=[];
        function walk(o,path=[]){for(const [k,v] of Object.entries(o)){const p=[...path,k];if(v&&typeof v==="object"&&!Array.isArray(v))walk(v,p);else fields.push({p,v,k:p.join("").toLowerCase().replace(/[^a-z0-9]/g,"")});}}
        walk(cfg);
        const urls=fields.filter(f=>proxyURL(f.v));
        const pw=fields.filter(f=>typeof f.v==="string"&&/(?:password|passwd|pwd|pass|secret|apikey|apitoken|proxykey|epkey|mfpkey|pkey|^key$|^token$)/.test(f.k));
        if(urls.length!==1||pw.length>1||fields.some(f=>!urls.includes(f)&&!pw.includes(f)&&f.v&&/(?:auth|credential|token|key|password|secret)/.test(f.k)))continue;
        matches.push({u,parts,i,cfg,url:urls[0].p,pw:pw[0]?.p});
      }catch{}
    }
    return matches.length===1?matches[0]:null;
  }catch{return null;}
}
function easySportsSchema(){
  const output={legacyConfigured:!!legacyEasySportsBase(),segments:[],recognized:!!(proxyTemplate()||pipeTemplate())};
  try{
    const u=new URL(legacyEasySportsBase());
    for(const part of u.pathname.split("/").filter(Boolean)){
      const raw=decodeURIComponent(part);
      const buf=Buffer.from(raw,"base64url");
      const decoded=buf.toString("utf8");
      const shape=v=>({length:v.length,printable:[...v].filter(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)<=126).length,
        startsObject:v.trimStart().startsWith("{"),startsArray:v.trimStart().startsWith("["),startsQuote:v.trimStart().startsWith('"'),
        startsHttp:/^https?:\/\//i.test(v),containsHttp:/https?:\/\//i.test(v),containsEncodedHttp:/https?%3a/i.test(v),
        percent: v.includes("%"), equals:v.includes("="), ampersand:v.includes("&"), pipe:v.includes("|"), colon:v.includes(":"), semicolon:v.includes(";"), comma:v.includes(","),
        base64Like:/^[A-Za-z0-9+/_=-]+$/.test(v),hexLike:/^[0-9a-f]+$/i.test(v)});
      const seg={encoded:shape(raw),decoded:shape(decoded),byteLength:buf.length,
        gzip:buf[0]===31&&buf[1]===139,zlib:buf[0]===120,utf8Bom:buf[0]===239&&buf[1]===187&&buf[2]===191};
      let cfg;
      for(const [format,value] of [["raw",raw],["base64",decoded],["base64-url-escaped",(()=>{try{return decodeURIComponent(decoded)}catch{return ""}})()],["double-base64",Buffer.from(decoded,"base64url").toString("utf8")]]){
        try{let p=JSON.parse(value);if(typeof p==="string")p=JSON.parse(p);if(p&&typeof p==="object"){cfg=p;seg.format=format;break;}}catch{}
      }
      if(cfg){
        seg.fields=[];
        const walk=(o,path=[],depth=0)=>{if(depth>5||!o||typeof o!=="object"||Array.isArray(o))return;for(const [k,v] of Object.entries(o).slice(0,40)){const p=[...path,/^[a-zA-Z][a-zA-Z0-9_-]{0,35}$/.test(k)?k:"[redacted-key]"];if(v&&typeof v==="object"&&!Array.isArray(v))walk(v,p,depth+1);else seg.fields.push({field:p.join("."),type:typeof v,url:!!proxyURL(v),empty:v===""||v===null});}};
        walk(cfg);
      }
      if(decoded.includes("|"))seg.pipeFields=decoded.split("|").map((v,index)=>({index,length:v.length,isURL:!!proxyURL(v),isAddonOrigin:proxyURL(v)===u.origin,isKnownSwitch:/^(?:|true|false|0|1|on|off|yes|no|all|auto|direct|proxy|easyproxy|mediaflow|it|en|ita|eng)$/i.test(v)}));
      output.segments.push(seg);
    }
  }catch{}
  return output;
}
// EasySports also uses Base64-encoded pipe-delimited settings.
function pipeTemplate(base=legacyEasySportsBase()){
  try{
    const u=new URL(base),parts=u.pathname.split("/").filter(Boolean);
    if(parts.length!==1)return null;
    const raw=decodeURIComponent(parts[0]);
    if(!/^[A-Za-z0-9+/_=-]+$/.test(raw))return null;
    const decoded=Buffer.from(raw,"base64url").toString("utf8");
    const fields=decoded.split("|");
    if(fields.length<2||fields.length>12||!proxyURL(fields[0])||fields.some(x=>/[\x00-\x1f\x7f\ufffd]/.test(x)))return null;
    // Preserve only recognized non-secret switches after the URL and password.
    // Unknown trailing fields must not be copied into another user's config.
    if(fields.slice(2).some((x,i)=>{
      if(/^(?:|true|false|0|1|on|off|yes|no|all|auto|direct|proxy|easyproxy|mediaflow|it|en|ita|eng)$/i.test(x))return false;
      // Only the known public EasySports origin can be preserved as an extra URL.
      return !(i===1&&fields.length===4&&proxyURL(x)===u.origin);
    }))return null;
    return {origin:u.origin,fields,padded:raw.endsWith("="),standard:/[+/]/.test(raw)};
  }catch{return null;}
}
function buildPipeBase(url,password,t=pipeTemplate()){
  const normalized=proxyURL(url);
  if(!t||!normalized||typeof password!=="string"||/[|\x00-\x1f\x7f]/.test(password))return null;
  const fields=[normalized,password,...t.fields.slice(2)];
  let encoded=Buffer.from(fields.join("|"),"utf8").toString(t.standard?"base64":"base64url");
  if(t.padded)encoded+="=".repeat((4-encoded.length%4)%4);
  else encoded=encoded.replace(/=+$/,"");
  return t.origin+"/"+encodeURIComponent(encoded);
}

function personalBase(url,password){
  const pipe=pipeTemplate();if(pipe)return buildPipeBase(url,password||"",pipe);
  const t=proxyTemplate();if(!t||!proxyURL(url)||(!t.pw&&password))return null;
  function set(path,value){let o=t.cfg;for(const k of path.slice(0,-1))o=o[k];o[path.at(-1)]=value;}
  set(t.url,proxyURL(url));if(t.pw)set(t.pw,password||"");
  t.parts[t.i]=Buffer.from(JSON.stringify(t.cfg)).toString("base64url");
  return t.u.origin+"/"+t.parts.join("/");
}
function encryptionKey(){const k=process.env.DADO_CONFIG_KEY||"";return /^[a-f0-9]{64}$/i.test(k)?Buffer.from(k,"hex"):null;}
function seal(v){const k=encryptionKey();if(!k)throw Error("Missing key");const iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",k,iv);const b=Buffer.concat([c.update(JSON.stringify(v)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString("base64url");}
function unseal(v){try{const b=Buffer.from(v,"base64url"),d=crypto.createDecipheriv("aes-256-gcm",encryptionKey(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}catch{return null;}}
/* =========================================================
   NORMALIZZAZIONE
========================================================= */

function normalize(str = "") {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|cf|ac|ssc|ss|as)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


/* =========================================================
   FILTRO
========================================================= */

/* =========================================================
   FILTRO
========================================================= */

function unwanted(name = "") {
  const n = normalize(name);

  // Always exclude women's and youth competitions, regardless of provider.
  // Second teams (II, B, Reserves) are handled per opponent below instead:
  // Inter vs Ajax II is a legitimate match for the selected first team.
  return (
    /\b(women|woman|womens|female|femminile|femminili|femenino|feminino|feminine|feminin|frauen|ladies)\b/.test(n) ||
    /\b(u\s?(15|16|17|18|19|20|21|22|23)|under\s?(15|16|17|18|19|20|21|22|23))\b/.test(n) ||
    /\b(youth|giovanili|giovanile|primavera|academy)\b/.test(n)
  );
}


/*
   Squadre interessanti.
   Niente frammenti corti:
   evitiamo falsi positivi.
*/

const wantedTeams = [

  // ITALIA
  "inter",
  "milan",
  "juventus",
  "napoli",
  "roma",
  "lazio",
  "atalanta",
  "bologna",
  "fiorentina",
  "torino",
  "genoa",
  "udinese",
  "cagliari",
  "lecce",
  "parma",
  "verona",
  "como",
  "cremonese",
  "sassuolo",
  "pisa",
  "sampdoria",
  "palermo",
  "bari",
  "spezia",
  "cesena",
  "catanzaro",
  "modena",
  "reggiana",
  "mantova",
  "sudtirol",
  "carrarese",
  "avellino",
  "pescara",
  "monza",
  "empoli",
  "venezia",
  "frosinone",


  // EUROPA
  "real madrid",
  "barcelona",
  "atletico madrid",
  "athletic club",
  "villarreal",
  "real betis",
  "sevilla",

  "manchester city",
  "manchester united",
  "liverpool",
  "arsenal",
  "chelsea",
  "tottenham",
  "newcastle",

  "bayern",
  "borussia dortmund",
  "bayer leverkusen",

  "psg",
  "paris saint germain",

  "marseille",
  "monaco",

  "benfica",
  "porto",
  "sporting",

  "ajax",
  "psv",
  "feyenoord",


  // NAZIONALI
  "italy",
  "italia",
  "france",
  "germany",
  "deutschland",
  "spain",
  "espana",
  "england",
  "portugal",
  "netherlands",
  "holland",
  "belgium",
  "croatia",
  "argentina",
  "brazil",
  "uruguay",
  "colombia",
  "mexico",
  "united states",
  "usa",
  "japan",
  "morocco"
];



/*
   Alias solo dove il nome cambia davvero.
*/

const aliases = {

  inter: [
    "internazionale",
    "inter milan",
    "inter milano"
  ],

  milan: [
    "ac milan"
  ],

  napoli: [
    "ssc napoli"
  ],

  roma: [
    "as roma"
  ],

  lazio: [
    "ss lazio"
  ],

  juventus: [
    "juventus fc",
    "juve"
  ],

  psg: [
    "paris saint germain",
    "paris saint-germain"
  ],

  bayern: [
    "bayern munich",
    "bayern munchen"
  ],

  barcelona: [
    "fc barcelona"
  ],

  atletico: [
    "atletico de madrid"
  ],

  manchester: [
    "manchester utd",
    "man united"
  ]
};



// Match whole team names, never incidental substrings (USA in Jerusalem).
function hasTeamTerm(value = "", term = "") {
  const haystack = normalize(value);
  const needle = normalize(term);
  return Boolean(needle) && (` ${haystack} `).includes(` ${needle} `);
}

// Prefer actual opponents rather than competition headings.
// Examples: "Netherlands - Eerste Divisie: Ajax II vs De Graafschap"
// and "Serie A: Inter vs Ajax II".
function getMatchSides(name = "") {
  const raw = String(name).replace(/\s+/g, " ").trim();
  const versus = /\s+(?:vs?\.?|versus|x)\s+/i.exec(raw);
  if (versus) {
    const left = raw.slice(0, versus.index).split(":").pop().trim();
    const right = raw.slice(versus.index + versus[0].length).split("|")[0].trim();
    if (left && right) return [left, right];
  }

  // Some sources use "Team A - Team B" instead of "vs".
  const suffix = raw.includes(":") ? raw.split(":").pop().trim() : raw;
  const separated = suffix.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
  if (separated.length === 2) return separated;

  return [];
}

// II/B/Reserves are an opponent attribute, not a blanket match exclusion.
function isReserveTeamSide(value = "") {
  const n = normalize(value);
  return /\b(ii|iii|iv|b|reserves?|b team|team b|second team)\b/.test(n);
}

const selectedTeamNames = [
  ...wantedTeams,
  ...Object.values(aliases).flat()
];

function isSelectedFirstTeam(value = "") {
  return !isReserveTeamSide(value) &&
    selectedTeamNames.some(team => hasTeamTerm(value, team));
}

function wantedEvent(name = "") {
  if (unwanted(name)) return false;

  // League headings are not match events. Do not mistake "Liga Portugal"
  // for a match involving the Portugal national team.
  if (/^\s*(?:liga|league|campionato|championship)\s+/i.test(String(name)) &&
      getMatchSides(name).length === 0) return false;

  const sides = getMatchSides(name);
  if (sides.length === 2) {
    return sides.some(isSelectedFirstTeam);
  }

  // Conservative fallback for uncommon provider event titles.
  // Strip a league prefix when available; still match complete words.
  const fallback = String(name).includes(":")
    ? String(name).split(":").pop()
    : String(name);
  return isSelectedFirstTeam(fallback);
}


/* =========================================================
   FETCH JSON
========================================================= */

async function getJsonRaw(url, timeoutMs = 12000, parentSignal = null) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Stremio-LIVE/3.0" }
    });

    if (!response.ok) {
      throw new Error(`Upstream HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", abortFromParent);
  }
}

// Try a backup if the preferred Highfly host is still slow after 2.5 seconds.
// The first successful JSON response wins; outstanding requests are aborted.
// A responsive primary host does not trigger any backup traffic.
async function getJson(url) {
  if (!url.startsWith(`${HIGHFLY}/`)) {
    return getJsonRaw(url);
  }

  const suffix = url.slice(HIGHFLY.length);
  const bases = [...new Set([preferredHighflyBase, HIGHFLY, ...HIGHFLY_BACKUPS])];
  const controller = new AbortController();
  const timers = [];
  const started = Array(bases.length).fill(false);
  let completed = 0;
  let settled = false;
  let lastError;

  try {
    return await new Promise((resolve, reject) => {
      function launch(index) {
        if (settled || started[index]) return;
        started[index] = true;
        const base = bases[index];

        getJsonRaw(
          `${base}${suffix}`,
          base === HIGHFLY ? 8000 : 5000,
          controller.signal
        ).then(json => {
          if (settled) return;
          settled = true;
          if (preferredHighflyBase !== base) {
            console.log("Highfly source switched to", base.split("/")[2]);
            preferredHighflyBase = base;
          }
          resolve(json);
          controller.abort();
        }).catch(error => {
          if (settled) return;
          lastError = error;
          completed += 1;
          console.warn("Highfly source unreachable:", base.split("/")[2], String(error));
          const next = started.findIndex(value => !value);
          if (next !== -1) launch(next);
          else if (completed === bases.length) {
            settled = true;
            reject(lastError);
          }
        });
      }

      launch(0);
      for (let i = 1; i < bases.length; i++) {
        timers.push(setTimeout(() => launch(i), i * 2500));
      }
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    controller.abort();
  }
}


/* =========================================================
   FONTI
========================================================= */

const PROVIDER_CATALOGS = [

  {
    source: "sv",

    url:
      `${STREMVERSE}/catalog/tv/` +
      `stremverse_live_events/genre=Football.json`
  },

  {
    source: "hf",

    url:
      `${HIGHFLY}/catalog/sport/` +
      `sports_live.json`
  },

  {
    source: "hf",

    url:
      `${HIGHFLY}/catalog/sport/` +
      `sports_today.json`
  },

  {
    source: "hf",

    url:
      `${HIGHFLY}/catalog/sport/` +
      `sports_football.json`
  }
];


/* =========================================================
   RECUPERO EVENTI
========================================================= */

// Classify the sport before checking team names: England, Barcelona etc.
// can also refer to cricket, basketball and other sports.
function sportText(value) {
  if (Array.isArray(value)) return value.map(sportText).join(" ");
  if (value && typeof value === "object") return sportText(value.name || value.title || value.id || "");
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function isOtherSport(value) {
  return /\b(?:basketball|basket|pallacanestro|baloncesto|nba|wnba|euroleague|cricket|ipl|bbl|t20|odi|baseball|mlb|softball|rugby|nfl|ncaa football|american football|football americano|futbol americano|australian football|aussie rules|gaelic football|hockey|nhl|tennis|atp|wta|volleyball|pallavolo|handball|darts|snooker|boxing|mma|ufc|wrestling|motorsport|formula 1|f1|golf|cycling|esports|futsal|beach soccer)\b/.test(sportText(value));
}
function isFootballSport(value) {
  const t = sportText(value);
  return !isOtherSport(t) && /\b(?:football|soccer|calcio|futbol|futebol|association football)\b/.test(t);
}
function easySportsFootballMeta(meta, catalog) {
  const structured = [meta.sport, meta.sportName, meta.genre, meta.genres,
    meta.category, meta.categories, meta.league, meta.competition];
  const title = [meta.name, meta.title, meta.id];
  // A mixed-catalog event must supply affirmative football evidence.
  if (structured.some(isOtherSport) || title.some(isOtherSport)) return false;
  if (isOtherSport(meta.description)) return false;
  return catalog.footballOnly || structured.some(isFootballSport) ||
    title.some(isFootballSport) || isFootballSport(meta.description) ||
    /\b(?:serie a|serie b|premier league|la liga|bundesliga|ligue 1|uefa|fifa|copa libertadores|copa sudamericana|eredivisie|primeira liga|championship)\b/.test(sportText([...structured, ...title, meta.description]));
}

// Discover the catalog IDs and types from the configured Stremio manifest.
// The existing event filter remains responsible for selecting the wanted teams.
async function discoverEasySportsCatalogs() {
  const base = easySportsBase();
  if (!base) return [];
  let easySportsCatalogCache=esCaches.get(base)||{expires:0,staleUntil:0,catalogs:[]};
  if (easySportsCatalogCache.expires > Date.now()) {
    return easySportsCatalogCache.catalogs;
  }
  try {
    const manifest = await getJsonRaw(`${base}/manifest.json`, 6000);
    const catalogs = [];
    for (const catalog of manifest.catalogs || []) {
      if (!catalog?.id || !catalog.type) continue;
      const extras = Array.isArray(catalog.extra) ? catalog.extra : [];
      const genre = extras.find(extra => extra.name === "genre");
      const football = genre?.options?.find(option => isFootballSport(option));
      const label = [catalog.id, catalog.name, catalog.type];
      if (isOtherSport(label) && !football) continue;
      const footballOnly = !!football || isFootballSport(label);
      const required = [...extras.filter(extra => extra.isRequired).map(extra => extra.name),
        ...(catalog.extraRequired || [])];
      if (required.some(name => name !== "genre" || !football)) continue;
      const suffix = football ? `/genre=${encodeURIComponent(football)}` : "";
      catalogs.push({
        source: "es",
        type: catalog.type,
        url: `${base}/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}${suffix}.json`,
        footballOnly,
        priority: /live|today|sport/i.test(`${catalog.id} ${catalog.name || ""}`)
      });
    }
    const footballCatalogs = catalogs.filter(catalog => catalog.footballOnly);
    const preferred = catalogs.filter(catalog => catalog.priority);
    const selected = footballCatalogs.length ? footballCatalogs :
      (preferred.length ? preferred : catalogs);
    easySportsCatalogCache = {
      expires: Date.now() + 30 * 60 * 1000,
      staleUntil: Date.now() + 6 * 60 * 60 * 1000,
      catalogs: selected
    };
    rememberBounded(esCaches,base,easySportsCatalogCache,32);
    return selected;
  } catch {
    // Never log the configured manifest URL or its credentials.
    console.warn("EasySports manifest unavailable");
    const previous=easySportsCatalogCache.staleUntil>Date.now()?easySportsCatalogCache.catalogs:[];
    easySportsCatalogCache={...easySportsCatalogCache,expires:Date.now()+30*1000,catalogs:previous};
    rememberBounded(esCaches,base,easySportsCatalogCache,32);return previous;
  }
}
function getEasySportsCatalogs(){const base=easySportsBase();if(!base)return Promise.resolve([]);if(esPending.has(base))return esPending.get(base);const work=discoverEasySportsCatalogs().finally(()=>esPending.delete(base));esPending.set(base,work);return work;}

// Prefer real StremVerse posters, then EasySports and Highfly artwork.
// Preserve the selected image's own shape when merging matching events.
function competitionLabel(meta) {
  for (const value of [meta.competition, meta.league, meta.tournament,
    meta.competitionName, meta.leagueName, meta.tournamentName]) {
    const label = typeof value === "string" ? value :
      (value && typeof value.name === "string" ? value.name : "");
    if (label.trim() && label.trim().length <= 100) return label.trim();
  }
  const name = String(meta.name || meta.title || "");
  const prefix = name.split(":")[0].trim();
  if (name.includes(":") && /\b(?:league|liga|serie|cup|copa|championship|campionato|champions|bundesliga|eredivisie|coppa|uefa)\b/i.test(prefix) &&
      !/\b(?:vs|versus)\b/i.test(prefix) && prefix.length <= 100) return prefix;
  return "";
}

function pickArtwork(meta, source) {
  const valid = value => typeof value === "string" && /^https?:\/\//i.test(value.trim());
  const shapes = ["poster", "landscape", "square"];
  const shape = shapes.includes(meta.posterShape) ? meta.posterShape : null;
  const priority = { sv: 0, es: 1, hf: 2 }[source] ?? 3;
  if (valid(meta.poster)) return {
    poster: meta.poster.trim(),
    posterShape: shape || (source === "sv" ? "poster" : "landscape"),
    posterRank: priority
  };
  if (valid(meta.background)) return {
    poster: meta.background.trim(), posterShape: "landscape", posterRank: 10 + priority
  };
  if (valid(meta.logo)) return {
    poster: meta.logo.trim(), posterShape: "square", posterRank: 20 + priority
  };
  return { poster: null, posterShape: null, posterRank: Infinity };
}

function preferArtwork(target, candidate) {
  if (candidate.poster && (!target.poster || candidate.posterRank < target.posterRank)) {
    target.poster = candidate.poster;
    target.posterShape = candidate.posterShape;
    target.posterRank = candidate.posterRank;
  }
}

// Match dates are evaluated in Italy, not in the server's local time zone.
const MATCH_ZONE = "Europe/Rome";
const MAX_MATCH_MS = 4 * 60 * 60 * 1000;
const matchDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: MATCH_ZONE, year:"numeric", month:"2-digit", day:"2-digit",
  hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23"
});
function romeParts(ms) {
  return Object.fromEntries(matchDateFormat.formatToParts(ms)
    .filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}
function dayKey(ms) {
  const p = romeParts(ms);
  return p.year * 10000 + p.month * 100 + p.day;
}
function romeWallTime(y,m,d,h=0,min=0,sec=0) {
  const wall = Date.UTC(y,m-1,d,h,min,sec);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth()+1 !== m ||
      check.getUTCDate() !== d || check.getUTCHours() !== h ||
      check.getUTCMinutes() !== min || check.getUTCSeconds() !== sec) return null;
  let result = wall;
  for (let i=0;i<3;i++) {
    const p = romeParts(result);
    const local = Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    result += wall-local;
  }
  const p = romeParts(result);
  if (p.year!==y || p.month!==m || p.day!==d || p.hour!==h || p.minute!==min) return null;
  return result;
}
const MONTH_NAMES = {
  jan:1,january:1,gen:1,gennaio:1,feb:2,february:2,febbraio:2,
  mar:3,march:3,marzo:3,apr:4,april:4,aprile:4,may:5,mag:5,maggio:5,
  jun:6,june:6,giu:6,giugno:6,jul:7,july:7,lug:7,luglio:7,
  aug:8,august:8,ago:8,agosto:8,sep:9,sept:9,september:9,set:9,settembre:9,
  oct:10,october:10,ott:10,ottobre:10,nov:11,november:11,novembre:11,
  dec:12,december:12,dic:12,dicembre:12
};
function nearestRomeYear(m,d,now) {
  const y=romeParts(now).year;
  return [y-1,y,y+1].filter(year=>romeWallTime(year,m,d)!==null)
    .sort((a,b)=>Math.abs(romeWallTime(a,m,d)-now)-Math.abs(romeWallTime(b,m,d)-now))[0];
}
function parseMatchDate(value,now=Date.now()) {
  if (value===null || value===undefined || value==="") return null;
  if (typeof value==="number" || (typeof value==="string" && /^\d{10}(?:\d{3})?$/.test(value.trim()))) {
    const n=Number(value), ms=n<1e12?n*1000:n;
    return Number.isFinite(ms) && ms>=Date.UTC(2000,0,1) && ms<Date.UTC(2100,0,1)
      ? {ms,precise:true} : null;
  }
  if (typeof value!=="string") return null;
  const t=value.trim();
  let match=t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (match) {
    const [,y,m,d,h,min,sec,offset]=match;
    const ms=offset?Date.parse(t.replace(" ","T")):romeWallTime(+y,+m,+d,+(h||0),+(min||0),+(sec||0));
    return ms!==null && Number.isFinite(ms)?{ms,precise:!!h}:null;
  }
  // Date-only labels such as 16/11, 16 November or November 16.
  match=t.match(/(?:^|\s)(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{4}|\d{2}))?(?:[ ,T]+(\d{1,2}):(\d{2}))?(?=$|\s|[,.)])/);
  let y,m,d,h,min;
  if (match) {
    d=+match[1];m=+match[2];y=match[3]?+match[3]:nearestRomeYear(m,d,now);
    if(y<100)y+=2000;h=match[4];min=match[5];
  } else {
    const word=t.toLowerCase().match(/\b(\d{1,2})\s+([a-z]+)\.?(?:[ ,]+(\d{4}))?(?:[ ,]+(\d{1,2}):(\d{2}))?\b/);
    const reverse=t.toLowerCase().match(/\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:[ ,]+(\d{4}))?(?:[ ,]+(\d{1,2}):(\d{2}))?\b/);
    const w=word && MONTH_NAMES[word[2]]?word:reverse && MONTH_NAMES[reverse[1]]?reverse:null;
    if(!w)return null;
    d=+(w===word?w[1]:w[2]);m=MONTH_NAMES[w===word?w[2]:w[1]];
    y=w[3]?+w[3]:nearestRomeYear(m,d,now);h=w[4];min=w[5];
  }
  if(!y || y<2000 || y>=2100)return null;
  const ms=romeWallTime(y,m,d,+(h||0),+(min||0));
  return ms===null?null:{ms,precise:h!==undefined};
}
function matchTiming(meta,source,now=Date.now()) {
  const statuses=[meta.status,meta.eventStatus,meta.matchStatus,meta.state,
    meta.status?.type,meta.status?.name,meta.status?.short,meta.status?.description,
    meta.status?.type?.name,meta.status?.type?.state]
    .filter(v=>typeof v==="string").map(v=>v.trim().toLowerCase().replace(/[_-]+/g," "));
  const finished=meta.finished===true || meta.isFinished===true || meta.ended===true ||
    statuses.some(v=>/^(?:ft|aet|pen|final|finished|ended|completed|complete|post|full time|match ended|cancelled|canceled|abandoned|postponed|terminata|terminato|rinviata|annullata)$/.test(v));
  const live=meta.isLive===true || statuses.some(v=>/^(?:live|in play|in progress|in|playing|1h|2h|ht|halftime|half time|et|in diretta)$/.test(v));
  let decodedStart=null;
  if(source==="es" && typeof meta.id==="string" && /^[a-z][a-z0-9_-]*:/i.test(meta.id)){
    try{decodedStart=JSON.parse(Buffer.from(meta.id.slice(meta.id.indexOf(":")+1),"base64url").toString("utf8")).s;}catch{}
  }
  const startFields=[["es.id.s",decodedStart],["startTime",meta.startTime],["startDate",meta.startDate],
    ["startsAt",meta.startsAt],["startTimestamp",meta.startTimestamp],["kickoff",meta.kickoff],
    ["kickoffTime",meta.kickoffTime],["timestamp",meta.timestamp],["scheduledAt",meta.scheduledAt],
    ["eventDate",meta.eventDate],["date",meta.date],["released",meta.released],["releaseInfo",meta.releaseInfo]];
  let selected=null;
  for(const [field,value] of startFields){
    const parsed=parseMatchDate(value,now);
    if(parsed && (!selected || (!selected.precise && parsed.precise && dayKey(parsed.ms)===dayKey(selected.ms)))){
      selected={...parsed,field};
      if(parsed.precise)break;
    }
  }
  if(!selected){
    // Only look at textual dates when structured fields are absent.
    for(const [field,value] of [["name",meta.name],["description",meta.description]]){
      const parsed=parseMatchDate(value,now);
      if(parsed){selected={...parsed,field};break;}
    }
  }
  return {start: selected?.ms ?? null, precise: selected?.precise || false,
    field: selected?.field || null, finished, live};
}
function timeDecision(t,now=Date.now()) {
  if(!t)return "unknown";
  if(t.finished)return "finished";
  if(t.start!==null){
    if(t.precise){
      if(now>=t.start+(t.sport==="tennis"?8*60*60*1000:t.sport==="motors"?12*60*60*1000:MAX_MATCH_MS))return "expired";
      return t.start>now?"upcoming":"current";
    }
    return dayKey(t.start)<dayKey(now)?"past-day":dayKey(t.start)>dayKey(now)?"upcoming":"today";
  }
  // A provider may omit timing metadata entirely (e.g. StremVerse).
  // Trust its current catalog membership, without claiming the event is live.
  return t.live?"live-undated":"catalog-undated";
}
function timeVisible(t,now=Date.now()) {
  return !["unknown","finished","expired","past-day"].includes(timeDecision(t,now));
}

// Catalog requests share a short per-endpoint cache. A failed provider can reuse
// its own last successful catalog briefly without delaying unrelated providers.
const providerCatalogCache=new Map();
const providerCatalogInFlight=new Map();
const catalogPerformance={refreshes:0,lastRefreshMs:null,lastCounts:{},sources:{},artwork:{hits:0,misses:0,shared:0,completed:0,failed:0,lastMs:null}};
function providerCatalog(item) {
  const cached=providerCatalogCache.get(item.url), now=Date.now();
  if(cached && cached.expires>now)return Promise.resolve(cached.value);
  if(providerCatalogInFlight.has(item.url))return providerCatalogInFlight.get(item.url);
  const started=Date.now();
  const stats=catalogPerformance.sources[item.source] ||= {requests:0,failures:0,lastMs:null,staleHits:0};
  stats.requests++;
  const work=Promise.resolve().then(()=>item.source==="hf"?getJson(item.url):getJsonRaw(item.url,6500))
    .then(value=>{
      if(!Array.isArray(value?.metas))throw new Error("Invalid provider catalog");
      providerCatalogCache.delete(item.url);
      providerCatalogCache.set(item.url,{value,expires:Date.now()+60*1000,staleUntil:Date.now()+20*60*1000});
      while(providerCatalogCache.size>48)providerCatalogCache.delete(providerCatalogCache.keys().next().value);
      return value;
    }).catch(error=>{
      stats.failures++;
      if(cached&&cached.staleUntil>Date.now()){
        stats.staleHits++;
        return cached.value;
      }
      throw error;
    }).finally(()=>{
      stats.lastMs=Date.now()-started;
      providerCatalogInFlight.delete(item.url);
    });
  providerCatalogInFlight.set(item.url,work);
  return work;
}

async function collectCatalogResponses(existing, discover, fetchCatalog) {
  const first=Promise.allSettled(existing.map(fetchCatalog));
  const second=Promise.resolve().then(discover).then(async catalogs=>({
    catalogs, results:await Promise.allSettled(catalogs.map(fetchCatalog))
  }));
  const [a,b]=await Promise.all([first,second]);
  return {catalogs:[...existing,...b.catalogs],results:[...a,...b.results]};
}

function sportCategory(value) {
  const t=sportText(value);
  if(/\b(?:table tennis|ping pong|padel|badminton|esports|virtual tennis)\b/.test(t))return "";
  if(/\b(?:tennis|atp|wta|itf|challenger tour|davis cup|billie jean king cup|wimbledon|roland garros|australian open|us open tennis)\b/.test(t))return "tennis";
  if(/\b(?:motorsport|motor sports?|motorsports|motor racing|formula [123e]|f1|f2|f3|motogp|moto gp|moto[23]|superbike|wsbk|nascar|indycar|indy car|wrc|rally|world endurance|wec|imsa|motocross|supercross|dtm|supercars|motorcycle racing)\b/.test(t))return "motors";
  if(isFootballSport(value))return "football";
  return "";
}
function classifySportMeta(meta,catalog) {
  const values=[meta.sport,meta.sportName,meta.genre,meta.genres,meta.category,meta.categories,meta.league,meta.competition,String(meta.id||"").split(":")[0],meta.name,meta.title];
  const strong=sportText(values);
  if(/\b(?:table tennis|ping pong|padel|badminton|esports|virtual tennis)\b/.test(strong))return "";
  const direct=values.map(sportCategory).filter(Boolean);
  if(direct.includes("tennis"))return "tennis";
  if(direct.includes("motors"))return "motors";
  if(direct.includes("football"))return "football";
  if(isOtherSport(strong))return "";
  return catalog.sport||sportCategory(meta.description);
}
function sportCatalogOptions(manifest,base,source,sport) {
  const options=[];
  for(const catalog of manifest?.catalogs||[]){
    if(!catalog?.id||!catalog.type)continue;
    const extras=Array.isArray(catalog.extra)?catalog.extra:[];
    const genre=extras.find(x=>x.name==="genre");
    const required=[...extras.filter(x=>x.isRequired).map(x=>x.name),...(catalog.extraRequired||[])];
    if(required.some(x=>x!=="genre"))continue;
    const label=[catalog.id,catalog.name,catalog.type],own=sportCategory(label);
    const matches=(Array.isArray(genre?.options)?genre.options:[]).filter(x=>sportCategory(x)===sport);
    const root=base+"/catalog/"+encodeURIComponent(catalog.type)+"/"+encodeURIComponent(catalog.id);
    for(const option of matches)options.push({source,type:catalog.type,sport,url:root+"/genre="+encodeURIComponent(option)+".json"});
    if(!matches.length&&!required.includes("genre")&&own===sport)options.push({source,type:catalog.type,sport,url:root+".json"});
    if(!matches.length&&!required.includes("genre")&&!own&&!isOtherSport(label)&&/\b(?:live|today|sport|sports|events|upcoming)\b/.test(sportText(label)))
      options.push({source,type:catalog.type,sport:null,url:root+".json"});
  }
  const dedicated=options.filter(x=>x.sport===sport);
  return [...new Map((dedicated.length?dedicated:options).map(x=>[x.url,x])).values()].slice(0,12);
}
const extraManifestCache=new Map(),extraManifestPending=new Map();
async function sportManifest(source,base) {
  const cacheKey=source==="es"?base:source;
  const cached=extraManifestCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.value;
  if(extraManifestPending.has(cacheKey))return extraManifestPending.get(cacheKey);
  const work=getJsonRaw(base+"/manifest.json",5000).then(value=>{
    rememberBounded(extraManifestCache,cacheKey,{value,expires:Date.now()+30*60*1000},40);return value;
  }).catch(()=>cached?.value||null).finally(()=>extraManifestPending.delete(cacheKey));
  extraManifestPending.set(cacheKey,work);return work;
}
async function discoverSportCatalogs(sport) {
  const inputs=[["sv",STREMVERSE],["hf",HIGHFLY],["es",easySportsBase()]].filter(x=>x[1]);
  const groups=await Promise.all(inputs.map(async ([source,base])=>sportCatalogOptions(await sportManifest(source,base),base,source,sport)));
  return groups.flat();
}
function sportEventKey(event) {
  if(event.sport==="football")return eventKey(event.name);
  const sides=getMatchSides(event.name);
  const title=sides.length===2?sides.map(sportText).sort().join("|"):sportText(event.name);
  const day=Number.isFinite(event.timing?.start)?dayKey(event.timing.start):"undated";
  // Include competition and kickoff for new sports to avoid collapsing different matches or sessions.
  const kickoff=event.timing?.precise?Math.floor(event.timing.start/60000):"";
  return title?event.sport+":"+day+":"+sportText(event.competition)+":"+kickoff+":"+title:"";
}

async function getProviderEvents(sport = "football") {

  const started=Date.now();
  // EasySports catalog requests begin as soon as discovery finishes, not after
  // StremVerse and Highfly have returned. Keep deterministic source order.
  const existing=sport==="football"?PROVIDER_CATALOGS:PROVIDER_CATALOGS.filter(item=>item.source==="hf"&&/sports_(?:live|today)\.json$/.test(item.url));
  const discover=sport==="football"?getEasySportsCatalogs:()=>discoverSportCatalogs(sport);
  const {catalogs,results}=await collectCatalogResponses(existing,discover,providerCatalog);
  catalogPerformance.refreshes++;
  catalogPerformance.lastRefreshMs=Date.now()-started;


  // An outage in every provider must not replace an existing catalog with an empty one.
  if (!results.some(result => result.status === "fulfilled")) {
    throw new Error("All provider catalogs unavailable");
  }


  const events = [];
  const eventIndex=new Map();
  const counts={};

  results.forEach(
    (result, index) => {

      if (
        result.status !==
        "fulfilled"
      ) {

        console.error(
          "Provider error:",
          catalogs[index].source
        );

        return;
      }


      const source =
        catalogs[index].source;
      counts[source]=(counts[source]||0)+result.value.metas.length;

      for (
  const meta of
  result.value.metas || []
) {

  if (!meta?.id) {
    continue;
  }
  if(sport==="football"){
    if(source==="es"&&!easySportsFootballMeta(meta,catalogs[index]))continue;
  }else if(classifySportMeta(meta,catalogs[index])!==sport)continue;


  const providerKey =
    `${source}:${meta.id}`;


  const alreadyExists=eventIndex.get(providerKey);


  if (alreadyExists) {
    preferArtwork(alreadyExists, pickArtwork(meta, source));
    if (!alreadyExists.competition) alreadyExists.competition = competitionLabel(meta);
    const timing = {...matchTiming(meta, source), sport};
    if (timing.finished || (!alreadyExists.timing.finished && (alreadyExists.timing.start === null || (!alreadyExists.timing.precise && timing.precise)))) alreadyExists.timing = timing;
    continue;
  }


  const event={

    source,
    sport,

    providerId:
      String(meta.id),

    ...(source === "es" || sport !== "football" ? { providerType: sport==="football"?(meta.type||catalogs[index].type):(catalogs[index].type || meta.type || (source==="sv"?"tv":"sport")) } : {}),

    name: meta.name || meta.title || "",
    competition: competitionLabel(meta) || (sport!=="football" && String(meta.name||meta.title||"").includes(":") ? String(meta.name||meta.title).split(":")[0].trim() : ""),
    timing: {...matchTiming(meta, source), sport},

    ...pickArtwork(meta, source),

    description:
      meta.description ||
      "",

    releaseInfo:
      meta.releaseInfo ||
      ""
  };
  events.push(event);
  eventIndex.set(providerKey,event);
}
    }
  );


  catalogPerformance.lastCounts=counts;
  return events;
}


/* =========================================================
   FILTRO + DEDUPLICAZIONE
========================================================= */

function wantedProviderEvent(event) {
  return !!event?.name && (event.sport==='tennis'||event.sport==='motors'||wantedEvent(event.name)) && timeVisible(event.timing);
}

function isSecondTeamMatch(value = "") {
  return /\b(?:juventus|milan|inter|roma|bayern|barcelona|real madrid|atletico)\s+(?:ii|iii|b|u23)\b/i.test(value);
}


function getInterestingTeams(name = "") {

  const parts =
    name
      .split(/\bvs\b|\bv\b| - /i)
      .map(x => x.trim())
      .filter(Boolean);


  const found = [];


  const canonicalMap = {

    // ITALIA
    "internazionale": "inter",
    "inter milan": "inter",
    "inter milano": "inter",

    "ac milan": "milan",

    "as roma": "roma",

    "ss lazio": "lazio",


    // GERMANIA
    "bayern munich": "bayern",
    "bayern munchen": "bayern",


    // FRANCIA
    "paris saint germain": "psg",
    "paris saint-germain": "psg",


    // SPAGNA
    "fc barcelona": "barcelona",

    
    // INGHILTERRA
    "manchester utd": "manchester united",
    "man united": "manchester united"

  };


  for (const part of parts) {

    const n =
      normalize(part);


    let canonical = null;


    // prima controllo alias precisi

    for (
      const key of Object.keys(canonicalMap)
    ) {

      if (
        n.includes(
          normalize(key)
        )
      ) {

        canonical =
          canonicalMap[key];

        break;
      }
    }


    // poi controllo squadre normali

    if (!canonical) {

      for (
        const team of wantedTeams
      ) {

        const t =
          normalize(team);


        if (
          n === t ||
          n.includes(t)
        ) {

          canonical = t;
          break;
        }
      }
    }


    if (canonical) {

      found.push(canonical);

    }

  }


  return [
    ...new Set(found)
  ].sort();

}


function eventKey(name = "") {
  const teams = getInterestingTeams(name);

  if (!teams.length) return "";

  // Keep first-team vs reserve-team fixtures separate from their
  // first-team equivalents (Inter-Ajax II != Inter-Ajax).
  const sides = getMatchSides(name);
  if (sides.length === 2 && sides.some(isReserveTeamSide)) {
    return "reserve:" + sides.map(normalize).sort().join("|");
  }

  return teams.map(t => normalize(t)).sort().join("|");
}


async function getCatalogEvents(sport = 'football') {

  const all =
    await getProviderEvents(sport);


  const filtered =
    all.filter(wantedProviderEvent);


  /*
    Raggruppiamo lo stesso evento proveniente
    dai due provider in una sola card.
  */

  const map = new Map();


  for (const event of filtered) {

    const key =
      sportEventKey(event);


    if (!key) {
      continue;
    }


    if (!map.has(key)) {

      map.set(key, {

        key,
        sport,

        name:
          event.name,

        poster: event.poster,
        posterShape: event.posterShape,
        posterRank: event.posterRank,
        competition: event.competition,
        timings: [],

        description:
          event.description,

        releaseInfo:
          event.releaseInfo,

        providers: []
      });
    }


    const item =
      map.get(key);


    preferArtwork(item, event);
    if (!item.competition && event.competition) item.competition = event.competition;
    item.timings.push(event.timing);


    item.providers.push({

      source:
        event.source,

      id:
        event.providerId,

      ...(event.providerType ? { type: event.providerType } : {})
    });
  }


  return Array.from(
    map.values()
  );
}


/* =========================================================
   CACHE CATALOGO
========================================================= */

let catalogCache = {
  expires: 0,
  staleUntil: 0,
  initialized: false,
  events: []
};

let catalogRefreshPromise = null;

// Keep the same five-minute fresh cache as the original addon.
const CACHE_MS = 5 * 60 * 1000;
const STALE_MS = 20 * 60 * 1000;
const RETRY_MS = 30 * 1000;

const sportCaches=new Map(),sportRefreshes=new Map();
async function getSportCatalog(sport) {
  if(sport==="football"&&!scope.getStore())return getCachedCatalog();
  const cacheKey=profileKey()+":"+sport;
  const now=Date.now(), cached=sportCaches.get(cacheKey);
  if(cached&&cached.expires>now)return currentCatalog(cached.events);
  if(!sportRefreshes.has(cacheKey)){
    const work=getCatalogEvents(sport).then(events=>{
      rememberBounded(sportCaches,cacheKey,{events,expires:Date.now()+CACHE_MS,staleUntil:Date.now()+STALE_MS},36);return events;
    }).finally(()=>sportRefreshes.delete(cacheKey));
    sportRefreshes.set(cacheKey,work);
  }
  if(cached&&cached.staleUntil>now){sportRefreshes.get(cacheKey).catch(()=>{});return currentCatalog(cached.events);}
  return currentCatalog(await sportRefreshes.get(cacheKey));
}
function currentCatalog(events) {
  const now = Date.now();
  return events.filter(event => event.timings.some(timing => timeVisible(timing, now)));
}

async function getCachedCatalog() {
  if(scope.getStore())return getSportCatalog("football");
  const now = Date.now();

  if (catalogCache.initialized && catalogCache.expires > now) {
    return currentCatalog(catalogCache.events);
  }

  // Share provider requests between concurrent Stremio catalog requests.
  if (!catalogRefreshPromise) {
    catalogRefreshPromise = getCatalogEvents()
      .then(events => {
        const updated = Date.now();
        catalogCache = {
          expires: updated + CACHE_MS,
          staleUntil: updated + STALE_MS,
          initialized: true,
          events
        };
        return events;
      })
      .catch(error => {
        console.error("Catalog refresh failed:", error);
        if (catalogCache.initialized) {
          catalogCache.expires = Math.min(
            Date.now() + RETRY_MS,
            catalogCache.staleUntil
          );
        }
        throw error;
      })
      .finally(() => {
        catalogRefreshPromise = null;
      });
  }

  // Show recent cached events immediately while checking fresh provider data.
  // Never keep older live events past the bounded stale cache interval.
  if (catalogCache.initialized && catalogCache.staleUntil > now) {
    catalogRefreshPromise.catch(() => {});
    return currentCatalog(catalogCache.events);
  }

  return currentCatalog(await catalogRefreshPromise);
}


/* =========================================================
   ID NOSTRI
========================================================= */

function encodeEventId(key) {

  return Buffer
    .from(key, "utf8")
    .toString("base64url");
}


function decodeEventId(id) {

  try {

    return Buffer
      .from(id, "base64url")
      .toString("utf8");

  } catch {

    return "";
  }
}


/* =========================================================
   META CATALOGO
========================================================= */

// Stremio Discover uses a uniform portrait grid even for landscape metadata.
// Serve a real portrait JPEG with the complete fallback artwork centered inside.
const ARTWORK_ORIGIN = "https://dado-live-tv.onrender.com";
const artworkRefs = new Map();
const artworkCache = new Map();
const artworkInFlight = new Map();
const artworkQueue = [];
let artworkActive = 0;
const ARTWORK_BYTES_MAX = 5 * 1024 * 1024;

function rememberBounded(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function pickDisplayTiming(event, now = Date.now()) {
  const timings = (event.timings || (event.timing ? [event.timing] : []))
    .filter(t => t && timeVisible(t, now) && Number.isFinite(t.start));
  // Prefer a known kickoff over a date-only record. Use the nearest valid event.
  return timings.slice().sort((a,b) =>
    Number(b.precise) - Number(a.precise) ||
    Math.abs(a.start-now) - Math.abs(b.start-now))[0] || null;
}

function artworkId(event, version = "v6") {
  let identity = event.key + "\n" + event.poster;
  if (version !== "v1") identity += "\n" + event.name + "\n" + (event.competition || "");
  if (["v3","v4","v5","v6"].includes(version)) {
    const t = pickDisplayTiming(event);
    identity += "\n"+version+"\n" + (t?.start ?? "") + "\n" + (t?.precise ? "1" : "0");
  }
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function artworkReference(event) {
  return { url: event.poster, name: event.name || "", competition: event.competition || "",
    timing: pickDisplayTiming(event), sport:event.sport||"football" };
}

function artworkForMeta(event) {
  if (!event.poster) return undefined;
  // Preserve original StremVerse portrait artwork; adapt all fallback artwork.
  if (event.posterRank === 0 && event.posterShape === "poster") return event.poster;
  const id = artworkId(event);
  rememberBounded(artworkRefs, id, artworkReference(event), 1000);
  return ARTWORK_ORIGIN + "/artwork/v6/" + id + ".jpg";
}

function publicArtworkIP(ip) {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 ||
      (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 ||
      (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

// The route only accepts opaque IDs registered by the catalog, not user URLs.
// Still validate each redirect and pin DNS to a public IPv4 address.
async function downloadArtwork(value, redirects = 0) {
  if (redirects > 3) throw new Error("Too many redirects");
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))) {
    throw new Error("Unsupported artwork URL");
  }
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const addresses = isIP(url.hostname) ? [url.hostname] : await resolver.resolve4(url.hostname);
  if (!addresses.length || addresses.some(ip => !publicArtworkIP(ip))) {
    throw new Error("Unsafe artwork address");
  }
  const address = addresses[0];
  const result = await new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let timer;
    const request = transport.get(url, {
      agent: false,
      family: 4,
      autoSelectFamily: false,
      lookup: (_name, opts, callback) => {
        if (opts.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
      headers: { "User-Agent": "Stremio-LIVE/3.0", Accept: "image/*" }
    }, response => {
      const status = response.statusCode || 0;
      if ([301,302,303,307,308].includes(status) && response.headers.location) {
        resolve({ redirect: new URL(response.headers.location, url).href });
        response.destroy();
        return;
      }
      if (status !== 200 || Number(response.headers["content-length"] || 0) > ARTWORK_BYTES_MAX) {
        response.destroy();
        reject(new Error("Artwork unavailable"));
        return;
      }
      const type = String(response.headers["content-type"] || "").toLowerCase();
      if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream")) {
        response.destroy();
        reject(new Error("Not an image"));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > ARTWORK_BYTES_MAX) {
          request.destroy(new Error("Artwork too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ buffer: Buffer.concat(chunks) }));
    });
    timer = setTimeout(() => request.destroy(new Error("Artwork timeout")), 7000);
    request.on("error", reject);
    request.on("close", () => clearTimeout(timer));
  });
  return result.redirect ? downloadArtwork(result.redirect, redirects + 1) : result.buffer;
}

function drainArtworkQueue() {
  while (artworkActive < 5 && artworkQueue.length) {
    const { task, resolve, reject } = artworkQueue.shift();
    artworkActive++;
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      artworkActive--;
      drainArtworkQueue();
    });
  }
}

function scheduleArtwork(task) {
  return new Promise((resolve, reject) => {
    if (artworkQueue.length >= 96) return reject(new Error("Artwork queue full"));
    artworkQueue.push({ task, resolve, reject });
    drainArtworkQueue();
  });
}

function xmlText(value) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]));
}

// Limit each line by approximate glyph width and split very long words.
function posterLines(value, maxChars, maxLines) {
  const words = String(value || "").replace(/\s+/g, " ").trim().slice(0, 180).split(" ").filter(Boolean);
  const chunks = words.flatMap(word => Array.from(word).length > maxChars
    ? Array.from(word).reduce((acc, ch, i) => {
        if (i % maxChars === 0) acc.push("");
        acc[acc.length - 1] += ch;
        return acc;
      }, [])
    : [word]);
  const lines = [];
  for (const word of chunks) {
    const last = lines[lines.length - 1];
    if (last && Array.from(last + " " + word).length <= maxChars) lines[lines.length - 1] += " " + word;
    else lines.push(word);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = Array.from(lines[maxLines - 1]).slice(0, maxChars - 1).join("") + "…";
  }
  return lines;
}

function cleanPosterText(value = "") {
  return String(value || "").normalize("NFKC")
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{E0000}-\u{E007F}]/gu, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}/gu, "")
    .replace(/[\uFE0E\uFE0F\u200D\u200B\u200C\u2060\u20E3\uFEFF]/gu, "")
    .replace(/\s+/g," ").trim();
}

const posterDateFormat = new Intl.DateTimeFormat("it-IT", {
  timeZone: MATCH_ZONE, day:"2-digit", month:"short",
  hour:"2-digit", minute:"2-digit", hourCycle:"h23"
});
function formatPosterDateTime(timing) {
  if (!timing || !Number.isFinite(timing.start)) return "";
  const parts = Object.fromEntries(posterDateFormat.formatToParts(timing.start)
    .filter(p => p.type !== "literal").map(p => [p.type,p.value]));
  const date = parts.day + " " + parts.month.replace(/\./g,"");
  return timing.precise ? date + " · " + parts.hour + ":" + parts.minute : date;
}

// Competition marks: known league IDs only; never use an arbitrary URL from metadata.
function competitionLogoId(value) {
  const label=cleanPosterText(value).normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const rules=[
    [/\b(?:uefa champions league|champions league|ucl)\b/,2],
    [/\b(?:uefa europa league|europa league)\b/,3],
    [/\b(?:uefa conference league|europa conference league|conference league)\b/,848],
    [/\b(?:italy|italia|italian) (?:serie b)\b|^serie b(?:kt)?$/,136],
    [/\b(?:italy|italia|italian) (?:serie a)\b|^serie a$/,135],
    [/\b(?:coppa italia|italy cup)\b/,137],
    [/\b(?:english premier league|england premier league)\b|^premier league$/,39],
    [/\b(?:la liga|laliga|primera division spain)\b/,140],
    [/\b(?:bundesliga)\b(?! 2)/,78],
    [/\b(?:ligue 1)\b/,61],
    [/\b(?:eredivisie)\b/,88],
    [/\b(?:liga portugal|primeira liga)\b/,94],
    [/\b(?:fifa world cup|mondiali di calcio)\b/,1],
    [/\b(?:uefa nations league)\b/,5],
    [/\b(?:copa america)\b/,9],
    [/\b(?:copa libertadores)\b/,13],
    [/\b(?:copa sudamericana)\b/,11]
  ];
  if (/\b(?:women|femminile|youth|under|qualif|qualification|qualifiers|friendly|amichevole|2 bundesliga|bundesliga 2)\b/.test(label)) return null;
  return rules.find(([pattern])=>pattern.test(label))?.[1] || null;
}
const competitionLogoCache=new Map();
const competitionLogoInFlight=new Map();
// Preserve the source PNG alpha and all white/coloured details.
 // Only brighten the dark navy artwork of the Champions League mark for dark posters.
function adaptCompetitionContrast(data, id) {
  if (id !== 2) return data;
  let transparent = false;
  for (let i=3;i<data.length;i+=4) if (data[i]<32) {transparent=true;break;}
  if(!transparent)return data;
  for(let i=0;i<data.length;i+=4){
    if(!data[i+3])continue;
    const r=data[i],g=data[i+1],b=data[i+2];
    const light=.2126*r+.7152*g+.0722*b;
    if(light>=155 || b+8<r || b+8<g)continue;
    // A pale silver-blue preserves contrast with white details and leaves alpha intact.
    const mix=Math.min(1,Math.max(0,(155-light)/80));
    data[i]=Math.round(r+(212-r)*mix);
    data[i+1]=Math.round(g+(224-g)*mix);
    data[i+2]=Math.round(b+(248-b)*mix);
  }
  return data;
}
async function transparentCompetitionLogo(input,id) {
  const raw=await sharp(input,{limitInputPixels:4000000}).rotate()
    .ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const data=adaptCompetitionContrast(raw.data,id);
  return sharp(data,{raw:{width:raw.info.width,height:raw.info.height,channels:4}})
    .resize(88,88,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}})
    .png().toBuffer();
}

async function loadCompetitionLogo(id) {
  if(!id)return null;
  const cached=competitionLogoCache.get(id);
  if(cached && cached.expires>Date.now())return cached.buffer;
  if(competitionLogoInFlight.has(id))return competitionLogoInFlight.get(id);
  const work=(async()=>{
    try {
      const input=await downloadArtwork("https://media.api-sports.io/football/leagues/"+id+".png");
      const buffer=await transparentCompetitionLogo(input,id);
      rememberBounded(competitionLogoCache,id,{buffer,expires:Date.now()+24*60*60*1000},40);
      return buffer;
    }catch{
      rememberBounded(competitionLogoCache,id,{buffer:null,expires:Date.now()+5*60*1000},40);
      return null;
    }
  })().finally(()=>competitionLogoInFlight.delete(id));
  competitionLogoInFlight.set(id,work);
  return work;
}

function footerGeometry(topCount, bottomCount) {
  const lineHeight=38, gap=50, center=598;
  const span=(topCount-1)*lineHeight+2*gap+(bottomCount-1)*lineHeight;
  const topStart=center-span/2;
  return {topStart, vsY:topStart+(topCount-1)*lineHeight+gap,
    bottomStart:topStart+(topCount-1)*lineHeight+2*gap,lineHeight};
}

function portraitOverlay(source, hasLogo = false, version = "v6") {
  const competition = posterLines(cleanPosterText(source.competition) || (source.sport==="tennis"?"TENNIS":source.sport==="motors"?"MOTORI":"CALCIO"), hasLogo ? 20 : 24, 2);
  const sides = getMatchSides(cleanPosterText(source.name)).map(cleanPosterText).filter(Boolean);
  const dateLabel = formatPosterDateTime(source.timing);
  const textLine = (value,y,fontSize,color,weight=700,x=240,maxWidth=428) => {
    const count = Array.from(value).reduce((n,c)=>n+(/[MW@%]/i.test(c)?0.92:/[ilI1.,' ]/.test(c)?0.32:0.68),0);
    const size = Math.min(fontSize,Math.floor(maxWidth/Math.max(count,1)));
    return '<text x="'+x+'" y="'+y+'" font-family="DejaVu Sans, sans-serif" font-size="'+size+
      '" font-weight="'+weight+'" fill="'+color+'" text-anchor="middle">'+xmlText(value)+'</text>';
  };
  const teamLines = sides.length===2?sides.map(side=>posterLines(side,19,2)):[];
  let footer="";
  if(teamLines.length===2 && teamLines.every(lines=>lines.length)){
    const g=footerGeometry(teamLines[0].length,teamLines[1].length);
    footer+=teamLines[0].map((line,i)=>textLine(line,g.topStart+i*g.lineHeight,38,"#ffffff",800)).join("");
    const badgeTop=g.vsY-26;
    footer+='<rect x="207" y="'+badgeTop+'" width="66" height="34" rx="17" fill="#141d29" stroke="#e7ce8f" stroke-opacity=".8"/>';
    footer+=textLine("VS",g.vsY-3,18,"#e7ce8f",800);
    footer+=teamLines[1].map((line,i)=>textLine(line,g.bottomStart+i*g.lineHeight,38,"#ffffff",800)).join("");
  }else{
    const lines=posterLines(cleanPosterText(source.name),19,4);
    footer=lines.map((line,i)=>textLine(line,598-(lines.length-1)*19+i*38,38,"#ffffff",800)).join("");
  }
  const headerStart=competition.length===1?94:77;
  const headerX=hasLogo?286:240, headerWidth=hasLogo?300:428;
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720">'+
    '<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#090e17" stop-opacity=".88"/><stop offset=".5" stop-color="#101724" stop-opacity=".46"/><stop offset="1" stop-color="#090e17" stop-opacity=".94"/></linearGradient></defs>'+
    '<rect width="480" height="720" fill="url(#shade)"/>'+
    (hasLogo&&version==="v4"?'<rect x="22" y="46" width="104" height="104" rx="13" fill="#f3f5f8" opacity=".97"/>':'')+
    '<rect x="'+(headerX-37)+'" y="40" width="74" height="4" rx="2" fill="#e7ce8f"/>'+
    competition.map((line,i)=>textLine(line.toUpperCase(),headerStart+i*30,25,"#e7ce8f",700,headerX,headerWidth)).join("")+
    (dateLabel?textLine(dateLabel.toUpperCase(),148,23,"#f1f3f7",600,headerX,headerWidth):"")+
    '<rect x="34" y="171" width="412" height="2" rx="1" fill="#ffffff" opacity=".14"/>'+
    '<rect x="34" y="468" width="412" height="2" rx="1" fill="#ffffff" opacity=".14"/>'+
    footer+'</svg>');
}

async function composePortrait(input, source, version, logoPromise) {
  const options = { limitInputPixels: 16000000 };
  const background = await sharp(input, options).rotate()
    .resize(480, 720, { fit: "cover" }).blur(28).flatten({background:"#161920"}).png().toBuffer();
  const foreground = await sharp(input, options).rotate()
    .resize(448, 274, { fit: "inside" }).flatten({background:"#161920"}).png().toBuffer({resolveWithObject:true});
  const left = Math.floor((480 - foreground.info.width) / 2);
  const top = Math.floor(319 - foreground.info.height / 2);
  const logo=await logoPromise;
  return sharp(background).composite([
    { input: portraitOverlay(source,!!logo,version), top: 0, left: 0 },
    { input: foreground.data, top, left },
    ...(logo?[{input:logo,top:54,left:30}]:[])
  ]).jpeg({quality:86}).toBuffer();
}

async function renderPortrait(id, source, version) {
  const cached = artworkCache.get(id);
  if (cached && cached.expires > Date.now()) {
    catalogPerformance.artwork.hits++;
    rememberBounded(artworkCache, id, cached, 96);
    return cached.buffer;
  }
  if (artworkInFlight.has(id)) {catalogPerformance.artwork.shared++;return artworkInFlight.get(id);}
  catalogPerformance.artwork.misses++;
  const started=Date.now();
  const work = scheduleArtwork(async () => {
    const logoPromise=["v4","v5","v6"].includes(version)?loadCompetitionLogo(competitionLogoId(source.competition)):Promise.resolve(null);
    const input = await downloadArtwork(source.url);
    let buffer;
    if (["v2","v3","v4","v5","v6"].includes(version)) {
      try { buffer = await composePortrait(input, source, version, logoPromise); }
      catch { console.warn("Decorated portrait unavailable; using plain portrait"); }
    }
    if (!buffer) buffer = await sharp(input, { limitInputPixels: 16000000 })
      .rotate()
      .resize(480, 720, {
        fit: "contain",
        position: "centre",
        background: { r: 22, g: 25, b: 32, alpha: 1 }
      })
      .flatten({ background: "#161920" })
      .jpeg({ quality: 86 })
      .toBuffer();
    rememberBounded(artworkCache, id, { buffer, expires: Date.now() + 2 * 60 * 60 * 1000 }, 96);
    catalogPerformance.artwork.completed++;
    return buffer;
  }).catch(error=>{catalogPerformance.artwork.failed++;throw error;}).finally(() => {
    catalogPerformance.artwork.lastMs=Date.now()-started;
    artworkInFlight.delete(id);
  });
  artworkInFlight.set(id, work);
  return work;
}


/* Private invite access: persistent Upstash Redis registry; fail closed. */
const ACCESS_ORIGIN="https://dado-live-tv.onrender.com";
const accessStoreURL=process.env.UPSTASH_REDIS_REST_URL||"";
const accessStoreToken=process.env.UPSTASH_REDIS_REST_TOKEN||"";
const adminPassword=process.env.DADO_ADMIN_PASSWORD||"";
const accessKey="dado:private:v1:users";
const accessActivity=new Map();
const localLoginAttempts=new Map();
function accessReady(){
  try{const u=new URL(accessStoreURL);return u.protocol==="https:"&&u.hostname.endsWith(".upstash.io")&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==="/"&&!!accessStoreToken&&adminPassword.length>=16&&!!encryptionKey();}catch{return false;}
}
async function accessRedis(...command){
  if(!accessReady())throw Error("Access store not configured");
  const r=await fetch(accessStoreURL.replace(/\/$/,""),{method:"POST",headers:{Authorization:"Bearer "+accessStoreToken,"Content-Type":"application/json"},body:JSON.stringify(command),signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error("Access store unavailable");
  const data=await r.json();if(data.error)throw Error("Access store unavailable");return data.result;
}
function accessHash(s){return crypto.createHash("sha256").update(s).digest("hex")}
function accessEqual(a,b){return typeof a==="string"&&typeof b==="string"&&crypto.timingSafeEqual(Buffer.from(accessHash(a)),Buffer.from(accessHash(b)))}
function validAccessId(id){return typeof id==="string"&&/^[a-f0-9]{24}$/.test(id)}
async function accessUser(id){
  if(!validAccessId(id))return null;
  const raw=await accessRedis("HGET",accessKey,id);if(typeof raw!=="string")return null;
  const u=JSON.parse(raw);return u&&u.id===id?u:null;
}
async function accessTouch(id){
  const now=Date.now();if(now-(accessActivity.get(id)||0)<300000)return;
  try{await accessRedis("HSET",accessKey+":activity",id,String(now));accessActivity.set(id,now);}catch{/* Activity must not prevent a valid request. */}
}
function accessCookie(req,name){
  const raw=(req.headers.cookie||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  if(!raw)return null;const value=raw.slice(name.length+1);if(!/^[A-Za-z0-9_-]{1,2200}$/.test(value))return null;
  const p=unseal(value);return p&&Number.isFinite(p.exp)&&p.exp>Date.now()?p:null;
}
function adminSession(req){const p=accessCookie(req,"dado_admin");return accessReady()&&p?.kind==="admin-session"&&accessEqual(p.auth,accessHash(adminPassword));}
function setAccessCookie(res,name,payload,seconds){res.cookie(name,seal({...payload,exp:Date.now()+seconds*1000}),{httpOnly:true,secure:true,sameSite:"strict",path:"/",maxAge:seconds*1000});}
function userSession(req){const p=accessCookie(req,"dado_user");return p?.kind==="user-session"&&validAccessId(p.uid)?p.uid:null;}
function privateEnvelope(token){
  if(typeof token!=="string"||!/^[A-Za-z0-9_-]{1,3500}$/.test(token))return null;
  const p=unseal(token);return p?.kind==="addon-v1"&&validAccessId(p.uid)&&p.config&&typeof p.config==="object"?p:null;
}
function accessPage(title,body,js=""){
  return '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+' | Dado Live TV</title><style>:root{color-scheme:dark;font:16px system-ui;background:#11131b;color:#f1f2f6}body{margin:0;padding:24px 16px}main{max-width:580px;margin:auto}header{display:flex;align-items:center;gap:14px}header img{width:56px;border-radius:12px}h1{font-size:22px}p,small{color:#b5bac9}section{background:#20232e;border:1px solid #343747;border-radius:14px;padding:18px;margin:16px 0}input,button,a.action{box-sizing:border-box;font:inherit;padding:12px;border-radius:9px;border:1px solid #484d60;background:#2c303d;color:#fff}input{width:100%;margin:8px 0}button{cursor:pointer}button.primary{background:#29bc75;color:#082519;font-weight:700;width:100%}button:disabled{opacity:.45}a{color:#8dbbff}article{border-top:1px solid #484d60;padding:12px 0;display:grid;gap:8px}#status,#code{overflow-wrap:anywhere;white-space:pre-wrap}label{display:block;margin-top:8px}</style></head><body><main><header><img src="/logo.png" alt=""><h1>'+title+'</h1></header>'+body+'</main><script>'+js+'</script></body></html>';
}
const accessClient=String.raw`
const el=id=>document.getElementById(id);
async function post(url,data){const r=await fetch(url,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw Error(d.error||"Operazione non riuscita");return d}
function showError(e){el("status").textContent=e.message}
`;
function loginPage(admin){
  const endpoint=admin?"/admin/login":"/access/login",dest=admin?"/admin":"/configure";
  return accessPage(admin?"Dado Live TV — Admin":"Dado Live TV — Accesso riservato",'<section><p>'+(admin?"Solo amministratore.":"Accesso esclusivamente su invito.")+'</p><form id="form"><label for="secret">'+(admin?"Password amministratore":"Codice di invito personale")+'</label><input id="secret" type="password" autocomplete="'+(admin?"current-password":"off")+'" required><button class="primary">Accedi</button></form><p id="status" role="status"></p></section>',accessClient+'el("form").onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector("button");b.disabled=true;try{await post('+JSON.stringify(endpoint)+',{secret:el("secret").value});location.replace('+JSON.stringify(dest)+')}catch(e){showError(e);b.disabled=false}}');
}
function adminPage(){
 return accessPage("Dado Live TV — Admin",'<section><h2>Nuovo invito</h2><form id="form"><label for="name">Nome utente</label><input id="name" maxlength="60" required><button class="primary">Crea invito</button></form><p id="code"></p><button id="copy" hidden>Copia codice</button><p id="status" role="status"></p></section><section><h2>Utenti autorizzati</h2><div id="users"></div><button id="refresh">Aggiorna elenco</button></section><p><a href="/configure">Configurazione addon</a> · <button id="logout">Esci</button></p>',accessClient+String.raw`
let code="";
async function refresh(){const r=await fetch("/admin/users",{cache:"no-store"});const d=await r.json();if(!r.ok)throw Error(d.error||"Errore");const box=el("users");box.replaceChildren();for(const u of d.users){const a=document.createElement("article"),name=document.createElement("strong"),details=document.createElement("small"),button=document.createElement("button");name.textContent=u.name;details.textContent=(u.active?"Attivo":"Revocato")+" · Ultima attività: "+(u.lastSeen?new Date(u.lastSeen).toLocaleString("it-IT",{timeZone:"Europe/Rome"}):"mai");button.textContent=u.active?"Revoca":"Riattiva";button.onclick=async()=>{if(u.active&&!confirm("Revocare "+u.name+"?"))return;button.disabled=true;try{await post("/admin/state",{id:u.id,active:!u.active});await refresh()}catch(e){showError(e);button.disabled=false}};a.append(name,details,button);box.append(a)}if(!d.users.length)box.textContent="Nessun invito creato."}
el("form").onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector("button");b.disabled=true;try{const d=await post("/admin/invite",{name:el("name").value});code=d.code;el("code").textContent="Conserva questo codice: "+code;el("copy").hidden=false;el("name").value="";await refresh()}catch(e){showError(e)}finally{b.disabled=false}};
el("copy").onclick=async()=>{try{await navigator.clipboard.writeText(code);el("status").textContent="Codice copiato."}catch(e){showError(e)}};
el("refresh").onclick=()=>refresh().catch(showError);
el("logout").onclick=async()=>{try{await post("/admin/logout",{});location.replace("/admin")}catch(e){showError(e)}};
refresh().catch(showError);
`);
}
function accessFail(res){return res.status(503).json({error:"Servizio accessi non disponibile."})}
function accessDenied(res){return res.status(403).json({error:"Accesso privato: richiedi un invito."})}
function accessAsync(fn){return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(()=>{if(!res.headersSent)accessFail(res)})}
function sameOrigin(req){return req.get("Origin")===ACCESS_ORIGIN&&req.is("application/json")}
function loginAllowed(req){
 const key=req.ip||"unknown",now=Date.now(),previous=localLoginAttempts.get(key);
 if(localLoginAttempts.size>2000)for(const [k,v] of localLoginAttempts)if(v.until<=now)localLoginAttempts.delete(k);
 if(localLoginAttempts.size>5000&&!previous)return false;
 const state=previous&&previous.until>now?previous:{count:0,until:now+600000};state.count++;localLoginAttempts.set(key,state);return state.count<=20;
}
// Public entry points and image assets only. All other paths are denied by default.
app.use(accessAsync(async(req,res,next)=>{
  const path=req.path;
  if(path==="/logo.png"||/^\/artwork\/v[1-6]\/[a-f0-9]+\.jpg$/.test(path))return next();
  res.set("Cache-Control","no-store");res.set("Referrer-Policy","no-referrer");
  if(!accessReady())return accessFail(res);
  if(path==="/"&&req.method==="GET")return res.redirect("/configure");
  if(path==="/admin"||path==="/access/login"||path==="/admin/login"||path==="/access")return next();
  if(path.startsWith("/admin/")||path.startsWith("/debug/"))return adminSession(req)?next():accessDenied(res);
  const m=path.match(/^\/c\/([A-Za-z0-9_-]{1,3500})(?:\/|$)/);
  if(m){
    const p=privateEnvelope(m[1]);if(!p)return accessDenied(res);
    const u=await accessUser(p.uid);if(!u?.active)return accessDenied(res);
    req.accessUid=u.id;req.accessConfig=p.config;await accessTouch(u.id);
    if(path==="/c/"+m[1]+"/configure"&&req.method==="GET")setAccessCookie(res,"dado_user",{kind:"user-session",uid:u.id},30*86400);
    return next();
  }
  if(path==="/configure"||path==="/configure/save"){
    const uid=userSession(req),u=uid?await accessUser(uid):null;
    if(!u?.active)return path==="/configure"&&req.method==="GET"?res.type("html").send(loginPage(false)):accessDenied(res);
    req.accessUid=u.id;await accessTouch(u.id);return next();
  }
  return accessDenied(res);
}));
app.get("/admin",(req,res)=>res.type("html").send(adminSession(req)?adminPage():loginPage(true)));
app.get("/access",(req,res)=>res.redirect("/configure"));
app.post("/admin/login",accessAsync(async(req,res)=>{
 if(!sameOrigin(req))return accessDenied(res);if(!loginAllowed(req))return res.status(429).json({error:"Troppi tentativi. Riprova tra 10 minuti."});
 const bucket=Math.floor(Date.now()/600000),rateKey="dado:private:v1:admin-attempts:"+bucket;
 const count=await accessRedis("EVAL","local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],1200) end; return n","1",rateKey);
 if(count>20)return res.status(429).json({error:"Troppi tentativi. Riprova tra 10 minuti."});
 if(typeof req.body?.secret!=="string"||req.body.secret.length>512||!accessEqual(req.body.secret,adminPassword))return res.status(401).json({error:"Password non valida."});
 setAccessCookie(res,"dado_admin",{kind:"admin-session",auth:accessHash(adminPassword)},8*3600);res.json({ok:true});
}));
app.post("/access/login",accessAsync(async(req,res)=>{
 if(!sameOrigin(req))return accessDenied(res);if(!loginAllowed(req))return res.status(429).json({error:"Troppi tentativi. Riprova tra 10 minuti."});
 const code=req.body?.secret;if(typeof code!=="string"||!/^[a-f0-9]{24}\.[A-Za-z0-9_-]{32}$/.test(code))return res.status(401).json({error:"Codice non valido."});
 const u=await accessUser(code.split(".")[0]);if(!u?.active||!accessEqual(u.hash,accessHash(code)))return res.status(401).json({error:"Codice non valido o revocato."});
 setAccessCookie(res,"dado_user",{kind:"user-session",uid:u.id},30*86400);await accessTouch(u.id);res.json({ok:true});
}));
function hashEntries(value){if(Array.isArray(value)){const out={};for(let i=0;i+1<value.length;i+=2)out[value[i]]=value[i+1];return out;}return value&&typeof value==="object"?value:{}}
app.get("/admin/users",accessAsync(async(req,res)=>{
 const registry=hashEntries(await accessRedis("HGETALL",accessKey)),activity=hashEntries(await accessRedis("HGETALL",accessKey+":activity"));
 const users=Object.values(registry).map(raw=>JSON.parse(raw)).map(u=>({id:u.id,name:u.name,active:u.active,lastSeen:Number(activity[u.id])||null}));
 res.json({users});
}));
app.post("/admin/invite",accessAsync(async(req,res)=>{
 if(!sameOrigin(req))return accessDenied(res);const name=typeof req.body?.name==="string"?req.body.name.trim():"";
 if(!name||name.length>60)return res.status(400).json({error:"Nome non valido."});
 const id=crypto.randomBytes(12).toString("hex"),code=id+"."+crypto.randomBytes(24).toString("base64url"),u={id,name,active:true,hash:accessHash(code)};
 await accessRedis("HSET",accessKey,id,JSON.stringify(u));res.json({code});
}));
app.post("/admin/state",accessAsync(async(req,res)=>{
 if(!sameOrigin(req))return accessDenied(res);if(typeof req.body?.active!=="boolean")return res.status(400).json({error:"Stato non valido."});
 const u=await accessUser(req.body.id);if(!u)return res.status(404).json({error:"Utente non trovato."});
 await accessRedis("HSET",accessKey,u.id,JSON.stringify({...u,active:req.body.active}));res.json({ok:true});
}));
app.post("/admin/logout",(req,res)=>{if(!sameOrigin(req))return accessDenied(res);res.clearCookie("dado_admin",{httpOnly:true,secure:true,sameSite:"strict",path:"/"});res.json({ok:true})});

app.get(["/artwork/v1/:id.jpg", "/artwork/v2/:id.jpg", "/artwork/v3/:id.jpg", "/artwork/v4/:id.jpg", "/artwork/v5/:id.jpg", "/artwork/v6/:id.jpg"], async (req, res) => {
  const id = req.params.id;
  const version = req.path.startsWith("/artwork/v6/") ? "v6" : req.path.startsWith("/artwork/v5/") ? "v5" : req.path.startsWith("/artwork/v4/") ? "v4" : req.path.startsWith("/artwork/v3/") ? "v3" : req.path.startsWith("/artwork/v2/") ? "v2" : "v1";
  if (!/^[a-f0-9]{64}$/.test(id)) return res.sendStatus(404);
  try {
    let source = artworkRefs.get(id);
    if (!source) {
      // A cached client may request an image after a Render restart.
      const matches=item=>item.poster && !(item.posterRank===0&&item.posterShape==="poster")&&artworkId(item,version)===id;
      let event=[...catalogCache.events,...Array.from(sportCaches.values()).flatMap(c=>c.events)].find(matches);
      if(!event){
        const football=await getCachedCatalog().catch(()=>[]);
        event=football.find(matches);
      }
      if(!event){
        const groups=await Promise.allSettled(["motors","tennis"].map(getSportCatalog));
        event=groups.flatMap(g=>g.status==="fulfilled"?g.value:[]).find(matches);
      }
      if (event) {
        source = artworkReference(event);
        rememberBounded(artworkRefs, id, source, 1000);
      }
    }
    if (!source) return res.sendStatus(404);
    const buffer = await renderPortrait(id, source, version);
    res.set("Cache-Control", "public, max-age=1800");
    return res.type("jpeg").send(buffer);
  } catch {
    // Never expose upstream URLs or credentials through errors or logs.
    res.set("Cache-Control", "no-store");
    return res.sendStatus(502);
  }
});

function eventToMeta(event) {

  return {

    id:
      `live_test:${encodeEventId(
        event.key
      )}`,

    type:
      "tv",

    name:
      event.name,

    poster: artworkForMeta(event),

    posterShape: "poster",

    description:
      event.description ||
      `${event.sport==="tennis"?"🎾":event.sport==="motors"?"🏎️":"⚽"} ${event.name}`,

    releaseInfo:
      event.releaseInfo ||
      undefined
  };
}


/* =========================================================
   MANIFEST
========================================================= */

const manifest = {

  id:
    "community.stremio.live.football.test",

  version:
    "3.5.0",

  name:
    "Dado Live TV",

  description:
    "Calcio, Motori e Tennis",

  logo:
    "https://dado-live-tv.onrender.com/logo.png",

  resources: [
    "catalog",
    "meta",
    "stream"
  ],

  types: [
    "tv"
  ],

  catalogs: [
    {
      type:
        "tv",

      id:
        "live_football_v5",

      name:
        "🔴 LIVE Football ⚽"
    },
    {type:"tv",id:"live_sport_v1",name:"🔴 LIVE Sport"}
  ],

  behaviorHints: {configurable:true,configurationRequired:false},
  idPrefixes: [
    "live_test:"
  ]
};


/* =========================================================
   MANIFEST
========================================================= */

app.get(
  "/manifest.json",
  (req, res) => {

    res.json(manifest);
  }
);



const DEFAULT_SETTINGS=Object.freeze({
  catalogs:["football","sport"],sources:["sv","es","hf"],languages:[0,1,2,3],proxy:"all"
});
function safeSettings(value,legacy=false) {
  const v=value&&typeof value==="object"?value:{};
  const unique=(items,allowed)=>Array.isArray(items)?[...new Set(items.filter(x=>allowed.includes(x)))]:allowed.slice();
  const catalogs=unique(v.catalogs,DEFAULT_SETTINGS.catalogs);
  let sources=unique(v.sources,DEFAULT_SETTINGS.sources);
  const easyProxyURL=proxyURL(v.easyProxyURL),easyProxyPassword=easyProxyURL&&typeof v.easyProxyPassword==="string"?v.easyProxyPassword.slice(0,256):"";
  if(!legacy&&!easyProxyURL)sources=sources.filter(x=>x!=="es");
  if(!sources.length)sources=["sv","hf"];
  const languages=unique(v.languages,DEFAULT_SETTINGS.languages);
  return {easyProxyURL,easyProxyPassword,catalogs:catalogs.length?catalogs:DEFAULT_SETTINGS.catalogs.slice(),
    sources:sources.length?sources:DEFAULT_SETTINGS.sources.slice(),
    languages:[...languages,...DEFAULT_SETTINGS.languages.filter(x=>!languages.includes(x))],
    proxy:["all","direct","proxy"].includes(v.proxy)?v.proxy:"all"};
}
function requestSettings(req,res) {
  const config=req.dadoConfig;
  if(!config)accessDenied(res);
  return config;
}
app.use("/c/:settings",(req,res,next)=>{
 const config=req.accessConfig?safeSettings(req.accessConfig):null;if(!config)return accessDenied(res);
 const base=config.sources.includes("es")?personalBase(config.easyProxyURL,config.easyProxyPassword):null;
 if(config.sources.includes("es")&&!base)return res.status(503).json({error:"EasySports configuration unavailable"});
 req.dadoConfig=config;res.set("Cache-Control","no-store");scope.run({base,key:base?crypto.createHash("sha256").update(base).digest("hex"):"no-es"},next);
});
function eventAllowed(event,config) {
  const catalog=event.sport==="tennis"||event.sport==="motors"?"sport":"football";
  return config.catalogs.includes(catalog)&&event.providers.some(p=>config.sources.includes(p.source));
}
function configuredManifest(config) {
  return {...manifest,catalogs:manifest.catalogs.filter(c=>config.catalogs.includes(c.id==="live_football_v5"?"football":"sport"))};
}
function configuredStreamList(entries,config) {
  const sourceId=entry=>Object.keys(STREAM_SOURCE_RANK).find(k=>STREAM_SOURCE_RANK[k]===entry.sourceRank);
  const sorted=entries.filter(entry=>config.sources.includes(sourceId(entry))&&
    (config.proxy==="all"||(config.proxy==="proxy")===entry.proxy))
    .sort((a,b)=>config.languages.indexOf(a.rank)-config.languages.indexOf(b.rank)||
      config.sources.indexOf(sourceId(a))-config.sources.indexOf(sourceId(b)));
  const seen=new Set(),unique=[];
  for(const {stream} of sorted){
    const key=stream.url||stream.externalUrl||stream.ytId||JSON.stringify(stream);
    if(!seen.has(key)){seen.add(key);unique.push(stream);}
  }
  return unique;
}
app.get("/c/:settings/manifest.json",(req,res)=>{
  const config=requestSettings(req,res);
  if(config)res.json(configuredManifest(config));
});


function configurePage(config,previousToken="") {
  const publicConfig={...config,easyProxyPassword:""};
  // Only validated ASCII preference values are inserted into the script.
  return '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dado Live TV | Configurazione</title><style>'+
  ':root{color-scheme:dark;font-family:system-ui,sans-serif;background:#11131b;color:#f1f2f6}*{box-sizing:border-box}body{margin:0;padding:22px 16px 40px}main{max-width:560px;margin:auto}header{display:flex;align-items:center;gap:14px;margin-bottom:22px}header img{width:72px;height:72px;border-radius:15px}h1{font-size:25px;margin:0}h2{font-size:17px;margin:0 0 12px}p{line-height:1.5;color:#b5bac9;font-size:14px;margin:8px 0}section{background:#20232e;border:1px solid #343747;padding:17px;border-radius:15px;margin:12px 0}.line{display:flex;align-items:center;gap:10px;min-height:44px;border-bottom:1px solid #383b48}.line:last-child{border:0}.grow{flex:1}.rank{color:#aeb5c7;min-width:20px}input{accent-color:#36c981;width:20px;height:20px}button,select,a.action{font:inherit;border:1px solid #484d60;border-radius:9px;background:#2c303d;color:#fff;padding:8px 12px;cursor:pointer}button:disabled{opacity:.32;cursor:default}.disabled{opacity:.42}.field{width:100%;height:auto;padding:12px;margin:6px 0;background:#2c303d;border:1px solid #484d60;border-radius:9px;color:#fff;font:inherit}a.action{text-decoration:none;display:block;text-align:center}a.primary{background:#29bc75;color:#082519;font-weight:700;border:0;padding:14px}a.action[aria-disabled="true"]{opacity:.4;cursor:default}button.wide{width:100%;padding:12px;margin-top:8px}select{width:100%;padding:12px}a{color:#7eb5ff}.actions{display:grid;gap:9px;margin-top:20px}#status{min-height:22px;color:#a4e8c4;overflow-wrap:anywhere}small{color:#b5bac9}</style></head><body><main><header><img src="/logo.png" alt="Dado Live TV"><div><h1>Dado Live TV</h1><p>Configurazione personale · v3.5.0</p></div></header>'+
  '<section><h2>Cataloghi nella Home</h2><div id="catalogs"></div></section>'+
  '<section><h2>EasyProxy · solo EasySports</h2><p>StremVerse e Highfly restano invariati. Inserisci un URL valido per abilitare EasySports.</p><label for="easyurl">URL EasyProxy</label><input class="field" id="easyurl" type="url" placeholder="http://IP:7860" autocomplete="off"><label for="easypass">Password API (facoltativa)</label><input class="field" id="easypass" type="password" autocomplete="new-password"><p id="proxystate"></p></section>'+
  '<section><h2>Fonti e priorità</h2><p>Attiva le fonti da visualizzare e ordinale a parità di lingua.</p><div id="sources"></div></section>'+
  '<section><h2>Priorità delle lingue</h2><p>La prima lingua viene mostrata per prima nei risultati.</p><div id="languages"></div></section>'+
  '<section><h2>Proxy</h2><select id="proxy" aria-label="Filtro proxy"><option value="all">Tutti i collegamenti</option><option value="direct">Senza indicazione PROXY</option><option value="proxy">Solo PROXY riconosciuti</option></select><p>Il riconoscimento dipende dai metadati. Gli eventi terminati restano esclusi.</p></section>'+
  '<div class="actions"><a class="action primary" id="install" aria-disabled="true">Installa addon su Stremio</a><button class="wide" id="copy" disabled>Copia URL di installazione</button><button class="wide" id="reset">Ripristina impostazioni predefinite</button></div><p id="status" role="status"></p><p>Il collegamento viene preparato automaticamente dopo ogni modifica. Le impostazioni si applicano installando il nuovo URL. Non aggiungere una seconda copia: sostituisci quella precedente se necessario.</p><p><a href="/debug/sports">Diagnostica cataloghi</a> · <a href="/debug/stream-performance">Diagnostica fonti</a></p></main>'+
  '<script>const defaults='+JSON.stringify(DEFAULT_SETTINGS)+';let config='+JSON.stringify(publicConfig).replace(/</g,"\\u003c")+';const previousToken='+JSON.stringify(previousToken)+';'+
  'const labels={football:"⚽ LIVE Football",sport:"🔴 LIVE Sport",sv:"StremVerse",es:"EasySports",hf:"Highfly",0:"🇮🇹 Italiano",1:"🇬🇧 Inglese",2:"🌍 Altre lingue",3:"❔ Lingua sconosciuta"};'+
  'const el=id=>document.getElementById(id);function row(parent,key,active,order,i,kind){const r=document.createElement("div");r.className="line";const locked=kind==="sources"&&key==="es"&&!validURL(config.easyProxyURL);if(locked)r.className+=" disabled";if(kind!=="languages"){const c=document.createElement("input");c.type="checkbox";c.checked=active;c.disabled=locked;c.setAttribute("aria-label",labels[key]);c.onchange=()=>{const list=config[kind];if(c.checked){if(!list.includes(key))list.push(key)}else if(list.length>1)config[kind]=list.filter(x=>x!==key);else el("status").textContent="Mantieni almeno una opzione attiva.";render()};r.append(c)}'+
  'const title=document.createElement("span");title.className="grow";title.textContent=(kind==="languages"||kind==="sources"&&active?String(i+1)+". ":"")+labels[key]+(locked?" (inserisci URL EasyProxy)":"");r.append(title);if(order&&active){for(const d of [-1,1]){const b=document.createElement("button");b.textContent=d===-1?"↑":"↓";b.setAttribute("aria-label",(d===-1?"Sposta su ":"Sposta giù ")+labels[key]);b.disabled=i+d<0||i+d>=order.length;b.onclick=()=>{[order[i],order[i+d]]=[order[i+d],order[i]];render()};r.append(b)}}parent.append(r)}'+
  'function validURL(v){try{const u=new URL(v.trim());return ["http:","https:"].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==="/"}catch{return false}}'+
  "\nlet readyURL=\"\",timer=null,revision=0,controller=null,lastPrepared=\"\",lastURL=\"\";\nfunction snapshot(){return JSON.stringify({...config,easyProxyPassword:el(\"easypass\").value,previousToken})}\nfunction setReady(url,message){readyURL=url;const link=el(\"install\");el(\"copy\").disabled=!url;link.setAttribute(\"aria-disabled\",url?\"false\":\"true\");if(url){link.href=url.replace(/^https:\\/\\//,\"stremio://\")}else{link.removeAttribute(\"href\")}el(\"status\").textContent=message}\nfunction schedule(){const current=++revision;clearTimeout(timer);if(controller){controller.abort();controller=null}setReady(\"\",\"Preparazione del collegamento…\");if(config.easyProxyURL&&!validURL(config.easyProxyURL)){setReady(\"\",\"Completa o cancella l indirizzo EasyProxy.\");return}const payload=snapshot();if(payload===lastPrepared&&lastURL){setReady(lastURL,\"Collegamento pronto.\");return}timer=setTimeout(()=>prepare(current,payload),700)}\nasync function prepare(current,payload){if(current!==revision)return;const local=new AbortController();controller=local;try{const r=await fetch(\"/configure/save\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:payload,signal:local.signal,cache:\"no-store\"});const d=await r.json();if(current!==revision)return;if(!r.ok)throw Error(d.error||\"Errore di configurazione\");if(typeof d.url!==\"string\"||!/^https:\\/\\/dado-live-tv\\.onrender\\.com\\/c\\/[A-Za-z0-9_-]+\\/manifest\\.json$/.test(d.url))throw Error(\"Collegamento non valido\");lastPrepared=payload;lastURL=d.url;setReady(d.url,\"Collegamento pronto.\");}catch(e){if(current!==revision||e.name===\"AbortError\")return;setReady(\"\",\"Impossibile preparare il collegamento: \"+e.message+\". Modifica un impostazione per riprovare.\");}finally{if(controller===local)controller=null}}\nfunction render(){if(!validURL(config.easyProxyURL))config.sources=config.sources.filter(k=>k!==\"es\");if(!config.sources.length)config.sources=[\"sv\",\"hf\"];for(const k of [\"catalogs\",\"sources\",\"languages\"])el(k).replaceChildren();for(const k of defaults.catalogs)row(el(\"catalogs\"),k,config.catalogs.includes(k),null,0,\"catalogs\");config.sources.forEach((k,i)=>row(el(\"sources\"),k,true,config.sources,i,\"sources\"));defaults.sources.filter(k=>!config.sources.includes(k)).forEach(k=>row(el(\"sources\"),k,false,null,0,\"sources\"));config.languages.forEach((k,i)=>row(el(\"languages\"),k,true,config.languages,i,\"languages\"));el(\"proxy\").value=config.proxy;el(\"proxystate\").textContent=validURL(config.easyProxyURL)?\"Ora puoi selezionare EasySports.\":\"EasySports non selezionabile.\";schedule()}\nel(\"easyurl\").value=config.easyProxyURL||\"\";el(\"easyurl\").oninput=()=>{config.easyProxyURL=el(\"easyurl\").value;render()};el(\"easypass\").oninput=schedule;el(\"proxy\").onchange=()=>{config.proxy=el(\"proxy\").value;render()};el(\"reset\").onclick=()=>{config=JSON.parse(JSON.stringify(defaults));config.easyProxyURL=\"\";el(\"easyurl\").value=\"\";el(\"easypass\").value=\"\";render()};\nel(\"install\").onclick=e=>{if(!readyURL)e.preventDefault()};\nel(\"copy\").onclick=async()=>{if(!readyURL)return;const url=readyURL;try{await navigator.clipboard.writeText(url);if(readyURL===url)el(\"status\").textContent=\"URL copiato.\"}catch{if(readyURL===url)el(\"status\").textContent=url}};\nrender();\n"+"</script></body></html>";

}
app.get(["/configure","/c/:settings/configure"],(req,res)=>{
  const config=req.params.settings?requestSettings(req,res):safeSettings();if(!config)return;
  res.set("Cache-Control","no-store");res.set("Referrer-Policy","no-referrer");res.type("html").send(configurePage(config,req.params.settings||""));
});

app.post("/configure/save",async(req,res)=>{
 res.set("Cache-Control","no-store");const v=req.body||{};
 if(typeof v.easyProxyURL==="string"&&v.easyProxyURL.trim()&&!proxyURL(v.easyProxyURL))return res.status(400).json({error:"URL EasyProxy non valido"});
 if(typeof v.easyProxyPassword==="string"&&v.easyProxyPassword.length>256)return res.status(400).json({error:"Password troppo lunga"});
 if(!sameOrigin(req)||!req.accessUid)return accessDenied(res);
 const envelope=privateEnvelope(v.previousToken),prior=envelope?.uid===req.accessUid?envelope.config:null,config=safeSettings(v);
 if(!config.easyProxyPassword&&prior?.easyProxyURL===config.easyProxyURL)config.easyProxyPassword=prior.easyProxyPassword||"";
 if(config.sources.includes("es")){
   const base=personalBase(config.easyProxyURL,config.easyProxyPassword);
   if(!base)return res.status(503).json({error:"Formato EasySports non riconosciuto; configurazione originale conservata"});
   try{const m=await getJsonRaw(base+"/manifest.json",6000);if(!Array.isArray(m.catalogs))throw Error("manifest");}catch{return res.status(502).json({error:"EasySports non ha accettato la configurazione"});}
 }
 try{res.json({url:"https://dado-live-tv.onrender.com/c/"+seal({kind:"addon-v1",uid:req.accessUid,config})+"/manifest.json"});}catch{res.status(503).json({error:"Salvataggio protetto non disponibile"});}
});
app.get("/debug/easyproxy-config",(req,res)=>{const t=proxyTemplate();res.set("Cache-Control","no-store");res.json({legacyConfigured:!!legacyEasySportsBase(),templateRecognized:!!(t||pipeTemplate()),passwordSupported:!!(t?.pw||pipeTemplate()),encryptionReady:!!encryptionKey(),schema:easySportsSchema()});});

/* =========================================================
   LOGO PERSONALIZZATO DADO LIVE TV
========================================================= */
app.get("/logo.png", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.type("png");
  res.sendFile(require("path").join(__dirname, "assets", "dado-live-tv.png"));
});

/* =========================================================
   CATALOGO
========================================================= */

app.get(
  ["/catalog/tv/live_football_v5.json","/c/:settings/catalog/tv/live_football_v5.json"],
  async (req, res) => {

    try {

      const config=requestSettings(req,res);if(!config)return;
      const events = config.catalogs.includes("football")?(await getCachedCatalog()).filter(e=>eventAllowed(e,config)):[];

      res.json({

        metas:
          events.map(
            eventToMeta
          )
      });


    } catch (error) {

      console.error(
        "Catalog error:",
        error
      );


      res.json({
        metas: []
      });
    }
  }
);


/* =========================================================
   TROVA EVENTO
========================================================= */

function combineSportResults(results) {
  const kickoff=event=>pickDisplayTiming(event)?.start??Infinity;
  return results.flatMap(r=>r.status==="fulfilled"?r.value:[])
    .sort((a,b)=>kickoff(a)-kickoff(b)||a.name.localeCompare(b.name,"it"));
}
app.get(["/catalog/tv/live_sport_v1.json","/c/:settings/catalog/tv/live_sport_v1.json"],async(req,res)=>{
  const config=requestSettings(req,res);if(!config)return;
  if(!config.catalogs.includes("sport"))return res.json({metas:[]});
  const results=await Promise.allSettled(["motors","tennis"].map(getSportCatalog));
  res.json({metas:combineSportResults(results).filter(e=>eventAllowed(e,config)).map(eventToMeta)});
});
app.get("/debug/sports",async(req,res)=>{
  res.set("Cache-Control","no-store");
  const sports=["football","motors","tennis"];
  const results=await Promise.allSettled(sports.map(getSportCatalog));
  res.json(Object.fromEntries(sports.map((sport,i)=>[sport,results[i].status==="fulfilled"?{
    count:results[i].value.length,events:results[i].value.map(e=>({name:e.name,sources:e.providers.map(p=>p.source)}))
  }:{error:"Catalog unavailable"}])));
});

async function findEvent(id) {

  if (
    !id ||
    !id.startsWith("live_test:")
  ) {

    return null;
  }


  const key =
    decodeEventId(
      id.substring(10)
    );


  if (!key) {
    return null;
  }


  const sport=key.startsWith("tennis:")?"tennis":key.startsWith("motors:")?"motors":"football";
  const events=await getSportCatalog(sport);


  return (
    events.find(
      event =>
        event.key === key
    ) ||
    null
  );
}


/* =========================================================
   META
========================================================= */

app.get(
  ["/meta/tv/:id.json","/c/:settings/meta/tv/:id.json"],
  async (req, res) => {

    try {

      const config=requestSettings(req,res);if(!config)return;
      const event = await findEvent(req.params.id);

      if (!event || !eventAllowed(event,config)) {

        return res
          .status(404)
          .json({
            error:
              "Event not found"
          });
      }


      res.json({

        meta:
          eventToMeta(event)
      });


    } catch (error) {

      console.error(
        "Meta error:",
        error
      );


      res.status(500).json({
        error:
          "Meta error"
      });
    }
  }
);


/* =========================================================
   STREAM DAL PROVIDER ORIGINALE
========================================================= */

// Language ranking uses provider metadata or recognizable channel labels,
// never a media probe. An inferred language is not a guarantee of audio.
const STREAM_SOURCE_RANK={sv:0,es:1,hf:2};
function streamText(v){
  return typeof v==="string"?v.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase():"";
}
function streamLangTokens(v){
  if(Array.isArray(v))return v.flatMap(streamLangTokens);
  if(v&&typeof v==="object")return [v.code,v.language,v.name].flatMap(streamLangTokens);
  return streamText(v).split(/[,;|/+\s]+/).map(x=>x.split("-")[0]).filter(Boolean);
}
const STREAM_IT=new Set(["it","ita","italian","italiano","italiana","italien"]);
const STREAM_EN=new Set(["en","eng","english","inglese","anglais"]);
const STREAM_OTHER=new Set("es spa spanish espanol spagnolo fr fra fre french francais francese de deu ger german deutsch tedesco pt por portuguese portugues portoghese ar ara arabic arabo ru rus russian tr tur turkish nl nld dut dutch pl pol polish el ell gre greek zh zho chi chinese ja jpn japanese ko kor korean hi hin hindi ro ron rum romanian sv swe swedish da dan danish no nor norwegian cs ces cze czech sk slk slovak hu hun hungarian hr hrv croatian sr srp serbian bg bul bulgarian".split(" "));
// A fixture title/description can contain team flags and must never identify
// the language of a channel. Prefer fields explicitly describing that channel.
function streamChannelFields(stream) {
  const values=[stream.channelName,stream.channel,stream.name,stream.title];
  return values.map(v=>typeof v==="string"?v:typeof v?.name==="string"?v.name:"")
    .map(v=>v.trim()).filter(v=>v && !/\b(?:vs\.?|versus)\s|⚽|🏆/iu.test(v));
}
function countryFlagRank(value) {
  const flags=[...new Set(String(value||"").match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)||[])];
  if(flags.length!==1)return null;
  const flag=flags[0];
  if(flag==="🇮🇹")return {rank:0,label:"🇮🇹"};
  if(flag==="🇬🇧"||flag==="🇺🇸")return {rank:1,label:flag};
  return {rank:2,label:flag};
}
function cleanChannelName(value) {
  return String(value||"").replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu,"")
    .replace(/[\u{E0000}-\u{E007F}\uFE0F\u200D]/gu,"")
    .replace(/\[?\b(?:proxy|mediaflow|easyproxy|mfp)\b\]?/gi," ")
    .replace(/^[\s•|:–-]+|[\s•|:–-]+$/g,"").replace(/\s+/g," ").trim();
}
function displayChannel(stream) {
  const values=streamChannelFields(stream);
  return values.map(cleanChannelName).find(v=>v && !/^(?:stream|direct|link|easysports|highfly|stremverse|it|ita|en|eng)$/i.test(v))||"Canale non indicato";
}
function classifyStreamLanguage(stream){
  const explicit=[stream.audioLanguage,stream.audioLanguages,stream.language,stream.languages,
    stream.behaviorHints?.audioLanguage,stream.behaviorHints?.audioLanguages,stream.behaviorHints?.language,stream.behaviorHints?.languages].flatMap(streamLangTokens);
  if(explicit.some(x=>STREAM_IT.has(x)))return {rank:0,label:"🇮🇹"};
  if(explicit.some(x=>STREAM_EN.has(x)))return {rank:1,label:"🇬🇧"};
  if(explicit.some(x=>STREAM_OTHER.has(x)))return {rank:2,label:""};
  const fields=streamChannelFields(stream);
  // The first unambiguous channel flag wins, even if the match title
  // contains a different country. Never scan description for language.
  for(const field of fields){
    const flag=countryFlagRank(field);
    if(flag)return flag;
  }
  const original=[...fields,typeof stream.country==="string"?stream.country:""].join(" ");
  const t=streamText(original);
  if(/🇮🇹/.test(original)||/\b(?:italiano|italiana|italian|italia|italy)\b|\b(?:dazn|sky|rai|mediaset|prime video|sportitalia)\s*(?:sport\s*)?(?:it|ita)\b|(?:^|[\s[(|])(?:it|ita)(?=$|[\s\])|])|\b(?:rai\s*(?:1|2|3|sport)|sportitalia|canale\s*5|italia\s*1|sky\s*sport\s*(?:calcio|uno|arena|24)|sky\s*sport\s*25[1-9]|dazn\s*(?:1|2)\s*it)\b/.test(t))return {rank:0,label:"🇮🇹 IT"};
  if(/🇬🇧|🇺🇸/.test(original)||/\b(?:english|inglese|uk|usa|united kingdom|united states)\b|(?:^|[\s[(|])(?:en|eng)(?=$|[\s\])|])|\b(?:tnt sports|sky sports|bbc sport|premier sports|fox soccer plus|nbc sports)\b/.test(t))return {rank:1,label:"🇬🇧 EN"};
  if(/[\u{1F1E6}-\u{1F1FF}]{2}/u.test(original)||/\b(?:french|france|francais|francese|german|deutsch|germany|tedesco|spanish|espana|spain|espanol|spagnolo|portuguese|portugal|brasil|brazil|arabic|arabo|turkish|turco|turkey|poland|polish|romania|romanian|serbia|croatia|greece|malaysia|argentina|mexico|denmark|bulgaria|cyprus|israel|netherlands|hungary|slovakia|czech|switzerland)\b/.test(t))return {rank:2,label:""};
  return {rank:3,label:""};
}
function isProxyStream(stream){
  if(stream.proxy===true||stream.isProxy===true||stream.behaviorHints?.proxy===true||stream.behaviorHints?.isProxy===true)return true;
  const text=streamText([stream.name,stream.title,stream.description].filter(v=>typeof v==="string").join(" "));
  if(!/\b(?:no proxy|without proxy|senza proxy|non proxy|proxy free)\b/.test(text)&&/\b(?:proxy|mediaflow|easyproxy|mfp)\b/.test(text))return true;
  for(const value of [stream.url,stream.externalUrl]){
    if(typeof value!=="string")continue;
    // Inspect only the authority and path. No network requests or URL changes.
    const m=value.match(/^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);
    if(!m)continue;
    const authority=m[1].toLowerCase(),path=m[2],query=m[3]||"";
    if(/(?:^|[.-])(?:mediaflow|easyproxy|proxy)(?:[.:-]|$)/i.test(authority)||
       /(?:^|\/)(?:proxy|mediaflow|easyproxy)(?:\/|$)/i.test(path)||
       (/\/(?:hls|stream)\/manifest\.m3u8$/i.test(path)&&/(?:^|&)(?:d|api_password)=/.test(query))||
       /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+):7860$/i.test(authority))return true;
  }
  return false;
}
function labelStream(stream,source){
  const lang=classifyStreamLanguage(stream);
  const names={sv:"StremVerse",es:"EasySports",hf:"Highfly"};
  const channel=displayChannel(stream);
  const proxy=isProxyStream(stream);
  const label=lang.label.replace(/\s+(?:IT|EN)$/,"");
  const channelLabel=label==="🇮🇹"?channel.replace(/\s+(?:IT|ITA|ITALIA)$/i,""):label==="🇬🇧"?channel.replace(/\s+(?:UK|EN|ENG)$/i,""):channel;
  const name=[names[source]||source,proxy?"[PROXY]":"",label,channelLabel].filter(Boolean).join(" ");
  return {stream:{...stream,name},rank:lang.rank,sourceRank:STREAM_SOURCE_RANK[source]??99,proxy};
}
function sortStreamEntries(entries){
  return entries.slice().sort((a,b)=>a.rank-b.rank||a.sourceRank-b.sourceRank);
}

async function getStreams(provider) {
  let url;

  if (provider.source === "sv") {
    url = `${STREMVERSE}/stream/${encodeURIComponent(provider.type||"tv")}/${encodeURIComponent(provider.id)}.json`;
  } else if (provider.source === "hf") {
    url = `${HIGHFLY}/stream/${encodeURIComponent(provider.type||"sport")}/${encodeURIComponent(provider.id)}.json`;
  } else if (provider.source === "es") {
    const base = easySportsBase();
    if (!base || !provider.type) return [];
    url = `${base}/stream/${encodeURIComponent(provider.type)}/${encodeURIComponent(provider.id)}.json`;
  } else {
    return [];
  }

  const data = provider.source === "es" ? await getJsonRaw(url, 6000) : await getJson(url);
  return (data.streams || []).map(stream => labelStream(stream,provider.source));
}


/* =========================================================
   STREAM RESPONSE CACHE & SOURCE TIMING
========================================================= */

// A short cache avoids repeated link resolution during a playback retry.
// Do not cache signed live URLs for minutes: they can expire quickly.
const STREAM_CACHE_MS = 15 * 1000;
const STREAM_CACHE_MAX_ENTRIES = 80;
const streamCache = new Map();
const streamInFlight = new Map();
const streamTimings = {
  sv: { requests: 0, failures: 0, empty: 0, totalMs: 0, lastMs: 0 },
  hf: { requests: 0, failures: 0, empty: 0, totalMs: 0, lastMs: 0 },
  es: { requests: 0, failures: 0, empty: 0, totalMs: 0, lastMs: 0 }
};

function readCachedStreams(id) {
  const cached = streamCache.get(id);
  if (!cached) return null;
  if (cached.expires > Date.now()) return cached.streams;
  streamCache.delete(id);
  return null;
}

function recordStreamTiming(source, milliseconds, successful, count) {
  const timing = streamTimings[source];
  if (!timing) return;
  timing.requests += 1;
  timing.totalMs += milliseconds;
  timing.lastMs = milliseconds;
  if (!successful) timing.failures += 1;
  else if (count === 0) timing.empty += 1;
}

async function collectStreams(event) {
  // Keep all providers and their original Stremio stream objects intact.
  const results = await Promise.allSettled(
    event.providers.map(async provider => {
      const started = Date.now();
      try {
        const streams = await getStreams(provider);
        recordStreamTiming(provider.source, Date.now() - started, true, streams.length);
        return streams;
      } catch (error) {
        recordStreamTiming(provider.source, Date.now() - started, false, 0);
        throw error;
      }
    })
  );

  // Cache raw ranked entries, so changing the order never loses duplicate alternatives.
  return results.flatMap(result=>result.status==="fulfilled"?result.value:[]);
}

async function getCachedStreams(id, event) {
  const cached = readCachedStreams(id);
  if (cached) return cached;
  if (streamInFlight.has(id)) return streamInFlight.get(id);

  const loading = collectStreams(event)
    .then(streams => {
      // Do not cache an empty list: an unavailable provider may recover.
      if (streams.length) {
        for (const [key, value] of streamCache) {
          if (value.expires <= Date.now()) streamCache.delete(key);
        }
        while (streamCache.size >= STREAM_CACHE_MAX_ENTRIES) {
          streamCache.delete(streamCache.keys().next().value);
        }
        streamCache.set(id, { expires: Date.now() + STREAM_CACHE_MS, streams });
      }
      return streams;
    })
    .finally(() => streamInFlight.delete(id));

  streamInFlight.set(id, loading);
  return loading;
}


/* =========================================================
   STREAM ROUTE
========================================================= */

app.get(["/stream/tv/:id.json","/c/:settings/stream/tv/:id.json"], async (req, res) => {
  try {
    // Fast path avoids even a catalog refresh for an immediate retry.
    const config=requestSettings(req,res);if(!config)return;
    const cacheId=profileKey()+":"+req.params.id;
    const cached=readCachedStreams(cacheId);
    if(cached&&!req.params.settings)return res.json({streams:configuredStreamList(cached,config)});
    const event=await findEvent(req.params.id);
    if(!event||!eventAllowed(event,config))return res.json({streams:[]});
    const entries=cached||await getCachedStreams(cacheId,event);
    res.json({streams:configuredStreamList(entries,config)});
  } catch (error) {
    console.error("Stream error:", error);
    res.json({ streams: [] });
  }
});

// Measured time to obtain stream lists, NOT media buffering/playback times.
app.get("/debug/stream-performance", (req, res) => {
  const sources = {};
  for (const [name, stats] of Object.entries(streamTimings)) {
    sources[name] = {
      requests: stats.requests,
      failures: stats.failures,
      empty: stats.empty,
      averageResponseMs: stats.requests
        ? Math.round(stats.totalMs / stats.requests) : null,
      lastResponseMs: stats.requests ? stats.lastMs : null
    };
  }
  res.json({
    version: "3.1.0",
    note: "Metrics measure stream-link fetching, not playback start or buffering.",
    streamCacheSeconds: STREAM_CACHE_MS / 1000,
    cachedEvents: streamCache.size,
    easySportsConfigured: !!easySportsBase(),
    sources
  });
});


/* =========================================================
   DEBUG
========================================================= */

app.get(
  "/debug/catalog",
  async (req, res) => {

    try {

      const all =
        await getProviderEvents();

      const events =
        await getCachedCatalog();


      res.json({

        version:
          "PROVIDERS 3.0.0",

        raw:
          all.length,

        filtered:
          events.length,

        events:
  events.map(
    event => ({

      name:
        event.name,

      key:
        event.key,

      providers:
        event.providers
    })
  )
      });


    } catch (error) {

      res.status(500).json({
        error:
          String(error)
      });
    }
  }
);

// Inspect date interpretation without exposing upstream URLs or access tokens.
app.get("/debug/time-filter", async (req, res) => {
  res.set("Cache-Control","no-store");
  try {
    const now=Date.now(), all=await getProviderEvents();
    const events=all.filter(event=>event.name && wantedEvent(event.name)).map(event=>({
      name:event.name,source:event.source,
      start:event.timing.start===null?null:new Date(event.timing.start).toISOString(),
      precise:event.timing.precise,field:event.timing.field,
      decision:timeDecision(event.timing,now),visible:timeVisible(event.timing,now)
    }));
    res.json({now:new Date(now).toISOString(),timezone:MATCH_ZONE,events});
  }catch{res.status(502).json({error:"Provider catalogs unavailable"});}
});

/* =========================================================
   DEBUG FILTRO
========================================================= */

app.get(
  "/debug/filter",
  async (req, res) => {
    // Prevent a browser or intermediary from reusing an older diagnostic.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    try {
      const all = await getProviderEvents();
      const passed = all.filter(wantedProviderEvent);
      const excluded = all.filter(e => !wantedProviderEvent(e));

      res.json({
        versioneFiltro: "reserve-aware-20261019-v3",
        generatoAlle: new Date().toISOString(),
        autoTest: {
          "Inter vs Ajax II": wantedEvent("Inter vs Ajax II"),
          "Beitar Jerusalem vs Maccabi Tel Aviv": wantedEvent("Beitar Jerusalem vs Maccabi Tel Aviv"),
          "Ajax II vs De Graafschap": wantedEvent("Ajax II vs De Graafschap"),
          "PSV II vs Dordrecht": wantedEvent("PSV II vs Dordrecht"),
          "Juventus II vs Renate": wantedEvent("Juventus II vs Renate"),
          "Liga Portugal Betclic": wantedEvent("Liga Portugal Betclic")
        },
        totale: all.length,
        passati: passed.map(e => e.name),
        scartati: excluded.map(e => e.name),
        // Include original source and metadata only for the puzzling examples.
        eventiDaControllare: all
          .filter(e => /\b(bayern|ajax|psv|juventus|beitar|liga portugal)\b/i.test(e.name))
          .map(e => ({
            fonte: e.source,
            nome: e.name,
            ammessa: wantedProviderEvent(e),
            descrizione: String(e.description || "").slice(0, 220)
          })),
        riconosciutiComeIndesiderati: all
          .filter(e => unwanted(e.name))
          .map(e => e.name)
      });
    } catch (error) {
      res.status(500).json({error: String(error)});
    }
  }
);







/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.send(
      "Stremio LIVE Football - StremVerse + Highfly + optional EasySports"
    );
  }
);


/* =========================================================
   START
========================================================= */

app.get("/debug/catalog-performance",(req,res)=>{
  res.set("Cache-Control","no-store");
  res.json({...catalogPerformance,cache:{events:catalogCache.events.length,validUntil:catalogCache.expires?new Date(catalogCache.expires).toISOString():null,refreshing:!!catalogRefreshPromise,providerEntries:providerCatalogCache.size,artworkEntries:artworkCache.size,artworkActive,artworkQueued:artworkQueue.length}});
});

app.listen(
  PORT,
  () => {

    console.log(
      `LIVE Football 3.0.0 running on port ${PORT}`
    );
    console.log("EasySports schema diagnostic:",JSON.stringify(easySportsSchema()));
    (async()=>{try{
      const t=pipeTemplate();
      if(!t){console.log("EasySports compatibility check: template not recognized");return;}
      const rebuilt=buildPipeBase(t.fields[0],t.fields[1],t);
      if(!rebuilt){console.log("EasySports compatibility check: reconstruction failed");return;}
      const m=await getJsonRaw(rebuilt+"/manifest.json",6000);
      console.log("EasySports compatibility check:",JSON.stringify({manifestValid:Array.isArray(m.catalogs),catalogCount:Array.isArray(m.catalogs)?m.catalogs.length:0}));
    }catch{console.log("EasySports compatibility check: upstream request failed");}})();
    // Prepare the catalog as soon as the process starts, without blocking listen.
    getCachedCatalog().catch(()=>console.warn("Initial catalog refresh unavailable"));
  }
);
