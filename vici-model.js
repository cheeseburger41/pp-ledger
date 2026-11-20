/* vici-model.js — Vici learning engine (window.ViciModel).
 *
 * Pure functions: no DOM, no network, no randomness, no clock (time only via build({now})).
 * Learns only from Vici's own graded picks (ai-picks.json; hit/miss only, push/void/pending excluded). Angus plays
 * only what Vici recommends (his call, 2026-11-17), so his own ledger legs are not a source. From his ledger it takes
 * only what PrizePicks actually pays (the To Win on his Power entries) and what Vici's own logged slips made.
 *
 *   ViciModel.build({journal, ledger, now}) -> Model   (model.track = what Vici predicted, Vici %, vs the actual results)
 *   ViciModel.adjust(model, rawProb, {sport, stat, side, tier, features}) -> {p, parts, note}
 *   ViciModel.breakEven(n, type) / edge(p, n, type) / promptBlock(model)
 *   ViciModel.summary(model, sport?) / compact(model, sport?) / calibrated(model, p, sport?)   (sport: "NBA"; omitted = all)
 *   ViciModel.calShare(model, sport?)   (how much of an upward calibration counts for that sport, 0..1)
 *   ViciModel.payout(model, n) / slipPlan(model, n, hit) / kelly(hit, mult) / growth(hit, mult, f) / kellyScale(model)
 *   ViciModel.altFactor(model, "goblin") / altValue(model, "goblin", p, stdP, appFactor) / altSplit(model, R, types)
 *     (goblin and demon legs)
 *
 * Statistics:
 *   - Hit rates: nested Beta shrinkage. global ~ Beta(10,10) + data; sport, sport|stat, sport|stat|side each use
 *     Beta(k*m, k*(1-m)) with m = parent's posterior mean, k = 15. 80% interval = normal approx to the Beta.
 *   - Calibration by sport: logit(p*) = (a+da_s) + (b+db_s)*logit(p), one joint MAP fit by damped Newton, priors
 *     a~N(0,.35^2), b~N(1,.25^2) (the pooled fit, used for a sport with no picks), da_s~N(0,.25^2), db_s~N(0,.15^2).
 *   - Earned raises (Angus, 2026-11-18: "The NBA picks are generally far worse than the NFL ones in success rate").
 *     Those priors let six graded picks, all hits, add 8 points to every NBA chance and 6 to every other sport's, so
 *     a 54% leg would have led a slip. adjust() now weighs the two corrections together (the calibration, and a
 *     segment's shift once it has ten graded picks): what they add above the bot's own number counts only as far as
 *     that sport's own graded picks have earned it, n/(n+30) of it (calShare: nothing for a sport with no picks,
 *     half at 30); a net cut counts in full, and so does whatever only brings a cut chance back toward the bot's
 *     number. So Vici % is never above what the full corrections say and equals it whenever that is at or under the
 *     bot's prob. The share is the sport's: a stat's own segment still joins at its own tenth pick. The fit, the
 *     segments, their diagnostics and the Learning lines are unchanged.
 *   - Each sport also gets its own segments, trust/fade, predicted-vs-actual track and pending count (model.bySport,
 *     bot.bySport, track.bySport, bot.pendingBy, calibration.bySport; model.sports lists them in display order).
 *   - Factors: L2 (lambda=1) logistic regression on standardized features, n >= 40, SEs from the inverse Hessian.
 *   - Profit (Angus, 2026-11-18: "Train the algorithm to help me gain the most profits"): payouts are learned from his
 *     Power entries (To Win / stake against the standard multiplier, shrunk toward the standard with 4 entries' weight,
 *     each size toward the pooled ratio). Slips carry the expected log growth of the Balance at their stake.
 *   - Goblins and demons (Angus, 2026-11-19: "the algo always goes for goblins instead of going for normal lines where
 *     my profits are so low it is not worth it"). A goblin leg is easier, and PrizePicks cuts the slip's payout for it
 *     (his slips: a Power 3 from 6x to 4.25x, a Power 2 from 3x to 2.6x). A Power slip's EV is its payout times the
 *     product over legs of chance x that leg's payout factor, so ranking legs by chance alone makes goblins look best.
 *     fitAltLines learns the factor per goblin leg and per demon leg from his Power entries whose notes say which legs
 *     were goblins or demons: ln(To Win / (stake x his usual multiplier for that size)) = goblins x ln g + demons x ln d,
 *     a ridge fit toward g = 0.8, d = 1.2 with the weight of PAY_K one-leg entries (an entry is one payout, so one
 *     with k goblins counts k squared; entries with a player twice, a part-game leg, a promo or "linked" are left out).
 *     altValue counts such a leg at chance x factor, and without the app's own factor never above the same prop's
 *     chance at its standard line: PrizePicks prices the cut to about cancel the easier line, and a deep goblin costs
 *     more than the average one, so an estimate never makes a goblin (or a demon) look better than the standard line.
 *     altSplit turns the multiplier the app shows for a lineup into its goblin and demon legs' factors.
 *   - Stakes (SAFE_STAKES, off). Angus, 2026-11-18: "By minimise risk I meant spread out the picks, not use a low
 *     budget". So a stake is 1/2 of the Kelly stake (1/4 while Vici's record says it has run too confident), at
 *     most 5% of the Balance on a slip, and there is no day limit (dayLimit gives null). Until v33 the share rose
 *     from 1/4 to 1/2 over the first 200 graded picks, on chances the unearned raise had inflated; with the raise
 *     earned (above), 1/2 keeps a slip that leads clearly at the stake it had instead of halving it (one that only
 *     just leads is staked lower: its chance was overstated). SAFE_STAKES on is what v31 shipped on the wrong
 *     reading of "minimise risk": a quarter whatever the record, 3% a slip, a day's entries together at most 10%
 *     of the Balance he started that day with.
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
  const CAL_SAS = 0.25, CAL_SBS = 0.15;  // how far one sport's calibration may sit from the pooled one (prior SDs)
  const CAL_RAMP = 30;          // a calibration that raises a chance counts n/(n+CAL_RAMP), n = that sport's own graded picks
  const FACTOR_MIN = 40, LAMBDA = 1, LAMBDA0 = 1e-3;
  const RESID_MIN = 10, RESID_K = 30;
  const P_MIN = 0.30, P_MAX = 0.85;
  const PAY_K = 4;                       // prior weight, in entries, of the standard multiplier (and of the pooled ratio per size)
  const LINKED_NOTE = /\blinked\b/i;      // how the chat marks a logged slip of linked legs (notes "Vici: … · linked")
  const PAY_LO = 0.25, PAY_HI = 2.5;     // a To Win outside this share of the standard is a typo or a promo, not PrizePicks' pricing
  const ALT_PRIOR = { goblin: 0.8, demon: 1.2 };              // payout factor per goblin / demon leg until his entries show his own
  const ALT_BOUNDS = { goblin: [0.25, 1], demon: [1, 3] };     // a factor outside these is not a goblin's (or a demon's)
  const SAFE_STAKES = false;             // off: Angus, 2026-11-18: "By minimise risk I meant spread out the picks, not use a low budget"
  const KELLY_LO = 0.25, KELLY_HI = SAFE_STAKES ? 0.25 : 0.5;   // share of the full Kelly stake: HI, and LO while the record says "too confident"
  const STAKE_CAP = SAFE_STAKES ? 0.03 : 0.05;   // never more than this share of the Balance on one slip
  const DAY_CAP = SAFE_STAKES ? 0.1 : null;      // never more than this share of the day's starting Balance on one day's entries
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
      prob: null, vici: null, cal: null, tier: null, home: null, lineType: "standard", f: null
    };
  }
  function unitProb(v) {
    let x = toNum(v);
    if (x != null && x > 1 && x <= 100) x /= 100;
    return x != null && x > 0 && x < 1 ? x : null;
  }
  function journalRows(journal) {
    const picks = toList(journal, "picks").slice().sort((a, b) =>
      cmpStr(s0(a.createdAt), s0(b.createdAt)) || cmpStr(s0(a.id), s0(b.id)) || cmpStr(s0(a.player), s0(b.player)));
    const rows = [], excluded = { push: 0, void: 0, pending: 0, noProb: 0 }, pendingBy = {};
    for (const p of picks) {
      const res = canonResult(p.result);
      if (res !== "hit" && res !== "miss") {
        excluded[res]++;
        if (res === "pending") { const sp = canonSport(p.sport); pendingBy[sp] = (pendingBy[sp] || 0) + 1; }
        continue;
      }
      const r = baseRow(p, canonSport(p.sport), res === "hit" ? 1 : 0);
      r.i = rows.length;   // row id: segments over the very same picks are told apart by their row sets
      r.prob = unitProb(p.prob);
      if (r.prob == null) excluded.noProb++;
      r.vici = unitProb(p.vici);   // the Vici % Angus saw on the card (journaled since 2026-11-17); older picks fall back to prob
      const tier = String(p.tier == null ? "" : p.tier).trim().toUpperCase();
      r.tier = tier === "A" || tier === "B" || tier === "C" ? tier : null;
      r.home = typeof p.home === "boolean" ? p.home : null;
      const lt = String(p.lineType == null ? "" : p.lineType).trim().toLowerCase();
      r.lineType = lt === "goblin" || lt === "demon" ? lt : "standard";
      r.f = p.features && typeof p.features === "object" && !Array.isArray(p.features) ? p.features : null;
      rows.push(r);
    }
    return { rows, excluded, pendingBy };
  }
  /** Sports in display order: Angus's four first, then any other sport alphabetically. */
  const SPORT_ORDER = ["NBA", "NFL", "CFB", "Soccer"];
  function sportSort(a, b) {
    const i = SPORT_ORDER.indexOf(a), j = SPORT_ORDER.indexOf(b);
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j) || cmpStr(a, b);
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
    // which picks it holds (not enumerable: never copied into the built model or its JSON)
    Object.defineProperty(seg, "_rows", { value: rows.map(r => r.i).join(","), enumerable: false });
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
  /** Flat (non-nested) segments of `rows`: side, and for the bot also tier, home/away and line type. With a sport they
   *  sit under that sport (key "NBA|tier:A", label "NBA Tier A", shrunk toward the sport); without one, under all picks. */
  function flatSegs(source, rows, prior, sport) {
    const flat = (level, keyFn, labelFn) => groupBy(rows, keyFn).map(([k, g]) =>
      makeSeg(source, level, (sport ? sport + "|" : "") + level + ":" + k, (sport ? sport + " " : "") + labelFn(k), sport ? { sport } : {}, g, prior, K))
      .sort((a, b) => b.n - a.n || cmpStr(a.key, b.key));
    const by = { side: flat("bySide", r => r.side, k => (k === "over" ? "Over" : "Under")) };
    if (source === "bot") {
      by.tier = flat("tier", r => r.tier, k => "Tier " + k);
      by.home = flat("home", r => (r.home == null ? null : r.home ? "home" : "away"), k => (k === "home" ? "Home" : "Away"));
      by.lineType = flat("lineType", r => r.lineType, k => k.charAt(0).toUpperCase() + k.slice(1));
    }
    return by;
  }
  function analyzeSource(source, rows, excluded) {
    const all = makeSeg(source, "all", "all", "Bot picks", {}, rows, 0.5, G_STRENGTH);
    const segments = [], bySport = {};
    for (const [sport, sRows] of groupBy(rows, r => r.sport)) {
      const sp = makeSeg(source, "sport", sport, sport, { sport, stat: null, statLabel: null, side: null }, sRows, all.post, K);
      segments.push(sp);
      bySport[sport] = flatSegs(source, sRows, sp.post, sport);
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
    return {
      source, n: all.n, hits: all.hits, misses: all.n - all.hits, raw: all.raw, post: all.post, lo80: all.lo80, hi80: all.hi80,
      verdict: all.verdict, excluded, segments, by: flatSegs(source, rows, all.post, null), bySport
    };
  }

  // ---------- calibration ----------
  /** Hierarchical logistic recalibration, one joint MAP fit:
   *    logit(cal) = (a + da[s]) + (b + db[s]) · logit(prob)
   *  a ~ N(0, SA²) and b ~ N(1, SB²) are the pooled calibration (used for a sport with no history); each sport's offsets
   *  da[s] ~ N(0, SAS²), db[s] ~ N(0, SBS²) let it drift from the pool only as far as its own picks support. A sport with a
   *  handful of picks therefore borrows the pooled fit and a sport with many gets its own. Sets r.cal on every row. */
  function fitCalibration(rows) {
    const P = rows.filter(r => r.prob != null);
    const n = P.length;
    const sports = Array.from(new Set(P.map(r => r.sport))).sort(cmpStr);
    const S = sports.length, D = 2 + 2 * S;
    const sIdx = new Map(sports.map((sp, i) => [sp, i]));
    const xs = P.map(r => logit(clamp(r.prob, 0.01, 0.99))), ys = P.map(r => r.y), ss = P.map(r => sIdx.get(r.sport));
    const prec = [1 / (CAL_SA * CAL_SA), 1 / (CAL_SB * CAL_SB)];
    for (let k = 0; k < S; k++) prec.push(1 / (CAL_SAS * CAL_SAS));
    for (let k = 0; k < S; k++) prec.push(1 / (CAL_SBS * CAL_SBS));
    const mu0 = prec.map((_, j) => (j === 1 ? 1 : 0));
    // row i touches 4 parameters: a, b, da[s], db[s] with weights 1, x, 1, x
    const idx = i => [0, 1, 2 + ss[i], 2 + S + ss[i]];
    const val = i => [1, xs[i], 1, xs[i]];
    const eta = (th, i) => th[0] + th[2 + ss[i]] + (th[1] + th[2 + S + ss[i]]) * xs[i];
    const lp = th => -0.5 * sum(prec, (q, j) => q * (th[j] - mu0[j]) * (th[j] - mu0[j])) +
      sum(xs, (x, i) => { const e = eta(th, i); return ys[i] * e - softplus(e); });
    const hess = th => {
      const H = prec.map((q, j) => prec.map((_, k) => (j === k ? q : 0)));
      for (let i = 0; i < n; i++) {
        const m = sigmoid(eta(th, i)), w = m * (1 - m), I = idx(i), V = val(i);
        for (let u = 0; u < 4; u++) for (let v = 0; v < 4; v++) H[I[u]][I[v]] += w * V[u] * V[v];
      }
      return H;
    };
    let th = mu0.slice(), cur = lp(th), ok = true;
    for (let it = 0; it < 100 && n; it++) {
      const g = prec.map((q, j) => -q * (th[j] - mu0[j]));
      for (let i = 0; i < n; i++) {
        const r = ys[i] - sigmoid(eta(th, i)), I = idx(i), V = val(i);
        for (let u = 0; u < 4; u++) g[I[u]] += r * V[u];
      }
      const Hi = invert(hess(th));
      if (!Hi) { ok = false; break; }
      const step = matVec(Hi, g);
      let t = 1, nt = th, nl = cur;
      while (t > 1e-8) {
        nt = th.map((v, j) => v + t * step[j]); nl = lp(nt);
        if (isNum(nl) && nl >= cur - 1e-12) break;
        t /= 2;
      }
      if (!(t > 1e-8)) break;
      const moved = sum(nt, (v, j) => Math.abs(v - th[j]));
      th = nt; cur = nl;
      if (moved < 1e-11) break;
    }
    if (!ok || !th.every(isNum)) th = mu0.slice();
    const cov = invert(hess(th)) || prec.map((q, j) => prec.map((_, k) => (j === k ? 1 / q : 0)));
    for (const r of rows) r.cal = null;
    P.forEach((r, i) => { r.cal = sigmoid(eta(th, i)); });

    // diagnostics for a set of rows (all of them, or one sport's): the calibration curve, Brier, and the gap
    // mean(raw) - mean(calibrated) (positive → bot too confident) with its SD by the delta method on the posterior
    function stats(ids) {
      const G = ids.map(i => P[i]), m = G.length;
      const buckets = BUCKETS.map(B => {
        const g = G.filter(r => r.prob >= B.lo && r.prob < B.hi);
        return {
          label: B.label, lo: B.lo, hi: Math.min(B.hi, 1), n: g.length,
          pred: g.length ? sum(g, r => r.prob) / g.length : null,
          cal: g.length ? sum(g, r => r.cal) / g.length : null,
          actual: g.length ? sum(g, r => r.y) / g.length : null
        };
      });
      const brier = m ? sum(G, r => (r.prob - r.y) ** 2) / m : null;
      const brierCal = m ? sum(G, r => (r.cal - r.y) ** 2) / m : null;
      let gap = null, gapSD = null, gap60 = null;
      const G60 = G.filter(r => r.prob >= 0.6);
      if (m) {
        gap = sum(G, r => r.prob - r.cal) / m;
        const grad = new Array(D).fill(0);
        for (const i of ids) {
          const c = P[i].cal, w = c * (1 - c) / m, I = idx(i), V = val(i);
          for (let u = 0; u < 4; u++) grad[I[u]] += w * V[u];
        }
        gapSD = Math.sqrt(Math.max(0, sum(grad, (gj, j) => gj * sum(grad, (gk, k) => cov[j][k] * gk))));
        if (G60.length) gap60 = sum(G60, r => r.prob - r.cal) / G60.length;
      }
      let verdict = "—";
      if (m >= CAL_MIN) {
        const z = gapSD > 0 ? gap / gapSD : 0;
        // direction must be ≥80% likely under the posterior (|z| ≥ 0.84) and ≥1.5 pts after shrinkage
        verdict = gap >= 0.015 && z >= 0.8416 ? "over" : gap <= -0.015 && z <= -0.8416 ? "under" : "well";
      }
      return {
        n: m, buckets, brier, brierCal, brier0: 0.25, skill: brier == null ? null : 1 - brier / 0.25,
        gap, gapSD, gap60, n60: G60.length, verdict
      };
    }
    const all = stats(P.map((_, i) => i));
    const bySport = {};
    sports.forEach((sp, k) => {
      const ia = 2 + k, ib = 2 + S + k;
      bySport[sp] = Object.assign({
        a: th[0] + th[ia], b: th[1] + th[ib],
        sdA: Math.sqrt(Math.max(0, cov[0][0] + 2 * cov[0][ia] + cov[ia][ia])),
        sdB: Math.sqrt(Math.max(0, cov[1][1] + 2 * cov[1][ib] + cov[ib][ib]))
      }, stats(P.map((_, i) => i).filter(i => ss[i] === k)));
    });
    return Object.assign({ n, a: th[0], b: th[1], sdA: Math.sqrt(cov[0][0]), sdB: Math.sqrt(cov[1][1]), identity: n === 0 }, all, { bySport });
  }
  /** The calibrated probability for a sport (its own fit when it has history, else the pooled one): what the fit says,
   *  before adjust() weighs a raise by calShare. */
  function calibrated(model, p, sport) {
    const c = model && model.calibration;
    const own = c && c.bySport && sport != null ? c.bySport[canonSport(sport)] : null;
    const src = own && isNum(own.a) && isNum(own.b) ? own : c;
    const a = src && isNum(src.a) ? src.a : 0, b = src && isNum(src.b) ? src.b : 1;
    return sigmoid(a + b * logit(clamp(p, 0.01, 0.99)));
  }
  /** How much of a correction that raises a chance counts, 0..1: n/(n+CAL_RAMP), n = the graded picks (with a prob) of
   *  that sport alone. A sport with none gets no raise, however the others have done: each sport earns its own. With no
   *  sport named (none, or a blank), the count of all graded picks. A correction that lowers a chance always counts in
   *  full (adjust). */
  function calShare(model, sport) {
    const c = model && model.calibration;
    if (!c) return 0;
    if (sport != null && String(sport).trim() === "") sport = null;
    const own = c.bySport && sport != null ? c.bySport[canonSport(sport)] : null;
    const n = sport == null ? c.n : own ? own.n : 0;
    return isNum(n) && n > 0 ? n / (n + CAL_RAMP) : 0;
  }

  // ---------- predicted vs actual (what Angus sees) ----------
  // Vici % is adjust()'s output, clamped to [P_MIN, P_MAX], so it can sit below 50%: the track has its own lowest bucket
  const TRACK_BUCKETS = [{ label: "<50", lo: 0, hi: 0.5 }].concat(BUCKETS.map((B, i) => (i ? B : { label: B.label, lo: 0.5, hi: B.hi })));
  /** Vici's prediction as shown on the card (Vici %, else its raw prob) against the graded result. */
  function fitTrack(rows) {
    const P = rows.map(r => ({ p: r.vici != null ? r.vici : r.prob, y: r.y })).filter(r => r.p != null);
    const n = P.length, hits = sum(P, r => r.y);
    const pred = n ? sum(P, r => r.p) / n : null, actual = n ? hits / n : null;
    const buckets = TRACK_BUCKETS.map(B => {
      const g = P.filter(r => r.p >= B.lo && r.p < B.hi);
      return {
        label: B.label, n: g.length,
        pred: g.length ? sum(g, r => r.p) / g.length : null,
        actual: g.length ? sum(g, r => r.y) / g.length : null
      };
    });
    return { n, hits, misses: n - hits, pred, actual, gap: n ? actual - pred : null, buckets };
  }

  // ---------- payouts, profit and stakes ----------
  /** What PrizePicks actually pays Angus on Power entries: To Win ÷ stake against the standard multiplier, from his ledger.
   *  Left out: bonus entries, entries whose notes mention a goblin or demon leg (their payout differs by design: the chat
   *  notes "Vici: … goblin/demon", the Log form "Goblin: <player> <stat>" or "Demon: …"), any share
   *  outside [0.25, 2.5], and a won entry without To Win whose payout is just the app's own standard fill-in (or flagged as
   *  estimated): that is the app's guess, not PrizePicks'. Each size is shrunk toward the pooled share, and the pooled share
   *  toward the standard, with PAY_K entries' weight.
   *  Linked slips (legs that hit together, which PrizePicks can pay less for; the chat marks them "linked" in the notes)
   *  are their own class: they stay out of the usual payouts, and `linked.share` is what they paid as a share of the usual
   *  payout of their size, shrunk toward 1 (no cut) with PAY_K entries' weight and never above 1. */
  function fitPayouts(ledger) {
    const rows = [], links = [];
    for (const e of toList(ledger, "entries")) {
      if (String(e.type || "").toLowerCase() !== "power" || e.bonus === true) continue;
      if (/\b(goblin|demon)s?\b/i.test(String(e.notes || ""))) continue;
      const picks = Array.isArray(e.picks) ? e.picks : [];
      const n = picks.length, std = POWER[n], stake = toNum(e.stake);
      if (!std || !(stake > 0)) continue;
      let full = toNum(e.toWin);
      if (!(full > 0)) {
        const pay = toNum(e.payout), auto = Math.round(stake * std * 100) / 100;
        full = pay > 0 && e.estPayout !== true && Math.abs(pay - auto) >= 0.005 && picks.every(p => canonResult(p && p.result) === "hit") ? pay : null;
      }
      if (!(full > 0)) continue;
      const r = full / (stake * std);
      if (r >= PAY_LO && r <= PAY_HI) (LINKED_NOTE.test(String(e.notes || "")) ? links : rows).push({ n, r });
    }
    const N = rows.length, ratio = (sum(rows, x => x.r) + PAY_K) / (N + PAY_K);
    const bySize = {}, usual = {};
    for (const n of [2, 3, 4, 5, 6]) {
      const g = rows.filter(x => x.n === n);
      const r = (sum(g, x => x.r) + PAY_K * ratio) / (g.length + PAY_K);
      const mult = Math.round(POWER[n] * r * 100) / 100;
      usual[n] = r;
      bySize[n] = { n: g.length, mult, standard: POWER[n], be: Math.pow(1 / mult, 1 / n) };
    }
    const share = Math.min(1, (sum(links, x => x.r / usual[x.n]) + PAY_K) / (links.length + PAY_K));
    return { n: N, ratio, bySize, linked: { n: links.length, share: Math.round(share * 1000) / 1000 } };
  }
  // ---------- goblin and demon legs ----------
  const ALT_WORD = /\b(goblin|demon)s?\b/gi;
  const ALT_NUM = { "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  // a sentence with a goblin or demon word and one of these says they were taken off, swapped or avoided, not played
  // ("Took the two goblins off", "all goblins were removed", "<leg> was a goblin, swapped to standard", "goblin-free").
  // Not "cut" ("(std 8.5, cut to 2.6x)" is a goblin's payout), "free" alone (Free Throws) or "taken" (Sacks Taken)
  const ALT_UNDO = /\b(?:off|out|remov(?:e|ed|es|ing)|drop(?:s|ped|ping)?|swap(?:s|ped|ping)?|replac(?:e|ed|es|ing)|pull(?:s|ed|ing)?|avoid(?:s|ed|ing)?|switch(?:ed|es|ing)?|chang(?:e|ed|es|ing)|gone|instead|without|(?:goblin|demon)s?[- ]free|(?:for|to|into|now)\s+(?:the\s+)?standard)\b/i;
  const ABBR = /^(?:jr|sr|st|mr|dr|vs|[a-z]|(?:[a-z]\.)+[a-z])$/i;   // a full stop after these doesn't end a list
  /** Where a list that starts at `from` ends: " · ", a full stop (not a decimal point, an initial, Jr. or St.), the next
   *  "Goblin:" / "Demon:", or the end. */
  function listEnd(s, from) {
    const next = /\b(?:goblin|demon)s?\s*:/ig;
    next.lastIndex = from;
    const k = next.exec(s), stop = k ? k.index : s.length;
    for (let i = from; i < stop; i++) {
      if (s[i] === "\u00b7") return i;
      if (s[i] === "." && (i + 1 === s.length || /\s/.test(s[i + 1]))) {
        const w = /([A-Za-z.]+)$/.exec(s.slice(from, i));
        if (!(w && ABBR.test(w[1]))) return i;
      }
    }
    return stop;
  }
  const FOLD = { "\u00f8": "o", "\u0142": "l", "\u00e6": "ae", "\u0153": "oe", "\u00df": "ss", "\u0111": "d", "\u0131": "i", "\u00f0": "d", "\u00fe": "th" };
  const plainLow = x => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u00f8\u0142\u00e6\u0153\u00df\u0111\u0131\u00f0\u00fe]/g, c => FOLD[c]);
  /** The words that name an entry's players (3 letters or more, 2 for a name with no longer word; Jr., II... and
   *  bracketed parts such as a team code left out), to tell a leg in a list from a tail such as ", 2.6x", ", placed 6:43
   *  PM PT" or "both standard" (a nickname alone, "OG", names no one: that entry teaches nothing). null without players. */
  function nameWords(players) {
    const out = new Set();
    (Array.isArray(players) ? players : []).forEach(p => {
      const w = plainLow(String(p || "").replace(/\([^)]*\)/g, " ")).split(/[^a-z]+/).filter(x => x && !/^(?:jr|sr|ii|iii|iv)$/.test(x));
      const long = w.filter(x => x.length >= 3);
      (long.length ? long : w.filter(x => x.length >= 2)).forEach(x => out.add(x));
    });
    return out.size ? out : null;
  }
  /** How many legs a list names: its pieces at , ; and "and" (and "&" with the entry's players), not inside brackets
   *  unless the whole list is one bracket group. With the entry's name words, only a piece that names one of its players
   *  counts. 0 for "none"; null when it names none. alt (a "Goblin:" / "Demon:" list): null when a part names a player
   *  and calls him standard ("Goblin: A 6.5, B and C standard"). */
  const nameIn = (names, x) => plainLow(x).split(/[^a-z]+/).some(w => names.has(w));
  const STD_WORD = /\b(?:standard|std|regular|normal)\b(?!\s*(?:line\s*)?\d)/i;   // "standard", not "std 8.5"
  function listItems(t, names, alt) {
    const whole = /^\s*\(([^()]*)\)\W*$/.exec(t);
    const segs = (whole ? whole[1] : t).replace(/\([^)]*\)/g, m => m.replace(/[,;&]|\band\b/gi, " ")).split(/\s*[,;]\s*/);
    const bits = [].concat(...segs.map(x => x.split(names ? /\s*(?:\band\b|&)\s*/i : /\s*\band\b\s*/i))).filter(x => /[A-Za-z]/.test(x));
    if (bits.length && bits.every(x => /^\W*(?:none|no|n\/a)\W*$/i.test(x))) return 0;
    if (!names) return bits.length || null;
    const named = x => nameIn(names, x);
    if (alt && segs.some(x => named(x) && STD_WORD.test(x.replace(/\([^)]*\)/g, " ")))) return null;
    const k = bits.filter(named).length;
    return k || null;
  }
  /** How many legs of an n-leg entry were goblins and how many demons, from its notes: {goblin, demon}, both 0 when the
   *  notes name neither, null when they mention one that can't be counted (the chat's old "· goblin/demon", "a demon
   *  Flex partial"...). Reads "Goblin: <leg>" and "Demons: <leg>, <leg>" (the Log form and the threads), "<leg> is a
   *  goblin line", "(goblin)", "2 goblins", "all six legs are demons", "Demon lines except <leg>". players: the entry's
   *  player names; with them a list item counts only when it names one (see listItems). */
  function altCounts(notes, n, players) {
    let s = String(notes || "");
    const orig = s;   // s with nothing blanked: what a list says before other passes took their tags out
    const c = { goblin: 0, demon: 0 };
    if (!(s.match(ALT_WORD) || []).length) return c;
    if (!Number.isInteger(n) || n < 1) return null;
    const kind = w => (/^g/i.test(w) ? "goblin" : "demon");
    const blank = (a, b) => { s = s.slice(0, a) + " ".repeat(b - a) + s.slice(b); };
    const each = (re, fn) => { let m; while ((m = re.exec(s))) { if (fn(m) === false) return false; } return true; };
    const names = nameWords(players);
    // the entry's player names taken out, for the checks that read words (a goblin, demon or "Out" in a name is none)
    const unNamed = t => (Array.isArray(players) ? players : []).reduce((x, p) => {
      const w = String(p || "").split(/[^\p{L}\p{N}']+/u).filter(Boolean);
      return w.length ? x.replace(new RegExp(w.join("[^\\p{L}\\p{N}']+"), "giu"), " ") : x;
    }, t);
    if (unNamed(s).split(/\.(?!\d)|[!?\u00b7\n]/).some(t => /\b(?:goblin|demon)/i.test(t) && ALT_UNDO.test(t))) return null;   // taken off, not played
    // every leg but the ones listed (a "(goblin)" among them is one)
    if (!each(/\b(?:all\s+(?:the\s+)?)?(goblin|demon)s?(?:\s+(?:lines?|legs?|picks?))?\s+except\s+/i, m => {
      const from = m.index + m[0].length, end = listEnd(s, from), part = s.slice(from, end), own = kind(m[1]);
      const tags = (part.match(/\((goblin|demon)\)/gi) || []).map(x => kind(x.slice(1)));
      if (tags.indexOf(own) >= 0 || /\b(?:goblin|demon)s?\b/i.test(unNamed(part).replace(/\((?:goblin|demon)\)/gi, " "))) return false;
      const ex = listItems(part, names);
      if (!ex || ex >= n) return false;
      c[own] += n - ex; tags.forEach(t => { c[t] += 1; }); blank(m.index, end);
    })) return null;
    // "all goblins", "all six legs are demons", "Flex 6, all demon lines", "Power 6 — all demons": "all" opens a clause (or
    // follows a dash or "Power N") and only count words come between it and the word ("all standard but one goblin",
    // "took all the goblins off" don't count here); a number among them is the count
    each(/(^|[.,;:(\u00b7\n]\s*|\s[-\u2013\u2014]+\s*|\b(?:power|flex)\s*[2-6]\s+)all((?:\s+(?:the|of|my|his|them|[1-6]|one|two|three|four|five|six|legs?|lines?|picks?|are|were))*)\s+(goblin|demon)s?\b(?!\s+(?:(?:are|were|got|been|being)\s+)?(?:off|out|removed|dropped|swapped|replaced|gone|pulled|cut|for|to|into|but|besides|other|minus|save|apart|except|bar|excluding|aside)\b)/i, m => {
      const num = /\b([1-6]|one|two|three|four|five|six)\b/i.exec(m[2]);
      c[kind(m[3])] += num ? ALT_NUM[num[1].toLowerCase()] : n;
      blank(m.index + m[1].length, m.index + m[0].length);
    });
    each(/\b([1-6]|one|two|three|four|five|six)\s+(goblin|demon)s?\b/i, m => { c[kind(m[2])] += ALT_NUM[m[1].toLowerCase()]; blank(m.index, m.index + m[0].length); });
    each(/\b(?:is|was|as)\s+(?:a|an|the)\s+(goblin|demon)\b|\((goblin|demon)\)/i, m => { c[kind(m[1] || m[2])] += 1; blank(m.index, m.index + m[0].length); });
    if (!each(/\b(goblin|demon)s?\s*:\s*/i, m => {
      const from = m.index + m[0].length, end = listEnd(s, from), k = listItems(s.slice(from, end), names, true);
      if (k == null || /\b(?:goblin|demon)s?\b/i.test(unNamed(orig.slice(from, end)))) return false;
      c[kind(m[1])] += k; blank(m.index, end);
    })) return null;
    if ((s.match(ALT_WORD) || []).length) return null;   // a mention none of the shapes above could count
    // every leg counted, yet a sentence calls one of the entry's players standard ("All goblins. Ann Mock was standard")
    if (names && c.goblin + c.demon === n && orig.split(/\.(?!\d)|[!?;\u00b7\n]/).some(t => nameIn(names, t) && STD_WORD.test(t.replace(/\([^)]*\)/g, " ")))) return null;
    return c.goblin + c.demon <= n ? c : null;
  }
  const normP = x => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z]/g, "");
  const ALT_SKIP = /\b(?:linked|live|in[- ]game|half[- ]?time|first half|second half|[12]H|[1-4]Q|Q[1-4]|promo|boost(?:ed)?|discount(?:ed)?|taco|power[- ]?up|free (?:entry|play|pick|square))\b/i;
  const PART_STAT = /\b(?:[12]H|[1-4]Q|Q[1-4]|1st|2nd|3rd|4th|half|quarter|period|live)\b/i;
  /** What a goblin leg and a demon leg do to his Power payouts, from his ledger: {goblin: {n, legs, factor}, demon: {...}}
   *  (n = entries with one, legs = how many, factor = the slip's payout with one such leg ÷ his usual payout for that size).
   *  An entry counts when its notes say how many legs were goblins and demons (altCounts) and it is a Power entry with a
   *  stake and a To Win (or a won payout that isn't the app's own fill-in), no bonus, no player twice, no part-game leg
   *  and no live, promo or "linked" note; its share of his usual payout (payouts.bySize) must be within [0.25, 2.5] of
   *  what ALT_PRIOR expects such a slip to pay (0.8 per goblin, 1.2 per demon), so a slip of many goblins isn't dropped
   *  for its expected cut. The two log factors come from one ridge fit, each pulled toward ALT_PRIOR with the weight of
   *  PAY_K one-leg entries (an entry is one payout: one with k goblins counts k squared). */
  function fitAltLines(ledger, payouts) {
    const P = payouts || fitPayouts(ledger), rows = [];
    for (const e of toList(ledger, "entries")) {
      if (String(e.type || "").toLowerCase() !== "power" || e.bonus === true) continue;
      const notes = String(e.notes || ""), picks = Array.isArray(e.picks) ? e.picks : [];
      const n = picks.length, std = POWER[n], stake = toNum(e.stake);
      if (!std || !(stake > 0) || ALT_SKIP.test(notes)) continue;
      const ct = altCounts(notes, n, picks.map(p => p && p.player));
      if (!ct || !(ct.goblin + ct.demon)) continue;
      const who = picks.map(p => normP(p && p.player));
      if (who.some(w => !w) || new Set(who).size < n || picks.some(p => PART_STAT.test(String((p && p.stat) || "")))) continue;
      let full = toNum(e.toWin);
      if (!(full > 0)) {
        const pay = toNum(e.payout), auto = Math.round(stake * std * 100) / 100;
        full = pay > 0 && e.estPayout !== true && Math.abs(pay - auto) >= 0.005 && picks.every(p => canonResult(p && p.result) === "hit") ? pay : null;
      }
      if (!(full > 0)) continue;
      const b = P && P.bySize ? P.bySize[n] : null;
      const r = full / (stake * (b && isNum(b.mult) && b.mult > 1 ? b.mult : std));
      const ex = Math.pow(ALT_PRIOR.goblin, ct.goblin) * Math.pow(ALT_PRIOR.demon, ct.demon);
      if (r >= PAY_LO * ex && r <= PAY_HI * ex) rows.push({ g: ct.goblin, d: ct.demon, y: Math.log(r) });
    }
    let gg = PAY_K, dd = PAY_K, gd = 0, gy = PAY_K * Math.log(ALT_PRIOR.goblin), dy = PAY_K * Math.log(ALT_PRIOR.demon);
    for (const r of rows) { gg += r.g * r.g; dd += r.d * r.d; gd += r.g * r.d; gy += r.g * r.y; dy += r.d * r.y; }
    const det = gg * dd - gd * gd, a = (dd * gy - gd * dy) / det, b = (gg * dy - gd * gy) / det;
    const out = (t, lf, key) => ({ n: rows.filter(r => r[key]).length, legs: sum(rows, r => r[key]),
      factor: Math.round(clamp(Math.exp(lf), ALT_BOUNDS[t][0], ALT_BOUNDS[t][1]) * 1000) / 1000 });
    return { goblin: out("goblin", a, "g"), demon: out("demon", b, "d") };
  }
  /** The payout factor one goblin (or demon) leg brings: what his entries have shown, ALT_PRIOR before any. 1 for a
   *  standard line. */
  function altFactor(model, type) {
    if (type !== "goblin" && type !== "demon") return 1;
    const A = model && model.alt ? model.alt[type] : null;
    return clamp(A && isNum(A.factor) ? A.factor : ALT_PRIOR[type], ALT_BOUNDS[type][0], ALT_BOUNDS[type][1]);
  }
  /** What a goblin or demon leg is worth in a Power slip, for comparing it with the same prop's standard line: its
   *  chance p times its payout factor (appFactor: this leg's share of the multiplier the app showed for his lineup, from
   *  altSplit, when Angus gave it; otherwise altFactor). With
   *  a learned factor the value is never above stdP, the prop's chance at its standard line (see the header).
   *  Returns {factor, value, std, capped, standardBetter, fromApp}; standardBetter (the standard line is worth at least
   *  as much) is null without stdP. null without a chance or for a standard line. */
  function altValue(model, type, p, stdP, appFactor) {
    if ((type !== "goblin" && type !== "demon") || !isNum(p) || !(p > 0) || !(p < 1)) return null;
    const B = ALT_BOUNDS[type];
    const app = isNum(appFactor) && appFactor >= B[0] && appFactor <= B[1] ? appFactor : null;
    const factor = app != null ? app : altFactor(model, type);
    const std = isNum(stdP) && stdP > 0 && stdP < 1 ? stdP : null;
    let value = p * factor, capped = false;
    if (app == null && std != null && value > std) { value = std; capped = true; }
    return { factor, value, std, capped, standardBetter: std == null ? null : value <= std + 1e-12, fromApp: app != null };
  }
  /** The multiplier the app shows for a lineup, split into its goblin and demon legs' payout factors. R: that multiplier
   *  divided by his usual one for the lineup's size; types: the lineup's goblin / demon legs, in order. Each leg keeps its
   *  learned factor's share, f_i = altFactor_i x (R / product of altFactor)^(1/k), so k legs of one kind get R's k-th root
   *  and the factors multiply back to R. null when R is no ratio or a leg's factor falls outside its bounds. */
  function altSplit(model, R, types) {
    const ts = Array.isArray(types) ? types : [];
    if (!ts.length || ts.some(t => t !== "goblin" && t !== "demon") || !isNum(R) || !(R > 0)) return null;
    const base = ts.map(t => altFactor(model, t)), scale = Math.pow(R / base.reduce((a, x) => a * x, 1), 1 / ts.length);
    const f = base.map(x => x * scale);
    if (!f.every((x, i) => x >= ALT_BOUNDS[ts[i]][0] - 1e-9 && x <= ALT_BOUNDS[ts[i]][1] + 1e-9)) return null;
    return f.map((x, i) => clamp(x, ALT_BOUNDS[ts[i]][0], ALT_BOUNDS[ts[i]][1]));
  }
  /** What Vici's own slips made: entries Angus logged from the chat (notes start "Vici:"), bonus entries left out. A Power
   *  entry with a missed leg counts as lost even before its payout is set. expectedRoi: the EV the chat put in the notes,
   *  weighted by stake, for the settled ones that have it. */
  function fitProfit(ledger) {
    let n = 0, won = 0, open = 0, staked = 0, back = 0, evW = 0, evStake = 0;
    for (const e of toList(ledger, "entries")) {
      const notes = String(e.notes || "");
      if (!/^\s*Vici:/.test(notes) || e.bonus === true) continue;
      const stake = toNum(e.stake);
      if (!(stake > 0)) continue;
      let pay = toNum(e.payout);
      const picks = Array.isArray(e.picks) ? e.picks : [];
      if (pay == null && String(e.type || "power").toLowerCase() === "power" && picks.some(p => canonResult(p && p.result) === "miss")) pay = 0;
      if (pay == null) { open++; continue; }
      n++; staked += stake; back += Math.max(0, pay);
      if (pay > stake) won++;
      const m = /EV ([+\u2212-]?)(\d+(?:\.\d+)?)%/.exec(notes);
      if (m) { evW += (m[1] === "+" || m[1] === "" ? 1 : -1) * Number(m[2]) / 100 * stake; evStake += stake; }
    }
    return { n, won, open, staked, pnl: back - staked, roi: staked ? (back - staked) / staked : null, expectedRoi: evStake ? evW / evStake : null };
  }
  /** Full-Kelly share of the Balance for a slip that pays mult × stake with chance hit (0 when it doesn't pay off). */
  function kelly(hit, mult) {
    if (!isNum(hit) || !isNum(mult) || mult <= 1 || !(hit > 0) || !(hit < 1)) return 0;
    return Math.max(0, (hit * mult - 1) / (mult - 1));
  }
  /** Expected log growth of the Balance from staking share f on that slip. */
  function growth(hit, mult, f) {
    if (!(f > 0) || !isNum(hit) || !isNum(mult)) return 0;
    if (f >= 1) return -Infinity;
    return hit * Math.log(1 + f * (mult - 1)) + (1 - hit) * Math.log(1 - f);
  }
  /** Share of the full Kelly stake: KELLY_HI, and KELLY_LO while Vici's graded picks say its probabilities have run
   *  too confident. With SAFE_STAKES the two are the same: a quarter, always. (Until v33 it rose from LO to HI over the
   *  first 200 graded picks; see Stakes at the top.) */
  function kellyScale(model) {
    const c = (model && model.calibration) || {};
    return c.verdict === "over" ? KELLY_LO : KELLY_HI;
  }
  /** The multiplier Angus usually gets on an n-pick Power slip (the standard one until his entries say otherwise).
   *  linked === true: for a slip of linked legs, that payout times what his linked slips have paid of it (1 until he
   *  has logged some). */
  function payout(model, n, linked) {
    const P = model && model.payouts ? model.payouts : null;
    const b = P && P.bySize ? P.bySize[n] : null;
    const mult = b && isNum(b.mult) && b.mult > 1 ? b.mult : POWER[n] || null;
    if (!mult || linked !== true) return mult;
    const sh = P && P.linked ? P.linked.share : null;
    const cut = isNum(sh) && sh > 0 && sh < 1 ? Math.round(mult * sh * 100) / 100 : mult;
    return cut > 1 ? cut : mult;
  }
  /** One n-pick Power slip with chance `hit`: what it pays, its EV per $1, per-leg break-even, the stake as a share of the
   *  Balance (fractional Kelly, capped at STAKE_CAP) and the expected log growth of the Balance at that stake.
   *  linked === true prices it as a slip of linked legs (payout). */
  function slipPlan(model, n, hit, linked) {
    const mult = payout(model, n, linked);
    if (!mult || !isNum(hit)) return null;
    const full = kelly(hit, mult);
    const stake = Math.min(STAKE_CAP, kellyScale(model) * full);
    return { n, mult, standard: POWER[n], be: Math.pow(1 / mult, 1 / n), hit, ev: hit * mult - 1, kelly: full, stake, growth: growth(hit, mult, stake) };
  }
  /** The day limit: a day's entries together take at most DAY_CAP of the Balance he started that day with. balance: the
   *  Balance now (stakes leave it when an entry is placed); ledger: his entries; today: "YYYY-MM-DD", the date entries
   *  carry. Returns dollars {start, limit, staked, left}; null without a day limit, a Balance or a date. Every entry
   *  of the day counts with its stake, settled or not (a win doesn't buy more room), and bonus entries count nothing.
   *  cap: a share to use in place of DAY_CAP. The app never passes one, so with DAY_CAP null (SAFE_STAKES off) it
   *  always gets null: no day limit. The tests pass one to keep this code checked while the switch is off. */
  function dayLimit(balance, ledger, today, cap) {
    const share = cap === undefined ? DAY_CAP : cap;
    if (!isNum(share) || !(share > 0) || !isNum(balance) || typeof today !== "string" || !today) return null;
    let staked = 0, back = 0;
    for (const e of Array.isArray(ledger) ? ledger : []) {
      if (!e || typeof e !== "object" || String(e.date || "") !== today) continue;
      const st = toNum(e.stake), pay = toNum(e.payout);
      if (st != null && st > 0) staked += st;
      if (pay != null && pay > 0) back += pay;
    }
    const r2 = x => Math.round(x * 100) / 100;
    const start = Math.max(0, balance + staked - back), limit = share * start;
    return { start: r2(start), limit: r2(limit), staked: r2(staked), left: r2(Math.max(0, limit - staked)) };
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
    { key: "marketGapPct", label: "Softer than market", kind: "sd", get: r => toNum(fget(r, "marketGapPct")) },
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
      // skip a segment that repeats the same picks as one already chosen: a parent/child with identical n, or any two
      // segments over the very same picks (e.g. "Soccer Shots On Target over" and "Soccer Over" when that is all of it)
      if (out.some(o => o.source === s.source && ((o._rows != null && o._rows === s._rows) ||
        (o.n === s.n && (isAncestor(o, s) || isAncestor(s, o)))))) continue;
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

  /** Build the learning model from Vici's journal. journal: JournalPick[] (or the ai-picks.json object). */
  function build(opts) {
    const o = opts || {};
    const nowMs = o.now == null ? null : o.now instanceof Date ? o.now.getTime() : toNum(o.now);
    const J = journalRows(o.journal);
    const calibration = fitCalibration(J.rows);
    const bot = analyzeSource("bot", J.rows, J.excluded);
    bot.pendingBy = J.pendingBy;
    const track = fitTrack(J.rows);
    track.bySport = {};
    for (const [sp, g] of groupBy(J.rows, r => r.sport)) track.bySport[sp] = fitTrack(g);
    const fit = fitFactors(J.rows);
    const cands = bot.segments.slice();
    for (const k of Object.keys(bot.by)) for (const s of bot.by[k]) if (s.n < 0.9 * bot.n) cands.push(s);
    // each sport's own trust/fade: its stat and side segments and its flat ones, leaving out any that is (nearly) the
    // whole sport, which its record already shows
    const bySport = {};
    for (const seg of bot.segments) {
      if (seg.level !== "sport") continue;
      const sp = seg.sport, own = [];
      for (const s of bot.segments) if (s.sport === sp && s.level !== "sport" && s.n < 0.9 * seg.n) own.push(s);
      const flats = bot.bySport[sp] || {};
      for (const k of Object.keys(flats)) for (const s of flats[k]) if (s.n < 0.9 * seg.n) own.push(s);
      bySport[sp] = { trust: pickTop(own, "trust", 5), fade: pickTop(own, "fade", 5) };
    }
    const sports = Object.keys(bySport).concat(Object.keys(J.pendingBy)).filter((x, i, a) => a.indexOf(x) === i).sort(sportSort);
    const be = { power: {}, flex: {} };
    for (const n of [2, 3, 4, 5, 6]) { be.power[n] = breakEven(n, "power"); if (FLEX[n]) be.flex[n] = breakEven(n, "flex"); }
    const payouts = fitPayouts(o.ledger), profit = fitProfit(o.ledger), alt = fitAltLines(o.ledger, payouts);
    return roundDeep({
      version: 1,
      builtAt: nowMs == null ? null : new Date(nowMs).toISOString(),
      params: { k: K, globalStrength: G_STRENGTH, thin: THIN, calMin: CAL_MIN, factorMin: FACTOR_MIN, lambda: LAMBDA, residK: RESID_K, residMin: RESID_MIN, clamp: [P_MIN, P_MAX],
        calRamp: CAL_RAMP, payK: PAY_K, kelly: [KELLY_LO, KELLY_HI], stakeCap: STAKE_CAP, dayCap: DAY_CAP, altPrior: ALT_PRIOR },
      breakEven: be, payouts, alt, profit,
      bot, track, calibration,
      factors: fit.factors,
      factorN: fit.n,
      trust: pickTop(cands, "trust", 5),
      fade: pickTop(cands, "fade", 5),
      sports, bySport
    });
  }

  // ---------- adjust ----------
  const pts = x => { const v = Math.round(x * 100); return (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v); };
  /** Vici %: raw prob through its sport's calibration + the shrunk residual of the most specific bot segment with ≥10
   *  graded picks, clamped. The two are weighed together: with net = what they add to the bot's own prob in full, a net
   *  cut counts in full and a net raise only as far as that sport's graded picks have earned it (calShare), so
   *  p = raw + net (net <= 0) or raw + net x share. parts.fit is what the fitted calibration says, parts.calibrated what
   *  counted of it and parts.calShare that part as a share; parts.segment is the segment's shift as it counted and
   *  parts.segmentShare its share of the full shift. A pick with no sport is read as "Other" when the journal has such
   *  picks (their segments are measured against that fit), else on the pooled fit. */
  function adjust(model, rawProb, ctx) {
    const c = ctx || {};
    let raw = toNum(rawProb);
    if (raw != null && raw > 1 && raw <= 100) raw /= 100;
    const noRaw = raw == null || !(raw > 0 && raw < 1);
    if (noRaw) raw = 0.5;
    const sport = canonSport(c.sport), st = canonStat(sport, c.stat), side = canonSide(c.side);
    const named = c.sport != null && String(c.sport).trim() !== "";
    const bySport = model && model.calibration && model.calibration.bySport;
    const own = named || (bySport && bySport[sport]) ? sport : null;
    const fit = calibrated(model, raw, own);
    const earned = calShare(model, own);
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
    // A raise has to be earned, a cut counts in full, and the two corrections are weighed together (the segment's
    // residual is measured against the full fit). Pulling the same way: both by the earned share when they raise, both
    // in full when they cut. Pulling against each other: the one that cuts counts in full, and the other in full as
    // far as it only makes up for that cut (room) and by the share beyond it.
    const fitAdj = fit - raw, segFull = seg ? w * seg.resid : 0;
    let share = 1, segShare = 1;
    if (fitAdj >= 0 && segFull >= 0) { if (fitAdj > 0) share = earned; if (segFull > 0) segShare = earned; }
    else if (fitAdj < 0 && segFull > 0) { const room = -fitAdj; if (segFull > room) segShare = (room + (segFull - room) * earned) / segFull; }
    else if (fitAdj > 0 && segFull < 0) { const room = -segFull; if (fitAdj > room) share = (room + (fitAdj - room) * earned) / fitAdj; }
    const cal = raw + fitAdj * share;
    const segAdj = segFull * segShare;
    const unclamped = cal + segAdj;
    const p = clamp(unclamped, P_MIN, P_MAX);
    const bits = [];
    if (noRaw) bits.push("no prob");
    if (model && model.calibration && model.calibration.n > 0 && Math.abs(cal - raw) >= 0.005) bits.push("calib " + pts(cal - raw));
    if (seg && Math.abs(segAdj) >= 0.005) bits.push(seg.label + " " + pts(segAdj) + " (n=" + seg.nP + ")");
    if (p !== unclamped) bits.push("capped");
    const botN = model && model.bot ? model.bot.n || 0 : 0;
    const note = bits.length ? bits.join(" · ") : botN ? "as is" : "no history";
    return {
      p,
      parts: {
        raw, fit, calShare: share, calibrated: cal, segment: segAdj,
        segmentKey: seg ? seg.key : null, segmentLabel: seg ? seg.label : null, segmentN: seg ? seg.nP : 0, segmentWeight: w, segmentShare: segShare
      },
      note
    };
  }

  // ---------- text outputs ----------
  const pct = x => (isNum(x) ? Math.round(x * 100) + "%" : "—");
  function segLine(kind, s) {
    return kind + ": " + s.label.trim() + " " + pct(s.raw) + " (" + s.hits + "/" + s.n + ").";
  }
  /** Compact plain text (≤ 1,200 chars) the bot reads before answering. */
  function promptBlock(model) {
    const m = model || build({});
    const bot = m.bot || { n: 0 }, tr = m.track || { n: 0 }, cal = m.calibration || { n: 0, verdict: "—" };
    const head = "Your graded picks: " + bot.n + (bot.n ? ", " + pct(bot.raw) + " hit" : "") +
      (tr.n ? "; Vici % averaged " + pct(tr.pred) + " on " + tr.n + " of them" : "") + ".";
    const mid = [];
    const graded = (bot.segments || []).filter(s => s.level === "sport" && s.n).sort((a, b) => b.n - a.n || sportSort(a.sport, b.sport));
    if (graded.length > 1) {
      // each sport's own record, its average Vici %, and its own calibration when that has a clear lean
      mid.push("By sport: " + graded.map(s => {
        const t = m.track && m.track.bySport ? m.track.bySport[s.sport] : null;
        const c = cal.bySport ? cal.bySport[s.sport] : null;
        let txt = s.sport + " " + s.hits + "/" + s.n + " (" + pct(s.raw) + ")";
        if (t && t.n) txt += ", Vici % " + pct(t.pred);
        if (c && (c.verdict === "over" || c.verdict === "under")) txt += ", " + Math.max(1, Math.round(Math.abs(c.gap) * 100)) + " pts too " + (c.verdict === "over" ? "confident" : "cautious");
        else if (c && c.verdict === "well" && isNum(c.gapSD) && c.gapSD <= 0.03) txt += ", calibrated";   // as sure as the pooled line
        return txt;
      }).join("; ") + ".");
    }
    // with several sports this is the pooled lean; each sport's own is on the By sport line
    const calHead = graded.length > 1 ? "Calibration, all sports: " : graded.length === 1 ? "Calibration (" + graded[0].sport + " picks only): " : "Calibration: ";
    if (cal.verdict === "over" || cal.verdict === "under") {
      const use60 = cal.n60 >= 10 && isNum(cal.gap60) && Math.sign(cal.gap60) === Math.sign(cal.gap) && Math.abs(cal.gap60) >= Math.abs(cal.gap);
      const g = use60 ? cal.gap60 : cal.gap;
      const p = Math.max(1, Math.round(Math.abs(g) * 100));
      mid.push(calHead + "bot runs " + p + " pts too " + (cal.verdict === "over" ? "confident" : "cautious") + (use60 ? " above 60%" : "") + " (n=" + cal.n + ").");
    } else if (cal.verdict === "well") {
      mid.push(calHead + (cal.gapSD <= 0.03 ? "well calibrated" : "no clear bias yet") + " (n=" + cal.n + ", Brier " + (isNum(cal.brier) ? cal.brier.toFixed(3) : "—") + " vs 0.250).");
    } else if (cal.n > 0) {
      mid.push(calHead + "too few graded bot picks (n=" + cal.n + ").");
    }
    const trust = (m.trust || []).slice(0, 3), fade = (m.fade || []).slice(0, 3);
    for (const s of trust) mid.push(segLine("Trust", s));
    for (const s of fade) mid.push(segLine("Fade", s));
    for (const f of (m.factors || []).filter(x => x.verdict !== "noise").slice(0, 2)) {
      const lift = Math.round(f.lift);
      mid.push("Factor: " + f.label + (f.kind === "sd" ? " +1 SD " : " ") + (lift >= 0 ? "+" : "-") + Math.abs(lift) + " pts (n=" + f.n + ").");
    }
    const pr = m.profit;
    if (pr && pr.n) {
      const usd = x => (x < 0 ? "−$" : "+$") + Math.abs(x).toFixed(2);
      mid.unshift("Your slips he played: " + pr.n + " settled, " + pr.won + " won, " + usd(pr.pnl) + " (ROI " + pts(pr.roi) + "%" +
        (isNum(pr.expectedRoi) ? ", EV said " + pts(pr.expectedRoi) + "%" : "") + ")" + (pr.open ? ", " + pr.open + " open" : "") + ".");
    }
    const P = m.payouts && m.payouts.bySize ? m.payouts : null;
    const mx = x => (Math.round(x * 100) / 100) + "x";
    const A = m.alt && m.alt.goblin && m.alt.demon ? m.alt : null;
    const altTxt = A ? " One goblin leg makes a slip pay \u00d7" + (Math.round(A.goblin.factor * 100) / 100) + " of that and one demon leg \u00d7" +
      (Math.round(A.demon.factor * 100) / 100) + " (from " + A.goblin.n + " and " + A.demon.n + " of his entries; \u00d70.8 and \u00d71.2 before any)." : "";
    const tail = (P && P.n
      ? "Payouts he gets (from " + P.n + " Power entries; standard 3/5/10/20/37.5x; est. = under 3 entries of that size, scaled by his other sizes) and break-even per leg: " +
        [2, 3, 4, 5, 6].map(n => { const b = P.bySize[n]; return "Power" + n + " " + mx(b.mult) + (b.n < 3 ? " est." : "") + " " + (b.be * 100).toFixed(1) + "%"; }).join(", ") + "." +
        (P.linked && P.linked.n && P.linked.share < 1 ? " Linked slips have paid " + Math.round(P.linked.share * 100) + "% of that (" + P.linked.n + " logged)." : "")
      : "Payouts: the standard 3/5/10/20/37.5x until his Power entries show what he gets. Break-even per leg: " +
        [2, 3, 4, 5, 6].map(n => "Power" + n + " " + (breakEven(n, "power") * 100).toFixed(1) + "%").join(", ") + ".") + altTxt;
    const lines = [head].concat(mid, [tail]);
    while (lines.join("\n").length > 1200 && lines.length > 2) lines.splice(lines.length - 2, 1);
    return lines.join("\n");
  }
  /** Headline numbers (the grade_picks result), for all picks or one sport ("NBA"). Rates are fractions (0..1) or null when
   *  nothing is graded. */
  function summary(model, sport) {
    const m = model || {};
    const sp = sport == null || sport === "" || String(sport).toLowerCase() === "all" ? null : canonSport(sport);
    if (sp) {
      const bot = m.bot || {};
      const seg = (bot.segments || []).find(s => s.level === "sport" && s.key === sp);
      const tr = (m.track && m.track.bySport && m.track.bySport[sp]) || { n: 0 };
      const c = m.calibration && m.calibration.bySport ? m.calibration.bySport[sp] : null;
      const n = seg ? seg.n : 0, hits = seg ? seg.hits : 0;
      return {
        graded: n, hits, misses: n - hits,
        pending: (bot.pendingBy && bot.pendingBy[sp]) || 0,
        rate: n ? seg.raw : null,
        predicted: tr.n ? tr.pred : null, actual: tr.n ? tr.actual : null, trackN: tr.n || 0,
        calib: (c && c.verdict) || "—"
      };
    }
    const bot = m.bot || { n: 0 }, tr = m.track || { n: 0 };
    return {
      graded: bot.n || 0, hits: bot.hits || 0, misses: bot.n ? bot.n - bot.hits : 0,
      pending: (bot.excluded && bot.excluded.pending) || 0,
      rate: bot.n ? bot.raw : null,
      predicted: tr.n ? tr.pred : null, actual: tr.n ? tr.actual : null, trackN: tr.n || 0,
      calib: (m.calibration && m.calibration.verdict) || "—"
    };
  }
  /** Trimmed model for the `vici_model` tool (small JSON): all sports, or one sport's own model. */
  function compact(model, sport) {
    const m = model || build({});
    const r2 = x => Math.round(x * 100) / 100;
    const segOut = s => ({ seg: s.label.trim(), n: s.n, hits: s.hits, raw: s.raw, post: s.post, lo80: s.lo80, hi80: s.hi80, verdict: s.verdict });
    const top = src => (src && src.segments ? src.segments.filter(s => s.n >= THIN).slice(0, 12).map(segOut) : []);
    const trackOut = t => (t ? { n: t.n, predicted: t.pred, actual: t.actual,
      buckets: (t.buckets || []).filter(b => b.n).map(b => ({ b: b.label, n: b.n, pred: b.pred, actual: b.actual })) } : null);
    const calOut = (c, pooled) => Object.assign({ n: c.n },
      // all sports: a, b are the pooled fit, which only a sport with no graded picks uses; each sport has its own
      pooled ? { pooled_a: c.a, pooled_b: c.b, note: "pooled_a/b apply only to a sport with no graded picks; each sport's own fit is in by_sport. What the fit and a segment's shift together add above the bot's prob counts raise_counts of it (n/(n+" + CAL_RAMP + ") on that sport's own graded picks, 0 for a sport with none); a net cut counts in full" } : { a: c.a, b: c.b },
      { verdict: c.verdict, gapPts: isNum(c.gap) ? Math.round(c.gap * 1000) / 10 : null, brier: c.brier,
        buckets: (c.buckets || []).filter(b => b.n).map(b => ({ b: b.label, n: b.n, pred: b.pred, actual: b.actual })) });
    const c = m.calibration || {};
    const sp = sport == null || sport === "" || String(sport).toLowerCase() === "all" ? null : canonSport(sport);
    if (sp) {
      const bot = m.bot || {};
      const seg = (bot.segments || []).find(s => s.level === "sport" && s.key === sp);
      const mine = (m.bySport && m.bySport[sp]) || { trust: [], fade: [] };
      const flats = (bot.bySport && bot.bySport[sp]) || {};
      const segs = (bot.segments || []).filter(s => s.sport === sp && s.level !== "sport")
        .concat(...Object.keys(flats).map(k => flats[k])).filter(s => s.n >= THIN).sort((a, b) => b.n - a.n || cmpStr(a.key, b.key));
      const cs = c.bySport && c.bySport[sp];
      return {
        sport: sp, builtAt: m.builtAt || null,
        bot: seg ? { n: seg.n, hits: seg.hits, raw: seg.raw, post: seg.post, lo80: seg.lo80, hi80: seg.hi80 } : { n: 0 },
        pending: (bot.pendingBy && bot.pendingBy[sp]) || 0,
        predicted_vs_actual: trackOut(m.track && m.track.bySport ? m.track.bySport[sp] : null),
        calibration: cs ? Object.assign(calOut(cs), { raise_counts: r2(calShare(m, sp)) })
          : { n: 0, raise_counts: 0, note: "no graded " + sp + " picks with a prob yet: the pooled calibration applies, and only where it lowers a chance" },
        trust: mine.trust.map(segOut), fade: mine.fade.map(segOut),
        segments: segs.slice(0, 12).map(segOut),
        breakEven: m.breakEven || null
      };
    }
    const bySp = {};
    for (const s of ((m.bot && m.bot.segments) || []).filter(x => x.level === "sport")) {
      const t = m.track && m.track.bySport ? m.track.bySport[s.sport] : null, cs = c.bySport ? c.bySport[s.sport] : null;
      bySp[s.sport] = { n: s.n, hits: s.hits, raw: s.raw, predicted: t && t.n ? t.pred : null, calib: cs ? cs.verdict : "—",
        gapPts: cs && isNum(cs.gap) ? Math.round(cs.gap * 1000) / 10 : null, a: cs ? cs.a : null, b: cs ? cs.b : null,
        raise_counts: r2(calShare(m, s.sport)) };
    }
    return {
      builtAt: m.builtAt || null,
      bot: m.bot ? { n: m.bot.n, hits: m.bot.hits, raw: m.bot.raw, post: m.bot.post } : null,
      by_sport: bySp,
      predicted_vs_actual: trackOut(m.track),
      calibration: calOut(c, true),
      trust: (m.trust || []).map(segOut), fade: (m.fade || []).map(segOut),
      factors: (m.factors || []).map(f => ({ f: f.label, n: f.n, liftPts: Math.round(f.lift * 10) / 10, sePts: Math.round(f.liftSE * 10) / 10, verdict: f.verdict })),
      segments: top(m.bot),
      breakEven: m.breakEven || null,
      // what PrizePicks pays him per Power size (learned from his entries) and the stake rule
      payouts: m.payouts ? { from_entries: m.payouts.n, by_size: Object.keys(m.payouts.bySize || {}).reduce((o, k) => {
        const b = m.payouts.bySize[k]; o[k] = { pays: b.mult, standard: b.standard, n: b.n, be: b.be }; return o; }, {}),
        linked_slips: m.payouts.linked && m.payouts.linked.n ? { n: m.payouts.linked.n, share_of_usual: m.payouts.linked.share } : null } : null,
      // what one goblin or demon leg does to a slip's payout (learned from his entries) and how suggest_picks counts it
      alt_lines: m.alt ? { goblin: { factor: m.alt.goblin.factor, from_entries: m.alt.goblin.n },
        demon: { factor: m.alt.demon.factor, from_entries: m.alt.demon.n },
        rule: "a goblin or demon leg counts at its chance x factor; with this learned factor never above the same prop's chance at its standard line" } : null,
      stake_rule: { kelly_share: kellyScale(m), cap: STAKE_CAP, day_cap: DAY_CAP },
      your_slips: m.profit && (m.profit.n || m.profit.open) ? m.profit : null
    };
  }

  const api = {
    version: 1,
    POWER, FLEX,
    breakEven, edge, build, adjust, promptBlock, summary, compact,
    payout, slipPlan, kelly, growth, kellyScale, dayLimit, altFactor, altValue, altSplit,
    stakeRule: { kelly: [KELLY_LO, KELLY_HI], cap: STAKE_CAP, dayCap: DAY_CAP },
    calibrated, calShare, canonStat, canonSport, canonSide, SPORT_ORDER, sportSort,
    util: { logit, sigmoid, invert, inv2, betaPost, verdictOf, fitPayouts, fitProfit, fitAltLines, altCounts }
  };
  if (root) root.ViciModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null);
