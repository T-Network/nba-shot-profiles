// Pull EVERY regular-season shot by a set of NBA players from ESPN's public APIs.
//
// Output (all small enough to load lazily in the browser):
//   data/index.js            — player/season aggregates only (~a few KB, always loaded)
//   data/<player>-<season>.js — that season's games, each with compact shot arrays
//
// Layout:
//   - ESPN's `season` query param is the calendar year the season ENDS in,
//     so 2024-25 is season=2025 and 2026-27 is season=2027.
//   - The athlete gamelog mixes preseason in, so only the "Regular Season"
//     bucket is read. It also carries the official per-game box line, which
//     means one request per player-season instead of one per game.
//   - Play-by-play (shots + coordinates) is one request per game and is cached
//     in .cache/plays/<eventId>.json, so re-runs are near-instant.
//
// ESPN coordinate system (verified against the play text distances):
//   x: 0..50 feet across the width of the court, hoop at x = 25
//   y: feet out from the baseline through the hoop, hoop at y = 0
// Free throws carry a sentinel coordinate, so they are excluded from shot charts.
//
// Usage:
//   node scripts/build-data.mjs            # full rebuild (uses the cache)
//   node scripts/build-data.mjs --refresh  # ignore the cache, re-download
//   node scripts/build-data.mjs --sample 3 # only the first 3 games per season

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const CACHE = ".cache/plays";
mkdirSync(CACHE, { recursive: true });

const ARGS = process.argv.slice(2);
const REFRESH = ARGS.includes("--refresh");
const SAMPLE = (() => {
  const i = ARGS.indexOf("--sample");
  return i >= 0 ? Number(ARGS[i + 1]) || 0 : 0;
})();

const HOOP_X = 25;
const CONCURRENCY = 5;
const UA = { headers: { "user-agent": "Mozilla/5.0 (compatible; shot-dashboard/1.0)" } };

const PLAYERS = [
  { key: "ant", short: "Ant", name: "Anthony Edwards", espnId: 4594268 },
  { key: "luka", short: "Luka", name: "Luka Dončić", espnId: 3945274 },
  { key: "lamelo", short: "LaMelo", name: "LaMelo Ball", espnId: 4432816 },
  { key: "sga", short: "SGA", name: "Shai Gilgeous-Alexander", espnId: 4278073 },
];

const SEASONS = [
  { label: "2024-25", season: 2025 },
  { label: "2025-26", season: 2026 },
  { label: "2026-27", season: 2027 },
];

// Zone order is the order the dashboard draws them in.
const ZONES = ["Paint", "Short mid", "Long mid", "Corner 3", "Above break 3"];
const STYLES = [
  "Dunk",
  "Layup",
  "Floater",
  "Hook",
  "Tip-in",
  "Alley-oop",
  "Fadeaway",
  "Step-back",
  "Pull-up",
  "Catch & shoot",
  "Jumper",
  "Heave",
];

// ESPN plots the shooter's release point, so layups/dunks sit ~4-7 ft from the rim.
// Anything inside 8 ft is one "Paint" bucket rather than pretending to split rim
// attempts from close paint attempts.
function zoneOf({ x, y, isThree, geom }) {
  if (isThree) {
    const corner = y <= 13 && Math.abs(x - HOOP_X) >= 21.5;
    return corner ? "Corner 3" : "Above break 3";
  }
  if (geom < 8) return "Paint";
  if (geom < 16) return "Short mid";
  return "Long mid";
}

// Shot "style" from ESPN's play text. Order matters: most specific first.
function styleOf(text) {
  const t = text.toLowerCase();
  if (/heave|half.?court/.test(t)) return "Heave";
  if (/alley.?oop/.test(t)) return "Alley-oop";
  if (/dunk/.test(t)) return "Dunk";
  if (/tip|putback/.test(t)) return "Tip-in";
  if (/layup|finger roll/.test(t)) return "Layup";
  if (/hook/.test(t)) return "Hook";
  if (/floating|floater|runner/.test(t)) return "Floater";
  if (/fade\s?away|turnaround/.test(t)) return "Fadeaway";
  if (/step.?back/.test(t)) return "Step-back";
  if (/pull.?up/.test(t)) return "Pull-up";
  if (/assists/.test(t)) return "Catch & shoot";
  return "Jumper";
}

function textDistance(text) {
  const m = text.match(/(\d+)\s*-?\s*foot/);
  return m ? Number(m[1]) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, UA);
      if (res.ok) return await res.text();
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      lastErr = new Error(`${url} -> HTTP ${res.status}`);
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.max(retryAfter * 1000, 900 * (i + 1)));
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

const getJson = async (url) => JSON.parse(await getText(url));

const playsUrl = (id) =>
  `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${id}/competitions/${id}/plays?limit=1000`;
const gamelogUrl = (espnId, season) =>
  `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnId}/gamelog?season=${season}`;

/* ---------- official per-game box lines from the athlete gamelog ---------- */

// The gamelog's stat arrays are positional; `names` (when present) tells us which
// position is which so a schema change shows up as a loud failure, not bad data.
function statIndexer(log) {
  const names = log?.names ?? [];
  const find = (re) => names.findIndex((n) => re.test(n));
  const idx = {
    min: find(/^minutes$/i),
    fg: find(/^fieldGoalsMade-fieldGoalsAttempted$/i),
    three: find(/^threePointFieldGoalsMade-threePointFieldGoalsAttempted$/i),
    ft: find(/^freeThrowsMade-freeThrowsAttempted$/i),
    pts: find(/^points$/i),
  };
  const ok = Object.values(idx).every((v) => v >= 0);
  // Fallback to ESPN's long-standing default order if `names` is missing.
  return ok ? idx : { min: 0, fg: 1, three: 3, ft: 5, pts: 13 };
}

function pairOf(v) {
  if (typeof v !== "string" || !v.includes("-")) return [null, null];
  const [a, b] = v.split("-").map(Number);
  return [Number.isFinite(a) && Number.isFinite(b) ? a : null, Number.isFinite(a) && Number.isFinite(b) ? b : null];
}

async function seasonGames(player, season) {
  const log = await getJson(gamelogUrl(player.espnId, season.season));
  const idx = statIndexer(log);
  const meta = log.events ?? {};
  const regular = (log.seasonTypes ?? []).find((t) => /regular season/i.test(t.displayName ?? ""));
  const rows = (regular?.categories ?? []).flatMap((c) =>
    (c.events ?? []).map((e) => ({ eventId: String(e.eventId ?? e.id), stats: e.stats ?? [] }))
  );

  const games = rows.map((r) => {
    const m = meta[r.eventId] ?? {};
    const team = m.team ?? {};
    const opp = m.opponent ?? {};
    const date = String(m.gameDate ?? "").slice(0, 10);
    // ESPN's gamelog event uses atVs ("vs" | "@"), gameResult ("W" | "L") and a
    // free-text score like "127-125 OT" — not the numeric score object.
    const home = m.atVs === "vs";
    const result = m.gameResult === "W" ? "W" : m.gameResult === "L" ? "L" : null;
    return {
      eventId: r.eventId,
      date,
      opponent: opp.abbreviation ?? null,
      home,
      result,
      scoreLine: typeof m.score === "string" ? m.score : null,
      min: Number(r.stats[idx.min]) || null,
      pts: Number(r.stats[idx.pts]) || 0,
      fg: r.stats[idx.fg] ?? null,
      three: r.stats[idx.three] ?? null,
      ft: r.stats[idx.ft] ?? null,
      team: team.abbreviation ?? null,
    };
  });

  games.sort((a, b) => a.date.localeCompare(b.date));
  return { games, seasonName: regular?.displayName ?? null, sample: SAMPLE ? games.slice(0, SAMPLE) : games };
}

/* ---------- shot extraction ---------- */

function athleteIdOf(play) {
  const ref = play.participants?.[0]?.athlete?.$ref ?? "";
  const m = ref.match(/athletes\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function playsFor(eventId) {
  const file = `${CACHE}/${eventId}.json`;
  if (!REFRESH && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const text = await getText(playsUrl(eventId));
  writeFileSync(file, text);
  return JSON.parse(text);
}

// Compact shot record: [x, y, made, zoneIndex, styleIndex, period, distance]
function extractShots(plays, player) {
  const [first, ...rest] = player.name.split(" ");
  const last = rest.pop() ?? "";
  const nameRe = new RegExp(`^${first} ${last} (makes|misses)`, "i");
  const shots = [];
  let skipped = 0;

  for (const p of plays) {
    if (!p.shootingPlay) continue;
    const text = p.text ?? "";
    if (athleteIdOf(p) !== player.espnId && !nameRe.test(text)) continue;
    if (p.pointsAttempted === 1 || /free throw/i.test(text)) continue; // not a field goal

    const x = Number(p.coordinate?.x);
    const y = Number(p.coordinate?.y);
    const onCourt =
      Number.isFinite(x) && Number.isFinite(y) && x > -5 && x < 55 && y > -5 && y < 50;
    if (!onCourt) {
      skipped++;
      continue;
    }

    const made = typeof p.scoringPlay === "boolean" ? p.scoringPlay : /\bmakes\b/.test(text);
    const isThree =
      p.pointsAttempted === 3 || /three point|three-pointer|3-point|heave/i.test(text);
    const geom = Math.hypot(x - HOOP_X, y);
    const dist = textDistance(text) ?? geom;
    const zone = ZONES.indexOf(zoneOf({ x, y, isThree, geom }));
    const style = STYLES.indexOf(styleOf(text));

    shots.push([
      Math.round(x * 10) / 10,
      Math.round(y * 10) / 10,
      made ? 1 : 0,
      zone < 0 ? 2 : zone,
      style < 0 ? STYLES.length - 1 : style,
      p.period?.number ?? 0,
      Math.round(dist * 10) / 10,
    ]);
  }
  return { shots, skipped };
}

/* ---------- aggregate a season ---------- */

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function aggregate(games, shotsByGame) {
  const zones = Object.fromEntries(ZONES.map((z) => [z, [0, 0]]));
  const styles = Object.fromEntries(STYLES.map((s) => [s, [0, 0]]));
  const acc = {
    gp: 0, min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0,
    chartedFga: 0, chartedFgm: 0, chartedTpa: 0, chartedTpm: 0, chartedPts: 0,
    chartedGames: 0, skipped: 0, distSum: 0,
  };

  for (const g of games) {
    acc.gp++;
    acc.min += Number(g.min) || 0;
    acc.pts += Number(g.pts) || 0;
    const [fm, fa] = pairOf(g.fg);
    const [tm, ta] = pairOf(g.three);
    const [ftm, fta] = pairOf(g.ft);
    acc.fgm += fm ?? 0; acc.fga += fa ?? 0;
    acc.tpm += tm ?? 0; acc.tpa += ta ?? 0;
    acc.ftm += ftm ?? 0; acc.fta += fta ?? 0;

    const shots = shotsByGame.get(g.eventId) ?? [];
    if (!shots.length) continue;
    acc.chartedGames++;
    for (const [x, y, made, z, s, , dist] of shots) {
      acc.chartedFga++;
      acc.distSum += dist;
      zones[ZONES[z]][0]++;
      styles[STYLES[s]][0]++;
      if (made) {
        acc.chartedFgm++;
        zones[ZONES[z]][1]++;
        styles[STYLES[s]][1]++;
      }
      if (z >= 3) acc.chartedTpa++;
      if (z >= 3 && made) acc.chartedTpm++;
    }
  }
  acc.chartedPts = acc.chartedFgm * 2 + acc.chartedTpm;

  const r3 = (v) => Math.round(v * 1000) / 1000;
  const fga = acc.chartedFga || 1;
  return {
    ...acc,
    fgPct: acc.fga ? r3(acc.fgm / acc.fga) : 0,
    efg: r3((acc.chartedFgm + 0.5 * acc.chartedTpm) / fga),
    threeRate: r3(acc.chartedTpa / fga),
    paintRate: r3(zones.Paint[0] / fga),
    midRate: r3((zones["Short mid"][0] + zones["Long mid"][0]) / fga),
    avgDist: r3(acc.distSum / fga),
    zones,
    styles,
  };
}

/* ---------- main ---------- */

const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`);

step(`fetching ${PLAYERS.length} players x ${SEASONS.length} season gamelogs`);
const logs = [];
for (const player of PLAYERS) {
  for (const season of SEASONS) {
    try {
      const r = await seasonGames(player, season);
      logs.push({ player, season, ...r });
      step(`  ${player.short} ${season.label}: ${r.games.length} games${r.sample.length !== r.games.length ? ` (sampling ${r.sample.length})` : ""}`);
    } catch (e) {
      console.warn(`  ! ${player.short} ${season.label}: gamelog failed (${e.message})`);
      logs.push({ player, season, games: [], sample: [], error: e.message });
    }
  }
}

// One play-by-play download per unique game, shared across players who played it.
const uniqueEvents = [...new Set(logs.flatMap((l) => (l.sample ?? l.games).map((g) => g.eventId)))];
step(`${uniqueEvents.length} unique games to chart`);

let done = 0;
const plays = new Map();
const failures = [];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (uniqueEvents.length) {
      const id = uniqueEvents.shift();
      try {
        plays.set(id, (await playsFor(id)).items ?? []);
      } catch (e) {
        failures.push({ id, error: e.message });
      }
      done++;
      if (done % 25 === 0) step(`  ${done} games fetched (${failures.length} failed)`);
    }
  })
);
step(`play-by-play done: ${plays.size} games`);

/* ---------- build files ---------- */

mkdirSync("data", { recursive: true });
const index = {
  generated: new Date().toISOString(),
  source:
    "ESPN public play-by-play + athlete gamelog (sports.core.api.espn.com, site.web.api.espn.com). Shot coordinates as published by ESPN; free throws excluded from shot charts.",
  seasons: SEASONS.map((s) => s.label),
  zones: ZONES,
  styles: STYLES,
  players: [],
};

const report = [];

for (const player of PLAYERS) {
  const seasonReports = [];
  for (const season of SEASONS) {
    const log = logs.find((l) => l.player.key === player.key && l.season.label === season.label);
    const games = log?.sample ?? [];
    const shotsByGame = new Map();
    let skipped = 0;
    let missing = 0;

    for (const g of games) {
      const items = plays.get(g.eventId);
      if (!items) { missing++; continue; }
      const { shots, skipped: sk } = extractShots(items, player);
      skipped += sk;
      shotsByGame.set(g.eventId, shots);
    }

    const agg = aggregate(games, shotsByGame);
    agg.skipped = skipped;

    const payload = {
      // Tuple order is documented in index.html's G constant.
      games: games.map((g) => {
        const [fm, fa] = pairOf(g.fg);
        const [tm, ta] = pairOf(g.three);
        const [ftm, fta] = pairOf(g.ft);
        return [
          g.date,
          g.opponent,
          g.home ? 1 : 0,
          g.result,
          g.scoreLine,
          Number(g.min) || 0,
          Number(g.pts) || 0,
          fm ?? 0, fa ?? 0,
          tm ?? 0, ta ?? 0,
          ftm ?? 0, fta ?? 0,
          shotsByGame.get(g.eventId) ?? [],
        ];
      }),
    };

    if (games.length) {
      writeFileSync(
        `data/${player.key}-${season.label}.js`,
        `window.SHOTS=window.SHOTS||{};window.SHOTS["${player.key}|${season.label}"]=${JSON.stringify(payload)};\n`
      );
    }

    index.players.find((p) => p.key === player.key) ??
      index.players.push({ key: player.key, short: player.short, name: player.name, espnId: player.espnId, seasons: [] });

    index.players.find((p) => p.key === player.key).seasons.push({
      season: season.label,
      team: mostCommon(games.map((g) => g.team)),
      ...agg,
      unreadable: missing,
    });

    seasonReports.push({
      season: season.label,
      games: games.length,
      charted: agg.chartedGames,
      chartedFga: agg.chartedFga,
      boxFga: agg.fga,
      diff: agg.chartedFga - agg.fga,
      skipped,
      missing,
      bytes: existsSync(`data/${player.key}-${season.label}.js`)
        ? readFileSync(`data/${player.key}-${season.label}.js`).length
        : 0,
    });
  }
  index.players.find((p) => p.key === player.key).seasons.sort((a, b) =>
    a.season.localeCompare(b.season)
  );
  report.push({ player: player.short, seasonReports });
}

writeFileSync("data/index.js", `window.SHOT_INDEX=${JSON.stringify(index)};\n`);

/* ---------- console report ---------- */

console.log("\nplayer | season   | games | charted | chartedFGA vs official | diff | no-coord | unreadable | file");
for (const r of report) {
  for (const s of r.seasonReports) {
    console.log(
      [
        r.player.padEnd(6),
        s.season.padEnd(8),
        String(s.games).padStart(5),
        String(s.charted).padStart(7),
        `${s.chartedFga} vs ${s.boxFga}`.padStart(22),
        String(s.diff).padStart(4),
        String(s.skipped).padStart(8),
        String(s.missing).padStart(10),
        `${(s.bytes / 1024).toFixed(0)}KB`.padStart(6),
      ].join(" | ")
    );
  }
}
console.log(
  `\ntotal charted attempts: ${index.players.reduce((n, p) => n + p.seasons.reduce((m, s) => m + s.chartedFga, 0), 0)}`
);
if (failures.length) console.log(`failed games (${failures.length}):`, failures.slice(0, 5));
console.log(`\nwrote data/index.js + ${index.players.reduce((n, p) => n + p.seasons.filter((s) => s.chartedGames).length, 0)} season files`);
