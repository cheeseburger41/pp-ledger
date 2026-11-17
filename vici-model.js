/* vici-model.js — Vici learning engine (window.ViciModel).
 *
 * Pure functions: no DOM, no network, no randomness, no clock (time only via build({now})).
 * Learns from two separate sources:
 *   "bot" = graded journal picks (ai-picks.json; hit/miss only, push/void/pending excluded)
 *   "you" = graded ledger legs   (ledger.json;   hit/miss only, push/pending excluded)
 *
 *   ViciModel.build({journal, ledger, now}) -> Model
 *   ViciModel.adjust(model, rawProb, {sport, stat, side, tier, features}) -> {p, parts, note}
 *   ViciModel.breakEven(n, type) / edge(p, n, type) / promptBlock(model) / summary(model) / compact(model)
 *
 * Statistics:
 *   - Hit rates: nested Beta shrinkage. global ~ Beta(10,10) + data; sport, sport|stat, sport|stat|side each use
 *     Beta(k*m, k*(1-m)) with m = parent's posterior mean, k = 15. 80% interval = normal approx to the Beta.
 *   - Calibration: logit(p*) = a + b*logit(p), MAP by damped Newton, priors a~N(0,.35^2), b~N(1,.25^2).
 *   - Factors: L2 (lambda=1) logistic regression on standardized features, n >= 40, SEs from the inverse Hessian.
 */
(function (root) {
  "use strict";

  // ---------- constants ----------
  const POWER = { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 };
  const FLEX = { 3: { 3: 3, 2: 1 }, 4: { 4: 6, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 } };
  const K = 15;                 // prior strength for each nested level
  const G_STRENGTH = 20;        // global prior Beta(10,10)
  const Z80 = 1.2815515655446004;
  const THIN = 10;              // n below this → "thin"
  const CAL_MIN = 15;           // calibration verdict needs this many graded bot picks
  const CAL_SA = 0.35, CAL_SB = 0.25;
  const FACTOR_MIN = 40, LAMBDA = 1, LAMBDA0 = 1e-3;
  const RESID_MIN = 10, RESID_K = 30;
  const P_MIN = 0.30, P_MAX = 0.85;
  const BUCKETS = [
    { label: "50-55", lo: 0, hi: 0.55 },     // lowest bucket also holds anything under 50%
    { label: "55-60", lo: 0.55, hi: 0.60 },
    { label: "60-65", lo: 0.60, hi: 0.65 },
    { label: "65-70", lo: 0.65, hi: 0.70 },
    { label: "70+", lo: 0.70, hi: 1.0000001 }
  ];

  // ---------- numeric helpers ----------
  const isNum = v => typeof v === "number" && isFinite(v);
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  function toNum(v) {
    if (v == null || v === "" || typeof v === "boolean") return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  function sigmoid(z) {
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    const e = Math.exp(z);
    return e / (1 + e);
  }
  function logit(p) {
    const q = clamp(p, 1e-6, 1 - 1e-6);
    return Math.log(q / (1 - q));
  }
  const softplus = z => (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)));
  const sum = (arr, f) => { let s = 0; for (let i = 0; i < arr.length; i++) s += f(arr[i], i); return s; };

  /** Gauss-Jordan inverse with partial pivoting. Returns null when (near) singular or non-finite. */
  function invert(M) {
    const n = M.length;
    if (!n) return [];
    let scale = 0;
    for (const row of M) for (const v of row) { if (!isNum(v)) return null; scale = Math.max(scale, Math.abs(v)); }
    if (!(scale > 0)) return null;
    const A = M.map((row, i) => {
      const r = row.slice(0, n);
      for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
      return r;
    });
    for (let c = 0; c < n; c++) {
      let p = c, best = Math.abs(A[c][c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r][c]); if (v > best) { best = v; p = r; } }
      if (!(best > 1e-13 * scale)) return null;
      if (p !== c) { const t = A[p]; A[p] = A[c]; A[c] = t; }
      const piv = A[c][c];
      for (let j = 0; j < 2 * n; j++) A[c][j] /= piv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c];
        if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
      }
    }
    const out = A.map(row => row.slice(n));
    for (const row of out) for (const v of row) if (!isNum(v)) return null;
    return out;
  }
  /** 2x2 inverse (closed form); null when singular. */
  function inv2(m) {
    const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    if (!isNum(det) || Math.abs(det) < 1e-14) return null;
    return [[m[1][1] / det, -m[0][1] / det], [-m[1][0] / det, m[0][0] / det]];
  }
  const matVec = (M, v) => M.map(row => sum(row, (x, j) => x * v[j]));

  /** Beta posterior with prior mean m and strength s after `hits` of `n`; normal-approx 80% interval. */
  function betaPost(hits, n, m, s) {
    const a = s * m + hits, b = s * (1 - m) + (n - hits);
    const t = a + b;
    const post = a / t;
    const sd = Math.sqrt((a * b) / (t * t * (t + 1)));
    return { post, lo80: clamp(post - Z80 * sd, 0, 1), hi80: clamp(post + Z80 * sd, 0, 1), alpha: a, beta: b };
  }
  function verdictOf(n, post, lo80, hi80) {
    if (n < THIN) return "thin";
    if (post >= 0.585 && lo80 >= 0.52) return "trust";
    if (post <= 0.47 && hi80 <= 0.56) return "fade";
    return "neutral";
  }

  // ---------- payouts ----------
  const comb = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  /** Per-leg break-even probability for an n-pick Power or Flex slip (standard multipliers); null if no table. */
  function breakEven(n, type) {
    n = Number(n);
    const t = String(type || "power").toLowerCase();
    if (t === "flex") {
      const tiers = FLEX[n];
      if (!tiers) return null;
      const f = p => Object.keys(tiers).reduce((s, k) => s + comb(n, +k) * Math.pow(p, +k) * Math.pow(1 - p, n - +k) * tiers[k], 0);
      let lo = 0, hi = 1;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) >= 1) hi = mid; else lo = mid; }
      return hi;
    }
    const m = POWER[n];
    return m ? Math.pow(1 / m, 1 / n) : null;
  }
  function edge(p, n, type) {
    const be = breakEven(n == null ? 2 : n, type);
    return be == null || !isNum(p) ? null : p - be;
  }

  // ---------- normalization ----------
  const SPORTS = { NBA: "NBA", NFL: "NFL", CFB: "CFB", NCAAF: "CFB", "COLLEGE FOOTBALL": "CFB", SOCCER: "Soccer", FUTBOL: "Soccer" };
  function canonSport(s) {
    const t = String(s == null ? "" : s).trim().replace(/\s+/g, " ");
    if (!t) return "Other";
    return SPORTS[t.toUpperCase()] || t;
  }
  function canonSide(s) {
    const t = String(s == null ? "" : s).trim().toLowerCase();
    if (t === "over" || t === "more" || t === "o" || t === "higher") return "over";
    if (t === "under" || t === "less" || t === "u" || t === "lower") return "under";
    return null;
  }
  function canonResult(s) {
    const t = String(s == null ? "" : s).trim().toLowerCase();
    if (t === "hit" || t === "win" || t === "won") return "hit";
    if (t === "miss" || t === "loss" || t === "lost") return "miss";
    if (t === "push" || t === "tie") return "push";
    if (t === "void" || t === "dnp" || t === "cancelled" || t === "canceled") return "void";
    return "pending";
  }

  // Canonical stat keys → readable label (the app's PrizePicks labels where they exist).
  const STAT_LABEL = {
    pts: "Points", reb: "Rebounds", ast: "Assists", blk: "Blocks", stl: "Steals", tov: "Turnovers",
    "pts+reb+ast": "Pts+Rebs+Asts", "pts+reb": "Pts+Rebs", "pts+ast": "Pts+Asts", "reb+ast": "Rebs+Asts", "blk+stl": "Blks+Stls",
    "3pm": "3-PT Made", fantasy: "Fantasy Score",
    pass_yds: "Pass Yards", pass_td: "Pass TDs", pass_att: "Pass Attempts", pass_cmp: "Completions", int: "INT",
    rush_yds: "Rush Yards", rush_att: "Rush Attempts", rush_td: "Rush TDs", rec_yds: "Receiving Yards", rec: "Receptions",
    rec_td: "Rec TDs", rush_rec_yds: "Rush+Rec Yds", pass_rush_yds: "Pass+Rush Yds", kick_pts: "Kicking Points",
    fg_made: "FG Made", consec_cmp: "Consecutive Completions", longest_rec: "Longest Reception", longest_rush: "Longest Rush",
    shots: "Shots", sot: "Shots On Target", goal: "Goals", "goal+ast": "Goal + Assist", passes: "Passes Attempted",
    tkl: "Tackles", saves: "Goalie Saves", fouls: "Fouls", clr: "Clearances", goals_allowed: "Goals Allowed"
  };
  // Whole-label aliases (after squash: lowercase, "and"/"&"/"plus" → "+", everything but [a-z0-9+] removed).
  const WHOLE = {};
  const alias = (key, list) => list.forEach(a => { WHOLE[a] = key; });
  alias("pts+reb+ast", ["pra", "ptsrebsasts", "pointsreboundsassists", "p+r+a"]);
  alias("pts+reb", ["pr", "ptsrebs", "p+r"]);
  alias("pts+ast", ["pa", "ptsasts", "p+a"]);
  alias("reb+ast", ["ra", "rebsasts", "r+a"]);
  alias("blk+stl", ["stocks", "blksstls", "b+s"]);
  alias("3pm", ["3ptmade", "3pm", "3ptm", "3pt", "3ptsmade", "3pointersmade", "3pointsmade", "threes", "threesmade", "threepointersmade", "3pointfieldgoalsmade", "3s"]);
  alias("fantasy", ["fantasyscore", "fantasy", "fantasypoints", "fantasypts", "fs", "fpts"]);
  alias("tov", ["turnovers", "turnover", "to", "tov", "tos"]);
  alias("pass_yds", ["passyards", "passingyards", "passyds", "passyd", "pyds", "passingyds"]);
  alias("pass_td", ["passtds", "passtd", "passingtds", "passingtd", "passingtouchdowns", "passtouchdowns"]);
  alias("pass_att", ["passattempts", "passingattempts", "passatt", "passatts", "attempts"]);
  alias("pass_cmp", ["completions", "passcompletions", "passingcompletions", "passcmp", "cmp", "comp", "comps"]);
  alias("int", ["int", "ints", "interceptions", "interceptionsthrown", "passint", "passints", "passinginterceptions"]);
  alias("rush_yds", ["rushyards", "rushingyards", "rushyds", "rushingyds", "ryds"]);
  alias("rush_att", ["rushattempts", "rushingattempts", "rushatt", "carries", "rushes"]);
  alias("rush_td", ["rushtds", "rushtd", "rushingtds", "rushingtouchdowns"]);
  alias("rec_yds", ["receivingyards", "receivingyds", "recyds", "recyards", "recyd", "recvyds"]);
  alias("rec", ["receptions", "reception", "recs", "rec", "catches"]);
  alias("rec_td", ["rectds", "receivingtds", "receivingtouchdowns"]);
  alias("rush_rec_yds", ["rush+recyds", "rushrecyds", "rush+recyards", "rush+receivingyards", "rushing+receivingyards", "rushingreceivingyards", "rushrecyards", "rush+rec"]);
  alias("pass_rush_yds", ["pass+rushyds", "passrushyds", "pass+rushyards", "passing+rushingyards"]);
  alias("kick_pts", ["kickingpts", "kickingpoints", "kickpts", "kickerpoints", "kickerpts"]);
  alias("fg_made", ["fgmade", "fieldgoalsmade", "fgm"]);
  alias("consec_cmp", ["consecutivecompletions", "consecutivepasscompletions", "consecutivecmp"]);
  alias("longest_rec", ["longestreception", "longestrec"]);
  alias("longest_rush", ["longestrush"]);
  alias("shots", ["shots", "shot", "totalshots", "shotsattempted"]);
  alias("sot", ["shotsontarget", "shotontarget", "sot", "shotsongoal"]);
  alias("goal", ["goals", "goal", "goalsscored"]);
  alias("goal+ast", ["goal+assist", "goals+assists", "goal+assists", "goals+assist", "goalassist", "goalsassists", "ga", "g+a"]);
  alias("passes", ["passesattempted", "passes", "passattempted", "passesatt", "totalpasses"]);
  alias("tkl", ["tackles", "tackle", "tkl", "tackleswon"]);
  alias("saves", ["goaliesaves", "saves", "gksaves", "keepersaves", "goalkeepersaves"]);
  alias("fouls", ["fouls", "foul", "foulscommitted"]);
  alias("clr", ["clearances", "clearance"]);
  alias("goals_allowed", ["goalsallowed", "goalsconceded"]);
  // Components for combo labels ("Points + Rebounds", "Rebs+Asts", "Goal + Assist" ...).
  const COMP = {
    points: "pts", point: "pts", pts: "pts", pt: "pts",
    rebounds: "reb", rebound: "reb", rebs: "reb", reb: "reb", boards: "reb",
    assists: "ast", assist: "ast", asts: "ast", ast: "ast",
    blocks: "blk", block: "blk", blks: "blk", blk: "blk",
    steals: "stl", steal: "stl", stls: "stl", stl: "stl",
    turnovers: "tov", turnover: "tov", tov: "tov",
    goals: "goal", goal: "goal"
  };
  const COMP_ORDER = ["pts", "goal", "reb", "ast", "blk", "stl", "tov"];
  const squash = s => String(s == null ? "" : s).toLowerCase()
    .replace(/&|\band\b|\bplus\b/g, "+")
    .replace(/[^a-z0-9+]/g, "")
    .replace(/\++/g, "+")
    .replace(/^\+|\+$/g, "");
  function tidyLabel(s) {
    const t = String(s == null ? "" : s).trim().replace(/\s+/g, " ").slice(0, 48);
    if (!t) return "Unknown";
    return t === t.toLowerCase() ? t.replace(/\b[a-z]/g, c => c.toUpperCase()) : t;
  }
  /** Canonical stat {key, label}. Case/spacing/abbreviation tolerant; unknown stats keep a readable label. */
  function canonStat(sport, stat) {
    const sq = squash(stat);
    if (!sq) return { key: "unknown", label: "Unknown", known: false };
    let key = WHOLE[sq] || null;
    if (!key && sq.indexOf("+") > 0) {
      const parts = sq.split("+").map(p => COMP[p] || null);
      if (parts.every(Boolean) && new Set(parts).size === parts.length) {
        key = parts.slice().sort((x, y) => COMP_ORDER.indexOf(x) - COMP_ORDER.indexOf(y)).join("+");
      }
    }
    if (!key && COMP[sq]) key = COMP[sq];
    if (key === "pass_att" && canonSport(sport) === "Soccer") key = "passes";
    if (key) {
      const label = STAT_LABEL[key] || key.split("+").map(c => STAT_LABEL[c] || c).join("+");
      return { key, label, known: true };
    }
    return { key: "x:" + sq, label: tidyLabel(stat), known: false };
  }

  // ---------- input handling ----------
  /** Accept an array, an id→item map, or a wrapper ({entries:{...}} / {picks:{...}}). Never mutates input. */
  function toList(x, wrapKey) {
    if (!x) return [];
    if (Array.isArray(x)) return x.filter(v => v && typeof v === "object");
    if (typeof x !== "object") return [];
    if (wrapKey && x[wrapKey] && typeof x[wrapKey] === "object" && (wrapKey !== "picks" || !Array.isArray(x[wrapKey]))) {
      return toList(x[wrapKey]);
    }
    return Object.keys(x).sort().map(k => {
      const v = x[k];
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      return v.id == null ? Object.assign({ id: k }, v) : v;
    }).filter(Boolean);
  }
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const s0 = v => (v == null ? "" : String(v));

  function baseRow(p, sport, y) {
    const st = canonStat(sport, p.stat);
    return {
      sport, statKey: st.key, statLabel: st.label, side: canonSide(p.side), y,
      prob: null, cal: null, tier: null, home: null, lineType: "standard", f: null
    };
  }
  function ledgerRows(ledger) {
    const entries = toList(ledger, "entries").slice().sort((a, b) =>
      cmpStr(s0(a.date), s0(b.date)) || cmpStr(s0(a.createdAt), s0(b.createdAt)) || cmpStr(s0(a.id), s0(b.id)));
    const rows = [], excluded = { push: 0, void: 0, pending: 0 };
    for (const e of entries) {
      const picks = Array.isArray(e.picks) ? e.picks : [];
      for (const p of picks) {
        if (!p || typeof p !== "object") continue;
        const res = canonResult(p.result);
        if (res !== "hit" && res !== "miss") { excluded[res]++; continue; }
        rows.push(baseRow(p, canonSport(p.sport), res === "hit" ? 1 : 0));
      }
    }
    return { rows, excluded };
  }
  function journalRows(journal) {
    const picks = toList(journal, "picks").slice().sort((a, b) =>
      cmpStr(s0(a.createdAt), s0(b.createdAt)) || cmpStr(s0(a.id), s0(b.id)) || cmpStr(s0(a.player), s0(b.player)));
    const rows = [], excluded = { push: 0, void: 0, pending: 0, noProb: 0 };
    for (const p of picks) {
      const res = canonResult(p.result);
      if (res !== "hit" && res !== "miss") { excluded[res]++; continue; }
      const r = baseRow(p, canonSport(p.sport), res === "hit" ? 1 : 0);
      let prob = toNum(p.prob);
      if (prob != null && prob > 1 && prob <= 100) prob /= 100;
      r.prob = prob != null && prob > 0 && prob < 1 ? prob : null;
      if (r.prob == null) excluded.noProb++;
      const tier = String(p.tier == null ? "" : p.tier).trim().toUpperCase();
      r.tier = tier === "A" || tier === "B" || tier === "C" ? tier : null;
      r.home = typeof p.home === "boolean" ? p.home : null;
      const lt = String(p.lineType == null ? "" : p.lineType).trim().toLowerCase();
      r.lineType = lt === "goblin" || lt === "demon" ? lt : "standard";
      r.f = p.features && typeof p.features === "object" && !Array.isArray(p.features) ? p.features : null;
      rows.push(r);
    }
    return { rows, excluded };
  }

  // ---------- segments ----------
  function groupBy(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (k == null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return Array.from(m.keys()).sort(cmpStr).map(k => [k, m.get(k)]);
  }
  function makeSeg(source, level, key, label, meta, rows, priorMean, strength) {
    const n = rows.length, hits = sum(rows, r => r.y);
    const b = betaPost(hits, n, priorMean, strength);
    const seg = Object.assign({ source, level, key, label }, meta, {
      n, hits, raw: n ? hits / n : null, prior: priorMean, post: b.post, lo80: b.lo80, hi80: b.hi80,
      verdict: verdictOf(n, b.post, b.lo80, b.hi80)
    });
    if (source === "bot") {
      const P = rows.filter(r => r.prob != null);
      seg.nP = P.length;
      if (P.length) {
        seg.pred = sum(P, r => r.prob) / P.length;
        seg.cal = sum(P, r => r.cal) / P.length;
        seg.resid = sum(P, r => r.y) / P.length - seg.cal;
      } else { seg.pred = null; seg.cal = null; seg.resid = null; }
    }
    return seg;
  }
  const sideWord = s => (s === "over" ? "over" : s === "under" ? "under" : "");
  function analyzeSource(source, rows, excluded) {
    const all = makeSeg(source, "all", "all", source === "bot" ? "Bot picks" : "Your legs", {}, rows, 0.5, G_STRENGTH);
    const segments = [];
    for (const [sport, sRows] of groupBy(rows, r => r.sport)) {
      const sp = makeSeg(source, "sport", sport, sport, { sport, stat: null, statLabel: null, side: null }, sRows, all.post, K);
      segments.push(sp);
      for (const [statKey, tRows] of groupBy(sRows, r => r.statKey)) {
        const statLabel = tRows[0].statLabel;
        const st = makeSeg(source, "stat", sport + "|" + statKey, sport + " " + statLabel,
          { sport, stat: statKey, statLabel, side: null }, tRows, sp.post, K);
        segments.push(st);
        for (const [side, dRows] of groupBy(tRows, r => r.side)) {
          segments.push(makeSeg(source, "side", sport + "|" + statKey + "|" + side, sport + " " + statLabel + " " + sideWord(side),
            { sport, stat: statKey, statLabel, side }, dRows, st.post, K));
        }
      }
    }
    const LV = { sport: 0, stat: 1, side: 2 };
    segments.sort((a, b) => LV[a.level] - LV[b.level] || b.n - a.n || cmpStr(a.key, b.key));
    const flat = (level, keyFn, labelFn) => groupBy(rows, keyFn).map(([k, g]) =>
      makeSeg(source, level, level + ":" + k, labelFn(k), {}, g, all.post, K)).sort((a, b) => b.n - a.n || cmpStr(a.key, b.key));
    const by = { side: flat("bySide", r => r.side, k => (k === "over" ? "Over" : "Under")) };
    if (source === "bot") {
      by.tier = flat("tier", r => r.tier, k => "Tier " + k);
      by.home = flat("home", r => (r.home == null ? null : r.home ? "home" : "away"), k => (k === "home" ? "Home" : "Away"));
      by.lineType = flat("lineType", r => r.lineType, k => k.charAt(0).toUpperCase() + k.slice(1));
    }
    return {
      source, n: all.n, hits: all.hits, misses: all.n - all.hits, raw: all.raw, post: all.post, lo80: all.lo80, hi80: all.hi80,
      verdict: all.verdict, excluded, segments, by
    };
  }

  // ---------- calibration ----------
  function fitCalibration(rows) {
    const P = rows.filter(r => r.prob != null);
    const n = P.length;
    const xs = P.map(r => logit(clamp(r.prob, 0.01, 0.99))), ys = P.map(r => r.y);
    const ia = 1 / (CAL_SA * CAL_SA), ib = 1 / (CAL_SB * CAL_SB);
    const lp = (a, b) => -0.5 * ia * a * a - 0.5 * ib * (b - 1) * (b - 1) + sum(xs, (x, i) => { const e = a + b * x; return ys[i] * e - softplus(e); });
    const hess = (a, b) => {
      let haa = ia, hab = 0, hbb = ib;
      for (let i = 0; i < n; i++) { const mu = sigmoid(a + b * xs[i]), w = mu * (1 - mu); haa += w; hab += w * xs[i]; hbb += w * xs[i] * xs[i]; }
      return [[haa, hab], [hab, hbb]];
    };
    let a = 0, b = 1, cur = lp(a, b), ok = true;
    for (let it = 0; it < 100 && n; it++) {
      let ga = -ia * a, gb = -ib * (b - 1);
      for (let i = 0; i < n; i++) { const r = ys[i] - sigmoid(a + b * xs[i]); ga += r; gb += r * xs[i]; }
      const Hi = inv2(hess(a, b));
      if (!Hi) { ok = false; break; }
      const da = Hi[0][0] * ga + Hi[0][1] * gb, db = Hi[1][0] * ga + Hi[1][1] * gb;
      let t = 1, na = a, nb = b, nl = cur;
      while (t > 1e-8) {
        na = a + t * da; nb = b + t * db; nl = lp(na, nb);
        if (isNum(nl) && nl >= cur - 1e-12) break;
        t /= 2;
      }
      if (!(t > 1e-8)) break;
      const moved = Math.abs(na - a) + Math.abs(nb - b);
      a = na; b = nb; cur = nl;
      if (moved < 1e-11) break;
    }
    if (!ok || !isNum(a) || !isNum(b)) { a = 0; b = 1; }
    const cov = inv2(hess(a, b)) || [[CAL_SA * CAL_SA, 0], [0, CAL_SB * CAL_SB]];
    for (const r of rows) r.cal = r.prob == null ? null : sigmoid(a + b * logit(clamp(r.prob, 0.01, 0.99)));

    const buckets = BUCKETS.map(B => {
      const g = P.filter(r => r.prob >= B.lo && r.prob < B.hi);
      return {
        label: B.label, lo: B.lo, hi: Math.min(B.hi, 1), n: g.length,
        pred: g.length ? sum(g, r => r.prob) / g.length : null,
        cal: g.length ? sum(g, r => r.cal) / g.length : null,
        actual: g.length ? sum(g, r => r.y) / g.length : null
      };
    });
    const brier = n ? sum(P, r => (r.prob - r.y) ** 2) / n : null;
    const brierCal = n ? sum(P, r => (r.cal - r.y) ** 2) / n : null;
    // gap = mean(raw) - mean(calibrated): positive → bot too confident. SD by the delta method on the posterior.
    let gap = null, gapSD = null, gap60 = null;
    const P60 = P.filter(r => r.prob >= 0.6);
    if (n) {
      gap = sum(P, r => r.prob - r.cal) / n;
      const ga = sum(P, r => r.cal * (1 - r.cal)) / n;
      const gb = sum(P, r => r.cal * (1 - r.cal) * logit(clamp(r.prob, 0.01, 0.99))) / n;
      gapSD = Math.sqrt(Math.max(0, ga * ga * cov[0][0] + 2 * ga * gb * cov[0][1] + gb * gb * cov[1][1]));
      if (P60.length) gap60 = sum(P60, r => r.prob - r.cal) / P60.length;
    }
    let verdict = "—";
    if (n >= CAL_MIN) {
      const z = gapSD > 0 ? gap / gapSD : 0;
      // direction must be ≥80% likely under the posterior (|z| ≥ 0.84) and ≥1.5 pts after shrinkage
      verdict = gap >= 0.015 && z >= 0.8416 ? "over" : gap <= -0.015 && z <= -0.8416 ? "under" : "well";
    }
    return {
      n, a, b, sdA: Math.sqrt(cov[0][0]), sdB: Math.sqrt(cov[1][1]), identity: n === 0,
      buckets, brier, brierCal, brier0: 0.25, skill: brier == null ? null : 1 - brier / 0.25,
      gap, gapSD, gap60, n60: P60.length, verdict
    };
  }
  function calibrated(model, p) {
    const c = model && model.calibration;
    const a = c && isNum(c.a) ? c.a : 0, b = c && isNum(c.b) ? c.b : 1;
    return sigmoid(a + b * logit(clamp(p, 0.01, 0.99)));
  }

  // ---------- factor model ----------
  function rateOf(v) {
    if (Array.isArray(v) && v.length >= 2) {
      const h = toNum(v[0]), g = toNum(v[1]);
      return h != null && g != null && g > 0 ? clamp(h / g, 0, 1) : null;
    }
    const x = toNum(v);
    return x != null && x >= 0 && x <= 1 ? x : null;
  }
  const fget = (r, k) => (r.f ? r.f[k] : undefined);
  const FACTORS = [
    { key: "l10", label: "L10 hit rate", kind: "sd", get: r => rateOf(fget(r, "l10")) },
    { key: "l5", label: "L5 hit rate", kind: "sd", get: r => rateOf(fget(r, "l5")) },
    { key: "gapPct", label: "Projection gap", kind: "sd", get: r => toNum(fget(r, "gapPct")) },
    { key: "oppRankPct", label: "Soft defense", kind: "sd", get: r => toNum(fget(r, "oppRankPct")) },
    { key: "home", label: "Home", kind: "bool", get: r => (r.home == null ? null : r.home ? 1 : 0) },
    { key: "b2b", label: "Back-to-back", kind: "bool", get: r => { const v = fget(r, "b2b"); return typeof v === "boolean" ? (v ? 1 : 0) : null; } },
    { key: "restDays", label: "Rest days", kind: "sd", get: r => { const v = toNum(fget(r, "restDays")); return v == null ? null : clamp(v, 0, 10); } },
    { key: "over", label: "Over side", kind: "bool", get: r => (r.side == null ? null : r.side === "over" ? 1 : 0) },
    { key: "tierA", label: "Tier A", kind: "bool", get: r => (r.tier == null ? null : r.tier === "A" ? 1 : 0) },
    { key: "tierC", label: "Tier C", kind: "bool", get: r => (r.tier == null ? null : r.tier === "C" ? 1 : 0) },
    { key: "goblin", label: "Goblin", kind: "bool", get: r => (r.lineType === "goblin" ? 1 : 0) },
    { key: "demon", label: "Demon", kind: "bool", get: r => (r.lineType === "demon" ? 1 : 0) }
  ];
  function fitFactors(rows) {
    const data = rows.filter(r => r.f);
    const n = data.length;
    if (n < FACTOR_MIN) return { n, factors: [] };
    const cols = [];
    for (const F of FACTORS) {
      const vals = data.map(r => { const v = F.get(r); return isNum(v) ? v : null; });
      const obs = vals.filter(v => v != null);
      if (obs.length < Math.max(10, Math.ceil(0.2 * n))) continue;
      const mean = sum(obs, v => v) / obs.length;
      const sd = Math.sqrt(sum(obs, v => (v - mean) ** 2) / obs.length);
      if (!(sd > 1e-9)) continue;
      if (F.kind === "bool") { const ones = sum(obs, v => v); if (ones < 3 || obs.length - ones < 3) continue; }
      cols.push({ F, vals, mean, sd, nObs: obs.length });
    }
    if (!cols.length) return { n, factors: [] };
    const d = cols.length + 1;
    const X = data.map((r, i) => [1].concat(cols.map(c => (c.vals[i] == null ? 0 : clamp((c.vals[i] - c.mean) / c.sd, -5, 5)))));
    const y = data.map(r => r.y);
    const lam = [LAMBDA0].concat(cols.map(() => LAMBDA));
    const obj = beta => sum(X, (x, i) => { const e = sum(x, (v, j) => v * beta[j]); return y[i] * e - softplus(e); }) - 0.5 * sum(beta, (b, j) => lam[j] * b * b);
    const negHess = beta => {
      const H = lam.map((l, j) => lam.map((_, k) => (j === k ? l : 0)));
      for (let i = 0; i < n; i++) {
        const x = X[i], mu = sigmoid(sum(x, (v, j) => v * beta[j])), w = mu * (1 - mu);
        for (let j = 0; j < d; j++) { const wx = w * x[j]; if (wx === 0) continue; for (let k = j; k < d; k++) H[j][k] += wx * x[k]; }
      }
      for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];
      return H;
    };
    let beta = new Array(d).fill(0), cur = obj(beta);
    for (let it = 0; it < 100; it++) {
      const g = lam.map((l, j) => -l * beta[j]);
      for (let i = 0; i < n; i++) { const x = X[i], r = y[i] - sigmoid(sum(x, (v, j) => v * beta[j])); for (let j = 0; j < d; j++) g[j] += r * x[j]; }
      const Hi = invert(negHess(beta));
      if (!Hi) return { n, factors: [] };
      const step = matVec(Hi, g);
      let t = 1, nb = beta, nl = cur;
      while (t > 1e-8) {
        nb = beta.map((b, j) => b + t * step[j]); nl = obj(nb);
        if (isNum(nl) && nl >= cur - 1e-12) break;
        t /= 2;
      }
      if (!(t > 1e-8)) break;
      const moved = sum(nb, (b, j) => Math.abs(b - beta[j]));
      beta = nb; cur = nl;
      if (moved < 1e-10) break;
    }
    const cov = invert(negHess(beta));
    if (!cov || !beta.every(isNum)) return { n, factors: [] };
    const b0 = beta[0], ds = z => { const s = sigmoid(z); return s * (1 - s); };
    const factors = cols.map((c, idx) => {
      const j = idx + 1, bj = beta[j], se = Math.sqrt(Math.max(cov[j][j], 0));
      let lift, dlift;
      if (c.F.kind === "bool") {   // true vs false at the average pick
        const z1 = (1 - c.mean) / c.sd, z0 = (0 - c.mean) / c.sd;
        lift = sigmoid(b0 + bj * z1) - sigmoid(b0 + bj * z0);
        dlift = z1 * ds(b0 + bj * z1) - z0 * ds(b0 + bj * z0);
      } else {                     // +1 SD, centered at the average pick
        lift = sigmoid(b0 + bj / 2) - sigmoid(b0 - bj / 2);
        dlift = 0.5 * ds(b0 + bj / 2) + 0.5 * ds(b0 - bj / 2);
      }
      const z = se > 0 ? bj / se : 0;
      return {
        key: c.F.key, label: c.F.label, kind: c.F.kind, n: c.nObs, mean: c.mean, sd: c.sd,
        coef: bj, se, z, lift: 100 * lift, liftSE: 100 * Math.abs(dlift) * se,
        verdict: z > 2 ? "helps" : z < -2 ? "hurts" : "noise"
      };
    });
    factors.sort((p, q) => Math.abs(q.z) - Math.abs(p.z) || cmpStr(p.key, q.key));
    return { n, factors, intercept: b0 };
  }

  // ---------- model ----------
  function isAncestor(a, b) { return b.key.indexOf(a.key + "|") === 0; }
  function pickTop(cands, verdict, limit) {
    const list = cands.filter(s => s.verdict === verdict).sort(verdict === "trust"
      ? (a, b) => b.lo80 - a.lo80 || b.post - a.post || cmpStr(a.source + a.key, b.source + b.key)
      : (a, b) => a.hi80 - b.hi80 || a.post - b.post || cmpStr(a.source + a.key, b.source + b.key));
    const out = [];
    for (const s of list) {
      // skip a segment that repeats the same picks as one already chosen (parent/child with identical n)
      if (out.some(o => o.source === s.source && o.n === s.n && (isAncestor(o, s) || isAncestor(s, o)))) continue;
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }
  function roundDeep(v) {
    if (typeof v === "number") { if (!isFinite(v)) return null; const r = Number.isInteger(v) ? v : Math.round(v * 1e4) / 1e4; return r === 0 ? 0 : r; }
    if (Array.isArray(v)) return v.map(roundDeep);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = roundDeep(v[k]); return o; }
    return v;
  }

  /** Build the learning model. journal: JournalPick[] (or the ai-picks.json object), ledger: Entry[] (or ledger.json). */
  function build(opts) {
    const o = opts || {};
    const nowMs = o.now == null ? null : o.now instanceof Date ? o.now.getTime() : toNum(o.now);
    const J = journalRows(o.journal), L = ledgerRows(o.ledger);
    const calibration = fitCalibration(J.rows);
    const bot = analyzeSource("bot", J.rows, J.excluded);
    const you = analyzeSource("you", L.rows, L.excluded);
    const fit = fitFactors(J.rows);
    const cands = [];
    for (const src of [bot, you]) {
      cands.push(...src.segments);
      for (const k of Object.keys(src.by)) for (const s of src.by[k]) if (s.n < 0.9 * src.n) cands.push(s);
    }
    const be = { power: {}, flex: {} };
    for (const n of [2, 3, 4, 5, 6]) { be.power[n] = breakEven(n, "power"); if (FLEX[n]) be.flex[n] = breakEven(n, "flex"); }
    return roundDeep({
      version: 1,
      builtAt: nowMs == null ? null : new Date(nowMs).toISOString(),
      params: { k: K, globalStrength: G_STRENGTH, thin: THIN, calMin: CAL_MIN, factorMin: FACTOR_MIN, lambda: LAMBDA, residK: RESID_K, residMin: RESID_MIN, clamp: [P_MIN, P_MAX] },
      breakEven: be,
      bot, you, calibration,
      factors: fit.factors,
      factorN: fit.n,
      trust: pickTop(cands, "trust", 5),
      fade: pickTop(cands, "fade", 5)
    });
  }

  // ---------- adjust ----------
  const pts = x => { const v = Math.round(x * 100); return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v); };
  /** Vici %: calibrated raw prob + shrunk residual of the most specific bot segment with ≥10 graded picks, clamped. */
  function adjust(model, rawProb, ctx) {
    const c = ctx || {};
    let raw = toNum(rawProb);
    if (raw != null && raw > 1 && raw <= 100) raw /= 100;
    const noRaw = raw == null || !(raw > 0 && raw < 1);
    if (noRaw) raw = 0.5;
    const cal = calibrated(model, raw);
    const sport = canonSport(c.sport), st = canonStat(sport, c.stat), side = canonSide(c.side);
    const segs = (model && model.bot && Array.isArray(model.bot.segments)) ? model.bot.segments : [];
    const keys = [];
    if (side) keys.push(sport + "|" + st.key + "|" + side);
    keys.push(sport + "|" + st.key, sport);
    let seg = null;
    for (const k of keys) {
      const s = segs.find(x => x.key === k);
      if (s && s.nP >= RESID_MIN && isNum(s.resid)) { seg = s; break; }
    }
    const w = seg ? seg.nP / (seg.nP + RESID_K) : 0;
    const segAdj = seg ? w * seg.resid : 0;
    const unclamped = cal + segAdj;
    const p = clamp(unclamped, P_MIN, P_MAX);
    const bits = [];
    if (noRaw) bits.push("no prob");
    if (model && model.calibration && model.calibration.n > 0 && Math.abs(cal - raw) >= 0.005) bits.push("calib " + pts(cal - raw));
    if (seg && Math.abs(segAdj) >= 0.005) bits.push(seg.label + " " + pts(segAdj) + " (n=" + seg.nP + ")");
    if (p !== unclamped) bits.push("capped");
    const youSegs = (model && model.you && Array.isArray(model.you.segments)) ? model.you.segments : [];
    const ys = youSegs.find(x => x.key === keys[0] && (x.verdict === "trust" || x.verdict === "fade"));
    if (ys) bits.push("you " + ys.verdict + " " + Math.round(ys.raw * 100) + "% (" + ys.hits + "/" + ys.n + ")");
    const botN = model && model.bot ? model.bot.n || 0 : 0;
    const note = bits.length ? bits.join(" · ") : botN ? "as is" : "no history";
    return {
      p,
      parts: {
        raw, calibrated: cal, segment: segAdj,
        segmentKey: seg ? seg.key : null, segmentLabel: seg ? seg.label : null, segmentN: seg ? seg.nP : 0, segmentWeight: w
      },
      note
    };
  }

  // ---------- text outputs ----------
  const pct = x => (isNum(x) ? Math.round(x * 100) + "%" : "—");
  function segLine(kind, s) {
    const who = s.source === "bot" ? "bot picks" : "your legs";
    return kind + " (" + who + "): " + s.label.trim() + " " + pct(s.raw) + " (" + s.hits + "/" + s.n + ").";
  }
  /** Compact plain text (≤ 1,200 chars) the bot reads before answering. */
  function promptBlock(model) {
    const m = model || build({});
    const bot = m.bot || { n: 0 }, you = m.you || { n: 0 }, cal = m.calibration || { n: 0, verdict: "—" };
    const head = "Graded: bot " + bot.n + (bot.n ? " (" + pct(bot.raw) + ")" : "") + ", you " + you.n + " legs" + (you.n ? " (" + pct(you.raw) + ")" : "") + ".";
    const mid = [];
    if (cal.verdict === "over" || cal.verdict === "under") {
      const use60 = cal.n60 >= 10 && isNum(cal.gap60) && Math.sign(cal.gap60) === Math.sign(cal.gap) && Math.abs(cal.gap60) >= Math.abs(cal.gap);
      const g = use60 ? cal.gap60 : cal.gap;
      const p = Math.max(1, Math.round(Math.abs(g) * 100));
      mid.push("Calibration: bot runs " + p + " pts too " + (cal.verdict === "over" ? "confident" : "cautious") + (use60 ? " above 60%" : "") + " (n=" + cal.n + ").");
    } else if (cal.verdict === "well") {
      mid.push("Calibration: " + (cal.gapSD <= 0.03 ? "well calibrated" : "no clear bias yet") + " (n=" + cal.n + ", Brier " + (isNum(cal.brier) ? cal.brier.toFixed(3) : "—") + " vs 0.250).");
    } else if (cal.n > 0) {
      mid.push("Calibration: too few graded bot picks (n=" + cal.n + ").");
    }
    const trust = (m.trust || []).slice(0, 3), fade = (m.fade || []).slice(0, 3);
    for (const s of trust) mid.push(segLine("Trust", s));
    for (const s of fade) mid.push(segLine("Fade", s));
    for (const f of (m.factors || []).filter(x => x.verdict !== "noise").slice(0, 2)) {
      const lift = Math.round(f.lift);
      mid.push("Factor: " + f.label + (f.kind === "sd" ? " +1 SD " : " ") + (lift >= 0 ? "+" : "-") + Math.abs(lift) + " pts (n=" + f.n + ").");
    }
    const be = [2, 3, 4, 5, 6].map(n => "Power" + n + " " + (breakEven(n, "power") * 100).toFixed(1) + "%").join(", ");
    const tail = "Break-even per leg: " + be + ".";
    const lines = [head].concat(mid, [tail]);
    while (lines.join("\n").length > 1200 && lines.length > 2) lines.splice(lines.length - 2, 1);
    return lines.join("\n");
  }
  /** Short numbers for the chat header. Rates are fractions (0..1) or null when nothing is graded. */
  function summary(model) {
    const m = model || {};
    const bot = m.bot || { n: 0 }, you = m.you || { n: 0 };
    return {
      graded: (bot.n || 0) + (you.n || 0),
      botN: bot.n || 0, youN: you.n || 0,
      botRate: bot.n ? bot.raw : null, youRate: you.n ? you.raw : null,
      calib: (m.calibration && m.calibration.verdict) || "—"
    };
  }
  /** Trimmed model for the `vici_model` tool (small JSON). */
  function compact(model) {
    const m = model || build({});
    const segOut = s => ({ src: s.source, seg: s.label.trim(), n: s.n, hits: s.hits, raw: s.raw, post: s.post, lo80: s.lo80, hi80: s.hi80, verdict: s.verdict });
    const top = src => (src && src.segments ? src.segments.filter(s => s.n >= THIN).slice(0, 12).map(segOut) : []);
    const c = m.calibration || {};
    return {
      builtAt: m.builtAt || null,
      bot: m.bot ? { n: m.bot.n, hits: m.bot.hits, raw: m.bot.raw, post: m.bot.post } : null,
      you: m.you ? { n: m.you.n, hits: m.you.hits, raw: m.you.raw, post: m.you.post } : null,
      calibration: { n: c.n, a: c.a, b: c.b, verdict: c.verdict, gapPts: isNum(c.gap) ? Math.round(c.gap * 1000) / 10 : null, brier: c.brier,
        buckets: (c.buckets || []).filter(b => b.n).map(b => ({ b: b.label, n: b.n, pred: b.pred, actual: b.actual })) },
      trust: (m.trust || []).map(segOut), fade: (m.fade || []).map(segOut),
      factors: (m.factors || []).map(f => ({ f: f.label, n: f.n, liftPts: Math.round(f.lift * 10) / 10, sePts: Math.round(f.liftSE * 10) / 10, verdict: f.verdict })),
      segments: { bot: top(m.bot), you: top(m.you) },
      breakEven: m.breakEven || null
    };
  }

  const api = {
    version: 1,
    POWER, FLEX,
    breakEven, edge, build, adjust, promptBlock, summary, compact,
    calibrated, canonStat, canonSport, canonSide,
    util: { logit, sigmoid, invert, inv2, betaPost, verdictOf }
  };
  if (root) root.ViciModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null);
