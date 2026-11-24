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
let easySportsCatalogCache = { expires: 0, catalogs: [] };

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
async function getEasySportsCatalogs() {
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
      expires: Date.now() + 5 * 60 * 1000,
      catalogs: selected
    };
    return selected;
  } catch {
    // Never log the configured manifest URL or its credentials.
    console.warn("EasySports manifest unavailable");
    return [];
  }
}

// Prefer real StremVerse posters, then Highfly and EasySports artwork.
// Preserve the selected image's own shape when merging matching events.
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

async function getProviderEvents() {

  // Start the existing providers immediately, even while discovering EasySports.
  const existingResults = Promise.allSettled(
    PROVIDER_CATALOGS.map(item => getJson(item.url))
  );
  const easyCatalogs = await getEasySportsCatalogs();
  const catalogs = [...PROVIDER_CATALOGS, ...easyCatalogs];
  const results = [
    ...await existingResults,
    ...await Promise.allSettled(easyCatalogs.map(item => getJsonRaw(item.url, 6000)))
  ];


  // An outage in every provider must not replace an existing catalog with an empty one.
  if (!results.some(result => result.status === "fulfilled")) {
    throw new Error("All provider catalogs unavailable");
  }


  const events = [];


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


  const alreadyExists =
    events.find(
      e =>
        `${e.source}:${e.providerId}` === providerKey
    );


  if (alreadyExists) {
    preferArtwork(alreadyExists, pickArtwork(meta, source));
    continue;
  }


  events.push({

    source,

    providerId:
      String(meta.id),

    ...(source === "es" ? { providerType: meta.type || catalogs[index].type } : {}),

    name: meta.name || meta.title || "",

    ...pickArtwork(meta, source),

    description:
      meta.description ||
      "",

    releaseInfo:
      meta.releaseInfo ||
      ""
  });
}
    }
  );


  return events;
}


/* =========================================================
   FILTRO + DEDUPLICAZIONE
========================================================= */

function wantedProviderEvent(event) {
  return !!event?.name && wantedEvent(event.name);
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

async function getCachedCatalog() {
  const now = Date.now();

  if (catalogCache.initialized && catalogCache.expires > now) {
    return catalogCache.events;
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
    return catalogCache.events;
  }

  return catalogRefreshPromise;
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

function artworkId(event) {
  return crypto.createHash("sha256").update(event.key + "\n" + event.poster)
    .digest("hex");
}

function artworkForMeta(event) {
  if (!event.poster) return undefined;
  // Preserve original StremVerse portrait artwork; adapt all fallback artwork.
  if (event.posterRank === 0 && event.posterShape === "poster") return event.poster;
  const id = artworkId(event);
  rememberBounded(artworkRefs, id, event.poster, 1000);
  return ARTWORK_ORIGIN + "/artwork/v1/" + id + ".jpg";
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
  while (artworkActive < 3 && artworkQueue.length) {
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

async function renderPortrait(id, source) {
  const cached = artworkCache.get(id);
  if (cached && cached.expires > Date.now()) {
    rememberBounded(artworkCache, id, cached, 96);
    return cached.buffer;
  }
  if (artworkInFlight.has(id)) return artworkInFlight.get(id);
  const work = scheduleArtwork(async () => {
    const input = await downloadArtwork(source);
    const buffer = await sharp(input, { limitInputPixels: 16000000 })
      .rotate()
      .resize(480, 720, {
        fit: "contain",
        position: "centre",
        background: { r: 22, g: 25, b: 32, alpha: 1 }
      })
      .flatten({ background: "#161920" })
      .jpeg({ quality: 86 })
      .toBuffer();
    rememberBounded(artworkCache, id, { buffer, expires: Date.now() + 30 * 60 * 1000 }, 96);
    return buffer;
  }).finally(() => artworkInFlight.delete(id));
  artworkInFlight.set(id, work);
  return work;
}

app.get("/artwork/v1/:id.jpg", async (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{64}$/.test(id)) return res.sendStatus(404);
  try {
    let source = artworkRefs.get(id);
    if (!source) {
      // A cached client may request an image after a Render restart.
      const events = await getCachedCatalog();
      const event = events.find(item => item.poster &&
        !(item.posterRank === 0 && item.posterShape === "poster") && artworkId(item) === id);
      if (event) {
        artworkForMeta(event);
        source = event.poster;
      }
    }
    if (!source) return res.sendStatus(404);
    const buffer = await renderPortrait(id, source);
    res.set("Cache-Control", "public, max-age=600");
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

app.listen(
  PORT,
  () => {

    console.log(
      `LIVE Football 3.0.0 running on port ${PORT}`
    );
  }
);
