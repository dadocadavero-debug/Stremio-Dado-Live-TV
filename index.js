const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const STREMVERSE =
"https://stremverse1.alwaysdata.net/1q1YqqVKyUgp3DFGqBQA";

const HIGHFLY =
  "https://sports.highfly.to/eyJpbmNsdWRlU3BvcnRzIjpbImZvb3RiYWxsIl19";

const HIGHFLY_BACKUPS = [
  "https://sportsfree.highfly.to/eyJpbmNsdWRlU3BvcnRzIjpbImZvb3RiYWxsIl19",
  "https://sportsfree-us2.highfly.to/eyJpbmNsdWRlU3BvcnRzIjpbImZvb3RiYWxsIl19"
];

let preferredHighflyBase = HIGHFLY;

// Shared, non-personal Flix-Streams Free soccer configuration.
// No user install ID, subscriber access or film catalog is included.
const FLIX_FREE =
  "https://free.flixnest.app/eJyNULtuwzAM_BfOERo4RQbv3bsXAaHIdC1UD4OkHKBF_71ynNZJm6GTIN7xjncfgCRCSb0NGPxESFP9CdoQ8gm7IMpko2AiPWV-g1a50AawZyIUN1C00EKzbfbbfdOYZdv0PiixGbPMz7SDDaxSziq9ZvYk0L6scyNjZjXV2Eh2ru5dxOaz4HCjMNiUKOBiM8vcwD65UDpC25Wg0PY2SD2Zkj0GWiN9R7nM79bwH85VSZ1ncvqzdIeN55Dn4EvIOdgVrD4S9pmj1bnWxwH-wO85UcWeCueRHp4te6mkkSn6EhcrnTDuCkou7H61DIfPL1fJvE8";


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

  return (
    /\b(women|woman|female|femminile|femminili|femenino|feminino|ladies)\b/.test(n) ||

    /\b(u\s?-?\s?(15|16|17|18|19|20|21|22|23)|under\s?(15|16|17|18|19|20|21|22|23))\b/.test(n) ||

    /\b(youth|giovanili|primavera|reserve|reserves|academy)\b/.test(n) ||

    /\b(b team|team b)\b/.test(n)
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



function wantedEvent(name = "") {

  if (unwanted(name)) {
    return false;
  }


  const n =
    normalize(name);


  // nome normale

  if (
    wantedTeams.some(
      team =>
        n.includes(
          normalize(team)
        )
    )
  ) {
    return true;
  }


  // alias

  for (
    const key of Object.keys(aliases)
  ) {

    for (
      const alias of aliases[key]
    ) {

      if (
        n.includes(
          normalize(alias)
        )
      ) {
        return true;
      }
    }
  }


  return false;
}


/* =========================================================
   FETCH JSON
========================================================= */

async function getJsonRaw(url, timeoutMs = 12000) {
  const controller = new AbortController();
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
  }
}

// Prefer the primary Highfly domain; keep the original football configuration.
async function getJson(url) {
  if (!url.startsWith(`${HIGHFLY}/`)) {
    return getJsonRaw(url);
  }

  const suffix = url.slice(HIGHFLY.length);
  const bases = [
    ...new Set([preferredHighflyBase, HIGHFLY, ...HIGHFLY_BACKUPS])
  ];
  let lastError;

  for (const base of bases) {
    try {
      const json = await getJsonRaw(
        `${base}${suffix}`,
        base === HIGHFLY ? 8000 : 5000
      );
      if (preferredHighflyBase !== base) {
        console.log("Highfly source switched to", base.split("/")[2]);
        preferredHighflyBase = base;
      }
      return json;
    } catch (error) {
      lastError = error;
      console.warn("Highfly source unreachable:", base.split("/")[2], String(error));
    }
  }

  throw lastError || new Error("All Highfly servers unavailable");
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
  },

  {
    source: "flix",
    url:
      `${FLIX_FREE}/catalog/tv/` +
      `dlstreams-sport-all-soccer-events-live.json`
  }
];


/* =========================================================
   RECUPERO EVENTI
========================================================= */

async function getProviderEvents() {

  const results =
    await Promise.allSettled(
      PROVIDER_CATALOGS.map(
        item =>
          item.source === "flix"
            ? getJsonRaw(item.url, 7500)
            : getJson(item.url)
      )
    );


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
          PROVIDER_CATALOGS[index].url
        );

        return;
      }


      const source =
        PROVIDER_CATALOGS[index].source;


      for (
  const meta of
  result.value.metas || []
) {

  if (!meta?.id) {
    continue;
  }


  const providerKey =
    `${source}:${meta.id}`;


  const alreadyExists =
    events.some(
      e =>
        `${e.source}:${e.providerId}` === providerKey
    );


  if (alreadyExists) {
    continue;
  }


  events.push({

    source,

    providerId:
      String(meta.id),

    name:
       source === "flix"
         ? cleanFlixMatchName(meta.name || meta.title || "")
         : (meta.name || meta.title || ""),

    poster:
      meta.poster ||
      meta.background ||
      meta.logo ||
      null,

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

// Flix adds league text before ":" and emojis near the teams.
function cleanFlixMatchName(value = "") {
  return String(value)
    .replace(/^[^:]+:\s*/, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Avoid attaching Flix streams to a different opponent:
// both full matchup names must agree, not just one well-known team.
function safeMatchPair(value = "") {
  const pieces = String(value).split(/\s+vs\.?\s+/i).map(normalize);
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;
  return pieces.sort().join("|");
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

  if (!teams.length) {
    return "";
  }

  return teams
    .map(t => normalize(t))
    .sort()
    .join("|");

}


async function getCatalogEvents() {

  const all =
    await getProviderEvents();


  const filtered =
    all.filter(
      event =>
        event.name &&
        wantedEvent(event.name)
    );


  /*
    Raggruppiamo lo stesso evento proveniente
    dai due provider in una sola card.
  */

  const map = new Map();


  for (const event of filtered) {

    // Keep original SV/HF events unchanged. Add Flix as a verified
    // extra source only when both opponents match the existing event.
    if (event.source === "flix") {
      if (isSecondTeamMatch(event.name)) continue;
      const pair = safeMatchPair(event.name);
      const matched = pair
        ? Array.from(map.values()).find(item => safeMatchPair(item.name) === pair)
        : null;

      if (matched) {
        matched.providers.push({source: "flix", id: event.providerId});
      } else if (pair) {
        map.set("flix:" + event.providerId, {
          key: "flix:" + event.providerId,
          name: event.name,
          poster: event.poster,
          description: event.description,
          releaseInfo: event.releaseInfo,
          providers: [{source: "flix", id: event.providerId}]
        });
      }
      continue;
    }

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

        poster:
          event.poster,

        description:
          event.description,

        releaseInfo:
          event.releaseInfo,

        providers: []
      });
    }


    const item =
      map.get(key);


    /*
      Se la prima fonte non aveva poster,
      utilizziamo quello dell'altra.
    */

    if (
      !item.poster &&
      event.poster
    ) {

      item.poster =
        event.poster;
    }


    item.providers.push({

      source:
        event.source,

      id:
        event.providerId
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

    poster:
      event.poster ||
      undefined,

    // posterShape:
//   "landscape",

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
    "3.0.1",

  name:
    "Dado Live TV",

  description:
    "Top Club Europei & Nazionali",

  logo:
    "https://stremio-live-test-20261019.onrender.com/logo.jpg",

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
        "🔴 Live Football ⚽"
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
app.get("/logo.jpg", (req, res) => {
  res.type("jpeg");
  res.sendFile(require("path").join(__dirname, "assets", "dado-live-tv.jpg"));
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
  } else if (provider.source === "flix") {
    url = `${FLIX_FREE}/stream/tv/${encodeURIComponent(provider.id)}.json`;
  } else {
    return [];
  }

  const data = provider.source === "flix"
    ? await getJsonRaw(url, 7500)
    : await getJson(url);

  return (data.streams || [])
    // Flix also returns a promotional FlixNest link: exclude it.
    .filter(stream =>
      provider.source !== "flix" ||
      (typeof stream.url === "string" && /^https?:\/\//i.test(stream.url))
    )
    .map(stream => ({
      ...stream,
      name:
        (provider.source === "sv"
          ? "StremVerse"
          : provider.source === "hf"
            ? "Highfly"
            : "Flix-Streams") +
        " • " + (stream.name || "Stream")
    }));
}


/* =========================================================
   STREAM ROUTE
========================================================= */

app.get(
  "/stream/tv/:id.json",
  async (req, res) => {

    try {

      const event =
        await findEvent(
          req.params.id
        );


      if (!event) {

        return res.json({
          streams: []
        });
      }


      const results =
        await Promise.allSettled(
          event.providers.map(
            getStreams
          )
        );


      const streams =
        results.flatMap(
          result =>
            result.status ===
            "fulfilled"
              ? result.value
              : []
        );


      /*
        Deduplicazione degli stream.
      */

      const unique = [];
      const seen = new Set();


      for (
        const stream of streams
      ) {

        const key =
          stream.url ||
          stream.externalUrl ||
          stream.ytId ||
          JSON.stringify(stream);


        if (seen.has(key)) {
          continue;
        }


        seen.add(key);
        unique.push(stream);
      }


      res.json({
        streams: unique
      });


    } catch (error) {

      console.error(
        "Stream error:",
        error
      );


      res.json({
        streams: []
      });
    }
  }
);


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

    try {

      const all =
        await getProviderEvents();


      res.json({

        totale:
          all.length,

        passati:
          all
            .filter(
              e => wantedEvent(e.name)
            )
            .map(
              e => e.name
            ),

        scartati:
          all
            .filter(
              e => !wantedEvent(e.name)
            )
            .map(
              e => e.name
            ), 

        riconosciutiComeIndesiderati:
  all
    .filter(
      e => unwanted(e.name)
    )
    .map(
      e => e.name
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
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {

    res.send(
      "Stremio LIVE Football - StremVerse + Highfly 3.0.0"
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
