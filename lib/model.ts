// token-radar-01 v7 — model + board builder (fresh implementation).
//
// Model (REPORT.md §4, unchanged from v5): fit at runtime from the
// snapshot's own 128 comps (mcap_usd > 0).
//   1. Global OLS curve: ln(mcap) = a + s * ln(TVL).
//   2. Pooled-group offsets: shrunk median curve-residual, w = n/(n+5),
//      k = 5. Unknown group -> global median residual.
//   3. Ridge-LAD (median regression, IRLS + ridge): design
//      [1, ln(TVL), pooled-group one-hot, growth, log age, ln(chain count),
//      8 chain flags], continuous features standardised with the train
//      mean and population sd. Ridge lambda = 10, intercept unpenalised,
//      40 IRLS rounds, weights 1/max(|r|, 1e-3).
//   4. Final: ln(mcap) = 0.7 * grouped + 0.3 * ridge-LAD, exponentiated.
// Blend 0.7/0.3 is the v5 re-weighting of the v4 architecture (REPORT §4).
//
// Board rule: every pre-token protocol that passes eligibility is ranked
// (198 rows = 40 watchlist + 158 off-list). Eligibility: no token recorded,
// category not Bridge / Canonical Bridge / Liquid Staking / Liquid
// Restaking / Restaked BTC / CEX, no version-marker name suffix, no whole
// word wrapped/staked/staking/bridged in the name, no exchange-name prefix.
// The ledger (LEVER-SPEC-v6 §2) accounts for all 758 protocols.
//
// REPRODUCTION NOTES (why this file is written the way it is).
// The board must come out byte-identical on every run, so the arithmetic
// below is deliberately boring: sequential accumulation everywhere, no
// cleverness, because floating-point addition is order-dependent and the
// last bits of group_offset_log and ridge_delta_log are printed in full.
// Concretely, the following choices are load-bearing — change any of them
// and the board's doubles drift in the 12th-15th digit:
//   - OLS is means-based: means first, then sum((x-xm)(y-ym)) /
//     sum((x-xm)^2) in snapshot order. (The raw-sums form gives a
//     different last digit for the intercept.)
//   - medians sort a copy and average the two middle values for even n.
//   - Ridge standardisation is two-pass (mean, then population sd,
//     sqrt(sum((x-mean)^2)/n)); the one-pass E[x^2]-mean^2 form drifts.
//   - Ridge design order is the spec's own: [1, ln(TVL), group one-hot,
//     growth, log age, ln(chain count), chain flags]. Column order changes
//     the solver's rounding path.
//   - The weighted ridge solve accumulates A[r][c] += (x[r]*w) * x[c] and
//     b[r] += (x[r]*w) * y (weight applied once, not via sqrt), adds
//     lambda = 10 to the diagonal except the intercept, and solves by
//     Gaussian elimination with partial pivoting. Cholesky, Gauss-Jordan
//     and sqrt-weighted forms all drift by ~1e-11.
//   - IRLS starts from the ridge-OLS solution (weights 1) and runs
//     exactly 40 rounds with weights 1/max(|r|, 1e-3). Starting from
//     beta = 0 converges somewhere else entirely.
//   - age_days counts whole days from listed_at to the snapshot's as_of
//     (UTC); a missing listed_at means the train median log-age in the
//     ridge and a null age_days on the row; a missing change_7d means
//     growth 0.
// None of this changes the model's meaning — only its last bits. The
// integers on the board (curve/grouped/ridge/implied dollars) are robust
// to all of it; the printed doubles are not, so they are pinned here.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  ratio: number;
  curve_usd: number;
  grouped_usd: number;
  ridge_usd: number;
  group: string;
  group_offset_log: number;
  ridge_delta_log: number;
  watchlist: boolean;
}

export interface Ledger {
  token_trades: number;
  token_no_cap: number;
  ranked_watchlist: number;
  ranked_above_floor: number;
  ranked_below_floor: number;
  out_bridge: number;
  out_liquid_staking: number;
  out_exchange: number;
  out_versioned: number;
  out_wrapped: number;
  total: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

// ---------------------------------------------------------------- helpers

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export function hasToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

// Pooled groups (REPORT §4 step 2). Every other category is its own group.
const GROUP_POOL: Record<string, string> = {
  Bridge: 'Bridge',
  'Canonical Bridge': 'Bridge',
  'Cross Chain Bridge': 'Bridge',
  'Liquid Staking': 'Staking',
  'Staking Pool': 'Staking',
  'Liquid Restaking': 'Staking',
  Restaking: 'Staking',
  Yield: 'Yield',
  'Yield Aggregator': 'Yield',
  'Leveraged Farming': 'Yield',
  Lending: 'Lending',
  'Uncollateralized Lending': 'Lending',
  CDP: 'Lending',
  Dexs: 'Dexs',
};

export function groupOf(category: string | null): string {
  if (category === null) return 'Unknown';
  return GROUP_POOL[category] ?? category;
}

const AS_OF_MS = (asOf: string): number => Date.parse(asOf + 'T00:00:00Z');

export function ageDays(p: Protocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  return Math.round((AS_OF_MS(asOf) - Date.parse(p.listed_at + 'T00:00:00Z')) / 86400000);
}

// ---------------------------------------------------------------- eligibility

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

// A version marker: a space followed by V1/V2/… or a dotted version (2.0).
// "Project 0", "R25" and "CommunityV3" are NOT version markers.
export function hasVersionSuffix(name: string): boolean {
  return /\s(v\d+|\d+\.\d+)$/i.test(name);
}

// Whole word wrapped / staked / staking / bridged, any case. "Restaking"
// is not the word "staking"; "stHYPE" is not either.
export function hasWrappedWord(name: string): boolean {
  return /(?<![A-Za-z])(wrapped|staked|staking|bridged)(?![A-Za-z])/i.test(name);
}

export function isEligible(p: Protocol): boolean {
  if (hasToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (hasVersionSuffix(p.name)) return false;
  if (hasWrappedWord(p.name)) return false;
  for (const ex of EXCHANGE_PREFIXES) if (p.name.startsWith(ex)) return false;
  return true;
}

// ---------------------------------------------------------------- the fit

const CHAIN_FLAGS = ['Ethereum', 'Solana', 'Base', 'Arbitrum', 'Optimism', 'Binance', 'Polygon', 'Avalanche'];

export interface Fit {
  intercept: number;
  slope: number;
  globalMedianResidual: number;
  offsets: Map<string, number>;
  groupList: string[];
  medLogAge: number;
  mu: Record<string, number>;
  sd: Record<string, number>;
  beta: number[];
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Gaussian elimination with partial pivoting on the (already regularised)
// normal equations. Column order and accumulation order are part of the
// result's last bits; do not "optimise" this routine.
function solveLinear(A: number[][], b: number[]): number[] {
  const m = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col) {
      const t = M[col];
      M[col] = M[piv];
      M[piv] = t;
    }
    const pv = M[col][col];
    for (let r = col + 1; r < m; r++) {
      const f = M[r][col] / pv;
      if (f !== 0) for (let c = col; c <= m; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array<number>(m).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let s = M[r][m];
    for (let c = r + 1; c < m; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

// Weighted ridge solve: (X' W X + lambda * P) beta = X' W y, lambda = 10,
// intercept (column 0) unpenalised.
function ridgeSolve(X: number[][], y: number[], w: number[]): number[] {
  const m = X[0].length;
  const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    const wi = w[i];
    const yi = y[i];
    for (let r = 0; r < m; r++) {
      const xr = xi[r] * wi;
      b[r] += xr * yi;
      for (let c = 0; c < m; c++) A[r][c] += xr * xi[c];
    }
  }
  for (let i = 1; i < m; i++) A[i][i] += 10;
  return solveLinear(A, b);
}

interface Features {
  lnTvl: number;
  growth: number;
  logAge: number;
  lnChains: number;
  flags: number[];
  onehot: number[];
}

function makeFeatures(p: Protocol, asOf: string, medLogAge: number, groupList: string[]): Features {
  const lnTvl = Math.log(p.tvl_usd);
  const growth =
    p.change_7d === null || p.change_7d === undefined
      ? 0
      : Math.min(Math.max(p.change_7d / 100, -0.95), 5);
  const ad = ageDays(p, asOf);
  const logAge = ad === null ? medLogAge : Math.log(ad + 1);
  const lnChains = Math.log(p.chains.length);
  const flags = CHAIN_FLAGS.map((c) => (p.chains.includes(c) ? 1 : 0));
  const g = groupOf(p.category);
  const onehot = groupList.map((gg) => (g === gg ? 1 : 0));
  return { lnTvl, growth, logAge, lnChains, flags, onehot };
}

export function fitModel(snapshot: Snapshot): Fit {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const n = comps.length;
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd as number));

  // Global OLS curve, means-based (sequential accumulation).
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const xm = sx / n;
  const ym = sy / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - xm) * (ys[i] - ym);
    sxx += (xs[i] - xm) * (xs[i] - xm);
  }
  const slope = sxy / sxx;
  const intercept = ym - slope * xm;

  // Group offsets: shrunk median residual, k = 5.
  const resid = comps.map((p, i) => ys[i] - (intercept + slope * xs[i]));
  const globalMedianResidual = median(resid);
  const byGroup = new Map<string, number[]>();
  comps.forEach((p, i) => {
    const g = groupOf(p.category);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(resid[i]);
  });
  const offsets = new Map<string, number>();
  for (const [g, rs] of byGroup) {
    const w = rs.length / (rs.length + 5);
    offsets.set(g, w * median(rs) + (1 - w) * globalMedianResidual);
  }
  const groupList = [...byGroup.keys()].sort();

  // Ridge-LAD features.
  const datedLogAges = comps
    .map((p) => ageDays(p, snapshot.as_of))
    .filter((v): v is number => v !== null)
    .map((v) => Math.log(v + 1));
  const medLogAge = median(datedLogAges);
  const F = comps.map((p) => makeFeatures(p, snapshot.as_of, medLogAge, groupList));

  // Standardise the four continuous features (train mean, population sd).
  const keys: Array<'lnTvl' | 'growth' | 'logAge' | 'lnChains'> = ['lnTvl', 'growth', 'logAge', 'lnChains'];
  const mu: Record<string, number> = {};
  const sd: Record<string, number> = {};
  for (const k of keys) {
    let s = 0;
    for (const f of F) s += f[k];
    const m = s / n;
    mu[k] = m;
    let ss = 0;
    for (const f of F) {
      const d = f[k] - m;
      ss += d * d;
    }
    sd[k] = Math.sqrt(ss / n);
  }

  // Design order (REPORT §4): [1, ln(TVL), group one-hot, growth,
  // log age, ln(chain count), chain flags].
  const design = (f: Features): number[] => [
    1,
    (f.lnTvl - mu.lnTvl) / sd.lnTvl,
    ...f.onehot,
    (f.growth - mu.growth) / sd.growth,
    (f.logAge - mu.logAge) / sd.logAge,
    (f.lnChains - mu.lnChains) / sd.lnChains,
    ...f.flags,
  ];
  const X = F.map(design);

  // IRLS, 40 rounds, from the ridge-OLS start.
  let beta = ridgeSolve(X, ys, new Array<number>(n).fill(1));
  for (let it = 0; it < 40; it++) {
    const w = ys.map((yy, i) => 1 / Math.max(Math.abs(yy - dot(X[i], beta)), 1e-3));
    beta = ridgeSolve(X, ys, w);
  }

  return { intercept, slope, globalMedianResidual, offsets, groupList, medLogAge, mu, sd, beta };
}

export interface Prediction {
  curveLog: number;
  groupedLog: number;
  ridgeLog: number;
  curveUsd: number;
  groupedUsd: number;
  ridgeUsd: number;
  implied: number;
  group: string;
  groupOffsetLog: number;
  ridgeDeltaLog: number;
}

export function predict(p: Protocol, snapshot: Snapshot, fit: Fit): Prediction {
  const lnTvl = Math.log(p.tvl_usd);
  const group = groupOf(p.category);
  const groupOffsetLog = fit.offsets.has(group) ? fit.offsets.get(group)! : fit.globalMedianResidual;
  const curveLog = fit.intercept + fit.slope * lnTvl;
  const groupedLog = curveLog + groupOffsetLog;
  const f = makeFeatures(p, snapshot.as_of, fit.medLogAge, fit.groupList);
  const x: number[] = [
    1,
    (f.lnTvl - fit.mu.lnTvl) / fit.sd.lnTvl,
    ...f.onehot,
    (f.growth - fit.mu.growth) / fit.sd.growth,
    (f.logAge - fit.mu.logAge) / fit.sd.logAge,
    (f.lnChains - fit.mu.lnChains) / fit.sd.lnChains,
    ...f.flags,
  ];
  const ridgeLog = dot(x, fit.beta);
  return {
    curveLog,
    groupedLog,
    ridgeLog,
    curveUsd: Math.round(Math.exp(curveLog)),
    groupedUsd: Math.round(Math.exp(groupedLog)),
    ridgeUsd: Math.round(Math.exp(ridgeLog)),
    implied: Math.round(Math.exp(0.7 * groupedLog + 0.3 * ridgeLog)),
    group,
    groupOffsetLog,
    ridgeDeltaLog: ridgeLog - groupedLog,
  };
}

// ---------------------------------------------------------------- farm plans

const GAS: Record<string, string> = {
  Ethereum: '$8',
  Solana: '$0.01',
  Base: '$0.50',
  Arbitrum: '$0.50',
  Optimism: '$0.50',
  Binance: '$0.30',
  Avalanche: '$0.30',
  Polygon: '$0.10',
};

export function gasFor(chain: string): string {
  return GAS[chain] ?? '$2';
}

// One six-step plan per category family. {NAME} is the protocol, {CHAIN}
// its first chain, {GAS} that chain's typical gas, {CHAIN2} its second
// chain (bridge plans). Claim costs track the primary chain's gas.
const GENERIC = [
  'Bridge $500 of USDC to {CHAIN} for about {GAS} gas (10 minutes), then open {NAME}.',
  'Deposit $500 into the main {NAME} position on {CHAIN}, about {GAS} gas (5 minutes).',
  'Hold the position for 4 weeks and check it weekly for rate or risk changes.',
  'Add a second $250 deposit after 2 weeks if the position performs, about {GAS} gas.',
  'Claim any rewards weekly for 4 weeks, about {GAS} per claim on {CHAIN}.',
  'Exit or rebalance after 8 weeks for about {GAS} gas and record the outcome.',
];
const CURATOR = [
  'Bridge $500 of USDC to {CHAIN} for about {GAS} gas (10 minutes), then open {NAME}.',
  'Deposit $500 into a curated vault on {NAME} on {CHAIN}, about {GAS} gas (5 minutes).',
  "Read the curator's allocation and risk limits before depositing more on {CHAIN}.",
  "Hold the vault position for 8 weeks and check the curator's reports monthly.",
  "Add $250 more after 4 weeks if the vault's risk stays within its stated limits.",
  "Withdraw after 8 weeks for about {GAS} gas and compare the return with the vault's target.",
];
const ALLOCATOR = [
  'Bridge $500 of USDC to {CHAIN} for about {GAS} gas (10 minutes), then open {NAME}.',
  'Allocate $500 through {NAME} on {CHAIN} for about {GAS} gas (5 minutes).',
  "Hold the allocation for 8 weeks and read the allocator's monthly reports.",
  'Claim any distributions weekly for 8 weeks, about {GAS} per claim on {CHAIN}.',
  'Rebalance after 4 weeks if the allocation drifts from its stated strategy.',
  'Exit the allocation after 8 weeks for about {GAS} gas on {CHAIN} (10 minutes).',
];
const RWA = [
  'Complete the onboarding for {NAME} and bridge $500 of USDC to {CHAIN}, about {GAS} gas.',
  'Buy $500 of the tokenised asset on {NAME} on {CHAIN} for about {GAS} gas (10 minutes).',
  'Hold the asset for 4 weeks and collect the yield it pays, about {GAS} per claim.',
  'Add a second $250 purchase after 2 weeks if the asset performs, about {GAS} gas.',
  'Check the underlying asset and issuer reports monthly while holding.',
  'Sell or redeem after 8 weeks for about {GAS} gas on {CHAIN} (10 minutes).',
];
const DEX = [
  'Bridge $500 of USDC to {CHAIN} for about {GAS} in gas (10 minutes), then open {NAME}.',
  'Swap $250 of USDC for the other token of the main pool on {NAME} on {CHAIN}, about {GAS} gas (5 minutes).',
  'Add $500 of liquidity to the main {NAME} pool on {CHAIN} for about {GAS} gas (10 minutes).',
  'Hold the LP position for 4 weeks and collect trading fees, about {GAS} per claim on {CHAIN}.',
  'Swap another $100 through {NAME} each week for 4 weeks to build swap volume on {CHAIN}.',
  "Review the LP position weekly and withdraw or re-add liquidity if the pool's TVL moves sharply.",
];
const LENDING = [
  'Bridge $1,000 of USDC to {CHAIN} for about {GAS} gas (10 minutes), then open {NAME}.',
  'Supply $1,000 of USDC as collateral on {NAME} on {CHAIN}, about {GAS} gas (5 minutes).',
  'Borrow $400 of a stable asset against the collateral on {NAME} on {CHAIN}, about {GAS} gas.',
  'Hold the borrow for 4 weeks, keep the health factor above 2, and top up collateral if it slips.',
  'Repay the $400 borrow on {NAME} on {CHAIN} after 4 weeks for about {GAS} gas (5 minutes).',
  'Withdraw the $1,000 collateral after repaying, and check the position weekly while it is open.',
];
const YIELD = [
  'Bridge $1,000 of USDC to {CHAIN} for about {GAS} gas (10 minutes), then open the {NAME} vault.',
  'Deposit $1,000 into the main {NAME} vault on {CHAIN}, about {GAS} gas (5 minutes).',
  'Stake the vault receipt token if {NAME} offers staking, about {GAS} gas on {CHAIN}.',
  'Compound the yield weekly for 8 weeks, about {GAS} per claim on {CHAIN}.',
  'Hold the position for at least 8 weeks to cover deposit and exit fees on {CHAIN}.',
  'Withdraw the deposit and rewards after 8 weeks for about {GAS} gas (10 minutes).',
];
const MARGIN = [
  'Bridge $500 of USDC to {CHAIN} for about {GAS} gas (10 minutes), then open {NAME}.',
  'Deposit $500 as margin on {NAME} on {CHAIN}, about {GAS} gas (5 minutes).',
  'Open a small 2x long position on {NAME} on {CHAIN} for about {GAS} gas.',
  'Set a stop loss and hold the position for 1 to 2 weeks on {CHAIN}.',
  'Close the position and take profit or cut the loss, about {GAS} gas on {CHAIN}.',
  'Withdraw the margin after closing and review the trade before opening another.',
];
const PREDICTION = [
  'Bridge $100 of USDC to {CHAIN} for about {GAS} gas (10 minutes), then open {NAME}.',
  'Place a $50 position on a high-volume market on {NAME} on {CHAIN}, about {GAS} gas.',
  'Provide $50 of liquidity to a market on {NAME} on {CHAIN} for about {GAS} gas.',
  'Hold both positions until the market resolves, usually 1 to 4 weeks.',
  'Claim any winnings after resolution for about {GAS} gas on {CHAIN} (5 minutes).',
  'Repeat with a new market each month and keep a record of wins and losses.',
];
const STAKING = [
  'Buy $1,000 of the base asset on {CHAIN} for about {GAS} gas (10 minutes).',
  'Stake $1,000 with {NAME} on {CHAIN} for about {GAS} gas (5 minutes).',
  'Hold the liquid receipt token for 4 weeks and use it in a lending market on {CHAIN}.',
  'Restake the staking rewards weekly for 8 weeks, about {GAS} per claim on {CHAIN}.',
  'Check the validator or operator set monthly and move stake if performance drops.',
  'Unstake after 8 weeks, allowing for the queue period, for about {GAS} gas on {CHAIN}.',
];
const BRIDGE = [
  'Bridge $500 of USDC from {CHAIN} to {CHAIN2} on {NAME} for about {GAS} gas (15 minutes).',
  'Bridge $250 back from {CHAIN2} to {CHAIN} to complete a round trip, about $2 gas.',
  'Use the bridged asset in a {CHAIN2} app for 2 weeks to leave a usage trail.',
  'Bridge a second $500 from {CHAIN} to another supported chain after 2 weeks.',
  'Repeat one bridge a month for 3 months, about {GAS} gas each time on {CHAIN}.',
  'Keep the receipt of each bridge and check finality times before bridging larger amounts.',
];

const TEMPLATES: Record<string, string[]> = {
  'Risk Curators': CURATOR,
  'Onchain Capital Allocator': ALLOCATOR,
  RWA,
  Dexs: DEX,
  Lending: LENDING,
  CDP: LENDING,
  'Uncollateralized Lending': LENDING,
  Yield: YIELD,
  'Yield Aggregator': YIELD,
  'Leveraged Farming': YIELD,
  'Basis Trading': MARGIN,
  Derivatives: MARGIN,
  'Interest Rate Derivatives': MARGIN,
  'Prediction Market': PREDICTION,
  Restaking: STAKING,
  'Staking Pool': STAKING,
  'Cross Chain Bridge': BRIDGE,
};

export function farmSteps(category: string | null, name: string, chains: string[]): string[] {
  const template = (category !== null && TEMPLATES[category]) || GENERIC;
  const chain = chains[0];
  const chain2 = chains.length > 1 ? chains[1] : 'a supported chain';
  const gas = gasFor(chain);
  return template.map((s) =>
    s.replaceAll('{CHAIN2}', chain2).replaceAll('{CHAIN}', chain).replaceAll('{GAS}', gas).replaceAll('{NAME}', name),
  );
}

// ---------------------------------------------------------------- board + ledger

export function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; fit: Fit } {
  const fit = fitModel(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const rows: BoardRow[] = [];
  for (const p of snapshot.protocols) {
    if (!isEligible(p)) continue;
    const pr = predict(p, snapshot, fit);
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: pr.implied,
      farm_steps: farmSteps(p.category, p.name, p.chains),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p, snapshot.as_of),
      ratio: pr.implied / p.tvl_usd,
      curve_usd: pr.curveUsd,
      grouped_usd: pr.groupedUsd,
      ridge_usd: pr.ridgeUsd,
      group: pr.group,
      group_offset_log: pr.groupOffsetLog,
      ridge_delta_log: pr.ridgeDeltaLog,
      watchlist: watchlist.has(p.slug),
    });
  }
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd);
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return { rows, fit };
}

// Ledger (LEVER-SPEC-v6 §2): every one of the 758 protocols, counted once.
// Priority for a pre-token protocol that is not ranked: bridge category,
// liquid-staking category, CEX category, versioned name, wrapped/staked
// name. The counts are verified at runtime against the spec (total 758).
export function buildLedger(snapshot: Snapshot, rankedSlugs: Set<string>): Ledger {
  const watchlist = new Set(snapshot.watchlist);
  const floor = snapshot.floor_usd;
  const L: Ledger = {
    token_trades: 0,
    token_no_cap: 0,
    ranked_watchlist: 0,
    ranked_above_floor: 0,
    ranked_below_floor: 0,
    out_bridge: 0,
    out_liquid_staking: 0,
    out_exchange: 0,
    out_versioned: 0,
    out_wrapped: 0,
    total: 0,
  };
  const BRIDGE_CATS = ['Bridge', 'Canonical Bridge', 'Cross Chain Bridge'];
  const STAKE_CATS = ['Liquid Staking', 'Liquid Restaking', 'Staking Pool', 'Restaked BTC'];
  for (const p of snapshot.protocols) {
    if (hasToken(p)) {
      if (p.mcap_usd !== null && p.mcap_usd > 0) L.token_trades++;
      else L.token_no_cap++;
    } else if (rankedSlugs.has(p.slug)) {
      if (watchlist.has(p.slug)) L.ranked_watchlist++;
      else if (p.tvl_usd >= floor) L.ranked_above_floor++;
      else L.ranked_below_floor++;
    } else if (p.category !== null && BRIDGE_CATS.includes(p.category)) {
      L.out_bridge++;
    } else if (p.category !== null && STAKE_CATS.includes(p.category)) {
      L.out_liquid_staking++;
    } else if (p.category === 'CEX') {
      L.out_exchange++;
    } else if (hasVersionSuffix(p.name)) {
      L.out_versioned++;
    } else if (hasWrappedWord(p.name)) {
      L.out_wrapped++;
    } else {
      throw new Error(`ledger: protocol ${p.slug} matches no group`);
    }
  }
  L.total =
    L.token_trades +
    L.token_no_cap +
    L.ranked_watchlist +
    L.ranked_above_floor +
    L.ranked_below_floor +
    L.out_bridge +
    L.out_liquid_staking +
    L.out_exchange +
    L.out_versioned +
    L.out_wrapped;
  return L;
}

// The 128 comps, for the dashboard's "live" comparison table, largest
// market cap first. ratio = mcap / TVL.
export function buildLive(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      ratio: (p.mcap_usd as number) / p.tvl_usd,
      change_7d: p.change_7d,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);
}
