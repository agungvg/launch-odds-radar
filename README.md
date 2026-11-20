# launch-odds-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A launch-odds token radar: it reads a sealed DefiLlama snapshot, ranks 178 pre-token protocols by fitted value — a comparables terminal value (category peer multiple times a fitted size curve) adjusted for damped 7-day growth, time with no token, and chain breadth — and hands in a dashboard with the board, a detail view showing the model's working for every protocol, a costed farm verdict for each one, and the already-trading peers the multiples come from.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to>/snapshot.json
```

Node 22, standard library only, no network. The program writes `out/board.json` (the ranked board), `out/data.js` (the dashboard's data), `out/dashboard/` (the static page), `out/screenshots/` and `out/dossier.json` (the judge's dossier, built with the vendored `vendor/makefun-board.ts`).

## How the value is priced

Implied value = TVL × category peer multiple × fitted size factor × damped 7-day growth × age factor × breadth factor. The peer multiple is the category's median market-cap-per-TVL among tokens that already trade, winsorized at 5 and shrunk toward the snapshot-wide median; the size factor is a log-log fit of how that multiple falls as protocols get bigger (slope −0.53 on this snapshot). Launch odds — the share of protocols in the same category that already have a token, shrunk toward the snapshot-wide rate — do not shrink the value: they set the expected value (implied × odds) and the farm verdict (Farm at $10M expected, Watch at $2M, else Track), costed against the farm's own capital plus gas. One function scores every protocol and no name is special-cased, and the dashboard shows the working for every row.

Held out and tested: the fit trains on 91 traded protocols and predicts the 28 it never saw with a typical miss of ×2.61, against ×5.72 for the naive snapshot-wide median multiple. The numbers are recomputed from the snapshot on every run and printed in the dashboard.

The board covers the whole watchlist (40 protocols at or above the $50M floor) plus every rankable pre-token protocol below it — 178 rows. Wrapped, staked and bridged products of tokens that already trade, exchanges and versioned pools are set aside, never ranked as launches, as are rankable protocols above the floor the watchlist leaves out.

---

<sub>Entered on [make.fun](https://make.fun/?ref=p9r33tb4&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
