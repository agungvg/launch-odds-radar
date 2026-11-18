// Launch-odds radar: the value model for token-radar-01.
//
// A protocol's launch is the token it may issue one day. This model prices
// each pre-token protocol by EXPECTED value, not by raw size: the terminal
// value its token would carry if launched, times the odds that a token ever
// comes. The odds come from the snapshot itself — how often protocols in the
// same category already have a token — so a big protocol in a category that
// almost never tokenises ranks below a smaller one in a category that
// usually does. Nothing is priced by name: one function scores every
// protocol from the snapshot's own ten fields.
//
//   terminal  = K * TVL^0.8            (sublinear: value grows slower than TVL)
//   K         = median tokenised market cap / median tokenised TVL^0.8,
//               both read from this snapshot, so the anchor is the typical
//               tokenised protocol — medians, so no single outlier sets it.
//   growth    = (1 + clamped 7d move)^8, clamped to [0.5, 2.0]
//   age       = 0.7 + 0.6 * log1p(ageDays/180) / log1p(maxAgeDays/180)
//               (older with no token: more overdue; missing date: 1.0)
//   breadth   = 1 + 0.15 * log2(chains), capped at 1.8
//   odds      = shrunk category tokenisation rate:
//               (tokenised in category + 5 * global rate)
//               / (protocols in category + 5), floored at 0.05, capped 0.90
//   implied   = terminal * growth * age * breadth * odds
//
// The board ranks every plausible pre-token protocol: tokenless, and not a
// wrapped, staked or bridged product of a token that already trades, not a
// CEX, not a versioned pool, not exchange-named. That is 201 rows here, the
// whole watchlist (40) plus every rankable protocol below the floor.

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
  terminal_usd: number;
  growth: number;
  age_factor: number;
  breadth: number;
  on_watchlist: boolean;
}

export interface Radar {
  meta: {
    as_of: string;
    floor_usd: number;
    model: string;
    protocols: number;
    candidates: number;
    watchlist: number;
    excluded: number;
    anchor_k: number;
    global_tokenisation_rate: number;
  };
  rows: BoardRow[];
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

const VERSION_SUFFIX = /\s(V2|v2|2\.0|V3|v3|3\.0)$/;
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

/** True when the protocol records no token. */
export function isTokenless(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
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

export interface ModelContext {
  asOf: string;
  anchorK: number;
  globalRate: number;
  oddsByCategory: Map<string, number>;
  maxAgeDays: number;
}

/** Build the model's context from the snapshot alone: no outside data. */
export function modelContext(snapshot: Snapshot): ModelContext {
  // The anchor is the typical tokenised protocol: K is set so the power law
  // passes through the median tokenised market cap at the median tokenised
  // TVL. Medians, so neither a CEX's giant TVL nor one outlier market cap
  // can set the price.
  const mcaps = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .map((p) => p.mcap_usd as number)
    .sort((a, b) => a - b);
  const tokenisedTvls = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .map((p) => p.tvl_usd)
    .sort((a, b) => a - b);
  const median = (xs: number[]): number => xs[Math.floor(xs.length / 2)]!;
  const anchorK = median(mcaps) / Math.pow(median(tokenisedTvls), 0.8);

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

  let maxAgeDays = 0;
  for (const p of snapshot.protocols) {
    const age = ageDays(p, snapshot.as_of);
    if (age !== null && age > maxAgeDays) maxAgeDays = age;
  }
  return { asOf: snapshot.as_of, anchorK, globalRate, oddsByCategory, maxAgeDays };
}

/** The launch odds for one protocol: its category's shrunk tokenisation rate. */
export function launchOdds(p: SnapshotProtocol, ctx: ModelContext): number {
  const odds = ctx.oddsByCategory.get(p.category ?? '(none)');
  return odds === undefined ? ctx.globalRate : odds;
}

/** The terminal value: what the token would be worth if launched today. */
export function terminalValue(p: SnapshotProtocol, ctx: ModelContext): number {
  return ctx.anchorK * Math.pow(Math.max(1, p.tvl_usd), 0.8);
}

/** Momentum: one week's move, damped and compounded over eight weeks. */
export function growthFactor(p: SnapshotProtocol): number {
  if (p.change_7d === null) return 1;
  const weekly = Math.min(0.2, Math.max(-0.2, p.change_7d / 100));
  return Math.min(2, Math.max(0.5, Math.pow(1 + weekly, 8)));
}

/** Maturity: older with no token counts as more overdue, on a log scale. */
export function ageFactor(p: SnapshotProtocol, ctx: ModelContext): number {
  const age = ageDays(p, ctx.asOf);
  if (age === null) return 1;
  const ratio = Math.log1p(age / 180) / Math.log1p(ctx.maxAgeDays / 180);
  return 0.7 + 0.6 * ratio;
}

/** Breadth: each extra chain adds reach, with diminishing returns. */
export function breadthFactor(p: SnapshotProtocol): number {
  return Math.min(1.8, 1 + 0.15 * Math.log2(Math.max(1, p.chains.length)));
}

/** Score one protocol: every factor, and the implied (expected) value. */
export function scoreProtocol(
  p: SnapshotProtocol,
  ctx: ModelContext,
): Omit<BoardRow, 'rank' | 'farm_steps' | 'on_watchlist'> {
  const terminal = terminalValue(p, ctx);
  const growth = growthFactor(p);
  const ageF = ageFactor(p, ctx);
  const breadth = breadthFactor(p);
  const odds = launchOdds(p, ctx);
  const implied = Math.max(1, Math.round(terminal * growth * ageF * breadth * odds));
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
    terminal_usd: Math.round(terminal),
    growth,
    age_factor: ageF,
    breadth,
  };
}

/* ---- Farm plans ------------------------------------------------------- */

// Position sizes follow the protocol's TVL: bigger books take bigger tickets.
function sizeBand(tvlUsd: number): string {
  if (tvlUsd >= 500_000_000) return '$1,000–$5,000';
  if (tvlUsd >= 100_000_000) return '$500–$2,000';
  if (tvlUsd >= 50_000_000) return '$250–$1,000';
  return '$100–$500';
}

function gasNote(chain: string): string {
  if (chain === 'Ethereum') return 'Budget $5–$30 of ETH gas per transaction.';
  const cheap = new Set([
    'Arbitrum', 'Base', 'Optimism', 'Polygon', 'Blast', 'Linea', 'Scroll',
    'Mantle', 'Mode', 'Fraxtal', 'Berachain', 'BNB Chain', 'Avalanche', 'Solana',
  ]);
  if (cheap.has(chain)) return 'Gas is under $1 per transaction on this chain.';
  return 'Budget a few dollars per transaction in gas.';
}

type StepFn = (name: string, chain: string, size: string, gas: string) => string[];

const FAMILIES: Record<string, StepFn> = {
  dex: (name, chain, size, gas) => [
    `Swap ${size} across two or three pairs on ${name} on ${chain} — small trades in both directions, not one big one, so the position reads as real usage. ${gas} Takes about 20 minutes.`,
    `Provide ${size} of liquidity to one ${name} pool on ${chain} and hold the LP position for at least 2–4 weeks; trading fees accrue while the position is open.`,
    `Repeat one swap or LP adjustment each week for a month, keeping the same wallet, so activity is consistent rather than a single burst.`,
    `If ${name} runs a points program, check its docs and confirm each action above earns points before committing more funds; do not chase unconfirmed programs.`,
    `Record every transaction hash and screenshot the position; stop if the pool's TVL falls by half or the team goes quiet for 30 days.`,
  ],
  lending: (name, chain, size, gas) => [
    `Supply ${size} of a major asset (ETH, USDC or wBTC) to ${name} on ${chain} and leave it earning for 2–4 weeks. ${gas} Takes about 15 minutes to open.`,
    `Borrow a small amount — under 40% of the collateral value — against the supply, then repay it within a week, to show both sides of the market.`,
    `Repeat the supply-borrow-repay cycle once a month, keeping the health factor above 1.8 at all times so nothing is liquidated.`,
    `If ${name} runs a points program, confirm in its docs which actions earn points and size the position to the program's tiers.`,
    `Withdraw the supply only after 30–60 days of steady activity; keep the transaction history as proof of use.`,
  ],
  perps: (name, chain, size, gas) => [
    `Open a small perpetual position of ${size} notional on ${name} on ${chain}, with leverage at or below 2x, and close it within a few days. ${gas}`,
    `Place one limit order and one market order in separate weeks so both order types are used.`,
    `Hold a position through one funding interval to pay and receive funding, then close before the position grows beyond 5% of the account.`,
    `If ${name} runs a trading-points program, check its docs for how volume and holding time are scored before sizing up.`,
    `Cap total losses at $50–$100 for the whole farming run and stop if the market moves 10% against the position.`,
  ],
  yield: (name, chain, size, gas) => [
    `Deposit ${size} into a ${name} vault on ${chain} and let the yield compound for 30 days without withdrawing. ${gas}`,
    `Claim or restake the yield once, mid-period, to show an active position rather than a dormant deposit.`,
    `If the vault accepts multiple assets, split the deposit across two of them to diversify the position.`,
    `Track the vault's APY weekly; exit if it drops by more than half or the vault's TVL falls 30% in a week.`,
    `If ${name} runs a points program, confirm the deposit counts toward it and keep the position until the program's snapshot window, if any, is announced.`,
  ],
  rwa: (name, chain, size, gas) => [
    `Deposit ${size} into ${name} on ${chain} and hold the position for 30–60 days; real-world-asset yields accrue slowly, so patience is the position. ${gas}`,
    `Reinvest the first yield payout back into the same product instead of withdrawing it.`,
    `Read the product's docs for lockups, redemption windows and minimums before depositing; never lock funds needed within 90 days.`,
    `If ${name} runs a points or allocation program, confirm the deposit qualifies and note the program's dates.`,
    `Redeem a small test amount first to confirm the redemption path works, then decide whether to add more.`,
  ],
  cdp: (name, chain, size, gas) => [
    `Lock ${size} of collateral in ${name} on ${chain} and mint its stablecoin against it at under 50% of the collateral-ratio limit. ${gas}`,
    `Use the minted stablecoin in one of the protocol's own pools or a paired DEX pool for 2–4 weeks.`,
    `Repay part of the debt and unlock a small amount of collateral to show active debt management.`,
    `Keep the collateral ratio above 200% at all times and set a price alert 20% below the liquidation level.`,
    `If ${name} runs a points program, confirm minting and LP activity both count before sizing the position.`,
  ],
  curator: (name, chain, size, gas) => [
    `Allocate ${size} across two or three vaults curated by ${name} on ${chain}, instead of a single vault, to spread curator risk. ${gas}`,
    `Hold the allocation for 30 days and compare each vault's realised return against its stated strategy.`,
    `Rebalance once, moving funds from the worst-performing vault to the best, and keep the rebalancing transaction as a record.`,
    `Check the curator's track record and audit history in its docs before allocating; skip curators with no public history.`,
    `Withdraw if any vault's value drops 15% below deposit while peers are flat, and do not re-enter the same vault.`,
  ],
  chain: (name, chain, size, gas) => [
    `Bridge ${size} to ${chain} using ${name} and keep the funds on-chain for 30 days. ${gas}`,
    `Use two or three of ${chain}'s flagship apps with the bridged funds — a swap, a lending deposit and a small LP position.`,
    `Repeat one on-chain action per week so the wallet shows steady ecosystem use, not a single visit.`,
    `If ${chain} or ${name} runs a points or quest program, confirm each action counts before committing more funds.`,
    `Keep a small reserve on ${chain} for gas and bridge back only after 30 days of activity.`,
  ],
  generic: (name, chain, size, gas) => [
    `Use ${name}'s core product on ${chain} with ${size} and hold the position for 30 days; steady use beats a single transaction. ${gas}`,
    `Repeat the core action once a week for a month, varying the amount slightly each time.`,
    `Read ${name}'s docs for any points, quest or rewards program and confirm which actions count before sizing up.`,
    `Track the protocol's TVL and announcements weekly; pause if TVL falls by half or the team goes quiet for 30 days.`,
    `Keep every transaction hash and a screenshot of the position as proof of use.`,
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
  return build(p.name, chain, sizeBand(p.tvl_usd), gasNote(chain));
}

/* ---- Board ------------------------------------------------------------ */

/** Build the ranked board and the dashboard's data from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const ctx = modelContext(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter((p) => isTokenless(p) && !isExcluded(p))
    .map((p) => scoreProtocol(p, ctx));
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));

  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const board: BoardRow[] = scored.map((row, i) => ({
    ...row,
    rank: i + 1,
    farm_steps: farmSteps(bySlug.get(row.slug)!),
    on_watchlist: watchlist.has(row.slug),
  }));

  const excluded = snapshot.protocols.filter((p) => isTokenless(p) && isExcluded(p)).length;
  const radar: Radar = {
    meta: {
      as_of: snapshot.as_of,
      floor_usd: snapshot.floor_usd,
      model: 'implied = K * TVL^0.8 * growth(7d, 8wk) * age * breadth * category launch odds',
      protocols: snapshot.protocols.length,
      candidates: board.length,
      watchlist: snapshot.watchlist.length,
      excluded,
      anchor_k: ctx.anchorK,
      global_tokenisation_rate: ctx.globalRate,
    },
    rows: board,
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
