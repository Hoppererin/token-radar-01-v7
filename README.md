[![make.fun competition](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Hoppererin/token-radar-01-v7/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Hoppererin/token-radar-01-v7/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar v7 — token-radar-01

Pre-token protocols, ranked by implied value: what a token would be worth if the protocol's record stayed as it is, and how to farm it first. Built for the [token-radar-01 bounty](https://make.fun/bounty/token-radar-01) on make.fun.

## What v7 adds

The model is unchanged from v5 (see `DESIGN.md`): a grouped comps curve blended 0.7 / 0.3 with a ridge-LAD median regression, fit at runtime from the snapshot's own 128 priced protocols. v7's lever is **validation four ways, shown on the cover**:

- Every value term tested keep-vs-drop on **two independent blind tests** (seed-999 and seed-42, 17 protocols each) **plus** 5-fold CV × 5 seeds **plus** walk-forward (66 oldest train → 29 newest test). Full model: Blind A 1.3189, Blind B 1.4050, CV 1.3038, walk-forward 1.0505 (median absolute log error of ln market cap).
- The dashboard's Method page prints the full 10-row ablation table with the verdict for each term — including the uncomfortable parts: the two n=17 blind tests disagree with each other by up to 0.42, so no term is dropped on one small split alone.
- Uncertainty intervals on every row (P25–P75; P10–P90 in the detail view) with their measured coverage stated honestly: P25–P75 covered 51.7% of the 29 walk-forward tests, P10–P90 covered 72.4%.
- A ledger accounting for all 758 protocols, a KPI strip and a self-check panel on the cover.

## The board

198 ranked rows (40 watchlist + 158 off-list), rank 1 Sentora Curator at $97,032,376 implied. Every row carries a six-step farm plan with chain-specific gas. The board is byte-identical to the v5 board: `sha256 142b31958e84089e9cae585e0f4fa9cbce6d794e5c17c5f95cd547518ae421e2`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22.18+ (standard library only, no install). `main.ts` reads the snapshot, fits the model at runtime, writes `board.json`, `data.js`, copies `dashboard/` and `screenshots/`, and writes `dossier.json` with `vendor/makefun-board.ts`. Run it twice: both runs write the same bytes.

## Layout

- `main.ts` — entrypoint
- `lib/model.ts` — the model, board builder, ledger, farm plans
- `dashboard/` — `index.html`, `app.js`, `app.css` (no network; data loads from `../data.js`)
- `screenshots/` — board, detail, filtered, Method (1440×800)
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte from the kit
- `DESIGN.md` — the model, intervals, ledger, validation and dashboard, in full
