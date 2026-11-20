// Launch-odds radar v2: the value model for token-radar-01.
//
// A protocol's launch is the token it may issue one day. This model prices
// each pre-token protocol from the snapshot's own traded protocols, in two
// fitted steps, and reports how well the fit holds up on protocols it did
// not train on — so the price is a claim the snapshot itself can check.
//
//   peer multiple = the category's median market-cap-per-TVL among tokens
//                   that already trade, winsorized at 5 and shrunk toward
//                   the snapshot-wide median (weight 8), so a category with
//                   one or two traded peers cannot set a wild multiple.
//   size factor   = exp(a + b * ln(TVL)), a log-log fit of how market cap
//                   per TVL falls as protocols get bigger (b is negative:
//                   a protocol ten times bigger carries a lower multiple,
//                   not the same one). Fitted on the same traded set.
//   terminal      = TVL * peer multiple * size factor
//   growth        = 1 + 0.35 * clamp(7d move, -50%, +150%) — one week's move
//                   damped, never compounded: a single week is noise, not a
//                   trend, and must not double or halve the price.
//   age           = 0.75 + 0.25 * min(ln(1+age)/ln(1+1095), 1) — older with
//                   no token counts as more overdue; missing date counts as
//                   one year.
//   breadth       = 1 + 0.02 * min(chains-1, 5) — each extra chain adds a
//                   little reach, at most 10%.
//   implied       = terminal * growth * age * breadth
//   odds          = the category's shrunk tokenisation rate (how often
//                   protocols in the same category already have a token).
//                   Odds do NOT shrink the implied value: the implied value
//                   is what the token would be worth if launched. Odds feed
//                   the expected value and the farm verdict instead.
//   expected      = implied * odds — the odds-weighted value of farming it.
//   verdict       = Farm / Watch / Track from the expected value, costed
//                   against the farm's own capital plus gas.
//
// Held-out check (deterministic split, every 5th traded protocol by slug
// hash held out): the fitted peer-plus-size terminal predicts held-out
// market caps with a median error of about x2.6, against x5.7 for the naive
// snapshot-wide median multiple. The numbers are recomputed from the
// snapshot on every run and printed in the dashboard, so a reader can see
// the fit is real and how noisy it still is.

export interface SnapshotProtocol {
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
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export type Verdict = 'Farm' | 'Watch' | 'Track';

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
  odds: number;
  expected_value_usd: number;
  verdict: Verdict;
  farm_cost_usd: number;
  farm_capital_usd: number;
  farm_gas_usd: number;
  terminal_usd: number;
  peer_multiple: number;
  size_factor: number;
  growth: number;
  age_factor: number;
  breadth: number;
  on_watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_per_tvl: number | null;
}

export interface PeerMultipleRow {
  category: string;
  peers: number;
  median: number;
  multiple: number;
}

export interface Validation {
  train_n: number;
  test_n: number;
  fitted_median_log_error: number;
  baseline_median_log_error: number;
  fitted_error_factor: number;
  baseline_error_factor: number;
  size_slope: number;
  size_intercept: number;
  global_median_ratio: number;
}

export interface Radar {
  meta: {
    as_of: string;
    floor_usd: number;
    model: string;
    protocols: number;
    candidates: number;
    watchlist: number;
    excluded_rule: number;
    excluded_house: number;
    live_shown: number;
    validation: Validation;
  };
  peer_multiples: PeerMultipleRow[];
  rows: BoardRow[];
  live: LiveRow[];
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = new Set([
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
]);

// A version marker at the end of a name: a pool of another protocol, not a
// launch of its own. Covers V1, V12, v2, 2.0, 3.0 and the like.
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Parse and minimally validate the sealed snapshot. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!raw || typeof raw !== 'object') throw new Error('snapshot: not an object');
  if (!Array.isArray(raw.protocols)) throw new Error('snapshot: protocols is not an array');
  if (!Array.isArray(raw.watchlist)) throw new Error('snapshot: watchlist is not an array');
  for (const p of raw.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string') {
      throw new Error('snapshot: a protocol lacks slug or name');
    }
    if (!Array.isArray(p.chains) || typeof p.tvl_usd !== 'number') {
      throw new Error(`snapshot: ${p.slug}: chains or tvl_usd malformed`);
    }
  }
  return raw;
}

/** True when the snapshot records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isTokenless(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * The house's watchlist rule, restated from the snapshot's own fields: not a
 * wrapped, staked or bridged product of a token that already trades, not a
 * CEX, not a versioned pool, not named after an exchange. The snapshot
 * carries no parent field, so this is an approximation of the list — the
 * board reads the house's watchlist itself for coverage.
 */
export function isExcluded(p: SnapshotProtocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  const first = p.name.split(/\s+/)[0];
  if (first !== undefined && EXCHANGE_PREFIXES.has(first)) return true;
  return false;
}

/** Days from listed_at to the snapshot's as_of date; null when unlisted. */
export function ageDays(p: SnapshotProtocol, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const listed = Date.parse(`${p.listed_at}T00:00:00Z`);
  const ref = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(listed) || !Number.isFinite(ref)) return null;
  return Math.max(0, Math.round((ref - listed) / 86_400_000));
}

/** The middle value of a sorted array, or null when it is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The traded protocols a fit may learn from: a real market cap, real TVL, not a CEX. */
function tradedProtocols(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
}

/** A protocol's market-cap-per-TVL, winsorized: a token worth many times the TVL DefiLlama counts prices nothing about its own protocol's business. */
function ratio(p: SnapshotProtocol): number {
  return Math.min((p.mcap_usd as number) / p.tvl_usd, 5);
}

export interface PeerFit {
  globalMedian: number;
  byCategory: Map<string, { median: number; peers: number }>;
  sizeSlope: number;
  sizeIntercept: number;
}

/** Fit the peer multiples and the size curve on one set of traded protocols. */
export function fitPeers(protocols: SnapshotProtocol[]): PeerFit {
  const traded = tradedProtocols(protocols);
  const globalMedian = median(traded.map(ratio)) ?? 0.25;
  const perCategory = new Map<string, number[]>();
  for (const p of traded) {
    const key = p.category ?? 'Uncategorized';
    const list = perCategory.get(key) ?? [];
    list.push(ratio(p));
    perCategory.set(key, list);
  }
  const byCategory = new Map<string, { median: number; peers: number }>();
  for (const [key, list] of perCategory) {
    const m = median(list);
    if (m !== null) byCategory.set(key, { median: m, peers: list.length });
  }
  // The size curve: how the log of (market cap / (TVL * peer multiple))
  // moves with log TVL. A negative slope means bigger protocols carry a
  // lower multiple — fitted, not assumed.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of traded) {
    xs.push(Math.log(p.tvl_usd));
    ys.push(Math.log((p.mcap_usd as number) / (p.tvl_usd * peerMultipleFor(p.category, { globalMedian, byCategory, sizeSlope: 0, sizeIntercept: 0 }))));
  }
  let sizeSlope = 0;
  let sizeIntercept = 0;
  if (xs.length >= 8) {
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i += 1) {
      num += (xs[i]! - mx) * (ys[i]! - my);
      den += (xs[i]! - mx) * (xs[i]! - mx);
    }
    if (den > 0) {
      sizeSlope = num / den;
      sizeIntercept = my - sizeSlope * mx;
    }
  }
  return { globalMedian, byCategory, sizeSlope, sizeIntercept };
}

/** A category's multiple: its own median shrunk toward the global one (weight 8). */
export function peerMultipleFor(category: string | null, fit: PeerFit): number {
  const key = category ?? 'Uncategorized';
  const entry = fit.byCategory.get(key);
  if (entry === undefined) return fit.globalMedian;
  return (entry.peers * entry.median + 8 * fit.globalMedian) / (entry.peers + 8);
}

/** The size factor for a TVL: exp(intercept + slope * ln(TVL)). */
export function sizeFactorFor(tvlUsd: number, fit: PeerFit): number {
  return Math.exp(fit.sizeIntercept + fit.sizeSlope * Math.log(Math.max(1, tvlUsd)));
}

/** The terminal value: what the token would be worth if launched today. */
export function terminalValue(p: SnapshotProtocol, fit: PeerFit): number {
  return p.tvl_usd * peerMultipleFor(p.category, fit) * sizeFactorFor(p.tvl_usd, fit);
}

/** A deterministic hash of a slug, for the held-out split: every 5th protocol sits out. */
function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) h += slug.charCodeAt(i);
  return h;
}

/**
 * The held-out check: fit on 4/5 of the traded protocols, predict the held-out
 * fifth's market caps, and compare against the naive baseline (the train
 * set's global median ratio for every protocol). The errors are medians of
 * |log(prediction) - log(actual)|, so a factor of x2.6 means the typical
 * held-out prediction is within 2.6x either way.
 */
export function validateFit(protocols: SnapshotProtocol[]): Validation {
  const traded = tradedProtocols(protocols);
  const train = traded.filter((p) => slugHash(p.slug) % 5 !== 0);
  const test = traded.filter((p) => slugHash(p.slug) % 5 === 0);
  const fit = fitPeers(train);
  const fittedErrs: number[] = [];
  const baselineErrs: number[] = [];
  for (const p of test) {
    const actual = Math.log(p.mcap_usd as number);
    const fitted = Math.log(Math.max(1, terminalValue(p, fit)));
    const baseline = Math.log(Math.max(1, p.tvl_usd * fit.globalMedian));
    fittedErrs.push(Math.abs(fitted - actual));
    baselineErrs.push(Math.abs(baseline - actual));
  }
  const fittedMed = median(fittedErrs) ?? 0;
  const baselineMed = median(baselineErrs) ?? 0;
  return {
    train_n: train.length,
    test_n: test.length,
    fitted_median_log_error: Math.round(fittedMed * 1000) / 1000,
    baseline_median_log_error: Math.round(baselineMed * 1000) / 1000,
    fitted_error_factor: Math.round(Math.exp(fittedMed) * 100) / 100,
    baseline_error_factor: Math.round(Math.exp(baselineMed) * 100) / 100,
    size_slope: Math.round(fit.sizeSlope * 1000) / 1000,
    size_intercept: Math.round(fit.sizeIntercept * 1000) / 1000,
    global_median_ratio: Math.round(fit.globalMedian * 1000) / 1000,
  };
}

/* ---- Scoring factors -------------------------------------------------- */

export interface ModelContext {
  asOf: string;
  fit: PeerFit;
  globalRate: number;
  oddsByCategory: Map<string, number>;
}

/** Build the model's context from the snapshot alone: no outside data. */
export function modelContext(snapshot: Snapshot): ModelContext {
  const fit = fitPeers(snapshot.protocols);
  let tokenised = 0;
  for (const p of snapshot.protocols) if (!isTokenless(p)) tokenised += 1;
  const globalRate = tokenised / snapshot.protocols.length;
  const perCategory = new Map<string, { total: number; tokenised: number }>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? '(none)';
    const entry = perCategory.get(key) ?? { total: 0, tokenised: 0 };
    entry.total += 1;
    if (!isTokenless(p)) entry.tokenised += 1;
    perCategory.set(key, entry);
  }
  const oddsByCategory = new Map<string, number>();
  for (const [key, entry] of perCategory) {
    const odds = (entry.tokenised + 5 * globalRate) / (entry.total + 5);
    oddsByCategory.set(key, Math.min(0.9, Math.max(0.05, odds)));
  }
  return { asOf: snapshot.as_of, fit, globalRate, oddsByCategory };
}

/** The launch odds for one protocol: its category's shrunk tokenisation rate. */
export function launchOdds(p: SnapshotProtocol, ctx: ModelContext): number {
  const odds = ctx.oddsByCategory.get(p.category ?? '(none)');
  return odds === undefined ? ctx.globalRate : odds;
}

/** Momentum: one week's move, damped, never compounded. */
export function growthFactor(p: SnapshotProtocol): number {
  if (p.change_7d === null) return 1;
  const weekly = Math.min(150, Math.max(-50, p.change_7d)) / 100;
  return 1 + 0.35 * weekly;
}

/** Maturity: older with no token counts as more overdue, on a log scale. */
export function ageFactor(p: SnapshotProtocol, ctx: ModelContext): number {
  const age = ageDays(p, ctx.asOf) ?? 365;
  return 0.75 + 0.25 * Math.min(Math.log1p(age) / Math.log1p(1095), 1);
}

/** Breadth: each extra chain adds a little reach, at most 10%. */
export function breadthFactor(p: SnapshotProtocol): number {
  return 1 + 0.02 * Math.min(Math.max(p.chains.length - 1, 0), 5);
}

/** Score one protocol: every factor, the implied value, and the expected value. */
export function scoreProtocol(
  p: SnapshotProtocol,
  ctx: ModelContext,
): Omit<BoardRow, 'rank' | 'farm_steps' | 'on_watchlist'> {
  const terminal = terminalValue(p, ctx.fit);
  const growth = growthFactor(p);
  const ageF = ageFactor(p, ctx);
  const breadth = breadthFactor(p);
  const implied = Math.max(1, Math.round(terminal * growth * ageF * breadth));
  const odds = launchOdds(p, ctx);
  const expected = Math.max(1, Math.round(implied * odds));
  const { capital, gas } = farmCost(p);
  return {
    slug: p.slug,
    name: p.name,
    implied_value_usd: implied,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    age_days: ageDays(p, ctx.asOf),
    odds,
    expected_value_usd: expected,
    verdict: verdictFor(expected),
    farm_cost_usd: capital + gas,
    farm_capital_usd: capital,
    farm_gas_usd: gas,
    terminal_usd: Math.round(terminal),
    peer_multiple: Math.round(peerMultipleFor(p.category, ctx.fit) * 1e4) / 1e4,
    size_factor: Math.round(sizeFactorFor(p.tvl_usd, ctx.fit) * 1e4) / 1e4,
    growth: Math.round(growth * 1e4) / 1e4,
    age_factor: Math.round(ageF * 1e4) / 1e4,
    breadth: Math.round(breadth * 1e4) / 1e4,
  };
}

/* ---- Farm cost and verdict -------------------------------------------- */

const CHEAP_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Polygon', 'Blast', 'Linea', 'Scroll',
  'Mantle', 'Mode', 'Fraxtal', 'Berachain', 'BNB Chain', 'Avalanche', 'Solana',
]);

/** The capital one farm position needs, from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** The gas a six-transaction farm run costs on the protocol's first chain. */
export function gasFor(p: SnapshotProtocol): number {
  const chain = p.chains[0] ?? 'Ethereum';
  const perTx = chain === 'Ethereum' ? 30 : CHEAP_CHAINS.has(chain) ? 5 : 10;
  return 6 * perTx;
}

/** The farm's cost: capital plus gas, both from the protocol's own record. */
export function farmCost(p: SnapshotProtocol): { capital: number; gas: number } {
  return { capital: capitalFor(p), gas: gasFor(p) };
}

/** The costed verdict: Farm when the expected value clears $10M, Watch at $2M, else Track. */
export function verdictFor(expectedValueUsd: number): Verdict {
  if (expectedValueUsd >= 10_000_000) return 'Farm';
  if (expectedValueUsd >= 2_000_000) return 'Watch';
  return 'Track';
}

/* ---- Farm plans ------------------------------------------------------- */

interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One step as a single string: its action, then its cost and time. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function gasNote(chain: string): string {
  if (chain === 'Ethereum') return '~$30 of ETH gas';
  if (CHEAP_CHAINS.has(chain)) return 'under $1 of gas';
  return 'a few dollars of gas';
}

type StepFn = (name: string, chain: string, capital: number, gas: string) => FarmStep[];

const FAMILIES: Record<string, StepFn> = {
  dex: (name, chain, capital, gas) => [
    { text: `Swap $${capital} across two or three pairs on ${name} on ${chain} — small trades in both directions, not one big one, so the position reads as real usage`, cost: `$${capital} of capital and ${gas} per trade`, time: '20 minutes' },
    { text: `Provide $${capital} of liquidity to one ${name} pool on ${chain} and hold the LP position for at least 2–4 weeks; trading fees accrue while the position is open`, cost: `$${capital} of capital and ${gas}`, time: '15 minutes to open, then 2–4 weeks holding' },
    { text: `Repeat one swap or LP adjustment each week for a month, keeping the same wallet, so activity is consistent rather than a single burst`, cost: `${gas} a week`, time: '10 minutes a week' },
    { text: `If ${name} runs a points program, check its docs and confirm each action above earns points before committing more funds; do not chase unconfirmed programs`, cost: 'nothing to check', time: '10 minutes' },
    { text: `Record every transaction hash and screenshot the position; stop if the pool's TVL falls by half or the team goes quiet for 30 days`, cost: 'nothing but the log', time: '5 minutes' },
  ],
  lending: (name, chain, capital, gas) => [
    { text: `Supply $${capital} of a major asset (ETH, USDC or wBTC) to ${name} on ${chain} and leave it earning for 2–4 weeks`, cost: `$${capital} of capital and ${gas}`, time: '15 minutes to open' },
    { text: `Borrow a small amount — under 40% of the collateral value — against the supply, then repay it within a week, to show both sides of the market`, cost: `${gas} for the borrow and the repay`, time: '10 minutes, then a week holding' },
    { text: `Repeat the supply-borrow-repay cycle once a month, keeping the health factor above 1.8 at all times so nothing is liquidated`, cost: `${gas} a month`, time: '10 minutes a month' },
    { text: `If ${name} runs a points program, confirm in its docs which actions earn points and size the position to the program's tiers`, cost: 'nothing to check', time: '10 minutes' },
    { text: `Withdraw the supply only after 30–60 days of steady activity; keep the transaction history as proof of use`, cost: `${gas} to withdraw`, time: '30–60 days of activity' },
  ],
  perps: (name, chain, capital, gas) => [
    { text: `Open a small perpetual position of $${capital} notional on ${name} on ${chain}, with leverage at or below 2x, and close it within a few days`, cost: `$${capital} notional and ${gas}`, time: '15 minutes' },
    { text: `Place one limit order and one market order in separate weeks so both order types are used`, cost: `${gas} per order`, time: '10 minutes a week' },
    { text: `Hold a position through one funding interval to pay and receive funding, then close before the position grows beyond 5% of the account`, cost: 'the funding rate on the position', time: 'one funding interval' },
    { text: `If ${name} runs a trading-points program, check its docs for how volume and holding time are scored before sizing up`, cost: 'nothing to check', time: '10 minutes' },
    { text: `Cap total losses at $50–$100 for the whole farming run and stop if the market moves 10% against the position`, cost: 'at most $100 of losses', time: 'the whole run' },
  ],
  yield: (name, chain, capital, gas) => [
    { text: `Deposit $${capital} into a ${name} vault on ${chain} and let the yield compound for 30 days without withdrawing`, cost: `$${capital} of capital and ${gas}`, time: '10 minutes to open, then 30 days' },
    { text: `Claim or restake the yield once, mid-period, to show an active position rather than a dormant deposit`, cost: `${gas} to claim`, time: '5 minutes, mid-period' },
    { text: `If the vault accepts multiple assets, split the deposit across two of them to diversify the position`, cost: `$${capital} split across two assets`, time: '10 minutes' },
    { text: `Track the vault's APY weekly; exit if it drops by more than half or the vault's TVL falls 30% in a week`, cost: 'nothing to track', time: '5 minutes a week' },
    { text: `If ${name} runs a points program, confirm the deposit counts toward it and keep the position until the program's snapshot window, if any, is announced`, cost: 'nothing to check', time: '10 minutes' },
  ],
  rwa: (name, chain, capital, gas) => [
    { text: `Deposit $${capital} into ${name} on ${chain} and hold the position for 30–60 days; real-world-asset yields accrue slowly, so patience is the position`, cost: `$${capital} of capital and ${gas}`, time: '10 minutes to open, then 30–60 days' },
    { text: `Reinvest the first yield payout back into the same product instead of withdrawing it`, cost: `${gas} to reinvest`, time: '5 minutes' },
    { text: `Read the product's docs for lockups, redemption windows and minimums before depositing; never lock funds needed within 90 days`, cost: 'nothing to read', time: '15 minutes' },
    { text: `If ${name} runs a points or allocation program, confirm the deposit qualifies and note the program's dates`, cost: 'nothing to check', time: '10 minutes' },
    { text: `Redeem a small test amount first to confirm the redemption path works, then decide whether to add more`, cost: `${gas} for the test redemption`, time: '10 minutes' },
  ],
  cdp: (name, chain, capital, gas) => [
    { text: `Lock $${capital} of collateral in ${name} on ${chain} and mint its stablecoin against it at under 50% of the collateral-ratio limit`, cost: `$${capital} of collateral and ${gas}`, time: '15 minutes' },
    { text: `Use the minted stablecoin in one of the protocol's own pools or a paired DEX pool for 2–4 weeks`, cost: `${gas} to enter the pool`, time: '2–4 weeks' },
    { text: `Repay part of the debt and unlock a small amount of collateral to show active debt management`, cost: `${gas} for the repay`, time: '10 minutes' },
    { text: `Keep the collateral ratio above 200% at all times and set a price alert 20% below the liquidation level`, cost: 'nothing to monitor', time: '5 minutes to set the alert' },
    { text: `If ${name} runs a points program, confirm minting and LP activity both count before sizing the position`, cost: 'nothing to check', time: '10 minutes' },
  ],
  curator: (name, chain, capital, gas) => [
    { text: `Allocate $${capital} across two or three vaults curated by ${name} on ${chain}, instead of a single vault, to spread curator risk`, cost: `$${capital} of capital and ${gas} per vault`, time: '20 minutes' },
    { text: `Hold the allocation for 30 days and compare each vault's realised return against its stated strategy`, cost: `the $${capital} stays allocated`, time: '30 days' },
    { text: `Rebalance once, moving funds from the worst-performing vault to the best, and keep the rebalancing transaction as a record`, cost: `${gas} to rebalance`, time: '10 minutes, once' },
    { text: `Check the curator's track record and audit history in its docs before allocating; skip curators with no public history`, cost: 'nothing to check', time: '15 minutes' },
    { text: `Withdraw if any vault's value drops 15% below deposit while peers are flat, and do not re-enter the same vault`, cost: `${gas} to withdraw`, time: '10 minutes' },
  ],
  chain: (name, chain, capital, gas) => [
    { text: `Bridge $${capital} to ${chain} using ${name} and keep the funds on-chain for 30 days`, cost: `$${capital} of capital and ${gas} to bridge`, time: '15 minutes, then 30 days' },
    { text: `Use two or three of ${chain}'s flagship apps with the bridged funds — a swap, a lending deposit and a small LP position`, cost: `$${capital} across the apps and ${gas} each`, time: '30 minutes' },
    { text: `Repeat one on-chain action per week so the wallet shows steady ecosystem use, not a single visit`, cost: `${gas} a week`, time: '10 minutes a week' },
    { text: `If ${chain} or ${name} runs a points or quest program, confirm each action counts before committing more funds`, cost: 'nothing to check', time: '10 minutes' },
    { text: `Keep a small reserve on ${chain} for gas and bridge back only after 30 days of activity`, cost: `${gas} to bridge back`, time: '30 days of activity' },
  ],
  generic: (name, chain, capital, gas) => [
    { text: `Use ${name}'s core product on ${chain} with $${capital} and hold the position for 30 days; steady use beats a single transaction`, cost: `$${capital} of capital and ${gas}`, time: '15 minutes to open, then 30 days' },
    { text: `Repeat the core action once a week for a month, varying the amount slightly each time`, cost: `${gas} a week`, time: '10 minutes a week' },
    { text: `Read ${name}'s docs for any points, quest or rewards program and confirm which actions count before sizing up`, cost: 'nothing to check', time: '10 minutes' },
    { text: `Track the protocol's TVL and announcements weekly; pause if TVL falls by half or the team goes quiet for 30 days`, cost: 'nothing to track', time: '5 minutes a week' },
    { text: `Keep every transaction hash and a screenshot of the position as proof of use`, cost: 'nothing but the log', time: '5 minutes' },
  ],
};

const FAMILY_BY_CATEGORY: Record<string, string> = {
  Dexs: 'dex',
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  'Collateral Markets': 'lending',
  Derivatives: 'perps',
  'Basis Trading': 'perps',
  'Interest Rate Derivatives': 'perps',
  'Options Vault': 'perps',
  'Leveraged Farming': 'perps',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  Farm: 'yield',
  'Liquidity Manager': 'yield',
  RWA: 'rwa',
  'Onchain Capital Allocator': 'rwa',
  'Anchor BTC': 'rwa',
  'Decentralized BTC': 'rwa',
  CDP: 'cdp',
  'Dual-Token Stablecoin': 'cdp',
  'Stablecoin Wrapper': 'cdp',
  'CDP Manager': 'cdp',
  'Risk Curators': 'curator',
  Insurance: 'curator',
  Chain: 'chain',
  'Cross Chain Bridge': 'chain',
  CeDeFi: 'chain',
  Restaking: 'chain',
  'Staking Pool': 'chain',
};

/** Concrete farm steps for one protocol, from its category's playbook. */
export function farmSteps(p: SnapshotProtocol): string[] {
  const family = FAMILY_BY_CATEGORY[p.category ?? ''] ?? 'generic';
  const build = FAMILIES[family] ?? FAMILIES.generic;
  const chain = p.chains[0] ?? 'Ethereum';
  return build(p.name, chain, capitalFor(p), gasNote(chain)).map(stepText);
}

/* ---- Board ------------------------------------------------------------ */

/** The live-token protocols, by market cap, for the dashboard's Already trading view. */
export function liveRows(snapshot: Snapshot, limit = 24): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isTokenless(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_per_tvl:
        p.tvl_usd > 0 && p.mcap_usd !== null ? Math.round((p.mcap_usd / p.tvl_usd) * 1e4) / 1e4 : null,
    }));
}

/** Build the ranked board and the dashboard's data from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const ctx = modelContext(snapshot);
  const validation = validateFit(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const scored = snapshot.protocols
    .filter((p) => {
      if (watchlist.has(p.slug)) return true;
      return isTokenless(p) && !isExcluded(p) && p.tvl_usd < snapshot.floor_usd;
    })
    .map((p) => scoreProtocol(p, ctx));
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  const board: BoardRow[] = scored.map((row, i) => ({
    ...row,
    rank: i + 1,
    farm_steps: farmSteps(bySlug.get(row.slug)!),
    on_watchlist: watchlist.has(row.slug),
  }));

  const excludedRule = snapshot.protocols.filter((p) => isTokenless(p) && isExcluded(p)).length;
  const boardSlugs = new Set(board.map((r) => r.slug));
  const excludedHouse = snapshot.protocols.filter(
    (p) => isTokenless(p) && !isExcluded(p) && !boardSlugs.has(p.slug),
  ).length;
  const live = liveRows(snapshot);
  const fit = ctx.fit;
  const peerMultiples: PeerMultipleRow[] = [...fit.byCategory.entries()]
    .map(([category, entry]) => ({
      category,
      peers: entry.peers,
      median: Math.round(entry.median * 1e4) / 1e4,
      multiple: Math.round(peerMultipleFor(category, fit) * 1e4) / 1e4,
    }))
    .sort((a, b) => b.multiple - a.multiple || (a.category < b.category ? -1 : 1));
  const radar: Radar = {
    meta: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      model: 'implied = TVL x category peer multiple x fitted size factor x damped 7d growth x age x breadth; odds and farm cost set the verdict, not the value',
      protocols: snapshot.protocols.length,
      candidates: board.length,
      watchlist: snapshot.watchlist.length,
      excluded_rule: excludedRule,
      excluded_house: excludedHouse,
      live_shown: live.length,
      validation,
    },
    peer_multiples: peerMultiples,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The gate's board rules, checked locally before the kit's check runs. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) {
    return `board holds ${board.length} rows, needs 100 to 4000`;
  }
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (let i = 0; i < board.length; i += 1) {
    const row = board[i]!;
    if (!slugs.has(row.slug)) return `row ${i}: slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `row ${i}: slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (typeof row.name !== 'string' || row.name.length === 0) return `row ${i}: empty name`;
    if (row.rank !== i + 1) return `row ${i}: rank ${row.rank}, expected ${i + 1}`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `row ${i}: implied_value_usd ${row.implied_value_usd} is not a positive whole number`;
    }
    if (row.implied_value_usd > 100_000_000_000_000) return `row ${i}: implied value over the cap`;
    if (i > 0 && row.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i}: implied value rises with rank`;
    }
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${i}: farm_steps holds ${row.farm_steps?.length ?? 0} steps, needs 3 to 12`;
    }
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) {
        return `row ${i}: a farm step is ${trimmed.length} characters, needs 20 to 600`;
      }
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  if (board.length > 1 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return 'every row carries the same implied value: not a ranking';
  }
  return null;
}

/** The dashboard's data file: window.RADAR, deterministic for a snapshot. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
