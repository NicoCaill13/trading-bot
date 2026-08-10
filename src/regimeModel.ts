/**
 * Morning market-regime assessment (#9).
 * Heuristic classifier (RF/XGBoost-compatible port) + VIX volatility scaling.
 * No broker coupling — riskManager consumes RegimeRiskScaler only.
 *
 * Alpaca I/O is lazy-loaded so pure unit tests do not require credentials.
 */
import config from './config';
import { createLogger } from './logger';
import { computeAdrPct } from './screenerMath';
import { getESTDate, nyWallTimeToUtc, toErrorMessage } from './utils';
import type {
  MarketRegime,
  RegimeFeatures,
  RegimeRiskScaler,
  RegimeSnapshot,
} from './types';

const log = createLogger('REGIME');

async function getAlpacaClient(): Promise<typeof import('./alpacaClient').default> {
  const mod = await import('./alpacaClient');
  return mod.default;
}

export interface RegimeClassifier {
  classify(features: RegimeFeatures): MarketRegime;
}

export interface VixProvider {
  getLastVix(): Promise<number | null>;
}

export interface RegimeMarketDataPort {
  getSpyAdr14d(): Promise<number | null>;
  getPremarketGlobalVolumeProxy(): Promise<number | null>;
}

export interface HeuristicThresholds {
  choppySpyAdrPct: number;
  choppyVixMin: number;
}

export interface RegimeScalingInput {
  regime: MarketRegime;
  vixLast: number | null;
  baseRiskPerTradePct: number;
  baseMinRiskRewardRatio: number;
  vixRiskHalveThreshold: number;
  choppyRr: number;
}

let currentSnapshot: RegimeSnapshot | null = null;

/**
 * Deterministic stand-in for a morning RF/XGBoost model.
 * Missing VIX or SPY ADR → UNKNOWN; high ADR + elevated VIX → CHOPPY; else TRENDING.
 */
export class HeuristicRegimeClassifier implements RegimeClassifier {
  constructor(private readonly thresholds: HeuristicThresholds) {}

  classify(features: RegimeFeatures): MarketRegime {
    const { vixLast, spyAdr14d } = features;
    if (vixLast === null || spyAdr14d === null) return 'UNKNOWN';
    if (
      spyAdr14d >= this.thresholds.choppySpyAdrPct &&
      vixLast >= this.thresholds.choppyVixMin
    ) {
      return 'CHOPPY';
    }
    return 'TRENDING';
  }
}

/** Pure risk / R:R mapping from regime + VIX (table-tested). */
export function resolveRegimeScaling(input: RegimeScalingInput): {
  effectiveRiskPerTradePct: number;
  minRiskRewardRatio: number;
} {
  const riskHalved =
    input.vixLast !== null && input.vixLast > input.vixRiskHalveThreshold;
  const effectiveRiskPerTradePct = riskHalved
    ? input.baseRiskPerTradePct / 2
    : input.baseRiskPerTradePct;

  const minRiskRewardRatio =
    input.regime === 'CHOPPY' ? input.choppyRr : input.baseMinRiskRewardRatio;

  return { effectiveRiskPerTradePct, minRiskRewardRatio };
}

export function buildRegimeSnapshot(params: {
  features: RegimeFeatures;
  regime: MarketRegime;
  predictedAt: string;
  applied: boolean;
  baseRiskPerTradePct: number;
  baseMinRiskRewardRatio: number;
  vixRiskHalveThreshold: number;
  choppyRr: number;
}): RegimeSnapshot {
  const scaling = resolveRegimeScaling({
    regime: params.regime,
    vixLast: params.features.vixLast,
    baseRiskPerTradePct: params.baseRiskPerTradePct,
    baseMinRiskRewardRatio: params.baseMinRiskRewardRatio,
    vixRiskHalveThreshold: params.vixRiskHalveThreshold,
    choppyRr: params.choppyRr,
  });

  return {
    regime: params.regime,
    features: params.features,
    effectiveRiskPerTradePct: scaling.effectiveRiskPerTradePct,
    minRiskRewardRatio: scaling.minRiskRewardRatio,
    predictedAt: params.predictedAt,
    applied: params.applied,
  };
}

interface YahooChartPayload {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number };
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>;
      };
    }>;
  };
}

function parseYahooVixLast(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const chart = (payload as YahooChartPayload).chart;
  const result = chart?.result?.[0];
  if (!result) return null;

  const metaPrice = result.meta?.regularMarketPrice;
  if (typeof metaPrice === 'number' && Number.isFinite(metaPrice) && metaPrice > 0) {
    return metaPrice;
  }

  const closes = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) return null;
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

/** Native HTTPS Yahoo ^VIX — returns null on any failure (graceful degrade). */
export class YahooVixProvider implements VixProvider {
  constructor(private readonly url: string = config.regime.vixYahooUrl) {}

  async getLastVix(): Promise<number | null> {
    try {
      const res = await fetch(this.url, {
        headers: { 'User-Agent': 'trading-bot/1.0 (regime-model)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log.warn(`VIX fetch HTTP ${res.status}`);
        return null;
      }
      const json: unknown = await res.json();
      return parseYahooVixLast(json);
    } catch (err: unknown) {
      log.warn(`VIX fetch failed — ${toErrorMessage(err)}`);
      return null;
    }
  }
}

async function fetchDailyOhlc(
  symbol: string,
  limit: number,
): Promise<Array<{ high: number; low: number; close: number }>> {
  const alpaca = await getAlpacaClient();
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(limit * 1.6) + 1);

  const bars: Array<{ high: number; low: number; close: number }> = [];
  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    timeframe: '1Day',
    feed: 'iex',
  });

  for await (const bar of iter) {
    bars.push({
      high: bar.HighPrice,
      low: bar.LowPrice,
      close: bar.ClosePrice,
    });
  }
  return bars.slice(-limit);
}

async function fetchPremarketShareVolume(symbol: string): Promise<number> {
  const alpaca = await getAlpacaClient();
  const estDay = getESTDate();
  const start = nyWallTimeToUtc(estDay, 4, 0);
  const end = nyWallTimeToUtc(estDay, 9, 30);

  let sum = 0;
  const iter = alpaca.getBarsV2(symbol, {
    start: start.toISOString(),
    end: end.toISOString(),
    timeframe: '1Min',
    feed: 'iex',
  });

  for await (const bar of iter) {
    const ts = new Date(bar.Timestamp).getTime();
    if (ts >= end.getTime() || ts < start.getTime()) continue;
    sum += bar.Volume;
  }
  return sum;
}

/** Alpaca-backed features: SPY ADR 14d + SPY+QQQ premarket volume proxy. */
export class AlpacaRegimeMarketDataPort implements RegimeMarketDataPort {
  async getSpyAdr14d(): Promise<number | null> {
    const lookback = config.screener.adrLookbackDays;
    const bars = await fetchDailyOhlc('SPY', lookback);
    return computeAdrPct(bars, lookback);
  }

  async getPremarketGlobalVolumeProxy(): Promise<number | null> {
    try {
      const [spyVol, qqqVol] = await Promise.all([
        fetchPremarketShareVolume('SPY'),
        fetchPremarketShareVolume('QQQ'),
      ]);
      return spyVol + qqqVol;
    } catch (err: unknown) {
      log.warn(`Premarket volume proxy failed — ${toErrorMessage(err)}`);
      return null;
    }
  }
}

export async function collectRegimeFeatures(
  vix: VixProvider,
  market: RegimeMarketDataPort,
): Promise<RegimeFeatures> {
  const [vixLast, spyAdr14d, premarketGlobalVolumeProxy] = await Promise.all([
    vix.getLastVix(),
    market.getSpyAdr14d(),
    market.getPremarketGlobalVolumeProxy(),
  ]);
  return { vixLast, spyAdr14d, premarketGlobalVolumeProxy };
}

/**
 * Runs morning inference, stores snapshot, returns it.
 * When disabled: no-op snapshot with nominal sizing (applied=false).
 * When shadow: predicts + logs but sizing getters stay on config defaults.
 */
export async function runMorningRegimeAssessment(deps?: {
  vix?: VixProvider;
  market?: RegimeMarketDataPort;
  classifier?: RegimeClassifier;
  nowIso?: string;
}): Promise<RegimeSnapshot> {
  const predictedAt = deps?.nowIso ?? new Date().toISOString();
  const baseRisk = config.risk.riskPerTradePct;
  const baseRr = config.risk.minRiskRewardRatio;

  if (!config.regime.enabled) {
    const features: RegimeFeatures = {
      vixLast: null,
      spyAdr14d: null,
      premarketGlobalVolumeProxy: null,
    };
    const snap = buildRegimeSnapshot({
      features,
      regime: 'UNKNOWN',
      predictedAt,
      applied: false,
      baseRiskPerTradePct: baseRisk,
      baseMinRiskRewardRatio: baseRr,
      vixRiskHalveThreshold: config.regime.vixRiskHalveThreshold,
      choppyRr: config.regime.choppyRr,
    });
    currentSnapshot = snap;
    log.info('REGIME_MODEL_ENABLED=false — nominal V7 risk/RR (no inference)');
    return snap;
  }

  const vix = deps?.vix ?? new YahooVixProvider();
  const market = deps?.market ?? new AlpacaRegimeMarketDataPort();
  const classifier =
    deps?.classifier ??
    new HeuristicRegimeClassifier({
      choppySpyAdrPct: config.regime.choppySpyAdrPct,
      choppyVixMin: config.regime.choppyVixMin,
    });

  let features: RegimeFeatures;
  try {
    features = await collectRegimeFeatures(vix, market);
  } catch (err: unknown) {
    log.error(`Feature collection failed — ${toErrorMessage(err)}`);
    features = {
      vixLast: null,
      spyAdr14d: null,
      premarketGlobalVolumeProxy: null,
    };
  }

  const regime = classifier.classify(features);
  const applied = !config.regime.shadow;
  const snap = buildRegimeSnapshot({
    features,
    regime,
    predictedAt,
    applied,
    baseRiskPerTradePct: baseRisk,
    baseMinRiskRewardRatio: baseRr,
    vixRiskHalveThreshold: config.regime.vixRiskHalveThreshold,
    choppyRr: config.regime.choppyRr,
  });
  currentSnapshot = snap;

  const vixStr = features.vixLast === null ? 'n/a' : features.vixLast.toFixed(2);
  const adrStr =
    features.spyAdr14d === null ? 'n/a' : `${features.spyAdr14d.toFixed(2)}%`;
  const pmStr =
    features.premarketGlobalVolumeProxy === null
      ? 'n/a'
      : features.premarketGlobalVolumeProxy.toLocaleString('en-US');

  log.info(
    `regime=${regime} applied=${applied} ` +
      `VIX=${vixStr} SPY_ADR14=${adrStr} PM_vol_proxy=${pmStr} | ` +
      `risk=${(snap.effectiveRiskPerTradePct * 100).toFixed(2)}% ` +
      `RR=${snap.minRiskRewardRatio}` +
      (config.regime.shadow ? ' (SHADOW — sizing unchanged)' : ''),
  );

  return snap;
}

export function getLastRegimeSnapshot(): RegimeSnapshot | null {
  return currentSnapshot;
}

/** Test / boot helper — clears morning state. */
export function resetRegimeSnapshotForTests(): void {
  currentSnapshot = null;
}

/** Test helper — inject a snapshot without running I/O. */
export function setRegimeSnapshotForTests(snap: RegimeSnapshot | null): void {
  currentSnapshot = snap;
}

function shouldApplySnapshot(snap: RegimeSnapshot | null): boolean {
  return snap !== null && snap.applied;
}

export function getEffectiveRiskPerTradePct(): number {
  const snap = currentSnapshot;
  if (shouldApplySnapshot(snap) && snap !== null) {
    return snap.effectiveRiskPerTradePct;
  }
  return config.risk.riskPerTradePct;
}

export function getMinRiskRewardRatio(): number {
  const snap = currentSnapshot;
  if (shouldApplySnapshot(snap) && snap !== null) {
    return snap.minRiskRewardRatio;
  }
  return config.risk.minRiskRewardRatio;
}

export function getRegime(): MarketRegime {
  const snap = currentSnapshot;
  if (shouldApplySnapshot(snap) && snap !== null) {
    return snap.regime;
  }
  return 'UNKNOWN';
}

/** DIP adapter for riskManager injection / tests. */
export function getRegimeRiskScaler(): RegimeRiskScaler {
  return {
    getEffectiveRiskPerTradePct,
    getMinRiskRewardRatio,
    getRegime,
  };
}
