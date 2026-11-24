const express = require("express");
const sharp = require("sharp");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { Resolver } = require("dns").promises;
const { isIP } = require("net");

sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });

const app = express();
app.use(express.json());

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
let easySportsCatalogCache = { expires: 0, staleUntil: 0, catalogs: [] };
let easySportsManifestInFlight = null;

function easySportsBase() {
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
      throw new Error(`${response.status} ${url}`);
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
    return selected;
  } catch {
    // Never log the configured manifest URL or its credentials.
    console.warn("EasySports manifest unavailable");
    const previous=easySportsCatalogCache.staleUntil>Date.now()?easySportsCatalogCache.catalogs:[];
    easySportsCatalogCache={...easySportsCatalogCache,expires:Date.now()+30*1000,catalogs:previous};
    return previous;
  }
}

function getEasySportsCatalogs() {
  if (easySportsManifestInFlight) return easySportsManifestInFlight;
  easySportsManifestInFlight=discoverEasySportsCatalogs().finally(()=>{easySportsManifestInFlight=null;});
  return easySportsManifestInFlight;
}

// Prefer real StremVerse posters, then Highfly and EasySports artwork.
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
  const priority = { sv: 0, hf: 1, es: 2 }[source] ?? 3;
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
  if(source==="es" && typeof meta.id==="string" && meta.id.startsWith("soccer:")){
    try{decodedStart=JSON.parse(Buffer.from(meta.id.slice(7),"base64url").toString("utf8")).s;}catch{}
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
      if(now>=t.start+MAX_MATCH_MS)return "expired";
      return t.start>now?"upcoming":"current";
    }
    return dayKey(t.start)<dayKey(now)?"past-day":dayKey(t.start)>dayKey(now)?"upcoming":"today";
  }
  return t.live?"live-undated":"unknown";
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

async function getProviderEvents() {

  const started=Date.now();
  // EasySports catalog requests begin as soon as discovery finishes, not after
  // StremVerse and Highfly have returned. Keep deterministic source order.
  const {catalogs,results}=await collectCatalogResponses(PROVIDER_CATALOGS,getEasySportsCatalogs,providerCatalog);
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
  if (source === "es" && !easySportsFootballMeta(meta, catalogs[index])) {
    continue;
  }


  const providerKey =
    `${source}:${meta.id}`;


  const alreadyExists=eventIndex.get(providerKey);


  if (alreadyExists) {
    preferArtwork(alreadyExists, pickArtwork(meta, source));
    if (!alreadyExists.competition) alreadyExists.competition = competitionLabel(meta);
    const timing = matchTiming(meta, source);
    if (timing.finished || (!alreadyExists.timing.finished && (alreadyExists.timing.start === null || (!alreadyExists.timing.precise && timing.precise)))) alreadyExists.timing = timing;
    continue;
  }


  const event={

    source,

    providerId:
      String(meta.id),

    ...(source === "es" ? { providerType: meta.type || catalogs[index].type } : {}),

    name: meta.name || meta.title || "",
    competition: competitionLabel(meta),
    timing: matchTiming(meta, source),

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
  return !!event?.name && wantedEvent(event.name) && timeVisible(event.timing);
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


async function getCatalogEvents() {

  const all =
    await getProviderEvents();


  const filtered =
    all.filter(wantedProviderEvent);


  /*
    Raggruppiamo lo stesso evento proveniente
    dai due provider in una sola card.
  */

  const map = new Map();


  for (const event of filtered) {

    const key =
      eventKey(event.name);


    if (!key) {
      continue;
    }


    if (!map.has(key)) {

      map.set(key, {

        key,

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

function currentCatalog(events) {
  const now = Date.now();
  return events.filter(event => event.timings.some(timing => timeVisible(timing, now)));
}

async function getCachedCatalog() {
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
    timing: pickDisplayTiming(event) };
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
  const competition = posterLines(cleanPosterText(source.competition) || "CALCIO", hasLogo ? 20 : 24, 2);
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

app.get(["/artwork/v1/:id.jpg", "/artwork/v2/:id.jpg", "/artwork/v3/:id.jpg", "/artwork/v4/:id.jpg", "/artwork/v5/:id.jpg", "/artwork/v6/:id.jpg"], async (req, res) => {
  const id = req.params.id;
  const version = req.path.startsWith("/artwork/v6/") ? "v6" : req.path.startsWith("/artwork/v5/") ? "v5" : req.path.startsWith("/artwork/v4/") ? "v4" : req.path.startsWith("/artwork/v3/") ? "v3" : req.path.startsWith("/artwork/v2/") ? "v2" : "v1";
  if (!/^[a-f0-9]{64}$/.test(id)) return res.sendStatus(404);
  try {
    let source = artworkRefs.get(id);
    if (!source) {
      // A cached client may request an image after a Render restart.
      const events = await getCachedCatalog();
      const event = events.find(item => item.poster &&
        !(item.posterRank === 0 && item.posterShape === "poster") && artworkId(item, version) === id);
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
      `⚽ ${event.name}`,

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
    "3.1.0",

  name:
    "Dado Live TV",

  description:
    "Top Club Europei & Nazionali",

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
    }
  ],

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
  "/catalog/tv/live_football_v5.json",
  async (req, res) => {

    try {

      const events =
        await getCachedCatalog();


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


  const events =
    await getCachedCatalog();


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
  "/meta/tv/:id.json",
  async (req, res) => {

    try {

      const event =
        await findEvent(
          req.params.id
        );


      if (!event) {

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

async function getStreams(provider) {
  let url;

  if (provider.source === "sv") {
    url = `${STREMVERSE}/stream/tv/${encodeURIComponent(provider.id)}.json`;
  } else if (provider.source === "hf") {
    url = `${HIGHFLY}/stream/sport/${encodeURIComponent(provider.id)}.json`;
  } else if (provider.source === "es") {
    const base = easySportsBase();
    if (!base || !provider.type) return [];
    url = `${base}/stream/${encodeURIComponent(provider.type)}/${encodeURIComponent(provider.id)}.json`;
  } else {
    return [];
  }

  const data = provider.source === "es" ? await getJsonRaw(url, 6000) : await getJson(url);
  const names = { sv: "StremVerse", hf: "Highfly", es: "EasySports" };

  return (data.streams || []).map(stream => ({
    ...stream,
    name: names[provider.source] + " • " + (stream.name || "Stream")
  }));
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

  const streams = results.flatMap(result =>
    result.status === "fulfilled" ? result.value : []
  );

  // Deduplicate without changing source order, headers or playback hints.
  const unique = [];
  const seen = new Set();
  for (const stream of streams) {
    const key = stream.url || stream.externalUrl || stream.ytId || JSON.stringify(stream);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(stream);
  }
  return unique;
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

app.get("/stream/tv/:id.json", async (req, res) => {
  try {
    // Fast path avoids even a catalog refresh for an immediate retry.
    const cached = readCachedStreams(req.params.id);
    if (cached) return res.json({ streams: cached });

    const event = await findEvent(req.params.id);
    if (!event) return res.json({ streams: [] });

    const streams = await getCachedStreams(req.params.id, event);
    res.json({ streams });
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
    // Prepare the catalog as soon as the process starts, without blocking listen.
    getCachedCatalog().catch(()=>console.warn("Initial catalog refresh unavailable"));
  }
);
