# token-radar-01 v7 — DESIGN

## 1. Model (unchanged from v5)

Fit at runtime from the snapshot's own 128 comps (`mcap_usd > 0`, snapshot
2026-11-14, 758 protocols). Nothing is hardcoded by name; the board is a
pure function of the snapshot.

1. **Global curve (OLS):** `ln(mcap) = a + s·ln(TVL)`, fitted on all 128:
   `a = 6.9646`, `s = 0.5223` (exact runtime values in `data.js` meta).
2. **Pooled groups (26):** Bridge ← Bridge / Canonical Bridge / Cross
   Chain Bridge; Staking ← Liquid Staking / Staking Pool / Liquid
   Restaking / Restaking; Yield ← Yield / Yield Aggregator / Leveraged
   Farming; Lending ← Lending / Uncollateralized Lending / CDP; Dexs
   alone; every other category its own group.
3. **Group offset:** shrunk median curve-residual, `w = n/(n+5)`, k = 5.
   An unseen group falls back to the global median residual (+0.073).
   Grouped prediction = curve + offset.
4. **Ridge-LAD** (median regression, IRLS + ridge): design `[1, ln(TVL),
   pooled-group one-hot, growth, log age, ln(chain count), 8 chain flags
   (ETH/SOL/Base/ARB/OP/BNB/MATIC/AVAX)]`, continuous features
   standardised with the train mean and population sd.
   `growth = clip(change_7d/100, −0.95, 5)` (missing → 0);
   `log age = ln(days since listed_at + 1)` (missing → train median).
   Ridge λ = 10, intercept unpenalised, 40 IRLS rounds from the
   ridge-OLS start, weights `1/max(|r|, 1e-3)`.
5. **Final:** `ln(mcap) = 0.7·grouped + 0.3·ridge-LAD`, exponentiated.
   For a pre-token protocol the implied value is the predicted mcap.

`lib/model.ts` documents the bit-exactness traps (summation order, design
order, solver) in its reproduction notes: the board must come out
byte-identical, and the last bits of `group_offset_log` and
`ridge_delta_log` depend on them. Verified: `board.json` sha256
`142b31958e84089e9cae585e0f4fa9cbce6d794e5c17c5f95cd547518ae421e2`,
identical to v5.

**Board rule.** Every pre-token protocol that passes eligibility is
ranked: 198 rows = 40 watchlist + 158 off-list. Eligibility: no token
recorded (`gecko_id` and `symbol` null), category not Bridge / Canonical
Bridge / Liquid Staking / Liquid Restaking / Restaked BTC / CEX, no
version-marker name suffix (`V2`, `V3`, `2.0` — but `Project 0`, `R25`,
`CommunityV3` are not markers), no whole word wrapped / staked / staking
/ bridged in the name (`Restaking` is not the word `staking`), no
exchange-name prefix (Binance, Coinbase, Bybit, Kraken, Bitget, OKX,
Bitfinex, Gemini). Rank 1: Sentora Curator, $97,032,376; rank 2:
Steakhouse Financial, $96,364,014; rank 198: Shift DeFi, $748,365.

**Farm plans.** One six-step plan per protocol, template by category
family (curator vault, allocator, RWA, DEX, lending, yield vault, margin,
prediction market, staking, bridge, generic), parameterised by name,
first chain and that chain's typical gas (ETH ~$8, SOL ~$0.01, Base/ARB/OP
~$0.50, BNB/AVAX ~$0.30, Polygon ~$0.10, anything else ~$2). Claim costs
track the primary chain's gas. Each step names an amount, a cost and a
duration.

## 2. Intervals + ledger (from v6)

**Intervals.** Multipliers from the v5 model's leave-one-out residuals on
the 128 comps (ratio actual/predicted mcap): P10 ×0.0696, P25 ×0.2805,
P50 ×1.0478, P75 ×3.6866, P90 ×8.4375. Every board row shows P25–P75
under its implied value; the detail view adds P10–P90. The interval is
`implied × multiplier`, computed at render time in `app.js` — never a
field on `board.json`. Example: Sentora $97,032,376 → P25–P75
$27,217,581–$357,719,557; P10–P90 $6,753,453–$818,710,672.

**Honesty, measured on the 29 walk-forward test protocols:** P25–P75
covered 51.7% (15/29) — stated as a 50% interval, slightly more honest
than its label. P10–P90 covered 72.4% (21/29) — stated as an 80%
interval, slightly less. Both are printed as measured on the Method page.

**infinifi** is the only protocol to list since the snapshot: model
implied ~$8.3M, real mcap ~$799k. A fresh launch can price at a small
fraction of the typical mcap/TVL ratio. The model's median prediction is
a centre, not a promise.

**Ledger.** `main.ts` computes it at runtime from the snapshot; total
must be 758. Priority for an unranked pre-token protocol: bridge
category (43), liquid-staking category (46), CEX category (42), versioned
name (11), wrapped/staked name (2). With the token side (128 trades +
288 recorded-but-no-cap) and the ranked side (40 watchlist + 20 above the
$50M floor + 138 below it), every protocol is counted once:
128+288+40+20+138+43+46+42+11+2 = 758. The ledger bar on the cover reads
`758 protocols accounted for: 198 ranked · 416 with a token · 144
excluded`; the Method page carries the full 10-row coverage table.

## 3. Validation four ways (new in v7)

Metric everywhere: median absolute log error of ln(market cap). Full
model (0.7 grouped / 0.3 ridge-LAD): **Blind A 1.3189, Blind B 1.4050,
CV (5-fold × 5 seeds) 1.3038, walk-forward 1.0505.** Blind diagnostics:
A median % error −26.8%, within ±30% 18%; B median % error −12.1%,
within ±30% 18%. The two blind tests are independent 17-protocol
stratified holdouts (seed-999 and seed-42); walk-forward trains on the
66 oldest dated protocols and tests on the 29 newest.

Each value term was tested keep-vs-drop on all four (delta = drop −
keep; positive = dropping hurts = the term earns its keep):

| term | Blind A | Blind B | CV | WF | verdict |
|---|---|---|---|---|---|
| growth | −0.0006 | −0.0336 | +0.0006 | +0.0300 | KEEP — walk-forward worsens +0.03 without it; blinds differ slightly (n=17, noisy) |
| log_age | +0.0190 | +0.0161 | +0.0058 | +0.1009 | KEEP — dropping worsens all four; walk-forward +0.10 |
| log_nchains | −0.0384 | +0.0191 | −0.0025 | +0.0042 | KEEP — neutral; blinds disagree, CV/WF practically unchanged |
| chain flags (8) | +0.0334 | +0.0138 | +0.0156 | +0.0500 | KEEP — dropping worsens all four |
| group dummies (ridge) | −0.0196 | −0.0171 | +0.0157 | +0.0284 | KEEP — blinds say dropping helps ~0.02, CV+WF say the opposite; kept on the larger tests |
| ln_tvl (ridge) | −0.0753 | +0.0568 | +0.0255 | +0.1368 | KEEP — walk-forward worsens +0.14 without it; blinds disagree with each other |
| grouped half (w 0.7→1.0) | −0.0387 | −0.0625 | +0.0074 | +0.0218 | KEEP blend 0.7 — blinds prefer grouped-only, but CV+WF+blind30-mean (1.2090 vs grouped 1.2335) prefer the blend |
| ridge-LAD only (w 0.7→0.0) | −0.2717 | +0.1457 | +0.0619 | −0.0508 | KEEP blend — blinds totally disagree (1.05 vs 1.55): one 17-protocol split cannot decide; blend wins on 30-split mean + CV |
| blend 0.6 | −0.0388 | +0.0208 | +0.0012 | −0.0073 | 0.7 kept — plateau 0.6–0.75, no reason to move |
| blend 0.8 | +0.0375 | −0.0208 | +0.0041 | +0.0073 | 0.7 kept — plateau |

Two terms (log_age, chain flags) prove themselves in all four tests. The
rest are kept on walk-forward / CV evidence, because the two n=17 blind
tests disagree with each other by up to 0.42 — one small split cannot
decide, so decisions come from the larger tests (30-split blind mean
1.2090, CV 1.3038, WF 1.0505). **No term was dropped.** No claim of
"best" is made without a number. The numbers above were computed by the
coordinator from the frozen snapshot under the REPORT.md §2 protocol and
are reproduced here as given.

## 4. Dashboard

`dashboard/index.html` + `app.js` + `app.css`, no network (data loads
from `../data.js`, written by `main.ts` beside the page). Views by hash:
`#board` (default; `?wl=1`, `?cat=`, `q=` filter state),
`#detail/<slug>`, `#method` (`#method/ablation` scrolls to the table).

- **KPI strip:** 198 ranked · 40 watchlist · 758 accounted · CV 1.3038 ·
  WF 1.0505 · blind30 1.2090.
- **Self-check panel** on the cover, answered live from the loaded
  data: board 198 rows, ranks 1..198, implied non-increasing, 40/40
  watchlist covered, ledger 758, 4 screenshots ≤512 KiB, dossier
  ≤1.5 MB.
- **Ledger bar** above the board (see §2).
- **Board:** sortable columns (rank / TVL / implied / age), search,
  watchlist-only toggle, category filter; each row shows the P25–P75
  interval under its implied value.
- **Detail:** implied value with P25–P75 and P10–P90 in full dollars,
  model breakdown (curve / grouped / ridge, group offset, ridge delta,
  implied/TVL, TVL, 7d change, age), the six farm steps, and the five
  closest priced peers from the same pooled group.
- **Method:** the ablation table, the honesty paragraphs, the interval
  coverage note, the infinifi note, the 10-row coverage table, the model
  spec.
- Source total under 64 KB (dossier text ≤ 65,536 B); dossier ≤ 1.5 MB;
  4 screenshots, each ≤ 512 KiB, 1440×800, 0 JS errors.

## 5. What changed vs v6

Model, board, ranking, prices and farm plans: **unchanged**
(byte-identical `board.json`). New in v7: the four-way validation
(ablation table + honesty text on the Method page), the KPI strip, the
self-check panel, and the detail view's closest-peers table. The ledger
bar and intervals are carried over from v6.
