# launch-odds-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A launch-odds token radar: it reads a sealed DefiLlama snapshot, ranks 201 pre-token protocols by expected value — the terminal value of the token each might one day issue, times the odds a token ever comes — and hands in a dashboard with the board, a detail view showing the model's working for every protocol, and a farm plan for each one.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to>/snapshot.json
```

Node 22, standard library only, no network. The program writes `out/board.json` (the ranked board), `out/data.js` (the dashboard's data), `out/dashboard/` (the static page), `out/screenshots/` and `out/dossier.json` (the judge's dossier, built with the vendored `vendor/makefun-board.ts`).

## How the value is priced

Implied value = terminal value × launch odds. Terminal value is a sublinear power law in TVL — K · TVL^0.8, with K anchored to this snapshot itself (median tokenised market cap over median tokenised TVL^0.8, so no outlier sets the price) — times a damped 7-day growth factor, a log-scale age factor for how long the protocol has run with no token, and a chain-breadth factor. Launch odds are the share of protocols in the same category that already have a token, shrunk toward the snapshot-wide rate. One function scores every protocol and no name is special-cased, and the dashboard shows the working for every row.

The board covers the whole watchlist (40 protocols at or above the $50M floor) plus every rankable pre-token protocol below it — 201 rows. Wrapped, staked and bridged products of tokens that already trade, exchanges and versioned pools are set aside, never ranked as launches.

---

<sub>Entered on [make.fun](https://make.fun/?ref=p9r33tb4&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
