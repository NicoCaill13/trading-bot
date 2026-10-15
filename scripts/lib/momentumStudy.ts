/**
 * Pure maths for the cross-sectional momentum study: rank liquid names on their
 * trailing 12-1 month return at a monthly rebalance, hold the winners for a
 * month, and compare with the pool and with the index.
 *
 * Timing is fixed to what is knowable: the rank is read from the close of the
 * rebalance session R, the position is bought at the open of R+1 and sold at the
 * close of R+HOLD. Nothing from R+1 onward informs the selection.
 *
 * No I/O and no config: every threshold is injected, so each rule is testable.
 * The formation, skip and hold lengths below are the pre-declared hypothesis;
 * editing them after reading results turns the test into a fit.
 */

import type { RawBar } from './barFetch';
import type { SessionOf } from './driftStudy';

/** Sessions of price history the rank looks back over (about 12 months). */
export const FORMATION_SESSIONS = 252;
/** Most recent sessions left out of the rank, to avoid short-term reversal (about 1 month). */
export const SKIP_SESSIONS = 21;
/** Holding period and rebalance interval, in sessions (about 1 month). */
export const HOLD_SESSIONS = 21;

/** Window of the liquidity gate, and how many of its sessions must have printed. */
export const LIQUIDITY_WINDOW = 60;
export const MIN_LIQUIDITY_BARS = 50;

/** Daily bars keyed by their index in the trading calendar, so a hole is a miss, not a shift. */
export type BarsBySession = ReadonlyMap<number, RawBar>;

export function indexBySession(
  bars: readonly RawBar[],
  sessionOf: SessionOf,
): Map<number, RawBar> {
  const bySession = new Map<number, RawBar>();
  for (const bar of bars) {
    const session = sessionOf(bar.t);
    if (session !== undefined) bySession.set(session, bar);
  }
  return bySession;
}

/**
 * Return from the close FORMATION sessions ago to the close SKIP sessions ago,
 * in percent, from split-adjusted bars. Null when either end is missing.
 */
export function momentumScorePct(bars: BarsBySession, session: number): number | null {
  const recent = bars.get(session - SKIP_SESSIONS);
  const formation = bars.get(session - FORMATION_SESSIONS);
  if (recent === undefined || formation === undefined) return null;
  if (!(formation.c > 0) || !(recent.c > 0)) return null;
  return (recent.c / formation.c - 1) * 100;
}

export interface LiquidityLimits {
  minPrice: number;
  minAverageDollarVolume: number;
}

/**
 * The tradability gate at the rebalance close, on raw bars: what traded that day,
 * not what a later split-adjustment makes it look like.
 */
export function passesLiquidity(
  raw: BarsBySession,
  session: number,
  limits: LiquidityLimits,
): boolean {
  const today = raw.get(session);
  if (today === undefined || today.c < limits.minPrice) return false;

  let dollarVolume = 0;
  let printed = 0;
  for (let k = session - LIQUIDITY_WINDOW + 1; k <= session; k++) {
    const bar = raw.get(k);
    if (bar === undefined) continue;
    dollarVolume += bar.c * bar.v;
    printed++;
  }
  return printed >= MIN_LIQUIDITY_BARS && dollarVolume / printed >= limits.minAverageDollarVolume;
}

/**
 * Return of buying the open of session+1 and selling the close of session+hold,
 * in percent. Null unless both ends exist, so a name that stopped printing
 * mid-period is a visible miss rather than a silent zero.
 */
export function holdReturnPct(
  bars: BarsBySession,
  session: number,
  hold: number,
): number | null {
  if (hold < 1) return null;
  const entry = bars.get(session + 1);
  const exit = bars.get(session + hold);
  if (entry === undefined || exit === undefined || !(entry.o > 0)) return null;
  return ((exit.c - entry.o) / entry.o) * 100;
}

/** Rebalance sessions from `first`, every `step`, whose holding period fits before `last`. */
export function rebalanceSessions(first: number, last: number, step: number): number[] {
  const sessions: number[] = [];
  for (let s = first; s + step <= last; s += step) sessions.push(s);
  return sessions;
}

export interface Candidate {
  symbol: string;
  /** Momentum score at the rebalance, in percent. */
  scorePct: number;
  /** Gross return of the holding period, in percent. */
  returnPct: number;
}

/** Best score first; ties broken by symbol so a rerun gives the same portfolio. */
function ranked(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(
    (a, b) => b.scorePct - a.scorePct || a.symbol.localeCompare(b.symbol),
  );
}

export function topCandidates(candidates: readonly Candidate[], count: number): Candidate[] {
  return count > 0 ? ranked(candidates).slice(0, count) : [];
}

export function bottomCandidates(candidates: readonly Candidate[], count: number): Candidate[] {
  const all = ranked(candidates);
  return count > 0 ? all.slice(Math.max(0, all.length - count)) : [];
}

/** A tenth of the pool, at least one name. */
export function decileSize(poolSize: number): number {
  return Math.max(1, Math.floor(poolSize / 10));
}

/** Equal-weight mean holding-period return, or null for an empty portfolio. */
export function meanReturnPct(candidates: readonly Candidate[]): number | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((sum, c) => sum + c.returnPct, 0) / candidates.length;
}

/** Total return of chaining period returns (each in percent), in percent. */
export function compoundedReturnPct(periodReturnsPct: readonly number[]): number {
  const growth = periodReturnsPct.reduce((acc, r) => acc * (1 + r / 100), 1);
  return (growth - 1) * 100;
}
