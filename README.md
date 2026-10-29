# NBA shot profiles

Shot-chart comparison for NBA players across the 2024-25, 2025-26 and 2026-27
seasons. Every regular-season field-goal attempt is plotted from ESPN's
published shot coordinates, so each dot is traceable to an actual play.

Open `index.html` in a browser, or serve the folder with any static server.

## What it shows

- Three seasons per player, on identical half-courts, with make/miss vs shot-zone
  colouring and hover text for every attempt.
- Season KPIs, a shot-diet breakdown by zone, and a radar comparing shot profile
  across seasons (toggle between shot zone and shot style).
- A 5-game rolling trend for three-point rate, paint rate, average distance and
  scoring.
- A full game log; click a game to chart only that game.

## Data

`data/index.js` holds only season aggregates and is always loaded.
`data/<player>-<season>.js` holds that season's shots and is fetched on demand.

Everything is generated from ESPN's public APIs:

```bash
node scripts/build-data.mjs            # rebuild from cache (~4s)
node scripts/build-data.mjs --refresh  # re-download play-by-play
node scripts/build-data.mjs --sample 3 # first 3 games per season, for a quick check
```

Play-by-play responses are cached in `.cache/plays/` (git-ignored), so a rebuild
without `--refresh` only touches the network for games it has not seen yet.
GitHub Actions runs the same command and commits the result whenever
`scripts/build-data.mjs` changes.

Free throws are excluded from the charts. The build report prints charted
attempts next to the official box-score attempts for every player-season so any
drift is visible rather than silent.

## Known caveats

- LaMelo Ball played only 2 games in 2025-26, so that season is not comparable to
  a full one; the dashboard only scales to seasons that have been played.
- ESPN's play feed occasionally disagrees with its own box score by a handful of
  attempts; those differences are reported by the build script.
- A season's team label is the player's most frequent team that season, which is
  misleading for players traded mid-season.
