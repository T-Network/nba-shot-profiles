// Pull shot-by-shot data for a set of NBA players from ESPN's public APIs and
// write data/meta.js plus one data/<player>.js per player for the dashboard.
//
// For each player we take the FIRST regular-season game of each season:
//   season=2025 -> 2024-25, season=2026 -> 2025-26, season=2027 -> 2026-27
// (ESPN's `season` query param is the calendar year the season ends in, and the
// gamelog mixes preseason in, so we read only the "Regular Season" bucket and
// then take the earliest date.)
//
// If a player missed his team's opener, the earliest game he actually played is
// used and the record is flagged (missedTeamOpener) so the UI can say so instead
// of passing a mid-season game off as opening night.
//
// ESPN coordinate system (verified against the play text distances):
//   x: 0..50 feet across the width of the court, hoop at x = 25
//   y: feet out from the baseline through the hoop, hoop at y = 0
// Free throws carry a sentinel coordinate, so they are excluded from shot charts.

import { writeFileSync, mkdirSync } from "node:fs";

const HOOP_X = 25;
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
  if (/free throw/.test(t)) return "Free throw";
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
  if (/jumper|jump shot|jumpshot|three point|three-pointer/.test(t)) {
    return /assists/.test(t) ? "Catch & shoot" : "Jumper";
  }
  return "Jumper";
}

function textDistance(text) {
  const m = text.match(/(\d+)\s*-?\s*foot/);
  return m ? Number(m[1]) : null;
}

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, UA);
      if (res.ok) return await res.json();
      lastErr = new Error(`${url} -> HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr;
}

const summaryUrl = (id) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`;
const playsUrl = (id) =>
  `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${id}/competitions/${id}/plays?limit=1000`;
const gamelogUrl = (espnId, season) =>
  `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnId}/gamelog?season=${season}`;
const scheduleUrl = (abbr, season) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${abbr}/schedule?season=${season}`;

function athleteIdOf(play) {
  const ref = play.participants?.[0]?.athlete?.$ref ?? "";
  const m = ref.match(/athletes\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function extract(plays, player) {
  const first = player.name.split(" ")[0];
  const last = player.name.split(" ").pop();
  const nameRe = new RegExp(`^${first} ${last} (makes|misses)`, "i");
  const shots = [];
  const skipped = [];

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
      skipped.push(text);
      continue;
    }

    const made = typeof p.scoringPlay === "boolean" ? p.scoringPlay : /\bmakes\b/.test(text);
    const isThree =
      p.pointsAttempted === 3 ||
      /three point|three-pointer|3-point|heave/.test(text.toLowerCase());
    const geom = Math.hypot(x - HOOP_X, y);
    const dist = textDistance(text) ?? geom;

    shots.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      made,
      pts: isThree ? 3 : 2,
      dist: Math.round(dist * 10) / 10,
      geom: Math.round(geom * 10) / 10,
      isThree,
      zone: zoneOf({ x, y, isThree, geom }),
      style: styleOf(text),
      period: p.period?.number ?? null,
      clock: p.clock?.displayValue ?? null,
      text,
    });
  }
  return { shots, skipped };
}

function matchupOf(competitors, teamId) {
  const me = competitors.find((c) => Number(c.team?.id) === Number(teamId));
  const other = competitors.find((c) => c !== me);
  const home = me?.homeAway === "home";
  return {
    team: me?.team?.abbreviation ?? null,
    teamName: me?.team?.displayName ?? null,
    opponent: other?.team?.abbreviation ?? null,
    opponentName: other?.team?.displayName ?? null,
    homeAway: me?.homeAway ?? null,
    venue: me ? (home ? `vs ${other?.team?.abbreviation}` : `at ${other?.team?.abbreviation}`) : null,
    teamScore: me?.score ?? null,
    oppScore: other?.score ?? null,
  };
}

// Official box line + matchup details for this specific game.
function boxAndMatchup(summary, player) {
  const competitors = summary.header?.competitions?.[0]?.competitors ?? [];
  const line = { min: null, pts: null, fg: null, three: null, ft: null };

  const mineTeam = (summary.boxscore?.players ?? []).find((team) =>
    (team.statistics ?? []).some((st) =>
      (st.athletes ?? []).some((a) => Number(a.athlete?.id) === player.espnId)
    )
  );
  const teamId = mineTeam?.team?.id ?? competitors[0]?.team?.id;

  for (const team of summary.boxscore?.players ?? []) {
    for (const stat of team.statistics ?? []) {
      const keys = stat.keys ?? [];
      for (const a of stat.athletes ?? []) {
        if (Number(a.athlete?.id) !== player.espnId) continue;
        const map = {};
        keys.forEach((k, i) => (map[k] = a.stats?.[i]));
        line.min = map.minutes ?? null;
        line.pts = map.points ?? null;
        line.fg = map["fieldGoalsMade-fieldGoalsAttempted"] ?? null;
        line.three = map["threePointFieldGoalsMade-threePointFieldGoalsAttempted"] ?? null;
        line.ft = map["freeThrowsMade-freeThrowsAttempted"] ?? null;
        line.team = team.team?.abbreviation ?? null;
        return { line, matchup: matchupOf(competitors, team.team?.id ?? teamId) };
      }
    }
  }
  return { line, matchup: matchupOf(competitors, teamId) };
}

function totalsOf(shots, box) {
  const fga = shots.length;
  const fgm = shots.filter((s) => s.made).length;
  const tpa = shots.filter((s) => s.isThree).length;
  const tpm = shots.filter((s) => s.isThree && s.made).length;
  const pts = shots.reduce((a, s) => a + (s.made ? s.pts : 0), 0);
  const parse = (v) =>
    typeof v === "string" && v.includes("-") ? v.split("-").map(Number) : [null, null];
  const [ftm, fta] = parse(box.ft);
  return {
    chartedFga: fga,
    chartedFgm: fgm,
    chartedPts: pts,
    tpa,
    tpm,
    tpPct: tpa ? tpm / tpa : 0,
    fgPct: fga ? fgm / fga : 0,
    ftPct: fta ? ftm / fta : null,
    ftm,
    fta,
    efg: fga ? (fgm + 0.5 * tpm) / fga : 0,
    avgDist: fga ? shots.reduce((a, s) => a + s.dist, 0) / fga : 0,
    paintRate: fga ? shots.filter((s) => s.zone === "Paint").length / fga : 0,
    threeRate: fga ? tpa / fga : 0,
    midRate: fga
      ? shots.filter((s) => s.zone === "Short mid" || s.zone === "Long mid").length / fga
      : 0,
  };
}

// First regular-season game of a season, from the player's gamelog.
async function firstGameOfSeason(espnId, season) {
  const log = await getJson(gamelogUrl(espnId, season));
  const events = log.events ?? {};
  const regular = (log.seasonTypes ?? []).find((t) => /regular season/i.test(t.displayName ?? ""));
  const ids = (regular?.categories ?? [])
    .flatMap((c) => c.events ?? [])
    .map((e) => String(e.eventId ?? e.id ?? e));
  const dated = ids
    .map((id) => ({ id, date: events[id]?.gameDate ?? null }))
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { first: dated[0] ?? null, gamesPlayed: dated.length };
}

// The team's actual opening night, so we can tell when a player missed it.
async function teamOpener(abbr, season) {
  if (!abbr) return null;
  try {
    const sch = await getJson(scheduleUrl(abbr, season));
    const reg = (sch.events ?? [])
      .filter((e) => Number(e.seasonType?.type ?? e.seasonType?.id ?? 2) === 2)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const first = reg[0];
    if (!first) return null;
    const comps = first.competitions?.[0]?.competitors ?? [];
    const mine = comps.find((c) => c.team?.abbreviation === abbr);
    const other = comps.find((c) => c !== mine);
    return {
      eventId: first.id,
      date: String(first.date ?? "").slice(0, 10),
      venue: mine
        ? `${mine.homeAway === "home" ? "vs" : "at"} ${other?.team?.abbreviation}`
        : null,
    };
  } catch {
    return null;
  }
}

const out = {
  generated: new Date().toISOString(),
  source:
    "ESPN public play-by-play + box score (sports.core.api.espn.com, site.api.espn.com). Shot coordinates as published by ESPN; free throws excluded from shot charts.",
  seasons: SEASONS.map((s) => s.label),
  players: [],
};

const rows = [];

for (const player of PLAYERS) {
  const entry = { key: player.key, short: player.short, name: player.name, espnId: player.espnId, games: [] };

  for (const s of SEASONS) {
    let found = { first: null, gamesPlayed: 0 };
    try {
      found = await firstGameOfSeason(player.espnId, s.season);
    } catch (e) {
      console.warn(`  ! ${player.name} ${s.label}: gamelog failed (${e.message})`);
    }
    if (!found.first) {
      entry.games.push({ season: s.label, missing: true, reason: "no regular-season game on record" });
      rows.push([player.short, s.label, "MISSING", "-", "-"]);
      continue;
    }

    const [plays, summary] = await Promise.all([
      getJson(playsUrl(found.first.id)),
      getJson(summaryUrl(found.first.id)),
    ]);
    const { shots, skipped } = extract(plays.items ?? [], player);
    const { line, matchup } = boxAndMatchup(summary, player);
    const totals = totalsOf(shots, line);
    const opener = await teamOpener(matchup.team, s.season);
    const missedTeamOpener = Boolean(opener && opener.date !== found.first.date.slice(0, 10));

    entry.games.push({
      season: s.label,
      eventId: found.first.id,
      date: found.first.date.slice(0, 10),
      ...matchup,
      seasonGames: found.gamesPlayed,
      teamOpener: opener,
      missedTeamOpener,
      box: line,
      shots,
      totals,
    });

    rows.push([
      player.short,
      s.label,
      `${found.first.date.slice(0, 10)} ${matchup.venue ?? ""}`.padEnd(18),
      `${totals.chartedFgm}-${totals.chartedFga} charted / box ${line.fg}`.padEnd(22),
      `${line.three} 3P, ${line.pts} pts, played ${found.gamesPlayed}${missedTeamOpener ? `, MISSED OPENER (team ${opener.date})` : ""}, skipped ${skipped.length}`,
    ]);
  }

  out.players.push(entry);
}

// One file per player so the data stays reviewable (and diffable) at league scale.
const round3 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const roundDeep = (v) => JSON.parse(JSON.stringify(v), (k, val) => round3(val));

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/meta.js",
  `window.SHOT_DATA_META = ${JSON.stringify(
    { generated: out.generated, source: out.source, seasons: out.seasons },
    null,
    1
  )};\n`
);
for (const p of out.players) {
  writeFileSync(
    `data/${p.key}.js`,
    `window.SHOT_DATA_PLAYERS = (window.SHOT_DATA_PLAYERS || []).concat(${JSON.stringify(
      [roundDeep(p)]
    )});\n`
  );
}

for (const r of rows) console.log(r.join(" | "));
console.log(`\nwrote data/meta.js + ${out.players.length} player files: ${out.players.map((p) => p.key).join(", ")}`);
