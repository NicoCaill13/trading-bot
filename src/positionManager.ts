import { RSI } from 'technicalindicators';
import alpaca from './alpacaClient';
import config from './config';
import * as trader from './trader';
import * as journalManager from './journalManager';
import { createLogger } from './logger';
import { getESTDate, toErrorMessage } from './utils';
import { sendTelegramAlert, formatExitAlert } from './notificationManager';
import type { BarData, SignalTier } from './types';
import type { AlpacaPosition } from '@alpacahq/alpaca-trade-api';

const log = createLogger('POSITION_MANAGER');

const scaledOutPositions = new Set<string>();
const volumeExhaustionStreak = new Map<string, number>();
const volumeExhaustionTrailApplied = new Set<string>();
const afternoonTrailApplied = new Set<string>();
const externalExitNotified = new Set<string>();
const sessionExitedSymbols = new Set<string>();

export interface PositionUpdateContext {
  bar1m: BarData;
  oneMinBars: BarData[];
  atrAtEntry: number | null;
}

// ---------------------------------------------------------------------------
// Session state (crash recovery)
// ---------------------------------------------------------------------------

export function markScaledOut(symbols: string[]): void {
  for (const symbol of symbols) {
    scaledOutPositions.add(symbol);
  }
  if (symbols.length > 0) {
    log.info(
      `Reconciliation: ${symbols.length} symbol(s) marked as scaled-out ` +
      `(${symbols.join(', ')})`,
    );
  }
}

export function wasScaledOut(symbol: string): boolean {
  return scaledOutPositions.has(symbol);
}

export function resetSessionState(): void {
  scaledOutPositions.clear();
  volumeExhaustionStreak.clear();
  volumeExhaustionTrailApplied.clear();
  afternoonTrailApplied.clear();
  externalExitNotified.clear();
  sessionExitedSymbols.clear();
}

export function consumeSessionExit(symbol: string): boolean {
  if (!sessionExitedSymbols.has(symbol)) return false;
  sessionExitedSymbols.delete(symbol);
  return true;
}

export function wasExternallyExited(symbol: string): boolean {
  return externalExitNotified.has(symbol);
}

// ---------------------------------------------------------------------------
// Indicator helpers
// ---------------------------------------------------------------------------

function computeRsi(closes: number[]): number | null {
  const period = config.risk.smartExitRsiPeriod;
  if (closes.length < period + 1) return null;

  const values = RSI.calculate({ period, values: closes });
  const last = values[values.length - 1];
  return last ?? null;
}

function computeVma10(bars: BarData[]): number | null {
  const period = config.risk.volumeConfirmationVmaPeriod;
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  return slice.reduce((sum, b) => sum + b.volume, 0) / period;
}

function resolveTimeDecayWindow(estNow: Date): 'normal' | 'halved' | 'afternoon' {
  const minutes = estNow.getHours() * 60 + estNow.getMinutes();
  const halveStart = config.risk.timeDecayTpHalveStartHour * 60;
  const halveEnd =
    config.risk.timeDecayTpHalveEndHour * 60 + config.risk.timeDecayTpHalveEndMinute;

  if (minutes >= halveEnd) return 'afternoon';
  if (minutes >= halveStart) return 'halved';
  return 'normal';
}

function resolveEffectiveTargetPct(
  atrAtEntry: number,
  entryPrice: number,
  tier: SignalTier,
  estNow: Date,
): number | null {
  const window = resolveTimeDecayWindow(estNow);
  if (window === 'afternoon') return null;

  const atrTargetPct = (config.risk.atrTakeProfitMultiplier * atrAtEntry) / entryPrice;
  const fixedTargetPct = tier === 'satellite'
    ? config.risk.scaleOutTargetPctSatellite
    : config.risk.scaleOutTargetPctCore;

  let targetPct = Math.min(atrTargetPct, fixedTargetPct);
  if (window === 'halved') targetPct /= 2;
  return targetPct;
}

// ---------------------------------------------------------------------------
// Smart exits & dynamic targets
// ---------------------------------------------------------------------------

async function executeFullMarketExit(
  symbol: string,
  position: AlpacaPosition,
  exitReason: 'rsi-overbought-exit',
  logReason: string,
): Promise<boolean> {
  const qty = parseInt(position.qty, 10);
  if (qty <= 0) return false;

  log.info(`${symbol}: ${logReason} — full market exit (${qty} shares)`);

  const failedCancels = await trader.cancelOrdersForSymbol(symbol);
  if (failedCancels > 0) {
    log.warn(`${symbol}: ${logReason} deferred — ${failedCancels} cancel failure(s)`);
    return false;
  }

  await new Promise(r => setTimeout(r, 500));
  await trader.placeSellOrder(symbol, qty, logReason);
  journalManager.closeTrade(symbol, exitReason, parseFloat(position.current_price));
  scaledOutPositions.add(symbol);
  sessionExitedSymbols.add(symbol);
  return true;
}

async function applyTightTrailing(
  symbol: string,
  trailPct: number,
  logReason: string,
  appliedSet: Set<string>,
): Promise<void> {
  if (appliedSet.has(symbol)) return;

  try {
    await trader.replaceWithTrailingStop(symbol, trailPct);
    appliedSet.add(symbol);
    log.info(
      `${symbol}: ${logReason} — trailing stop ${(trailPct * 100).toFixed(2)}% activated`,
    );
    void sendTelegramAlert(formatExitAlert(symbol, logReason));
  } catch (err) {
    log.error(`${symbol}: ${logReason} trailing failed — ${toErrorMessage(err)}`);
  }
}

/**
 * Dynamic exit engine — evaluated on each 1-min bar close before fixed TP targets.
 * Order: Smart Exit RSI → Volume Exhaustion → Time-Decay afternoon trail → ATR/Fixed TP scale-out.
 */
export async function handlePositionUpdate(
  symbol: string,
  currentPrice: number,
  tier: SignalTier,
  context: PositionUpdateContext,
): Promise<void> {
  let position: AlpacaPosition;
  try {
    position = await alpaca.getPosition(symbol);
  } catch {
    if (!journalManager.hasOpenTrade(symbol)) return;
    if (!externalExitNotified.has(symbol)) {
      externalExitNotified.add(symbol);
      void sendTelegramAlert(formatExitAlert(symbol, 'Stop Loss / Trailing Stop'));
    }
    return;
  }

  const entryPrice = parseFloat(position.avg_entry_price);
  const totalQty = parseInt(position.qty, 10);
  if (totalQty <= 0) return;

  const unrealizedPct = (currentPrice - entryPrice) / entryPrice;
  const estNow = getESTDate();
  const { bar1m, oneMinBars, atrAtEntry } = context;

  // C — RSI Overbought (full exit)
  if (unrealizedPct > config.risk.smartExitMinPnlPct) {
    const closes = oneMinBars.map(b => b.close);
    const rsi = computeRsi(closes);
    if (rsi !== null && rsi > config.risk.smartExitRsiThreshold) {
      await executeFullMarketExit(symbol, position, 'rsi-overbought-exit', 'RSI_OVERBOUGHT_EXIT');
      return;
    }
  }

  // D — Volume Exhaustion (hyper-tight trailing)
  if (unrealizedPct > config.risk.volumeExhaustionMinPnlPct) {
    const vma10 = computeVma10(oneMinBars.slice(0, -1));
    if (vma10 !== null && vma10 > 0) {
      const isExhausted = bar1m.volume < vma10 * config.risk.volumeExhaustionVmaRatio;
      const streak = isExhausted ? (volumeExhaustionStreak.get(symbol) ?? 0) + 1 : 0;
      volumeExhaustionStreak.set(symbol, streak);

      if (
        streak >= config.risk.volumeExhaustionConsecutiveBars &&
        !volumeExhaustionTrailApplied.has(symbol)
      ) {
        await applyTightTrailing(
          symbol,
          config.risk.volumeExhaustionTrailPct,
          'VOLUME_EXHAUSTION_TRAILING',
          volumeExhaustionTrailApplied,
        );
      }
    }
  } else {
    volumeExhaustionStreak.set(symbol, 0);
  }

  if (scaledOutPositions.has(symbol)) return;

  // B — Afternoon time-decay: no fixed TP, trail once PnL > +1.5%
  const decayWindow = resolveTimeDecayWindow(estNow);
  if (
    decayWindow === 'afternoon' &&
    unrealizedPct >= config.risk.timeDecayAfternoonMinPnlPct
  ) {
    await applyTightTrailing(
      symbol,
      config.risk.timeDecayAfternoonTrailPct,
      'Time-Decay afternoon trail',
      afternoonTrailApplied,
    );
    return;
  }

  // A — ATR dynamic TP (with time-decay halving) then fixed 5%/7% fallback
  const atr = atrAtEntry;
  if (atr === null || atr <= 0) return;

  const targetPct = resolveEffectiveTargetPct(atr, entryPrice, tier, estNow);
  if (targetPct === null || unrealizedPct < targetPct) return;

  const sellQty = Math.floor(totalQty / 2);
  if (sellQty < 1) return;

  const tierLabel: 'Core' | 'Satellite' = tier === 'satellite' ? 'Satellite' : 'Core';

  try {
    await trader.executeBreakEvenScaleOut(
      symbol,
      sellQty,
      entryPrice,
      targetPct,
      tierLabel,
    );
    scaledOutPositions.add(symbol);

    const fixedTarget = tier === 'satellite'
      ? config.risk.scaleOutTargetPctSatellite
      : config.risk.scaleOutTargetPctCore;
    const atrTargetPct = (config.risk.atrTakeProfitMultiplier * atr) / entryPrice;
    const scaleOutReason = atrTargetPct <= fixedTarget
      ? 'target-atr' as const
      : (tier === 'satellite' ? 'target-7pct' as const : 'target-5pct' as const);
    const scaleOutPrice = parseFloat((entryPrice * (1 + targetPct)).toFixed(2));
    journalManager.recordScaleOut(symbol, scaleOutReason, scaleOutPrice, sellQty);
  } catch (err) {
    log.error(`${symbol}: dynamic scale-out failed — ${toErrorMessage(err)}`);
  }
}

