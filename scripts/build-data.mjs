// Pull Anthony Edwards' shot-by-shot data for the two season openers from ESPN's
// public play-by-play API, normalise it, and write data/shots.js for the dashboard.
//
// ESPN coordinate system (verified against the play text distances):
//   x: 0..50 feet across the width of the court, hoop at x = 25
//   y: feet out from the baseline through the hoop, hoop at y = 0
// Free throws carry a sentinel coordinate, so they are excluded from shot charts.
//
// Games:
//   2025-26 opener: MIN @ POR, 2025-10-22, ESPN event 401809942 (NBA 0022500089)
//   2026-27 opener: MIN @ MIA, 2026-10-21, ESPN event 401909091 (NBA 0022600004)

import { writeFileSync, mkdirSync } from "node:fs";

const PLAYER_ID = 4594268; // ESPN athlete id for Anthony Edwards
const PLAYER_RE = /^Anthony Edwards (makes|misses)/i;
const HOOP_X = 25;

const GAMES = [
  {
    key: "last",
    label: "2025-26",
    eventId: "401809942",
    date: "2025-10-22",
    opponent: "POR",
    venue: "at Portland",
    nbaGameId: "0022500089",
  },
  {
    key: "this",
    label: "2026-27",
    eventId: "401909091",
    date: "2026-10-21",
    opponent: "MIA",
    venue: "at Miami",
    nbaGameId: "0022600004",
  },
];

// ESPN plots the shooter's release point, so layups/dunks sit ~4-7 ft from the rim.
// Anything inside 8 ft is therefore treated as one "Paint" bucket rather than
// pretending to split rim attempts from close paint attempts.
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

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchPlays(eventId) {
  const url =
    `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/` +
    `${eventId}/competitions/${eventId}/plays?limit=1000`;
  const data = await getJson(url);
  return data.items ?? [];
}

function athleteIdOf(play) {
  const ref = play.participants?.[0]?.athlete?.$ref ?? "";
  const m = ref.match(/athletes\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function extract(plays) {
  const shots = [];
  const skipped = [];
  for (const p of plays) {
    if (!p.shootingPlay) continue;
    const text = p.text ?? "";
    const isAnt = athleteIdOf(p) === PLAYER_ID || PLAYER_RE.test(text);
    if (!isAnt) continue;
    if (p.pointsAttempted === 1 || /free throw/i.test(text)) continue; // not a field goal

    const x = Number(p.coordinate?.x);
    const y = Number(p.coordinate?.y);
    const onCourt =
      Number.isFinite(x) && Number.isFinite(y) && x > -5 && x < 55 && y > -5 && y < 50;
    if (!onCourt) {
      skipped.push(text);
      continue;
    }

    const made = /^Anthony Edwards makes/i.test(text);
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

// Official box line, so the header numbers match the published game.
function boxLine(summary) {
  const out = { min: null, pts: null, fg: null, three: null, ft: null };
  for (const team of summary.boxscore?.players ?? []) {
    for (const stat of team.statistics ?? []) {
      const keys = stat.keys ?? [];
      for (const a of stat.athletes ?? []) {
        if (!/Edwards/.test(a.athlete?.displayName ?? "")) continue;
        const map = {};
        keys.forEach((k, i) => (map[k] = a.stats?.[i]));
        out.min = map.minutes ?? null;
        out.pts = map.points ?? null;
        out.fg = map["fieldGoalsMade-fieldGoalsAttempted"] ?? null;
        out.three = map["threePointFieldGoalsMade-threePointFieldGoalsAttempted"] ?? null;
        out.ft = map["freeThrowsMade-freeThrowsAttempted"] ?? null;
        out.team = team.team?.abbreviation ?? "MIN";
        return out;
      }
    }
  }
  return out;
}

function totalsOf(shots, box) {
  const fga = shots.length;
  const fgm = shots.filter((s) => s.made).length;
  const tpa = shots.filter((s) => s.isThree).length;
  const tpm = shots.filter((s) => s.isThree && s.made).length;
  const pts = shots.reduce((a, s) => a + (s.made ? s.pts : 0), 0);
  const parse = (v) => (typeof v === "string" && v.includes("-") ? v.split("-").map(Number) : [null, null]);
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

const out = {
  generated: new Date().toISOString(),
  source:
    "ESPN public play-by-play + box score (sports.core.api.espn.com). Shot coordinates as published by ESPN; free throws excluded from charts.",
  player: { name: "Anthony Edwards", espnId: PLAYER_ID, team: "MIN" },
  games: [],
};

for (const g of GAMES) {
  const [plays, summary] = await Promise.all([
    fetchPlays(g.eventId),
    getJson(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${g.eventId}`
    ),
  ]);
  const { shots, skipped } = extract(plays);
  const box = boxLine(summary);

  out.games.push({ ...g, box, shots, totals: totalsOf(shots, box) });
  console.log(
    `${g.label} ${g.venue}: charted ${shots.length} FGA ` +
      `(${shots.filter((s) => s.made).length} made, ${shots.reduce((a, s) => a + (s.made ? s.pts : 0), 0)} pts) ` +
      `| official ${box.fg} FG, ${box.three} 3P, ${box.ft} FT, ${box.pts} pts` +
      (skipped.length ? ` | skipped ${skipped.length} bad coords` : "")
  );
}

mkdirSync("data", { recursive: true });
writeFileSync("data/shots.js", `window.SHOT_DATA = ${JSON.stringify(out, null, 1)};\n`);
console.log("wrote data/shots.js");
