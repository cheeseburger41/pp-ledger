/* vici-data.js - Vici data layer (window.ViciData).
 *
 * ESPN + Open-Meteo clients, the pick journal (ai-picks.json in the data repo) and auto-grading.
 *
 *   ViciData.LEAGUES / STATS
 *   ViciData.scoreboard({sport, league?, date?})          -> [{eventId, league, name, short, start, timePT, state, completed, aet?, home, away, venue, odds?, weather?, detail?}]
 *   ViciData.findPlayer({name, sport?})                    -> [{athleteId, name, team, league, sport}]
 *   ViciData.gamelog({sport, league?, athleteId, last?, stat?, line?}) -> {player, rows:[{date, opp, home, result, min, stats}], vs?}
 *   ViciData.boxScore({sport, league?, eventId})           -> {state, completed, aet?, detail?, score?, players:[{athleteId, name, team, stats} | {..., dnp:true}]}
 *   ViciData.injuries({sport, team?, eventId?})            -> [{team, player, status, detail, date}]
 *   ViciData.weather({city?, lat?, lon?, time})            -> {tempF, windMph, gustMph, precipPct, summary, place?}
 *   ViciData.statValue(sport, statLabel, stats)            -> Number | undefined
 *   ViciData.gradePick(pick, box)                          -> {result, actual} | null
 *   ViciData.journal                                       -> load(), all(), get(id), add(picks) -> ids, update(id, patch), sync(), onChange(cb), status(), forget()
 *   ViciData.gradeJournal({now})                           -> {graded, still, items[], manual?[]}  (manual: soccer after extra time, NFL/CFB Fantasy Score near the line)
 *
 * Every ESPN call: fetch with a 12 s timeout, in-memory cache (60 s when a game in the payload is live, else 10 min),
 * failures throw Error{code:"espn_unreachable", url, status?}; the chat tells the bot to use web_search (never the URL).
 * Tool-facing results are compact: null/empty fields dropped, numbers rounded to 2 decimals.
 * Never touches the DOM; strings from ESPN are returned as data only.
 */
(function (root) {
  "use strict";

  // ---------- environment (tests override these) ----------
  const env = {
    fetch: null,                 // null -> root.fetch
    now: () => Date.now(),
    timeoutMs: 12000,
    storage: null,               // null -> root.localStorage -> in-memory
    autoSync: true,              // journal pushes ~250 ms after a change
    syncDelayMs: 250,
    random: () => Math.random(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: t => clearTimeout(t)
  };

  // ---------- constants ----------
  const SITE = "https://site.api.espn.com/apis/site/v2/sports/";
  const WEB = "https://site.web.api.espn.com/apis/common/v3/";
  const SEARCH_V2 = "https://site.web.api.espn.com/apis/search/v2";
  const CORE = "https://sports.core.api.espn.com/v2/sports/";
  const GEO = "https://geocoding-api.open-meteo.com/v1/search";
  const METEO = "https://api.open-meteo.com/v1/forecast";
  const TTL_LIVE = 60e3, TTL_DEFAULT = 600e3, TTL_WEATHER = 1800e3, CACHE_MAX = 150;
  const PT = "America/Los_Angeles";
  const HOUR = 3600e3;

  const LEAGUES = {
    NBA: "basketball/nba",
    NFL: "football/nfl",
    CFB: "football/college-football",
    Soccer: ["eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "usa.1", "mex.1", "uefa.champions", "uefa.europa", "uefa.europa.conf",
      "uefa.nations", "fifa.world", "fifa.worldq.uefa", "fifa.friendly", "eng.fa", "eng.league_cup", "ned.1", "por.1", "sau.1", "bra.1"],
    WNBA: "basketball/wnba",
    CBB: "basketball/mens-college-basketball",
    NHL: "hockey/nhl",
    MLB: "baseball/mlb"
  };
  // PrizePicks labels the app uses (statValue supports all of these and more).
  const STATS = {
    NBA: ["Points", "Rebounds", "Assists", "Pts+Rebs+Asts", "Pts+Rebs", "Pts+Asts", "Rebs+Asts", "3-PT Made", "Fantasy Score", "Blks+Stls", "Turnovers"],
    NFL: ["Pass Yards", "Pass TDs", "Pass Attempts", "Completions", "Rush Yards", "Rush+Rec Yds", "Receiving Yards", "Receptions", "Rush Attempts", "Fantasy Score", "INT"],
    CFB: ["Pass Yards", "Pass TDs", "Rush Yards", "Rush+Rec Yds", "Receiving Yards", "Receptions", "Fantasy Score"],
    Soccer: ["Shots", "Shots On Target", "Goals", "Assists", "Goal + Assist", "Passes Attempted", "Tackles", "Goalie Saves", "Fouls", "Clearances"]
  };

  // ---------- small helpers ----------
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (v == null || v === "" ? undefined : String(v));
  const round2 = x => Math.round(x * 100) / 100;
  const isNum = v => typeof v === "number" && isFinite(v);
  function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : undefined;
    if (typeof v !== "string") return undefined;
    const t = v.trim().replace(/,/g, "").replace(/^\+/, "");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : /^-?\.\d+$/.test(t) ? Number(t) : undefined;
  }
  function pair(v) { // "3-8", "22/35" -> [3, 8]
    const m = /^\s*(\d+)\s*[-/]\s*(\d+)\s*$/.exec(String(v == null ? "" : v));
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  /** Drop null/undefined/""/NaN fields recursively and round numbers (tool results are fed to Claude). */
  function clean(v) {
    if (Array.isArray(v)) return v.map(clean).filter(x => x !== undefined);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) { const c = clean(v[k]); if (c !== undefined) o[k] = c; }
      return o;
    }
    if (typeof v === "number") return isFinite(v) ? round2(v) : undefined;
    if (v === null || v === undefined || v === "") return undefined;
    return v;
  }
  const fail = (code, extra) => Object.assign(new Error(String(code)), { code }, extra || {});
  const badInput = msg => fail("bad_input", { message: msg });
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length); let i = 0;
    const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
    return out;
  }
  const getRoot = k => { try { return root ? root[k] : undefined; } catch (e) { return undefined; } };

  // ---------- dates (America/Los_Angeles) ----------
  let fmtDay = null, fmtTime = null;
  function ptDate(t) {
    const d = new Date(typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t + "T12:00:00Z" : t);
    if (isNaN(d.getTime())) return null;
    try {
      fmtDay = fmtDay || new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" });
      const p = {}; for (const x of fmtDay.formatToParts(d)) p[x.type] = x.value;
      return `${p.year}-${p.month}-${p.day}`;
    } catch (e) { return new Date(d.getTime() - 8 * HOUR).toISOString().slice(0, 10); }
  }
  function ptTime(t) {
    const d = new Date(t); if (isNaN(d.getTime())) return undefined;
    try {
      fmtTime = fmtTime || new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
      return fmtTime.format(d).replace(",", "");
    } catch (e) { return undefined; }
  }
  function addDays(ymd, n) {
    const d = new Date(ymd + "T12:00:00Z"); if (isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
  }
  /** "today" | "tomorrow" | "yesterday" | YYYY-MM-DD | YYYYMMDD | ISO -> YYYY-MM-DD (PT). */
  function ymdOf(date, now) {
    const today = ptDate(now == null ? env.now() : now);
    if (date == null || date === "") return today;
    const s = String(date).trim().toLowerCase();
    if (s === "today" || s === "tonight") return today;
    if (s === "tomorrow") return addDays(today, 1);
    if (s === "yesterday") return addDays(today, -1);
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const p = ptDate(String(date)); if (p) return p;
    throw badInput("date must be YYYY-MM-DD");
  }
  const toMs = v => (v == null ? undefined : v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v));

  // ---------- sports & leagues ----------
  const SPORT_ALIAS = {
    nba: "NBA", basketball: "NBA", "basketball/nba": "NBA",
    nfl: "NFL", "football/nfl": "NFL", "american football": "NFL",
    cfb: "CFB", ncaaf: "CFB", "college football": "CFB", "college-football": "CFB", "football/college-football": "CFB", ncaafb: "CFB",
    soccer: "Soccer", futbol: "Soccer", "f\u00fatbol": "Soccer",
    wnba: "WNBA", "basketball/wnba": "WNBA",
    cbb: "CBB", ncaab: "CBB", ncaam: "CBB", "college basketball": "CBB", "mens-college-basketball": "CBB",
    nhl: "NHL", hockey: "NHL", mlb: "MLB", baseball: "MLB"
  };
  const DEFAULT_LEAGUE = { NBA: "nba", NFL: "nfl", CFB: "college-football", WNBA: "wnba", CBB: "mens-college-basketball", NHL: "nhl", MLB: "mlb" };
  const LEAGUE_ALIAS = {
    epl: "eng.1", "premier league": "eng.1", "english premier league": "eng.1", "la liga": "esp.1", laliga: "esp.1", "serie a": "ita.1",
    bundesliga: "ger.1", "ligue 1": "fra.1", mls: "usa.1", "liga mx": "mex.1", ucl: "uefa.champions", "champions league": "uefa.champions",
    uel: "uefa.europa", "europa league": "uefa.europa", uecl: "uefa.europa.conf", "conference league": "uefa.europa.conf",
    "nations league": "uefa.nations", "world cup": "fifa.world", "fa cup": "eng.fa", "league cup": "eng.league_cup", "carabao cup": "eng.league_cup",
    eredivisie: "ned.1", "primeira liga": "por.1", "saudi pro league": "sau.1", brasileirao: "bra.1", friendly: "fifa.friendly", friendlies: "fifa.friendly"
  };
  const leagueSlug = l => { const t = String(l == null ? "" : l).trim().toLowerCase(); return LEAGUE_ALIAS[t] || t; };
  const isSoccerSlug = t => /^[a-z]{2,4}\.[a-z0-9_.]+$/.test(t) || /^(uefa|fifa|conmebol|concacaf|afc|caf)\b/.test(t);
  function canonSport(s) {
    const t = String(s == null ? "" : s).trim().toLowerCase();
    if (!t) return null;
    if (SPORT_ALIAS[t]) return SPORT_ALIAS[t];
    if (/^soccer\b/.test(t) || isSoccerSlug(t)) return "Soccer";
    return null;
  }
  function sportFrom(sport, league) {
    const lg = String(league || "").toLowerCase(), sp = String(sport || "").toLowerCase();
    for (const [k, v] of Object.entries(DEFAULT_LEAGUE)) if (v === lg) return k;
    if (sp === "soccer" || (lg && isSoccerSlug(lg))) return "Soccer";
    return null;
  }
  const kindOf = sport => (sport === "NBA" || sport === "WNBA" || sport === "CBB" ? "bb" : sport === "NFL" || sport === "CFB" ? "fb" : sport === "Soccer" ? "soc" : "gen");
  function resolveSport(sport, league) {
    let s = canonSport(sport);
    let lg = league == null || league === "" ? null : leagueSlug(league);
    if (!s && lg) s = canonSport(lg) || sportFrom(null, lg);
    // Errors never quote the caller's input: tool errors go back to the model, and an echoed string could carry data.
    if (!s) throw badInput("unknown sport");
    if (s !== "Soccer") lg = DEFAULT_LEAGUE[s];
    else if (lg && !/^[a-z0-9_.-]{2,40}$/.test(lg)) throw badInput("bad league slug");
    return { sport: s, league: lg || null };
  }
  const pathFor = (sport, league) => (sport === "Soccer" ? "soccer/" + (league || LEAGUES.Soccer[0]) : LEAGUES[sport]);
  const idOk = v => /^-?\d{1,12}$/.test(String(v == null ? "" : v));

  // ---------- names ----------
  const SPECIAL = { "\u00f8": "o", "\u00e6": "ae", "\u0153": "oe", "\u00df": "ss", "\u0142": "l", "\u0111": "d", "\u00f0": "d", "\u00fe": "th", "\u0131": "i", "\u0127": "h" };
  const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv", "junior"]);
  /** "Erling Haaland (NOR)" -> "erling haaland"; "Michael Penix Jr." -> "michael penix"; "J. J. McCarthy" -> "jj mccarthy". */
  function normName(s) {
    let t = String(s == null ? "" : s).toLowerCase();
    t = t.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
    t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u00f8\u00e6\u0153\u00df\u0142\u0111\u00f0\u00fe\u0131\u0127]/g, c => SPECIAL[c]);
    t = t.replace(/['\u2019\u2018`\u00b4.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    if (!t) return "";
    const tok = [];
    let singleRun = false;
    for (const w of t.split(" ")) {
      if (w.length === 1 && singleRun) { tok[tok.length - 1] += w; continue; }
      tok.push(w); singleRun = w.length === 1;
    }
    while (tok.length >= 2) {
      const last = tok[tok.length - 1];
      if (SUFFIX.has(last) || (last === "v" && tok.length > 2)) tok.pop(); else break;
    }
    return tok.join(" ");
  }
  /** 3 = same name, 2 = initial/nickname or middle-name variant, 1 = surname / mononym only, 0 = different. */
  function nameScore(a, b) {
    const x = normName(a), y = normName(b);
    if (!x || !y) return 0;
    if (x === y) return 3;
    const xa = x.split(" "), ya = y.split(" ");
    if (xa.length >= 2 && ya.length >= 2) {
      const f = xa[0], g = ya[0];
      if (xa.slice(1).join(" ") === ya.slice(1).join(" ") && f[0] === g[0] &&
        (f.length === 1 || g.length === 1 || f.startsWith(g) || g.startsWith(f))) return 2;
      if (f === g && xa[xa.length - 1] === ya[ya.length - 1]) return 2;
      return 0;
    }
    const single = xa.length === 1 ? xa[0] : ya[0], other = xa.length === 1 ? ya : xa;
    if (other.length === 1) return single.length >= 3 && (other[0].startsWith(single) || single.startsWith(other[0])) ? 1 : 0;
    return other[other.length - 1] === single || other[0] === single ? 1 : 0;
  }
  const sameTeam = (a, b) => !!a && !!b && String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
  /** Best player row for a pick: athleteId first, then a unique best name match (team breaks ties).
   *  info.ambiguous is set when several players match equally well (then null means "can't tell", not "absent"). */
  function findInBox(players, pick, info) {
    const list = arr(players);
    const id = pick && pick.athleteId != null ? String(pick.athleteId) : "";
    if (id) { const p = list.find(x => x && String(x.athleteId) === id); if (p) return p; }
    const name = pick && pick.player;
    if (!name) return null;
    let best = [], top = 0;
    for (const p of list) {
      if (!p) continue;
      let s = nameScore(name, p.name);
      if (!s) continue;
      if (id && s < 3) continue;   // an id was given and did not match: accept only an exact name
      if (pick.team && p.team && sameTeam(pick.team, p.team)) s += 0.5;
      if (s > top) { top = s; best = [p]; } else if (s === top) best.push(p);
    }
    if (best.length > 1 && info) info.ambiguous = true;
    if (best.length !== 1 || top < 1) return null;
    if (top < 2 && pick.team && !sameTeam(pick.team, best[0].team)) return null;
    return best[0];
  }

  // ---------- teams ----------
  const TEAM_ALIAS = {
    "man utd": "manchester united", "man united": "manchester united", "man u": "manchester united", "man city": "manchester city",
    spurs: "tottenham hotspur", psg: "paris saint germain", barca: "barcelona", inter: "internazionale", "inter milan": "internazionale",
    atleti: "atletico madrid", wolves: "wolverhampton wanderers", bayern: "bayern munich", juve: "juventus", "real": "real madrid"
  };
  const TEAM_STOP = new Set(["fc", "cf", "afc", "sc", "the", "club", "ac", "cd", "ssc"]);
  function normTeam(s) {
    let t = normName(String(s || "").replace(/&/g, " and "));
    if (TEAM_ALIAS[t]) t = TEAM_ALIAS[t];
    return t.split(" ").filter(w => w && !TEAM_STOP.has(w)).join(" ");
  }
  // Common abbreviations that differ from ESPN's (NBA / NFL), so "GSW" finds ESPN's "GS".
  const ABBR_ALIAS = { GSW: "GS", NYK: "NY", NOP: "NO", SAS: "SA", UTA: "UTAH", WAS: "WSH", PHO: "PHX", BRK: "BKN", CHO: "CHA",
    GNB: "GB", JAC: "JAX", KCC: "KC", KAN: "KC", LVR: "LV", NWE: "NE", SFO: "SF", TAM: "TB" };
  const canonAbbr = s => { const u = String(s).trim().toUpperCase(); return ABBR_ALIAS[u] || u; };
  function teamMatch(q, t) {
    if (q == null || !t) return false;
    const qs = String(q).trim(); if (!qs) return false;
    if (t.id != null && qs === String(t.id)) return true;
    if (t.abbr && canonAbbr(qs) === canonAbbr(t.abbr)) return true;
    const qn = normTeam(qs), nn = normTeam(t.name || "");
    if (!qn || !nn) return false;
    if (qn === nn) return true;
    const qt = qn.split(" "), nt = nn.split(" ");
    let j = 0;
    for (const w of qt) {
      while (j < nt.length && !(nt[j] === w || (w.length >= 3 && nt[j].startsWith(w)))) j++;
      if (j >= nt.length) return false;
      j++;
    }
    return true;
  }

  // ---------- fetch + cache ----------
  const cache = new Map();          // url -> {t, ttl, data} | {promise}
  const eventLeague = new Map();    // soccer eventId -> league slug (from scoreboards)
  const athleteLeague = new Map();  // athleteId -> league slug (from search)
  const nameCache = new Map();      // athleteId -> display name
  function remember(map, k, v) { if (k != null && v) { map.set(String(k), v); if (map.size > 2000) map.delete(map.keys().next().value); } }
  function netErr(source, url, why, status) {
    const weather = source === "weather";
    const e = new Error((weather ? "Weather service unreachable" : "ESPN unreachable") + ` (${why}). URL: ${url}`);
    e.code = weather ? "weather_unreachable" : "espn_unreachable";
    e.url = url;
    if (status) e.status = status;
    return e;
  }
  function isLive(j) {
    if (!j || typeof j !== "object") return false;
    const st = x => (x && ((x.status && x.status.type && x.status.type.state) ||
      (x.competitions && x.competitions[0] && x.competitions[0].status && x.competitions[0].status.type && x.competitions[0].status.type.state))) || null;
    if (Array.isArray(j.events) && j.events.some(e => st(e) === "in")) return true;
    return !!(j.header && st(j.header) === "in");
  }
  async function rawFetch(url, source) {
    const f = env.fetch || (typeof getRoot("fetch") === "function" ? getRoot("fetch").bind(root) : null);
    if (typeof f !== "function") throw netErr(source, url, "no fetch");
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = env.setTimeout(() => { try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ } reject(netErr(source, url, "timeout")); }, env.timeoutMs);
    });
    try {
      const res = await Promise.race([f(url, { mode: "cors", credentials: "omit", signal: ctl ? ctl.signal : undefined }), timeout]);
      if (!res || !res.ok) throw netErr(source, url, "HTTP " + (res ? res.status : "?"), res ? res.status : undefined);
      return await Promise.race([res.json(), timeout]);
    } catch (e) {
      if (e && (e.code === "espn_unreachable" || e.code === "weather_unreachable")) throw e;
      throw netErr(source, url, e && e.name === "AbortError" ? "timeout" : e instanceof SyntaxError ? "bad JSON" : "network");
    } finally { env.clearTimeout(timer); }
  }
  /** Cached GET of JSON. ttl: ms or fn(data) -> ms; default 60 s if a game in the payload is live, else 10 min. */
  function getJSON(url, opts) {
    const o = opts || {};
    const hit = cache.get(url);
    if (hit) {
      if (hit.promise) return hit.promise;
      if (env.now() - hit.t < hit.ttl) return Promise.resolve(hit.data);
      cache.delete(url);
    }
    const p = rawFetch(url, o.source || "espn").then(data => {
      const ttl = typeof o.ttl === "number" ? o.ttl : isLive(data) ? TTL_LIVE : TTL_DEFAULT;
      cache.set(url, { t: env.now(), ttl, data });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return data;
    }, err => { cache.delete(url); throw err; });
    cache.set(url, { promise: p });
    return p;
  }
  function clearCache() { cache.clear(); eventLeague.clear(); athleteLeague.clear(); nameCache.clear(); }

  // ---------- status ----------
  function finalFlag(type) {
    if (!type) return false;
    if (type.completed === true) return true;
    return type.completed == null && type.state === "post" && /FINAL|FULL_TIME/.test(String(type.name || ""));
  }
  const isFinal = x => !!x && x.state === "post" && x.completed === true;
  /** Soccer match that went past 90 minutes (extra time and/or penalties). ESPN's totals include extra time, but
   *  PrizePicks settles soccer props on 90 minutes + stoppage, so such a match can't be graded from the box. */
  function extraTime(status) {
    const s = status || {}, type = s.type || {};
    if (/_AET$|_PEN$|PENALT/.test(String(type.name || ""))) return true;
    if (/\bAET\b|\bpens?\b|penalt|extra time/i.test([type.detail, type.shortDetail, type.description].filter(Boolean).join(" "))) return true;
    return Number(s.period) > 2;   // soccer periods: 1-2 halves, 3-4 extra time, 5 shoot-out
  }

  // ---------- scoreboard ----------
  function parseEvent(ev, league) {
    const comp = (ev && ev.competitions && ev.competitions[0]) || {};
    const status = (ev && ev.status && ev.status.type ? ev.status : comp.status) || {};
    const type = status.type || {};
    const state = type.state || undefined;
    const completed = finalFlag(type);
    const soccer = isSoccerSlug(String(league || ""));
    const comps = arr(comp.competitors);
    const side = ha => {
      const c = comps.find(x => x && x.homeAway === ha);
      if (!c) return undefined;
      const t = c.team || {};
      const sc = c.score && typeof c.score === "object" ? (c.score.value != null ? c.score.value : c.score.displayValue) : c.score;
      const rank = c.curatedRank && toNum(c.curatedRank.current);
      return { abbr: t.abbreviation, name: t.displayName || t.shortDisplayName || t.name, id: str(t.id != null ? t.id : c.id),
        score: state === "pre" ? undefined : toNum(sc), rank: rank && rank <= 25 ? rank : undefined };
    };
    let home = side("home"), away = side("away");
    if (!home && !away && ev && ev.shortName) {
      const m = /^\s*(\S+)\s+(?:@|vs\.?|at)\s+(\S+)\s*$/i.exec(ev.shortName);
      if (m) { away = { abbr: m[1] }; home = { abbr: m[2] }; }
    }
    const v = comp.venue || {}, a = v.address || {};
    const odds = comp.odds && comp.odds[0];
    const w = ev && ev.weather;
    return {
      eventId: str(ev && ev.id), league, name: ev && ev.name, short: ev && ev.shortName,
      start: (ev && ev.date) || comp.date, timePT: ptTime((ev && ev.date) || comp.date),
      state, completed,
      aet: soccer && state === "post" && extraTime(status) ? true : undefined,
      detail: state === "in" || (state === "post" && !completed) ? type.shortDetail || type.detail || type.description : undefined,
      home, away,
      venue: v.fullName || a.city ? { name: v.fullName, city: a.city, state: a.state, country: a.state ? undefined : a.country, indoor: typeof v.indoor === "boolean" ? v.indoor : undefined } : undefined,
      odds: odds && (odds.details || odds.overUnder != null) ? { line: odds.details, total: toNum(odds.overUnder) } : undefined,
      weather: w && (w.temperature != null || w.displayValue) ? { tempF: toNum(w.temperature), summary: w.displayValue } : undefined
    };
  }
  async function scoreboardOne(sport, league, ymd) {
    const lg = sport === "Soccer" ? league : DEFAULT_LEAGUE[sport];
    const url = `${SITE}${pathFor(sport, league)}/scoreboard?dates=${ymd.replace(/-/g, "")}` + (sport === "CFB" ? "&groups=80&limit=300" : sport === "CBB" ? "&groups=50&limit=300" : "");
    const j = await getJSON(url);
    const slug = (j && j.leagues && j.leagues[0] && j.leagues[0].slug) || lg;
    return arr(j && j.events).map(ev => {
      const e = parseEvent(ev, slug);
      if (sport === "Soccer" && e.eventId) remember(eventLeague, e.eventId, slug);
      return e;
    });
  }
  const byStart = (a, b) => String(a.start || "").localeCompare(String(b.start || "")) || String(a.eventId).localeCompare(String(b.eventId));
  async function scoreboardRaw(o) {
    const { sport, league } = resolveSport(o.sport, o.league);
    const ymd = ymdOf(o.date);
    if (sport === "Soccer" && !league) {
      const lists = await mapLimit(LEAGUES.Soccer, 6, lg => scoreboardOne("Soccer", lg, ymd).catch(e => e));
      const ok = lists.filter(Array.isArray);
      if (!ok.length) throw lists.find(x => x instanceof Error) || netErr("espn", SITE + "soccer", "network");
      return [].concat(...ok).sort(byStart);
    }
    return (await scoreboardOne(sport, league, ymd)).sort(byStart);
  }
  /** Day's games (date = PT day, default today). Soccer without a league scans every league in LEAGUES.Soccer. */
  async function scoreboard(o) { return clean(await scoreboardRaw(o || {})); }
  /** First event of the day that matches EVERY team given (team and/or opponent: abbr, id or name such as "Man United").
   *  With both given, a game of only one of them is never taken: that is another game of the same team or the opponent. */
  async function findEvent(o) {
    const q = o || {};
    const wants = [q.team, q.opponent].filter(x => x != null && String(x).trim());
    if (!wants.length) return null;
    const list = await scoreboardRaw(q);
    for (const ev of list) {
      if (q.ptDate && ev.start && ptDate(ev.start) !== q.ptDate) continue;
      if (wants.every(w => teamMatch(w, ev.home) || teamMatch(w, ev.away))) return clean(ev);
    }
    return null;
  }

  // ---------- stat key maps ----------
  const BB_KEYS = {
    MIN: "MIN", minutes: "MIN", PTS: "PTS", points: "PTS", REB: "REB", rebounds: "REB", totalRebounds: "REB",
    AST: "AST", assists: "AST", STL: "STL", steals: "STL", BLK: "BLK", blocks: "BLK", TO: "TO", turnovers: "TO",
    PF: "PF", fouls: "PF", OREB: "OREB", offensiveRebounds: "OREB", DREB: "DREB", defensiveRebounds: "DREB",
    FG: "FG", "fieldGoalsMade-fieldGoalsAttempted": "FG", "3PT": "3PT", "threePointFieldGoalsMade-threePointFieldGoalsAttempted": "3PT",
    FT: "FT", "freeThrowsMade-freeThrowsAttempted": "FT"
  };
  const BB_PAIR = new Set(["FG", "3PT", "FT"]);
  const FB_KEYS = {
    passing: { "completions/passingAttempts": ["passCmp", "passAtt"], completions: "passCmp", passingAttempts: "passAtt", passingYards: "passYds",
      passingTouchdowns: "passTD", interceptions: "passInt", longPassing: "passLong" },
    rushing: { rushingAttempts: "rushAtt", rushingYards: "rushYds", rushingTouchdowns: "rushTD", longRushing: "rushLong" },
    receiving: { receptions: "rec", receivingYards: "recYds", receivingTouchdowns: "recTD", longReception: "recLong", receivingTargets: "targets" },
    fumbles: { fumblesLost: "fumLost" },
    defensive: { totalTackles: "tackles", sacks: "defSacks" },
    interceptions: { interceptions: "defInt" },
    kickReturns: { kickReturnTouchdowns: "krTD" },
    puntReturns: { puntReturnTouchdowns: "prTD" },
    kicking: { "fieldGoalsMade/fieldGoalAttempts": ["fgm", "fga"], "extraPointsMade/extraPointAttempts": ["xpm", "xpa"], totalKickingPoints: "kickPts" }
  };
  const FB_SPARSE = new Set(["fumLost", "krTD", "prTD", "defInt", "defSacks", "tackles"]);   // zero -> omitted (football: missing = 0)
  const SOC_KEYS = {
    totalGoals: "goals", goalAssists: "assists", totalShots: "shots", shotsOnTarget: "sot", foulsCommitted: "fouls", saves: "saves",
    goalsConceded: "conceded", yellowCards: "yc", redCards: "rc", totalPasses: "passes", accuratePasses: "passesCmp",
    totalTackles: "tackles", effectiveTackles: "tacklesWon", totalClearance: "clearances", minutes: "minutes", appearances: "app",
    shotAssists: "shotAssists", totalCrosses: "crosses", offsides: "offsides", foulsSuffered: "fouled"
  };
  const SOC_SPARSE = new Set(["yc", "rc", "offsides", "fouled", "conceded"]);

  function fbAssign(stats, group, key, raw) {
    const g = FB_KEYS[group];
    let tgt = g && g[key];
    if (tgt === undefined && !g) for (const gg of Object.keys(FB_KEYS)) if (FB_KEYS[gg][key] !== undefined) { tgt = FB_KEYS[gg][key]; break; }
    if (tgt === undefined) return;
    if (Array.isArray(tgt)) {
      const p = pair(raw); if (!p) return;
      if (tgt[0]) stats[tgt[0]] = p[0];
      if (tgt[1]) stats[tgt[1]] = p[1];
      return;
    }
    const v = toNum(raw);
    if (v === undefined || (v === 0 && FB_SPARSE.has(tgt))) return;
    stats[tgt] = v;
  }
  function bbAssign(stats, key, label, raw) {
    const k = BB_KEYS[key] || BB_KEYS[label];
    if (!k) return;
    if (BB_PAIR.has(k)) { const p = pair(raw); if (p) stats[k] = p[0] + "-" + p[1]; return; }
    const v = toNum(raw); if (v !== undefined) stats[k] = v;
  }
  function socAssign(stats, name, raw, keeper) {
    const k = SOC_KEYS[name]; if (!k || k === "app") return;
    const v = toNum(raw); if (v === undefined) return;
    if (SOC_SPARSE.has(k) && !(k === "conceded" && keeper) && v === 0) return;
    if (k === "conceded" && !keeper) return;
    stats[k] = v;
  }

  // ---------- box score ----------
  function bbPlayers(j, sport) {
    const out = [], teams = {};
    for (const t of arr(j && j.boxscore && j.boxscore.players)) {
      const abbr = t && t.team && t.team.abbreviation;
      for (const g of arr(t && t.statistics)) {
        const keys = arr(g.keys), labels = arr(g.labels).length ? arr(g.labels) : arr(g.names);
        const multi = arr(t.statistics).length > 1;
        for (const a of arr(g.athletes)) {
          const ath = (a && a.athlete) || {};
          const id = str(ath.id);
          if (id && Number(id) < 0) continue;
          let p = id && teams[id];
          if (!p) { p = { athleteId: id, name: ath.displayName || ath.shortName, team: abbr }; out.push(p); if (id) teams[id] = p; }
          const raw = arr(a.stats);
          if (a.didNotPlay === true || !raw.length) { if (!p.stats) p.dnp = true; continue; }
          delete p.dnp;
          p.stats = p.stats || {};
          raw.forEach((v, i) => {
            if (sport === "gen") {
              const lab = labels[i] || keys[i]; if (!lab) return;
              const k = multi && g.name ? g.name + "." + lab : lab;
              const n = toNum(v); p.stats[k] = n !== undefined ? n : pair(v) ? String(v) : undefined;
            } else bbAssign(p.stats, keys[i], labels[i], v);
          });
        }
      }
    }
    return out;
  }
  function fbPlayers(j) {
    const out = [], byId = {};
    for (const t of arr(j && j.boxscore && j.boxscore.players)) {
      const abbr = t && t.team && t.team.abbreviation;
      for (const g of arr(t && t.statistics)) {
        const keys = arr(g.keys);
        for (const a of arr(g.athletes)) {
          const ath = (a && a.athlete) || {};
          const id = str(ath.id);
          if (!id || Number(id) < 0 || String(ath.displayName || "").trim() === "Team") continue;
          let p = byId[id];
          if (!p) { p = byId[id] = { athleteId: id, name: ath.displayName, team: abbr, stats: {} }; out.push(p); }
          arr(a.stats).forEach((v, i) => fbAssign(p.stats, g.name, keys[i], v));
        }
      }
    }
    return out;
  }
  function socPlayers(j, final) {
    const out = [];
    for (const t of arr(j && j.rosters)) {
      const abbr = t && t.team && t.team.abbreviation;
      for (const e of arr(t && t.roster)) {
        const ath = (e && e.athlete) || {};
        const keeper = /^G/.test(String((e.position && e.position.abbreviation) || ""));
        const stats = {};
        let app;
        for (const s of arr(e.stats)) {
          if (!s || !s.name) continue;
          const v = s.value != null ? s.value : s.displayValue;
          if (s.name === "appearances") app = toNum(v);
          socAssign(stats, s.name, v, keeper);
        }
        const sub = e.subbedIn && typeof e.subbedIn === "object" ? !!e.subbedIn.didSub : !!e.subbedIn;
        const unused = app === 0 || (e.starter === false && !sub);
        const p = { athleteId: str(ath.id), name: ath.displayName, team: abbr };
        if (unused) { if (final) p.dnp = true; else p.bench = true; } else p.stats = stats;
        out.push(p);
      }
    }
    return out;
  }
  function parseBox(j, sport, league, eventId) {
    const hc = (j && j.header && j.header.competitions && j.header.competitions[0]) || {};
    const type = (hc.status && hc.status.type) || {};
    const state = type.state || undefined, completed = finalFlag(type);
    const kind = kindOf(sport);
    const players = kind === "soc" ? socPlayers(j, state === "post" && completed) : kind === "fb" ? fbPlayers(j) : bbPlayers(j, kind);
    const cs = arr(hc.competitors);
    const h = cs.find(c => c && c.homeAway === "home"), a = cs.find(c => c && c.homeAway === "away");
    const ab = c => (c && c.team && c.team.abbreviation) || "";
    const score = state && state !== "pre" && h && a && toNum(h.score) !== undefined && toNum(a.score) !== undefined
      ? `${ab(a)} ${toNum(a.score)} @ ${ab(h)} ${toNum(h.score)}` : undefined;
    const box = clean({
      state, completed,
      aet: kind === "soc" && state === "post" && extraTime(hc.status) ? true : undefined,   // not gradable (see extraTime)
      detail: state === "in" || (state === "post" && !completed) ? type.shortDetail || type.detail || type.description : undefined,
      score, players
    });
    if (!box.players) box.players = [];
    const athleteTeam = {}, teamIds = {};
    const teamBlocks = kind === "soc" ? arr(j && j.rosters) : arr(j && j.boxscore && j.boxscore.players);
    for (const t of teamBlocks) {
      const tid = str(t && t.team && t.team.id); if (!tid) continue;
      if (t.team.abbreviation) teamIds[t.team.abbreviation] = tid;
      for (const e of kind === "soc" ? arr(t.roster) : [].concat(...arr(t.statistics).map(g => arr(g && g.athletes)))) {
        const id = str(e && e.athlete && e.athlete.id); if (id) athleteTeam[id] = tid;
      }
    }
    for (const p of box.players) if (p.athleteId && p.name) remember(nameCache, p.athleteId, p.name);
    Object.defineProperty(box, "_meta", { value: { sport, league, eventId: String(eventId), athleteTeam, teamIds }, enumerable: false });
    return box;
  }
  const summaryUrl = (sport, league, eventId) => `${SITE}${pathFor(sport, league)}/summary?event=${encodeURIComponent(eventId)}`;
  /** Live or final box score. Soccer without a league uses the league seen on a scoreboard, else tries LEAGUES.Soccer. */
  async function boxScore(o) {
    const q = o || {};
    const { sport, league } = resolveSport(q.sport, q.league);
    const eventId = str(q.eventId != null ? q.eventId : q.event_id);
    if (!eventId || !idOk(eventId)) throw badInput("eventId required");
    let lg = league;
    if (sport === "Soccer" && !lg) lg = eventLeague.get(eventId) || null;
    if (sport === "Soccer" && !lg) {
      let lastErr = null;
      for (const cand of LEAGUES.Soccer) {
        try {
          const j = await getJSON(summaryUrl(sport, cand, eventId));
          const hid = j && j.header && (j.header.id || (j.header.competitions && j.header.competitions[0] && j.header.competitions[0].id));
          if (hid == null || String(hid) === eventId) { remember(eventLeague, eventId, cand); return parseBox(j, sport, cand, eventId); }
        } catch (e) { lastErr = e; if (!e.status) break; }   // network failure: stop; HTTP 4xx: try the next league
      }
      throw lastErr || netErr("espn", summaryUrl(sport, "eng.1", eventId), "event not found");
    }
    const j = await getJSON(summaryUrl(sport, lg, eventId));
    return parseBox(j, sport, lg, eventId);
  }
  /** Soccer per-match player stats from the core API (passes, tackles, clearances, minutes...). */
  async function soccerPlayerStats(o) {
    const q = o || {};
    const lg = String(q.league || "").toLowerCase();
    if (!/^[a-z0-9_.-]{2,40}$/.test(lg) || !idOk(q.eventId) || !idOk(q.teamId) || !idOk(q.athleteId)) throw badInput("league, eventId, teamId, athleteId required");
    const url = `${CORE}soccer/leagues/${lg}/events/${q.eventId}/competitions/${q.eventId}/competitors/${q.teamId}/roster/${q.athleteId}/statistics/0`;
    const j = await getJSON(url);
    const stats = {};
    for (const c of arr(j && j.splits && j.splits.categories)) for (const s of arr(c && c.stats)) {
      if (!s || !s.name || !SOC_KEYS[s.name]) continue;
      const v = toNum(s.value != null ? s.value : s.displayValue);
      if (v !== undefined) stats[SOC_KEYS[s.name]] = v;
    }
    return stats;
  }

  // ---------- statValue ----------
  const squash = s => String(s == null ? "" : s).toLowerCase()
    .replace(/&|\band\b|\bplus\b/g, "+").replace(/[^a-z0-9+]/g, "").replace(/\++/g, "+").replace(/^\+|\+$/g, "");
  const ALIAS = {};
  const al = (c, list) => list.forEach(s => { ALIAS[s] = c; });
  al("pts", ["points", "point", "pts", "pt"]);
  al("reb", ["rebounds", "rebound", "rebs", "reb", "totalrebounds", "boards"]);
  al("ast", ["assists", "assist", "asts", "ast", "goalassists"]);
  al("stl", ["steals", "steal", "stl", "stls"]);
  al("blk", ["blocks", "block", "blk", "blks", "blockedshots"]);
  al("tov", ["turnovers", "turnover", "to", "tov", "tos"]);
  al("3pm", ["3ptmade", "3pm", "3ptm", "3pointersmade", "3pointsmade", "threes", "threesmade", "threepointersmade", "3pt", "3ptsmade", "3pointfieldgoalsmade", "3s"]);
  al("3pa", ["3ptattempted", "3pa", "3ptattempts", "3pointersattempted", "threepointersattempted", "3ptsattempted"]);
  al("fgm", ["fgmade", "fieldgoalsmade", "fgm"]);
  al("fga", ["fgattempted", "fieldgoalsattempted", "fga", "fgattempts"]);
  al("ftm", ["freethrowsmade", "ftm", "ftmade", "freethrows"]);
  al("fta", ["freethrowsattempted", "fta", "ftattempted"]);
  al("2pm", ["twopointersmade", "2ptmade", "2pm", "2pointersmade"]);
  al("2pa", ["twopointersattempted", "2ptattempted", "2pa", "2pointersattempted"]);
  al("oreb", ["offensiverebounds", "oreb", "offrebounds"]);
  al("dreb", ["defensiverebounds", "dreb", "defrebounds"]);
  al("pf", ["personalfouls", "pf"]);
  al("fantasy", ["fantasyscore", "fantasy", "fantasypoints", "fantasypts", "fpts", "fs"]);
  al("min", ["minutes", "min", "minutesplayed"]);
  al("pass_yds", ["passyards", "passingyards", "passyds", "passyd", "passingyds"]);
  al("pass_td", ["passtds", "passtd", "passingtds", "passingtd", "passingtouchdowns", "passtouchdowns"]);
  al("pass_att", ["passattempts", "passingattempts", "passatt", "passatts", "passattempt"]);
  al("pass_cmp", ["completions", "passcompletions", "passingcompletions", "passcmp", "cmp", "comp", "comps", "completion"]);
  al("int", ["int", "ints", "interceptions", "interceptionsthrown", "passint", "passints", "passinginterceptions", "interception"]);
  al("rush_yds", ["rushyards", "rushingyards", "rushyds", "rushingyds"]);
  al("rush_att", ["rushattempts", "rushingattempts", "rushatt", "carries", "rushes", "rushattempt"]);
  al("rush_td", ["rushtds", "rushtd", "rushingtds", "rushingtouchdowns"]);
  al("rec_yds", ["receivingyards", "receivingyds", "recyds", "recyards", "recyd"]);
  al("rec", ["receptions", "reception", "recs", "rec", "catches"]);
  al("rec_td", ["rectds", "receivingtds", "receivingtouchdowns", "rectd"]);
  al("targets", ["targets", "receivingtargets", "tgts"]);
  al("rush_rec_yds", ["rush+recyds", "rushrecyds", "rush+recyards", "rush+receivingyards", "rushing+receivingyards", "rushingreceivingyards",
    "rushrecyards", "rush+rec", "rushyds+recyds", "rushyards+recyards", "rushingyards+receivingyards", "rushyards+receivingyards"]);
  al("pass_rush_yds", ["pass+rushyds", "passrushyds", "pass+rushyards", "passing+rushingyards", "passyards+rushyards", "passyds+rushyds"]);
  al("rush_rec_td", ["rush+rectds", "rushrectds", "rush+rectd", "rushing+receivingtds", "rush+receivingtds"]);
  al("longest_rush", ["longestrush", "longrush", "longestrushing"]);
  al("longest_rec", ["longestreception", "longestrec", "longrec"]);
  al("longest_pass", ["longestpass", "longestcompletion", "longpass"]);
  al("fum_lost", ["fumbleslost", "fumlost"]);
  al("kick_pts", ["kickingpoints", "kickingpts", "kickpts", "kickerpoints", "kickerpts"]);
  al("xpm", ["extrapointsmade", "patmade", "xpmade", "xpm"]);
  al("shots", ["shots", "shot", "totalshots", "shotsattempted"]);
  al("sot", ["shotsontarget", "shotontarget", "sot", "shotsongoal", "shotsongoals"]);
  al("goals", ["goals", "goal", "goalsscored", "totalgoals"]);
  al("goal+ast", ["goal+assist", "goals+assists", "goal+assists", "goals+assist", "g+a"]);
  al("passes", ["passesattempted", "passes", "passattempted", "totalpasses", "passesatt"]);
  al("tkl", ["tackles", "tackle", "tkl", "totaltackles"]);
  al("saves", ["goaliesaves", "saves", "gksaves", "keepersaves", "goalkeepersaves", "save"]);
  al("fouls", ["fouls", "foul", "foulscommitted"]);
  al("clr", ["clearances", "clearance", "totalclearance", "totalclearances"]);
  al("conceded", ["goalsallowed", "goalsconceded", "goalallowed"]);
  al("shot_assists", ["shotsassisted", "shotassists", "shotsassists"]);
  al("offsides", ["offsides"]);
  al("crosses", ["crosses", "totalcrosses", "attemptedcrosses", "crossesattempted"]);
  // short combo names (values are component lists, same as "Pts+Rebs+Asts" etc.)
  al(["pts", "reb", "ast"], ["pra", "ptsrebsasts", "pointsreboundsassists", "p+r+a"]);
  al(["pts", "reb"], ["pr", "ptsrebs", "pointsrebounds", "p+r"]);
  al(["pts", "ast"], ["pa", "ptsasts", "pointsassists", "p+a"]);
  al(["reb", "ast"], ["ra", "rebsasts", "reboundsassists", "r+a"]);
  al(["blk", "stl"], ["stocks", "blksstls", "blocksteals", "b+s", "s+b"]);
  const SOC_CORE_ONLY = new Set(["passes", "pass_att", "tkl", "clr", "shot_assists", "crosses"]);

  /** Label -> concept key ("pts", "rush_rec_yds", ...) or a combo array (["pts","reb"]) or null. */
  function concept(label) {
    const sq = squash(label);
    if (!sq) return null;
    if (ALIAS[sq]) return ALIAS[sq];
    if (sq.indexOf("+") > 0) {
      const parts = sq.split("+").map(p => ALIAS[p] || null);
      if (parts.every(Boolean) && new Set(parts).size === parts.length) return parts;
    }
    return null;
  }
  function look(s, keys) { for (const k of keys) { if (s[k] !== undefined) { const v = toNum(s[k]); if (v !== undefined) return v; } } return undefined; }
  function lookPair(s, direct, pairs, idx) {
    const d = look(s, direct); if (d !== undefined) return d;
    for (const k of pairs) { const p = pair(s[k]); if (p) return p[idx]; }
    return undefined;
  }
  const BBK = {
    PTS: ["PTS", "points", "pts"], REB: ["REB", "rebounds", "totalRebounds", "reb"], AST: ["AST", "assists", "ast"], STL: ["STL", "steals", "stl"],
    BLK: ["BLK", "blocks", "blk"], TO: ["TO", "turnovers", "TOV", "tov"], OREB: ["OREB", "offensiveRebounds"], DREB: ["DREB", "defensiveRebounds"],
    PF: ["PF", "fouls"], MIN: ["MIN", "minutes", "min"]
  };
  const BB_PAIRS = {
    "3": [["3PM", "threePointFieldGoalsMade"], ["3PA", "threePointFieldGoalsAttempted"], ["3PT", "threePointFieldGoalsMade-threePointFieldGoalsAttempted"]],
    FG: [["FGM", "fieldGoalsMade"], ["FGA", "fieldGoalsAttempted"], ["FG", "fieldGoalsMade-fieldGoalsAttempted"]],
    FT: [["FTM", "freeThrowsMade"], ["FTA", "freeThrowsAttempted"], ["FT", "freeThrowsMade-freeThrowsAttempted"]]
  };
  const bbPair = (s, g, idx) => lookPair(s, BB_PAIRS[g][idx], BB_PAIRS[g][2], idx);
  function bbValue(c, s) {
    switch (c) {
      case "pts": return look(s, BBK.PTS);
      case "reb": return look(s, BBK.REB);
      case "ast": return look(s, BBK.AST);
      case "stl": return look(s, BBK.STL);
      case "blk": return look(s, BBK.BLK);
      case "tov": return look(s, BBK.TO);
      case "oreb": return look(s, BBK.OREB);
      case "dreb": return look(s, BBK.DREB);
      case "pf": case "fouls": return look(s, BBK.PF);
      case "min": return look(s, BBK.MIN);
      case "3pm": return bbPair(s, "3", 0);
      case "3pa": return bbPair(s, "3", 1);
      case "fgm": return bbPair(s, "FG", 0);
      case "fga": return bbPair(s, "FG", 1);
      case "ftm": return bbPair(s, "FT", 0);
      case "fta": return bbPair(s, "FT", 1);
      case "2pm": { const a = bbPair(s, "FG", 0), b = bbPair(s, "3", 0); return a === undefined || b === undefined ? undefined : a - b; }
      case "2pa": { const a = bbPair(s, "FG", 1), b = bbPair(s, "3", 1); return a === undefined || b === undefined ? undefined : a - b; }
      case "fantasy": {
        const v = ["pts", "reb", "ast", "blk", "stl", "tov"].map(k => bbValue(k, s));
        if (v.some(x => x === undefined)) return undefined;
        return v[0] + 1.2 * v[1] + 1.5 * v[2] + 3 * v[3] + 3 * v[4] - v[5];
      }
      default: return undefined;
    }
  }
  const FBK = {
    passYds: ["passYds", "passingYards"], passTD: ["passTD", "passingTouchdowns"], passInt: ["passInt"], passLong: ["passLong", "longPassing"],
    rushYds: ["rushYds", "rushingYards"], rushAtt: ["rushAtt", "rushingAttempts"], rushTD: ["rushTD", "rushingTouchdowns"], rushLong: ["rushLong", "longRushing"],
    recYds: ["recYds", "receivingYards"], rec: ["rec", "receptions"], recTD: ["recTD", "receivingTouchdowns"], recLong: ["recLong", "longReception"],
    targets: ["targets", "receivingTargets"], fumLost: ["fumLost", "fumblesLost"], krTD: ["krTD", "kickReturnTouchdowns"], prTD: ["prTD", "puntReturnTouchdowns"],
    tackles: ["tackles", "totalTackles"], kickPts: ["kickPts", "totalKickingPoints"]
  };
  /** Football: a player present in the box with no row in a group recorded 0 there, so missing -> 0. */
  function fbValue(c, s) {
    const F = k => { const v = look(s, FBK[k]); return v === undefined ? 0 : v; };
    const P = (direct, idx) => { const v = lookPair(s, direct, ["completions/passingAttempts", "C/ATT"], idx); return v === undefined ? 0 : v; };
    switch (c) {
      case "pass_yds": return F("passYds");
      case "pass_td": return F("passTD");
      case "pass_att": return P(["passAtt", "passingAttempts"], 1);
      case "pass_cmp": return P(["passCmp", "completions"], 0);
      case "int": return F("passInt");
      case "rush_yds": return F("rushYds");
      case "rush_att": return F("rushAtt");
      case "rush_td": return F("rushTD");
      case "rec_yds": return F("recYds");
      case "rec": return F("rec");
      case "rec_td": return F("recTD");
      case "targets": return F("targets");
      case "rush_rec_yds": return F("rushYds") + F("recYds");
      case "pass_rush_yds": return F("passYds") + F("rushYds");
      case "rush_rec_td": return F("rushTD") + F("recTD");
      case "longest_rush": return F("rushLong");
      case "longest_rec": return F("recLong");
      case "longest_pass": return F("passLong");
      case "fum_lost": return F("fumLost");
      case "tkl": return F("tackles");
      case "kick_pts": return F("kickPts");
      case "fgm": { const v = lookPair(s, ["fgm"], ["fieldGoalsMade/fieldGoalAttempts"], 0); return v === undefined ? 0 : v; }
      case "xpm": { const v = lookPair(s, ["xpm"], ["extraPointsMade/extraPointAttempts"], 0); return v === undefined ? 0 : v; }
      case "fantasy": // PrizePicks NFL scoring; 2-pt conversions and fumble-recovery TDs are not in the box score
        return 0.04 * F("passYds") + 4 * F("passTD") - F("passInt") + 0.1 * F("rushYds") + 6 * F("rushTD") + F("rec") +
          0.1 * F("recYds") + 6 * F("recTD") - F("fumLost") + 6 * (F("krTD") + F("prTD"));
      default: return undefined;
    }
  }
  const SOCK = {
    shots: ["shots", "totalShots"], sot: ["sot", "shotsOnTarget"], goals: ["goals", "totalGoals"], ast: ["assists", "goalAssists"],
    passes: ["passes", "totalPasses"], pass_att: ["passes", "totalPasses"], tkl: ["tackles", "totalTackles"], saves: ["saves"],
    fouls: ["fouls", "foulsCommitted"], clr: ["clearances", "totalClearance"], conceded: ["conceded", "goalsConceded"],
    shot_assists: ["shotAssists"], offsides: ["offsides"], crosses: ["crosses", "totalCrosses"], min: ["minutes"]
  };
  function socValue(c, s) {
    if (c === "goal+ast") { const g = look(s, SOCK.goals), a = look(s, SOCK.ast); return g === undefined || a === undefined ? undefined : g + a; }
    return SOCK[c] ? look(s, SOCK[c]) : undefined;
  }
  function genericValue(label, s) {
    const sq = squash(label);
    for (const k of Object.keys(s)) {
      if (squash(k) === sq || squash(k.split(".").pop()) === sq) { const v = toNum(s[k]); if (v !== undefined) return v; }
    }
    return undefined;
  }
  /** PrizePicks stat label -> number from a stats object (box score row or gamelog row); undefined when unknown/missing. */
  function statValue(sport, statLabel, stats) {
    if (!stats || typeof stats !== "object") return undefined;
    const sp = canonSport(sport);
    const kind = kindOf(sp);
    const fn = kind === "bb" ? bbValue : kind === "fb" ? fbValue : kind === "soc" ? socValue : null;
    const c = concept(statLabel);
    let v;
    if (fn && c) {
      if (Array.isArray(c)) {
        let total = 0;
        for (const part of c) { const x = fn(part, stats); if (x === undefined) { total = undefined; break; } total += x; }
        v = total;
      } else v = fn(c, stats);
    }
    if (v === undefined && !(fn && c)) v = genericValue(statLabel, stats);
    return v === undefined || !isFinite(v) ? undefined : round2(v);
  }
  const statSupported = (sport, label) => {
    const k = kindOf(canonSport(sport)), c = concept(label);
    if (!c || k === "gen") return false;
    const probe = k === "bb" ? { PTS: 1, REB: 1, AST: 1, STL: 1, BLK: 1, TO: 1, OREB: 1, DREB: 1, PF: 1, MIN: 1, FG: "1-1", "3PT": "1-1", FT: "1-1" }
      : k === "fb" ? {} : { shots: 1, sot: 1, goals: 1, assists: 1, passes: 1, tackles: 1, saves: 1, fouls: 1, clearances: 1, conceded: 1, shotAssists: 1, offsides: 1, crosses: 1, minutes: 1 };
    return statValue(sport, label, probe) !== undefined;
  };

  // ---------- grading ----------
  function canonSide(s) {
    const t = String(s == null ? "" : s).trim().toLowerCase();
    if (t === "over" || t === "more" || t === "o" || t === "higher") return "over";
    if (t === "under" || t === "less" || t === "u" || t === "lower") return "under";
    return null;
  }
  /** NFL / CFB Fantasy Score from a box score is approximate: it can't see 2-pt conversions (+2) or return and
   *  fumble-recovery TDs (+6). Within FB_FANTASY_MARGIN of the line the true total could land on either side, so the pick
   *  is left for a manual grade instead of a wrong one in the learning data. */
  const FB_FANTASY_MARGIN = 8;
  function fantasyTooClose(sport, stat, line, v) {
    return kindOf(canonSport(sport)) === "fb" && concept(stat) === "fantasy" && Math.abs(v - line) <= FB_FANTASY_MARGIN;
  }
  function gradeAgainst(pick, box, player) {
    if (!pick || !box || !isFinal(box)) return null;
    const line = toNum(pick.line), side = canonSide(pick.side);
    if (line === undefined || !side) return null;
    const sport = pick.sport || (box._meta && box._meta.sport);
    if (box.aet && canonSport(sport) === "Soccer") return null;   // extra time: ESPN totals aren't the 90-minute stats
    if (!arr(box.players).length && !player) return null;   // an empty box after a final is an ESPN glitch, not a DNP
    if (!player || player.dnp) return { result: "void", actual: null };
    const v = statValue(sport, pick.stat, player.stats || {});
    if (v === undefined) return null;
    if (fantasyTooClose(sport, pick.stat, line, v)) return null;
    const actual = round2(v);
    const result = Math.abs(actual - line) < 1e-9 ? "push" : (actual > line) === (side === "over") ? "hit" : "miss";
    return { result, actual };
  }
  /** {result:"hit"|"miss"|"push"|"void", actual} for a final box; null when not final or the stat can't be read. */
  function gradePick(pick, box) {
    if (!pick || !box) return null;
    const info = {};
    const player = findInBox(box.players, pick, info);
    if (!player && info.ambiguous) return null;
    return gradeAgainst(pick, box, player);
  }

  // ---------- search ----------
  const labelTeam = l => { const s = String(l || ""); const i = s.indexOf(" - "); return i >= 0 ? s.slice(i + 3).trim() : undefined; };
  const idFrom = (uid, href) => { const m = /~a:(\d+)/.exec(uid || "") || /\/id\/(\d+)/.exec(href || ""); return m ? m[1] : undefined; };
  function parseV3(j) {
    return arr(j && j.items).filter(it => it && (!it.type || it.type === "player")).map(it => {
      const lg = String(it.league || it.defaultLeagueSlug || "").toLowerCase();
      return { athleteId: str(it.id), name: it.displayName, team: it.teamDisplayName || labelTeam(it.label), league: lg || undefined, sport: sportFrom(it.sport, lg), active: it.isActive };
    });
  }
  function parseV2(j) {
    const out = [];
    for (const r of arr(j && j.results)) {
      if (!r || r.type !== "player") continue;
      for (const c of arr(r.contents)) {
        const lg = String(c.defaultLeagueSlug || "").toLowerCase();
        out.push({ athleteId: idFrom(c.uid, c.link && c.link.web), name: c.displayName, team: c.subtitle || undefined, league: lg || undefined, sport: sportFrom(c.sport, lg) });
      }
    }
    return out;
  }
  /** ESPN athlete search; strips "(NOR)" tags, tolerates accents and initials ("J. Brunson"). */
  async function findPlayer(o) {
    const q = o || {};
    const raw = String(q.name || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (!raw) throw badInput("name required");
    const want = q.sport ? canonSport(q.sport) : null;
    const plain = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const toks = normName(raw).split(" ");
    const queries = [raw];
    if (plain !== raw) queries.push(plain);
    if (toks.length >= 2 && toks[0].length <= 2) queries.push(toks.slice(1).join(" "));   // initial: search the surname
    let found = [], reached = false, lastErr = null;
    for (const query of queries) {
      const enc = encodeURIComponent(query);
      let items = [];
      try { items = parseV3(await getJSON(`${WEB}search?query=${enc}&limit=10&type=player`)); reached = true; } catch (e) { lastErr = e; }
      if (!items.some(x => x.athleteId && x.sport)) {
        try { items = items.concat(parseV2(await getJSON(`${SEARCH_V2}?query=${enc}&limit=10&type=player`))); reached = true; } catch (e) { lastErr = e; }
      }
      items = items.filter(x => x.athleteId && x.sport && (!want || x.sport === want));
      found = found.concat(items);
      if (items.some(x => nameScore(raw, x.name) >= 2)) break;
    }
    if (!reached && lastErr) throw lastErr;
    const seen = new Set();
    const ranked = found.filter(x => (seen.has(x.athleteId) ? false : (seen.add(x.athleteId), true)))
      .map((x, i) => ({ x, s: nameScore(raw, x.name), i }))
      .sort((a, b) => b.s - a.s || (b.x.active === false ? -1 : 0) - (a.x.active === false ? -1 : 0) || a.i - b.i);
    const top = ranked.length ? ranked[0].s : 0;
    const out = ranked.filter(r => top < 2 || r.s >= 1).slice(0, 5).map(r => r.x);
    for (const p of out) { remember(nameCache, p.athleteId, p.name); if (p.sport === "Soccer") remember(athleteLeague, p.athleteId, p.league); }
    return clean(out.map(p => ({ athleteId: p.athleteId, name: p.name, team: p.team, league: p.league, sport: p.sport })));
  }

  // ---------- game log ----------
  const BB_LOG = new Set(["MIN", "PTS", "REB", "AST", "STL", "BLK", "TO", "PF", "OREB", "DREB", "FG", "3PT", "FT"]);
  function parseGamelog(j, sport) {
    const kind = kindOf(sport);
    const names = arr(j && j.names), labels = arr(j && j.labels);
    const groupOf = [];
    let gi = 0;
    for (const c of arr(j && j.categories)) for (let k = 0; k < (Number(c && c.count) || 0); k++) groupOf[gi++] = c.name;
    const evs = (j && j.events && typeof j.events === "object") ? j.events : {};
    const rows = [], seen = new Set();
    for (const st of arr(j && j.seasonTypes)) {
      if (/pre-?season/i.test(String(st && st.displayName || ""))) continue;
      for (const cat of arr(st && st.categories)) {
        if (cat && cat.type && cat.type !== "event") continue;
        for (const e of arr(cat && cat.events)) {
          const eid = str(e && e.eventId);
          if (!eid || seen.has(eid)) continue;
          seen.add(eid);
          const m = evs[eid] || {};
          const t = Date.parse(m.gameDate);
          const home = m.atVs === "vs" ? true : m.atVs === "@" ? false
            : m.homeTeamId && m.team && m.team.id ? String(m.homeTeamId) === String(m.team.id) : undefined;
          const hs = toNum(m.homeTeamScore), as = toNum(m.awayTeamScore);
          let score;
          if (hs !== undefined && as !== undefined && home !== undefined) score = home ? `${hs}-${as}` : `${as}-${hs}`;
          else { const p = pair(m.score); if (p) { const hi = Math.max(p[0], p[1]), lo = Math.min(p[0], p[1]); score = m.gameResult === "L" ? `${lo}-${hi}` : m.gameResult === "W" ? `${hi}-${lo}` : `${p[0]}-${p[1]}`; } }
          const stats = {};
          arr(e.stats).forEach((v, i) => {
            const nm = names[i], lab = labels[i];
            if (kind === "bb") bbAssign(stats, nm, lab, v);
            else if (kind === "fb") fbAssign(stats, groupOf[i], nm, v);
            else if (kind === "soc") socAssign(stats, nm, v, false);
            else if (lab) { const n = toNum(v); if (n !== undefined) stats[groupOf[i] ? groupOf[i] + "." + lab : lab] = n; }
          });
          const row = { eventId: eid, t: isFinite(t) ? t : 0, date: isFinite(t) ? ptDate(t) : undefined, opp: m.opponent && m.opponent.abbreviation,
            home, result: [m.gameResult, score].filter(Boolean).join(" ") || undefined, stats };
          if (kind === "bb") {
            for (const k of Object.keys(stats)) if (!BB_LOG.has(k)) delete stats[k];
            row.min = stats.MIN; delete stats.MIN;
            if (!row.min) { row.dnp = true; row.stats = undefined; }
          } else if (kind === "fb" && Object.keys(stats).every(k => stats[k] === 0)) {
            row.dnp = true; row.stats = undefined;   // an all-zero football row is not proof of playing (dressed backup)
          }
          rows.push(row);
        }
      }
    }
    rows.sort((a, b) => b.t - a.t || String(b.eventId).localeCompare(String(a.eventId)));
    return rows;
  }
  async function gamelogRows(sport, league, athleteId, season) {
    let lg = league;
    if (sport === "Soccer" && !lg) lg = athleteLeague.get(String(athleteId)) || LEAGUES.Soccer[0];
    const url = `${WEB}sports/${pathFor(sport, lg)}/athletes/${encodeURIComponent(athleteId)}/gamelog` + (season ? `?season=${encodeURIComponent(season)}` : "");
    const j = await getJSON(url);
    return { rows: parseGamelog(j, sport), name: j && j.athlete && j.athlete.displayName };
  }
  /** Recent games, newest first. Optional {stat, line}: adds vs:{l5:[overHits,games], l10, avg5, avg10, values}. */
  async function gamelog(o) {
    const q = o || {};
    const { sport, league } = resolveSport(q.sport, q.league);
    const id = str(q.athleteId != null ? q.athleteId : q.athlete_id);
    if (!id || !idOk(id)) throw badInput("athleteId required");
    const season = q.season != null && /^\d{4}$/.test(String(q.season)) ? String(q.season) : null;
    const { rows, name } = await gamelogRows(sport, league, id, season);
    const n = Math.max(1, Math.min(82, Math.floor(toNum(q.last) || 10)));
    const out = { player: nameCache.get(id) || name, rows: rows.slice(0, n).map(r => ({ date: r.date, opp: r.opp, home: r.home, result: r.result, min: r.min, dnp: r.dnp, stats: r.stats })) };
    const line = toNum(q.line);
    if (q.stat && line !== undefined) {
      const vals = rows.filter(r => !r.dnp && r.stats).map(r => statValue(sport, q.stat, r.stats)).filter(v => v !== undefined);
      if (vals.length) {
        const hits = k => [vals.slice(0, k).filter(v => v > line).length, vals.slice(0, k).length];
        const avg = k => { const s = vals.slice(0, k); return s.reduce((x, y) => x + y, 0) / s.length; };
        out.vs = { stat: q.stat, line, l5: hits(5), l10: hits(10), avg5: avg(5), avg10: avg(10), values: vals.slice(0, n) };
      }
    }
    return clean(out);
  }

  // ---------- injuries ----------
  const md = iso => { const d = ptDate(iso); return d ? Number(d.slice(5, 7)) + "/" + Number(d.slice(8, 10)) : null; };
  /** League injury report (or one game's, with eventId). Soccer has no ESPN feed -> Error{code:"unsupported"}. */
  async function injuries(o) {
    const q = o || {};
    const { sport, league } = resolveSport(q.sport, q.league);
    if (sport === "Soccer") throw fail("unsupported", { message: "ESPN has no soccer injury feed; use web search" });
    const eid = q.eventId != null ? q.eventId : q.event_id;
    let blocks;
    if (eid != null && idOk(eid)) {
      const j = await getJSON(summaryUrl(sport, league, String(eid)));
      blocks = arr(j && j.injuries).map(b => ({ abbr: b && b.team && b.team.abbreviation, name: b && b.team && b.team.displayName, id: str(b && b.team && b.team.id), items: arr(b && b.injuries) }));
    } else {
      const j = await getJSON(`${SITE}${pathFor(sport, league)}/injuries`);
      blocks = arr(j && j.injuries).map(b => ({ abbr: b && b.team && b.team.abbreviation, name: b && b.displayName, id: str(b && b.id), items: arr(b && b.injuries) }));
    }
    const team = q.team != null && String(q.team).trim() ? String(q.team).trim() : null;
    const out = [];
    for (const b of blocks) {
      for (const it of b.items) {
        if (!it) continue;
        const ath = it.athlete || {};
        const abbr = (ath.team && ath.team.abbreviation) || b.abbr;
        if (team && !teamMatch(team, { abbr, name: b.name, id: b.id })) continue;
        const status = it.status || (it.type && it.type.description) || undefined;
        if (/^active$/i.test(String(status || ""))) continue;
        const d = it.details || {};
        const brief = [d.type, d.detail && d.detail !== d.type ? String(d.detail).toLowerCase() : null].filter(Boolean).join(" ") +
          (d.returnDate ? (d.type ? " \u00b7 " : "") + "back ~" + md(d.returnDate) : "");
        const comment = String(it.shortComment || "").trim();
        out.push({ team: abbr || b.name, player: ath.displayName, status: status || (d.fantasyStatus && d.fantasyStatus.abbreviation),
          detail: team && comment ? (comment.length > 180 ? comment.slice(0, 177) + "\u2026" : comment) : brief || undefined, date: ptDate(it.date) || undefined });
      }
    }
    return clean(out);
  }

  // ---------- weather (Open-Meteo) ----------
  const US = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
    DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
    KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
    MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
    SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
  function wmo(c) {
    if (c == null) return undefined;
    if (c === 0) return "Clear"; if (c <= 2) return "Partly cloudy"; if (c === 3) return "Overcast";
    if (c === 45 || c === 48) return "Fog"; if (c >= 51 && c <= 57) return "Drizzle"; if (c >= 61 && c <= 67) return "Rain";
    if (c >= 71 && c <= 77) return "Snow"; if (c >= 80 && c <= 82) return "Showers"; if (c === 85 || c === 86) return "Snow showers";
    if (c >= 95) return "Thunderstorm"; return undefined;
  }
  async function geocode(city) {
    const parts = String(city).split(",").map(s => s.trim()).filter(Boolean);
    const name = parts[0], hint = parts.slice(1).join(" ").trim();
    const st = US[hint.toUpperCase()] || Object.values(US).find(v => v.toLowerCase() === hint.toLowerCase());
    const url = `${GEO}?name=${encodeURIComponent(name)}&count=5&language=en&format=json` + (st ? "&countryCode=US" : "");
    const j = await getJSON(url, { ttl: TTL_WEATHER, source: "weather" });
    const res = arr(j && j.results);
    if (!res.length) throw fail("not_found", { message: "place not found" });
    const h = hint.toLowerCase();
    return (st && res.find(r => r.admin1 === st)) || (h && res.find(r => String(r.country || "").toLowerCase() === h || String(r.country_code || "").toLowerCase() === h ||
      String(r.admin1 || "").toLowerCase() === h)) || res[0];
  }
  /** Forecast for the 3 h from `time` (kickoff, ISO). tempF at kickoff, mean wind, max gust & precip chance. */
  async function weather(o) {
    const q = o || {};
    let lat = toNum(q.lat), lon = toNum(q.lon), place;
    if (lat === undefined || lon === undefined) {
      if (!q.city) throw badInput("city or lat/lon required");
      const g = await geocode(q.city);
      lat = g.latitude; lon = g.longitude; place = [g.name, g.admin1 || g.country].filter(Boolean).join(", ");
    }
    if (!isNum(lat) || !isNum(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw badInput("bad lat/lon");
    const t = q.time ? Date.parse(q.time) : env.now();
    if (!isFinite(t)) throw badInput("time must be ISO");
    const start = Math.floor(t / HOUR) * HOUR;
    const hr = ms => new Date(ms).toISOString().slice(0, 13) + ":00";
    const url = `${METEO}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m,weather_code` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&start_hour=${hr(start)}&end_hour=${hr(start + 3 * HOUR)}`;
    const j = await getJSON(url, { ttl: TTL_WEATHER, source: "weather" });
    const h = (j && j.hourly) || {};
    const times = arr(h.time);
    if (!times.length) throw fail("not_found", { message: "no forecast for that time (Open-Meteo covers 16 days)" });
    const i0 = Math.max(0, times.indexOf(hr(start)));
    const win = k => arr(h[k]).slice(i0, i0 + 4).map(toNum).filter(v => v !== undefined);
    const temp = toNum(arr(h.temperature_2m)[i0]);
    const wind = win("wind_speed_10m"), gust = win("wind_gusts_10m"), pp = win("precipitation_probability"), codes = win("weather_code");
    const r0 = x => (x === undefined ? undefined : Math.round(x));
    return clean({
      tempF: r0(temp),
      windMph: wind.length ? r0(wind.reduce((a, b) => a + b, 0) / wind.length) : undefined,
      gustMph: gust.length ? r0(Math.max(...gust)) : undefined,
      precipPct: pp.length ? r0(Math.max(...pp)) : undefined,
      summary: codes.length ? wmo(Math.max(...codes)) : undefined,
      place
    });
  }

  // ---------- pick journal (ai-picks.json, synced like the app's ledger) ----------
  const memStore = (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; })();
  const storage = () => { if (env.storage) return env.storage; try { return getRoot("localStorage") || memStore; } catch (e) { return memStore; } };
  const LS = {
    get(k) { try { const v = storage().getItem("ppl." + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { storage().setItem("ppl." + k, JSON.stringify(v)); } catch (e) { /* quota / private mode */ } }
  };
  const J = { loaded: false, remote: null, outbox: [], view: null, busy: null, again: false, mode: "idle", problem: "", lastOk: null, subs: new Set(), timer: null };
  const FILE = "ai-picks.json";
  const jPath = repo => `/repos/${repo}/contents/${FILE}`;
  const RESULTS = new Set(["pending", "hit", "miss", "push", "void"]);
  function jLoad() {
    if (J.loaded) return;
    J.remote = LS.get("journal");
    const ob = LS.get("journalOutbox");
    J.outbox = Array.isArray(ob) ? ob.filter(o => o && o.id && o.op) : [];
    J.loaded = true; J.view = null;
  }
  const jSave = () => { if (J.dead) return; LS.set("journal", J.remote); LS.set("journalOutbox", J.outbox); };
  function normJ(d) {
    const out = { version: 1, picks: {} };
    if (!d || typeof d !== "object") return out;
    const src = d.picks || {};
    if (Array.isArray(src)) { for (const p of src) if (p && p.id) out.picks[p.id] = Object.assign({}, p); }
    else for (const id of Object.keys(src)) { const p = src[id]; if (p && typeof p === "object" && !Array.isArray(p)) out.picks[id] = Object.assign({}, p, { id }); }
    return out;
  }
  function applyJ(data, ops) {
    const d = normJ(data);
    for (const o of ops) {
      if (!o || !o.id) continue;
      if (o.op === "set") {
        // create-only: a replayed "set" (its PUT landed but the answer was lost) must not reset a pick that another
        // device or a hand edit has graded since
        if (!d.picks[o.id]) d.picks[o.id] = Object.assign({}, o.doc, { id: o.id });
      } else if (o.op === "update") {
        const cur = d.picks[o.id];
        if (!cur) continue;
        let doc = o.doc || {};
        if (cur.gradedBy === "manual" && doc.gradedBy === "espn") {   // a hand grade wins over the auto-grader
          doc = Object.assign({}, doc);
          for (const k of ["result", "actual", "gradedAt", "gradedBy"]) delete doc[k];
        }
        d.picks[o.id] = Object.assign({}, cur, doc, { id: o.id });
      } else if (o.op === "delete") delete d.picks[o.id];
    }
    return d;
  }
  function orderedJ(d) { // newest first, so the file reads like a log
    const ids = Object.keys(d.picks).sort((a, b) => String(d.picks[b].createdAt || "").localeCompare(String(d.picks[a].createdAt || "")) || a.localeCompare(b));
    const picks = {}; for (const id of ids) picks[id] = d.picks[id];
    return { version: 1, picks };
  }
  function jView() { jLoad(); if (!J.view) J.view = applyJ(J.remote && J.remote.data, J.outbox); return J.view; }
  function all() { const v = orderedJ(jView()); return Object.keys(v.picks).map(id => Object.assign({}, v.picks[id])); }
  function get(id) { const p = jView().picks[id]; return p ? Object.assign({}, p) : null; }
  function emit() {
    J.view = null;
    const list = all();
    for (const cb of Array.from(J.subs)) { try { cb(list); } catch (e) { /* a listener's bug must not break the store */ } }
    try { if (root && typeof root.dispatchEvent === "function" && typeof CustomEvent === "function") root.dispatchEvent(new CustomEvent("vici:journal")); } catch (e) { /* ignore */ }
  }
  function onChange(cb) { if (typeof cb !== "function") return () => {}; J.subs.add(cb); return () => J.subs.delete(cb); }
  function queue(o) {
    o.at = env.now();
    const repo = currentRepo();
    if (repo) o.repo = repo;   // made while connected: only ever pushed to this repo (local-mode ops go to the first one)
    J.outbox.push(o); J.view = null;
  }
  function scheduleSync() {
    if (!env.autoSync || J.dead) return;
    if (J.timer) env.clearTimeout(J.timer);
    J.timer = env.setTimeout(() => { J.timer = null; sync(); }, env.syncDelayMs);
  }
  function currentRepo() {
    const V = getRoot("Vici");
    try { if (V && typeof V.gh === "function" && typeof V.repo === "function") { const r = V.repo(); return r && /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null; } } catch (e) { /* ignore */ }
    return null;
  }

  // pick validation
  const cleanStr = (v, n) => { const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); return s ? s.slice(0, n) : ""; };
  const strOrNull = (v, n) => { const s = cleanStr(v, n || 40); return s || null; };
  const numOrNull = v => { const n = toNum(v); return n === undefined ? null : n; };
  const boolOrNull = v => (v === true || v === false ? v : v === "true" ? true : v === "false" ? false : null);
  function isoOrNull(v) { if (v == null || v === "") return null; const t = toMs(v); return isFinite(t) ? new Date(t).toISOString() : null; }
  function ymdOrNull(v) { if (v == null || v === "") return null; try { return ymdOf(v); } catch (e) { return null; } }
  function hitPair(v) {
    let a = v;
    if (typeof v === "string") { const p = /^\s*(\d+)\s*(?:\/|of|-)\s*(\d+)\s*$/.exec(v); a = p ? [Number(p[1]), Number(p[2])] : null; }
    if (!Array.isArray(a) || a.length !== 2) return null;
    const h = toNum(a[0]), g = toNum(a[1]);
    return h !== undefined && g !== undefined && g > 0 && h >= 0 && h <= g ? [Math.round(h), Math.round(g)] : null;
  }
  function normFeatures(f) {
    const x = f && typeof f === "object" ? f : {};
    let opp = numOrNull(x.oppRankPct);
    if (opp != null && opp > 1 && opp <= 100) opp /= 100;
    if (opp != null) opp = Math.min(1, Math.max(0, opp));
    const trend = String(x.minutesTrend || "").toLowerCase();
    const w = x.weather && typeof x.weather === "object" ? { tempF: numOrNull(x.weather.tempF), windMph: numOrNull(x.weather.windMph), precipPct: numOrNull(x.weather.precipPct) } : null;
    return {
      l5: hitPair(x.l5), l10: hitPair(x.l10), seasonAvg: numOrNull(x.seasonAvg), last5Avg: numOrNull(x.last5Avg), projection: numOrNull(x.projection),
      gapPct: numOrNull(x.gapPct), oppRankPct: opp, restDays: numOrNull(x.restDays), b2b: boolOrNull(x.b2b),
      minutesTrend: trend === "up" || trend === "flat" || trend === "down" ? trend : null, injuryFlag: strOrNull(x.injuryFlag, 60),
      weather: w && (w.tempF != null || w.windMph != null || w.precipPct != null) ? w : null
    };
  }
  function newId(now) { return "p" + Math.floor(now).toString(36) + Math.floor(env.random() * 1679616).toString(36).padStart(4, "0"); }
  /** Validate + fill a journal pick. -> {pick} or {error}. */
  function normalizePick(raw, nowArg) {
    const now = nowArg == null ? env.now() : toMs(nowArg);
    if (!raw || typeof raw !== "object") return { error: "pick must be an object" };
    const sport = canonSport(raw.sport) || canonSport(raw.league);
    if (!sport) return { error: "unknown sport" };
    const player = cleanStr(raw.player, 80); if (!player) return { error: "player required" };
    const stat = cleanStr(raw.stat, 48); if (!stat) return { error: "stat required" };
    const line = toNum(raw.line); if (line === undefined || line < 0 || line > 10000) return { error: "line must be a number" };
    const side = canonSide(raw.side); if (!side) return { error: "side must be over/under" };
    let prob = toNum(raw.prob != null ? raw.prob : raw.probability);
    if (prob !== undefined && prob > 1 && prob <= 100) prob /= 100;
    let vici = toNum(raw.vici);   // the Vici % shown on the card (prob after the model's adjustment): model.track's "predicted"
    if (vici !== undefined && vici > 1 && vici <= 100) vici /= 100;
    const gtRaw = raw.gameTime != null ? raw.gameTime : raw.game_time;
    const dayOnly = typeof gtRaw === "string" && /^\s*\d{4}-\d{2}-\d{2}\s*$/.test(gtRaw);   // a day, not a start time:
    const gameTime = dayOnly ? null : isoOrNull(gtRaw);                                     // never read as UTC midnight
    const date = ymdOrNull(raw.date) || (dayOnly ? gtRaw.trim() : gameTime ? ptDate(gameTime) : ptDate(now));
    let league = strOrNull(raw.league, 40);
    league = league ? leagueSlug(league) : null;
    if (sport !== "Soccer") league = DEFAULT_LEAGUE[sport] || league;
    else if (league && !isSoccerSlug(league)) league = null;
    const lt = String(raw.lineType || raw.line_type || "").toLowerCase();
    const tier = String(raw.tier || "").toUpperCase();
    const id = typeof raw.id === "string" && /^p[a-z0-9]{6,20}$/.test(raw.id) ? raw.id : newId(now);
    const ev = raw.eventId != null ? raw.eventId : raw.event_id, ath = raw.athleteId != null ? raw.athleteId : raw.athlete_id;
    return { pick: {
      id, createdAt: new Date(now).toISOString(), convId: cleanStr(raw.convId != null ? raw.convId : raw.conv_id, 64),
      sport, league, player, athleteId: idOk(ath) ? String(ath) : null,
      team: strOrNull(raw.team, 40), opponent: strOrNull(raw.opponent, 40), home: boolOrNull(raw.home),
      eventId: idOk(ev) ? String(ev) : null, gameTime, date,
      stat, line, side, lineType: lt === "goblin" || lt === "demon" ? lt : "standard",
      prob: prob !== undefined && prob > 0 && prob < 1 ? Math.round(prob * 1000) / 1000 : null,
      vici: vici !== undefined && vici > 0 && vici < 1 ? Math.round(vici * 1000) / 1000 : null,
      tier: tier === "A" || tier === "B" || tier === "C" ? tier : "B",
      features: normFeatures(raw.features),
      reasons: cleanStr(raw.reasons != null ? raw.reasons : raw.reason, 300),
      result: "pending", actual: null, gradedAt: null, gradedBy: null
    } };
  }
  const pickKey = p => [p.date, normName(p.player), squash(p.stat), p.side, Number(p.line)].join("|");
  /** Save picks; returns ids aligned with the input (null where a pick was invalid). A repeat of a known pick returns its id. */
  function add(picks) {
    jLoad();
    const now = env.now();
    const view = jView();
    const byKey = new Map(Object.keys(view.picks).map(id => [pickKey(view.picks[id]), view.picks[id]]));
    const ids = [];
    let changed = false;
    for (const raw of arr(picks)) {
      const r = normalizePick(raw, now);
      if (r.error) { ids.push(null); continue; }
      const p = r.pick;
      const dup = view.picks[p.id] || byKey.get(pickKey(p));
      if (dup) {
        ids.push(dup.id);
        if ((dup.result || "pending") === "pending") {
          const patch = {};
          for (const k of ["prob", "vici", "tier", "lineType", "reasons", "features", "eventId", "athleteId", "gameTime", "team", "opponent", "home", "league"]) {
            if (p[k] != null && JSON.stringify(p[k]) !== JSON.stringify(dup[k])) patch[k] = p[k];
          }
          if (Object.keys(patch).length) { queue({ op: "update", id: dup.id, doc: patch }); changed = true; }
        }
        continue;
      }
      queue({ op: "set", id: p.id, doc: p });
      view.picks[p.id] = p; byKey.set(pickKey(p), p);
      ids.push(p.id); changed = true;
    }
    if (changed) { jSave(); emit(); scheduleSync(); }
    return ids;
  }
  const PATCHABLE = ["result", "actual", "gradedAt", "gradedBy", "eventId", "athleteId", "gameTime", "date", "team", "opponent", "home", "league",
    "prob", "vici", "tier", "lineType", "features", "reasons", "line", "side", "stat", "player"];
  function sanitizePatch(patch) {
    const doc = {};
    for (const k of PATCHABLE) if (Object.prototype.hasOwnProperty.call(patch, k)) doc[k] = patch[k];
    if ("result" in doc && !RESULTS.has(doc.result)) delete doc.result;
    if ("actual" in doc) doc.actual = numOrNull(doc.actual);
    if ("side" in doc) { const s = canonSide(doc.side); if (s) doc.side = s; else delete doc.side; }
    if ("line" in doc) { const l = toNum(doc.line); if (l === undefined) delete doc.line; else doc.line = l; }
    if ("features" in doc) doc.features = normFeatures(doc.features);
    if ("reasons" in doc) doc.reasons = cleanStr(doc.reasons, 300);
    return doc;
  }
  function updateQuiet(id, patch) {
    if (!id || !patch || typeof patch !== "object" || !jView().picks[id]) return false;
    const doc = sanitizePatch(patch);
    if (!Object.keys(doc).length) return false;
    queue({ op: "update", id, doc });
    return true;
  }
  function update(id, patch) {
    jLoad();
    if (!updateQuiet(id, patch)) return false;
    jSave(); emit(); scheduleSync();
    return true;
  }
  function commitMsg(ops, base) {
    const known = normJ(base).picks;
    const added = new Map(), graded = new Set(), other = new Set();
    for (const o of ops) {
      if (o.op === "set" && !known[o.id]) added.set(o.id, o.doc || {});
      else if (o.op === "update" && o.doc && o.doc.result && o.doc.result !== "pending") graded.add(o.id);
      else other.add(o.id);
    }
    for (const id of added.keys()) { graded.delete(id); other.delete(id); }
    for (const id of graded) other.delete(id);
    const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const parts = [];
    if (added.size) {
      const sports = Array.from(new Set(Array.from(added.values()).map(d => d.sport).filter(Boolean))).sort();
      parts.push(pl(added.size, "pick") + (sports.length ? ` (${sports.join("/")})` : ""));
    }
    if (graded.size) parts.push("graded " + pl(graded.size, "pick"));
    if (other.size || !parts.length) parts.push("updated " + pl(Math.max(1, other.size), "pick"));
    return "Vici: " + parts.join(" \u00b7 ");
  }
  const toB64 = s => { const b = new TextEncoder().encode(s); let out = ""; for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(out); };
  const fromB64 = s => { const bin = atob(String(s).replace(/\s/g, "")); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new TextDecoder().decode(b); };
  async function gh(path, opts) {
    const V = getRoot("Vici");
    try { return await V.gh(path, opts || {}); }
    catch (e) { throw fail(e && e.code ? e.code : "net"); }
  }
  async function pull(repo) {
    const h = {};
    if (J.remote && J.remote.etag) h["If-None-Match"] = J.remote.etag;
    const res = await gh(jPath(repo), { headers: h });
    if (res.status === 304 && J.remote) { J.remote.at = env.now(); jSave(); return; }
    if (res.status === 404) {
      const r = await gh(`/repos/${repo}`);
      if (!r.ok) throw fail(r.status === 404 ? "no_repo" : r.status);
      J.remote = { repo, sha: null, etag: null, at: env.now(), data: { version: 1, picks: {} } }; jSave(); J.view = null; return;
    }
    if (!res.ok) throw fail(res.status);
    const j = await res.json();
    let text = j && j.encoding === "base64" && typeof j.content === "string" && j.content ? fromB64(j.content) : null;
    if (text == null) {
      const raw = await gh(jPath(repo), { headers: { Accept: "application/vnd.github.raw+json" } });
      if (!raw.ok) throw fail(raw.status);
      text = await raw.text();
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { throw fail("bad_json"); }
    const etag = res.headers && typeof res.headers.get === "function" ? res.headers.get("ETag") : null;
    J.remote = { repo, sha: (j && j.sha) || null, etag: etag || null, at: env.now(), data: normJ(data) };
    jSave(); J.view = null;
  }
  async function push(repo) {
    for (let tries = 0; tries < 4 && J.outbox.length; tries++) {
      const ops = J.outbox.slice(), base = J.remote.data, next = orderedJ(applyJ(base, ops));
      const body = { message: commitMsg(ops, base), content: toB64(JSON.stringify(next, null, 2) + "\n") };
      if (J.remote.sha) body.sha = J.remote.sha;
      const res = await gh(jPath(repo), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        let j = null; try { j = await res.json(); } catch (e) { /* ignore */ }
        J.remote = { repo, sha: (j && j.content && j.content.sha) || null, etag: null, at: env.now(), data: next };
        J.outbox = J.outbox.slice(ops.length); jSave(); J.view = null;
        tries = -1; continue;
      }
      if (res.status === 409 || res.status === 422) { J.remote.etag = null; await pull(repo); continue; } // another device saved first: build on its copy
      throw fail(res.status);
    }
    if (J.outbox.length) throw fail("conflict");
  }
  function status() {
    jLoad();
    return clean({ mode: J.mode, pending: J.outbox.length, picks: Object.keys(jView().picks).length, lastOk: J.lastOk ? new Date(J.lastOk).toISOString() : null, problem: J.problem || null, repo: currentRepo() });
  }
  async function syncOnce() {
    const repo = currentRepo();
    if (!repo) { J.mode = "local"; return; }
    const nav = getRoot("navigator");
    if (nav && nav.onLine === false) { J.mode = "offline"; return; }
    // Another repo now (a new token for a different repo, or another person connected this device): drop the copy and
    // every change made for the old repo, like the app does with its own outbox. Never push them into this repo.
    const otherRepo = !!(J.remote && J.remote.repo && J.remote.repo !== repo);
    const mine = J.outbox.filter(o => !o.repo || o.repo === repo);
    if (otherRepo || mine.length !== J.outbox.length) {
      if (otherRepo) J.remote = null;
      J.outbox = mine; J.view = null; jSave();
    }
    J.mode = "syncing";
    try {
      await pull(repo);
      if (J.outbox.length) await push(repo);
      J.lastOk = env.now(); J.problem = ""; J.mode = "synced";
    } catch (e) {
      const c = e && e.code;
      if (c === "net") { J.mode = "offline"; J.problem = ""; }
      else if (c === "no_auth") { J.mode = "local"; J.problem = ""; }
      else { J.mode = "error"; J.problem = String(c || "error"); }
    }
  }
  /** Pull + push ai-picks.json. Never rejects; resolves to status(). Not connected -> stays local; offline -> outbox kept. */
  function sync() {
    jLoad();
    if (J.dead) return Promise.resolve(status());
    if (J.busy) { J.again = true; return J.busy; }
    if (J.timer) { env.clearTimeout(J.timer); J.timer = null; }
    J.busy = (async () => {
      do { J.again = false; await syncOnce(); } while (J.again);
      emit();
      return status();
    })().catch(() => status()).finally(() => { J.busy = null; });
    return J.busy;
  }
  /** Reads the local cache at once (all() works right after), then resolves with the picks after one sync attempt. */
  function load() {
    jLoad();
    if (!currentRepo()) { J.mode = "local"; return Promise.resolve(all()); }
    return sync().then(() => all(), () => all());
  }
  function resetJournal() { // tests
    if (J.timer) env.clearTimeout(J.timer);
    Object.assign(J, { loaded: false, remote: null, outbox: [], view: null, busy: null, again: false, mode: "idle", problem: "", lastOk: null, timer: null, dead: false });
    J.subs.clear();
  }
  /** "Disconnect this device": drop the cached journal and its unsynced changes from this device. Nothing is saved or
   *  synced again until the page reloads (an in-flight sync may still finish its PUT, but can't write the cache back). */
  function forgetJournal() {
    resetJournal();
    J.dead = true; J.loaded = true;
    for (const k of ["journal", "journalOutbox"]) { try { storage().removeItem("ppl." + k); } catch (e) { /* ignore */ } }
  }
  const journal = { load, all, get, add, update, sync, onChange, status, normalize: normalizePick, forget: forgetJournal, _reset: resetJournal };
  if (root && typeof root.addEventListener === "function") {
    root.addEventListener("online", () => { if (J.loaded && J.outbox.length) sync(); });
    root.addEventListener("vici:data", () => { if (J.loaded && J.outbox.length && currentRepo() && !J.busy) scheduleSync(); }); // device may have just connected
  }

  // ---------- auto-grading ----------
  const FINAL_AFTER = 3.5 * HOUR, POSTPONED_VOID = 36 * HOUR, UNFOUND_VOID_DAYS = 4;
  function isDue(p, now, today) {
    const gt = Date.parse(p.gameTime);
    return (isFinite(gt) && now >= gt + FINAL_AFTER) || (!!p.date && p.date < today);
  }
  async function resolveEvent(p, sport, league) {
    const dates = p.date ? [p.date, addDays(p.date, 1)] : [];   // ESPN days are US-Eastern; a late PT game sits on the next one
    // The player's own team is implied once the player is found (game log, box score); the opponent is not, so a known
    // opponent must match too. Otherwise a back-to-back or an opponent's other game could be taken for this one.
    const oppOk = abbrOrName => !p.opponent || teamMatch(p.opponent, abbrOrName);
    if (p.team || p.opponent) {
      const leagues = sport === "Soccer" && league ? [league, null] : [sport === "Soccer" ? null : league];
      for (const lg of leagues) for (const d of dates) {
        const ev = await findEvent({ sport, league: lg, date: d, team: p.team, opponent: p.opponent, ptDate: p.date });
        if (ev) return { eventId: ev.eventId, league: ev.league || lg };
      }
    }
    if (p.athleteId && p.date) {
      const g = await gamelogRows(sport, league, p.athleteId).catch(() => null);
      const r = g && g.rows.find(x => x.date === p.date && (!x.opp || oppOk({ abbr: x.opp })));
      if (r) return { eventId: r.eventId, league };
    }
    if (sport !== "Soccer" && p.date) { // last resort: look for the player in each box score of the day
      for (const d of dates) {
        const list = (await scoreboardRaw({ sport, league, date: d })).filter(e => !e.start || ptDate(e.start) === p.date).slice(0, 16);
        for (const e of list) {
          if (!isFinal(e)) continue;
          if (p.opponent && !(oppOk(e.home) || oppOk(e.away))) continue;
          const box = await boxScore({ sport, league: e.league, eventId: e.eventId }).catch(() => null);
          const pl = box && findInBox(box.players, p);
          if (pl && nameScore(p.player, pl.name) >= 2) return { eventId: e.eventId, league: e.league };
        }
      }
    }
    return null;
  }
  /** Grade from the player's own ESPN game log (site.web.api) when the box score or scoreboard (site.api) can't be
   *  loaded: from a phone, ESPN's CDN refuses some site.api requests. NBA / NFL / CFB only (a soccer log can't tell
   *  extra time). Returns a grade, null (try again later) or undefined (the log can't decide either). */
  const LOG_GRADED = new Set(["NBA", "NFL", "CFB", "WNBA", "CBB"]);
  async function gradeFromLog(p, sport, league, eventId, now) {
    if (!LOG_GRADED.has(sport)) return undefined;
    const extra = {};
    let aid = p.athleteId && idOk(p.athleteId) ? String(p.athleteId) : null;
    if (!aid) {
      const hits = await findPlayer({ name: p.player, sport }).catch(() => []);
      const h = hits.filter(x => nameScore(p.player, x.name) >= 2);
      if (h.length !== 1) return undefined;   // not found, or two players fit the name
      aid = String(h[0].athleteId);
      extra.athleteId = aid;
    }
    const g = await gamelogRows(sport, league, aid).catch(() => undefined);
    if (g === undefined) return undefined;
    const oppOk = r => !p.opponent || !r.opp || teamMatch(p.opponent, { abbr: r.opp });
    let rows = eventId ? g.rows.filter(r => r.eventId === eventId) : g.rows.filter(r => r.date === p.date && oppOk(r));
    if (rows.length > 1) return undefined;   // a doubleheader-like clash: can't tell which game
    const r = rows[0];
    if (!r) {
      // no row: the log isn't updated yet, or he didn't play. Only call it a DNP well after the game.
      const ref = Date.parse(p.gameTime) || Date.parse((p.date || "") + "T20:00:00Z");
      return isFinite(ref) && now - ref > POSTPONED_VOID ? { result: "void", actual: null, extra } : null;
    }
    if (!eventId) extra.eventId = r.eventId;
    if (r.dnp || !r.stats) return { result: "void", actual: null, extra };
    if (!/^[WLT]\b/.test(String(r.result || ""))) return null;   // a game log row without W/L/T isn't final yet
    const line = toNum(p.line), side = canonSide(p.side);
    const v = statValue(sport, p.stat, r.stats);
    if (line === undefined || !side || v === undefined) return null;
    if (fantasyTooClose(sport, p.stat, line, v)) return { manual: "fantasy score near the line", extra };
    const actual = round2(v);
    return { result: Math.abs(actual - line) < 1e-9 ? "push" : (actual > line) === (side === "over") ? "hit" : "miss", actual, extra };
  }
  async function gradeOne(p, now, today) {
    try {
      return await gradeFromBox(p, now, today);
    } catch (e) {
      if (!e || e.code !== "espn_unreachable") throw e;
      const sport = canonSport(p.sport);
      const g = await gradeFromLog(p, sport, DEFAULT_LEAGUE[sport], p.eventId && idOk(p.eventId) ? String(p.eventId) : null, now);
      if (g === undefined) throw e;
      return g;
    }
  }
  async function gradeFromBox(p, now, today) {
    const sport = canonSport(p.sport);
    if (!sport) return null;
    let league = sport === "Soccer" ? (p.league && isSoccerSlug(p.league) ? p.league : null) : DEFAULT_LEAGUE[sport];
    let eventId = p.eventId && idOk(p.eventId) ? String(p.eventId) : null;
    const extra = {};
    if (!eventId) {
      const ev = await resolveEvent(p, sport, league);
      if (!ev) {
        if (p.date && addDays(p.date, UNFOUND_VOID_DAYS) <= today) return { result: "void", actual: null, extra };
        return null;
      }
      eventId = ev.eventId; league = ev.league || league;
      extra.eventId = eventId;
      if (sport === "Soccer" && league && league !== p.league) extra.league = league;
    }
    const box = await boxScore({ sport, league, eventId });
    if (sport === "Soccer" && !league && box._meta) { league = box._meta.league; if (league) extra.league = league; }
    if (!isFinal(box)) {
      if (box.state === "post" && box.completed === false) { // postponed / cancelled
        const ref = Date.parse(p.gameTime) || Date.parse(p.date + "T20:00:00Z");
        if (isFinite(ref) && now - ref > POSTPONED_VOID) return { result: "void", actual: null, extra };
      }
      return null;
    }
    // Went to extra time / penalties: PrizePicks counts 90 minutes + stoppage only, and ESPN can't split the totals.
    // Leave it pending for a manual grade (before any DNP / void logic: a sub who came on in extra time didn't play the 90).
    if (sport === "Soccer" && box.aet) return { manual: "extra time", extra };
    const info = {};
    let target = findInBox(box.players, p, info);
    if (!target && info.ambiguous) return null;   // two players fit the name: leave it for a manual grade
    if (!target && (sport === "NFL" || sport === "CFB")) {
      // Football boxes list only players who recorded a stat; the game log tells "played, no stat" from "inactive".
      let aid = p.athleteId;
      if (!aid) {
        const hits = await findPlayer({ name: p.player, sport }).catch(() => []);
        const h = hits.find(x => nameScore(p.player, x.name) >= 2);
        aid = h && h.athleteId;
      }
      if (aid) {
        const g = await gamelogRows(sport, league, aid).catch(() => undefined);
        if (g === undefined) return null;   // ESPN hiccup: try again later
        const r = g.rows.find(x => x.eventId === eventId);
        if (r && r.stats) target = { athleteId: aid, name: p.player, stats: r.stats };
      }
    }
    if (target && !target.dnp && sport === "Soccer") {
      const c = concept(p.stat);
      const needCore = c && !Array.isArray(c) && SOC_CORE_ONLY.has(c) && statValue(sport, p.stat, target.stats || {}) === undefined;
      if (needCore) {
        const teamId = box._meta && box._meta.athleteTeam[target.athleteId];
        const core = await soccerPlayerStats({ league, eventId, teamId, athleteId: target.athleteId }).catch(() => null);
        if (!core) return null;
        target = core.app === 0 ? Object.assign({}, target, { dnp: true }) : Object.assign({}, target, { stats: Object.assign({}, target.stats, core) });
      }
    }
    if (target && !target.dnp && (sport === "NFL" || sport === "CFB")) {
      const v = statValue(sport, p.stat, target.stats || {}), line = toNum(p.line);
      if (v !== undefined && line !== undefined && fantasyTooClose(sport, p.stat, line, v)) {
        return { manual: "fantasy score near the line", extra };   // stays pending: Angus grades it from PrizePicks
      }
    }
    const g = gradeAgainst(p, box, target);
    if (!g) return null;
    if (target && target.athleteId && !p.athleteId) extra.athleteId = String(target.athleteId);
    return Object.assign({}, g, { extra });
  }
  /** Grade pending journal picks whose game should be over (gameTime + 3.5 h, or date before today PT).
   *  One run at a time: the chat grades in the background and from its grade_picks tool, so a second call while a run is
   *  in flight waits for it and then grades whatever is still due (normally nothing). */
  let gradeRun = null;
  function gradeJournal(o) {
    const prev = gradeRun || Promise.resolve();
    const run = prev.catch(() => null).then(() => gradeJournalOnce(o));
    gradeRun = run;
    run.then(() => { if (gradeRun === run) gradeRun = null; }, () => { if (gradeRun === run) gradeRun = null; });
    return run;
  }
  async function gradeJournalOnce(o) {
    jLoad();
    const q = o || {};
    const now = toMs(q.now) != null && isFinite(toMs(q.now)) ? toMs(q.now) : env.now();
    const today = ptDate(now);
    const pending = all().filter(p => (p.result || "pending") === "pending");
    const due = pending.filter(p => isDue(p, now, today));
    let still = pending.length - due.length, errors = 0, lastErr = null, touched = false;
    const items = [], manual = [];
    const results = await mapLimit(due, 4, p => gradeOne(p, now, today).catch(e => { errors++; lastErr = e; return null; }));
    results.forEach((g, i) => {
      const p = due[i];
      if (!g) { still++; return; }
      if (g.manual) {   // stays pending; record the event found so the next run doesn't search again
        still++;
        manual.push({ id: p.id, player: p.player, stat: p.stat, line: p.line, side: p.side, why: g.manual });
        if (g.extra && Object.keys(g.extra).length && updateQuiet(p.id, g.extra)) touched = true;
        return;
      }
      updateQuiet(p.id, Object.assign({ result: g.result, actual: g.actual, gradedAt: new Date(now).toISOString(), gradedBy: "espn" }, g.extra));
      items.push({ id: p.id, player: p.player, stat: p.stat, line: p.line, side: p.side, result: g.result, actual: g.actual });
    });
    if (items.length || touched) { jSave(); emit(); if (currentRepo()) sync(); }
    return clean({ graded: items.length, still, errors: errors || undefined, error: !items.length && lastErr ? lastErr.code || "error" : undefined, items,
      manual: manual.length ? manual : undefined });
  }

  // ---------- export ----------
  const api = {
    version: 1,
    LEAGUES, STATS,
    scoreboard, findPlayer, gamelog, boxScore, injuries, weather,
    statValue, gradePick, journal, gradeJournal,
    findEvent, soccerPlayerStats, statSupported, normalizePick, isFinal,
    normName, nameScore, teamMatch, ptDate, canonSport, clean, clearCache,
    _env: env
  };
  if (root) root.ViciData = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null);
