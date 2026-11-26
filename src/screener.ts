import fs from 'fs/promises';
import path from 'path';
import type { AlpacaBar } from '@alpacahq/alpaca-trade-api';
import alpaca from './alpacaClient';
import config from './config';
import { applySplits, loadSplitIndex, type SplitIndex } from './corporateActions';
import { fetchDailyBars, type DailyBar } from './dailyBars';
import { readEodBars, writeEodBars } from './eodCache';
import { createLogger } from './logger';
import { queryRequiredWatchlistTradingDay } from './marketCalendar';
import { assessIndexRegime, combineRegimes } from './marketRegime';
import { createNewsProvider } from './newsProvider';
import { alertInfo } from './notifier';
import { detectEpisodicPivot } from './patterns/episodicPivot';
import { detectCupAndHandle, detectFlatBase, detectKullamagiFlag } from './patterns/continuation';
import { detectEtei, detectWyckoffSpring } from './patterns/reversal';
import { detectVcp } from './patterns/vcp';
import type { ContinuationOpts } from './patterns/continuation';
import type { PivotStateOpts } from './patterns/bars';
import type { VcpOpts } from './patterns/vcp';
import { assignRsRatings, distanceFromHigh52w, momentumScore } from './relativeStrength';
import { formatSwingAlert, formatSwingReport } from './reportFormatter';
import { computeAdrPct, isAllowedExchange, isEtfLikeProduct, passesAdrGate } from './screenerMath';
import { assessStrictBullishCatalyst } from './sentiment';
import { buildTheoreticalPlan, scoreSetup } from './swingScoring';
import { assessTrendTemplate } from './trendTemplate';
import {
  aggregateWeeklyBars,
  assessWeeklyStructure,
  evaluateWeeklyClearance,
} from './weeklyStructure';
import { writeJsonAtomic } from './jsonStore';
import { clampQueryEnd, estCalendarDayKey, nyWallTimeToUtc, toErrorMessage, toESTDate } from './utils';
import type {
  DatedDailyBar,
  FunnelStats,
  PriceBar,
  StudyCard,
  SwingSetup,
  SwingStudyReport,
  WeeklyAssessment,
} from './types';

const log = createLogger('SCREENER');
const newsProvider = createNewsProvider();
const CALENDAR_DAYS_PER_SESSION = 1.75;

export interface UniverseAsset {
  symbol: string;
  exchange: string;
}

export async function getDynamicUniverseAssets(): Promise<UniverseAsset[]> {
  log.info('Fetching dynamic universe from Alpaca...');
  const assets = await alpaca.getAssets({ status: 'active', asset_class: 'us_equity' });
  const filtered: UniverseAsset[] = [];

  for (const asset of assets) {
    if (!asset.tradable) continue;
    if (asset.symbol.includes('.') || asset.symbol.includes('/')) continue;
    if (!isAllowedExchange(asset.exchange ?? '', config.universe.allowedExchanges)) continue;
    if (isEtfLikeProduct({ name: asset.name, attributes: asset.attributes })) continue;
    filtered.push({ symbol: asset.symbol, exchange: asset.exchange });
  }

  log.info(`Universe ${filtered.length} common stocks (from ${assets.length} assets)`);
  return filtered;
}

export async function getDynamicUniverse(): Promise<string[]> {
  const assets = await getDynamicUniverseAssets();
  return assets.map(asset => asset.symbol);
}

function parseNyDay(day: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) throw new Error(`[SCREENER] Invalid trading day ${day}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function shiftDays(day: string, delta: number): string {
  const date = parseNyDay(day);
  date.setDate(date.getDate() + delta);
  return estCalendarDayKey(date);
}

function toAlpacaBar(symbol: string, bar: DailyBar): AlpacaBar {
  return {
    Symbol: symbol,
    Timestamp: bar.t,
    OpenPrice: bar.o,
    HighPrice: bar.h,
    LowPrice: bar.l,
    ClosePrice: bar.c,
    Volume: bar.v,
    VWAP: bar.c,
    TradeCount: 0,
  } as AlpacaBar;
}

function toPriceBars(bars: readonly AlpacaBar[]): PriceBar[] {
  return bars.map(bar => ({
    open: bar.OpenPrice,
    high: bar.HighPrice,
    low: bar.LowPrice,
    close: bar.ClosePrice,
    volume: bar.Volume,
  }));
}

function toDatedDailyBars(bars: readonly AlpacaBar[]): DatedDailyBar[] {
  return bars.map(bar => ({
    day: barSessionDay(bar.Timestamp),
    open: bar.OpenPrice,
    high: bar.HighPrice,
    low: bar.LowPrice,
    close: bar.ClosePrice,
    volume: bar.Volume,
  }));
}

function barSessionDay(timestamp: string): string {
  return estCalendarDayKey(toESTDate(new Date(timestamp)));
}

function endsOn(bars: readonly AlpacaBar[], tradingDay: string): boolean {
  const last = bars[bars.length - 1];
  return last !== undefined && barSessionDay(last.Timestamp) === tradingDay;
}

function averageDollarVolume(bars: readonly PriceBar[], days: number): number | null {
  if (bars.length < days) return null;
  const slice = bars.slice(-days);
  let sum = 0;
  for (const bar of slice) sum += bar.close * bar.volume;
  return sum / days;
}

function pivotStateOpts(): PivotStateOpts {
  const p = config.patterns;
  return {
    maxDistanceBelowPct: p.maxDistanceBelowPct,
    maxExtensionPct: p.maxExtensionPct,
    minBreakoutRvol: p.minBreakoutRvol,
    rvolAvgDays: p.rvolAvgDays,
  };
}

function continuationOpts(): ContinuationOpts {
  const p = config.patterns;
  return {
    ...pivotStateOpts(),
    cupMinBars: p.cupMinBars,
    cupMaxBars: p.cupMaxBars,
    cupMinDepthPct: p.cupMinDepthPct,
    cupMaxDepthPct: p.cupMaxDepthPct,
    handleMinBars: p.handleMinBars,
    handleMaxBars: p.handleMaxBars,
    handleMaxRetracePct: p.handleMaxRetracePct,
    flagImpulseMinPct: p.flagImpulseMinPct,
    flagImpulseMaxBars: p.flagImpulseMaxBars,
    flagMinBars: p.flagMinBars,
    flagMaxBars: p.flagMaxBars,
    flagVolDryUpRatio: p.flagVolDryUpRatio,
    flagAdrRiskMultiple: p.flagAdrRiskMultiple,
    adrLookbackDays: config.universe.adrLookbackDays,
    flatBaseBars: p.flatBaseBars,
    flatBaseAtrShort: p.flatBaseAtrShort,
    flatBaseAtrRef: p.flatBaseAtrRef,
    flatBaseAtrCompressionRatio: p.flatBaseAtrCompressionRatio,
    flatBaseMaxRangePct: p.flatBaseMaxRangePct,
    maxRiskPct: p.maxRiskPct,
  };
}

function vcpOpts(): VcpOpts {
  const p = config.patterns;
  return {
    ...pivotStateOpts(),
    swingWing: p.swingWing,
    minBaseBars: p.vcpMinBaseBars,
    maxBaseBars: p.vcpMaxBaseBars,
    minContractions: p.vcpMinContractions,
    maxContractions: p.vcpMaxContractions,
    contractionRatio: p.vcpContractionRatio,
    maxLastContraction: p.vcpMaxLastContraction,
    dryUpRatio: p.vcpDryUpRatio,
    dryUpLookback: 50,
  };
}

function detectChartSetup(bars: readonly PriceBar[]): SwingSetup | null {
  const reversal = {
    swingWing: config.patterns.swingWing,
    springReclaimRvol: config.patterns.minBreakoutRvol,
    springSupportTolerancePct: 0.005,
    eteiBreakoutRvol: config.patterns.minBreakoutRvol,
    rvolAvgDays: config.patterns.rvolAvgDays,
    maxAgeBars: config.patterns.reversalMaxAgeBars,
    maxExtensionPct: config.patterns.maxExtensionPct,
  };
  return (
    detectVcp(bars, vcpOpts()) ??
    detectCupAndHandle(bars, continuationOpts()) ??
    detectKullamagiFlag(bars, continuationOpts()) ??
    detectFlatBase(bars, continuationOpts()) ??
    detectWyckoffSpring(bars, reversal) ??
    detectEtei(bars, reversal)
  );
}

function tradingViewUrl(exchange: string, symbol: string): string {
  const venue = exchange.toUpperCase() === 'NYSE' ? 'NYSE' : 'NASDAQ';
  return `https://www.tradingview.com/chart/?symbol=${venue}:${encodeURIComponent(symbol)}`;
}

async function loadAdjustedSeries(
  symbols: readonly string[],
  tradingDay: string,
  startDay: string,
  splits: SplitIndex,
): Promise<Map<string, AlpacaBar[]>> {
  const out = new Map<string, AlpacaBar[]>();
  const missing: string[] = [];

  for (const symbol of symbols) {
    const cached = await readEodBars(tradingDay, symbol, startDay, splits.mode);
    if (cached !== null && cached.length > 0) out.set(symbol, cached);
    else missing.push(symbol);
  }

  if (missing.length === 0) return out;

  const start = nyWallTimeToUtc(parseNyDay(startDay), 0, 0);
  const end = clampQueryEnd(
    nyWallTimeToUtc(parseNyDay(shiftDays(tradingDay, 1)), 0, 0),
    config.alpaca.dataFeed,
    config.alpaca.sipDelayMs,
  );
  log.info(`Fetching ${missing.length} daily series (${startDay} → ${tradingDay})`);
  const raw = await fetchDailyBars(
    missing,
    start,
    end,
    config.alpaca.dataFeed,
    splits.mode === 'own' ? 'raw' : 'split',
  );

  for (const symbol of missing) {
    const series = raw.get(symbol) ?? [];
    const alpacaBars = series
      .map(bar => toAlpacaBar(symbol, bar))
      .filter(bar => {
        const day = barSessionDay(bar.Timestamp);
        return day >= startDay && day <= tradingDay;
      })
      .sort((a, b) => a.Timestamp.localeCompare(b.Timestamp));
    const adjusted = splits.mode === 'own'
      ? applySplits(alpacaBars, splits.getSplits(symbol))
      : alpacaBars;
    if (adjusted.length > 0) {
      await writeEodBars(tradingDay, symbol, startDay, splits.mode, adjusted);
      out.set(symbol, adjusted);
    }
  }

  return out;
}

function emptyFunnel(universe: number): FunnelStats {
  return {
    universe,
    liquid: 0,
    adrPass: 0,
    templatePass: 0,
    weeklyTrendPass: 0,
    chartSetups: 0,
    episodicCandidates: 0,
    episodicPass: 0,
    rejectedOverheadSupply: 0,
    rejectedWideRisk: 0,
    published: 0,
  };
}

interface Draft {
  card: StudyCard;
  headline: string | null;
}

function tryPublish(
  symbol: string,
  exchange: string,
  bars: readonly PriceBar[],
  weekly: WeeklyAssessment | null,
  setup: SwingSetup,
  rsRating: number | null,
  adr: number,
  funnel: FunnelStats,
): Draft | null {
  const close = bars[bars.length - 1].close;
  const plan = buildTheoreticalPlan(
    setup,
    close,
    config.referenceSizing.capitalUsd,
    config.referenceSizing.riskPerTradePct,
    config.referenceSizing.maxPositionPct,
  );
  if (plan === null || plan.riskPct > config.patterns.maxRiskPct) {
    funnel.rejectedWideRisk++;
    return null;
  }

  const clearance = weekly
    ? evaluateWeeklyClearance(weekly, plan.entry, setup.stop, config.weekly.overheadBufferPct)
    : null;
  if (
    clearance !== null &&
    !clearance.blueSky &&
    clearance.roomToResistanceR !== null &&
    clearance.roomToResistanceR < config.weekly.minRoomToResistanceR
  ) {
    funnel.rejectedOverheadSupply++;
    return null;
  }

  const highs = bars.map(bar => bar.high);
  const distance = distanceFromHigh52w(highs, close, config.trendTemplate.weekSessions);
  const scored = scoreSetup({
    rsRating,
    setup,
    riskPct: plan.riskPct,
    adrPct: adr,
    distanceFromHigh52wPct: distance,
    weekly,
    clearance,
  });
  const template = assessTrendTemplate(bars, rsRating ?? 0, config.trendTemplate);

  return {
    headline: null,
    card: {
      symbol,
      exchange,
      pattern: setup.pattern,
      state: setup.state,
      grade: scored.grade,
      masterScore: scored.masterScore,
      close,
      pivot: setup.pivot,
      stop: setup.stop,
      riskPct: plan.riskPct,
      entry: plan.entry,
      target2r: plan.target2r,
      target3r: plan.target3r,
      referenceQty: plan.qty,
      rsRating,
      adrPct: adr,
      rvol: setup.rvol,
      distanceFromHigh52wPct: distance,
      ema10: template?.ema10 ?? null,
      ema20: template?.ema20 ?? null,
      sma50: template?.sma50 ?? null,
      weeklyStage: weekly?.stage ?? null,
      sma10w: weekly?.sma10w ?? null,
      sma30w: weekly?.sma30w ?? null,
      sma40w: weekly?.sma40w ?? null,
      weeklyMaAligned: weekly?.maAligned ?? false,
      tightWeeksCount: weekly?.tightWeeksCount ?? 0,
      weeklySupport: clearance?.nearestSupport?.price ?? null,
      weeklyResistance: clearance?.nearestResistance?.price ?? null,
      weeklyBlueSky: clearance?.blueSky ?? true,
      roomToResistanceR: clearance?.roomToResistanceR ?? null,
      thesis: setup.thesis,
      catalystHeadline: null,
      tradingViewUrl: tradingViewUrl(exchange, symbol),
    },
  };
}

async function attachCatalysts(drafts: Draft[], tradingDay: string): Promise<StudyCard[]> {
  const lookbackMs = config.episodicPivot.newsLookbackHours * 60 * 60 * 1000;
  const end = nyWallTimeToUtc(parseNyDay(shiftDays(tradingDay, 1)), 12, 0);
  const start = new Date(end.getTime() - lookbackMs);
  const cards: StudyCard[] = [];
  const concurrency = config.sentiment.fetchConcurrency;

  for (let i = 0; i < drafts.length; i += concurrency) {
    const batch = drafts.slice(i, i + concurrency);
    const resolved = await Promise.all(batch.map(async draft => {
      if (draft.card.pattern !== 'EPISODIC_PIVOT') return draft.card;
      try {
        const headlines = await newsProvider.getHeadlines(draft.card.symbol, start, end);
        const assessment = assessStrictBullishCatalyst(headlines);
        if (!assessment.passes) return null;
        return {
          ...draft.card,
          catalystHeadline: assessment.catalystHeadline,
          thesis: `${draft.card.thesis}. ${assessment.catalystHeadline ?? ''}`.trim(),
        };
      } catch (err) {
        log.warn(`${draft.card.symbol} episodic pivot dropped — news: ${toErrorMessage(err)}`);
        return null;
      }
    }));
    for (const card of resolved) {
      if (card !== null) cards.push(card);
    }
  }
  return cards;
}

export async function runSwingScan(asOfTradingDay?: string): Promise<SwingStudyReport> {
  const tradingDay = asOfTradingDay ?? await queryRequiredWatchlistTradingDay();
  if (tradingDay === null) {
    throw new Error('[SCREENER] Cannot resolve a trading day');
  }

  const startDay = shiftDays(
    tradingDay,
    -Math.ceil(config.universe.historySessions * CALENDAR_DAYS_PER_SESSION),
  );
  const assets = await getDynamicUniverseAssets();
  const exchangeBySymbol = new Map(assets.map(asset => [asset.symbol, asset.exchange]));
  const symbols = [
    ...config.universe.benchmarks,
    ...assets.map(asset => asset.symbol),
  ];
  const splits = await loadSplitIndex(startDay, tradingDay);
  const series = await loadAdjustedSeries(symbols, tradingDay, startDay, splits);

  const regimes = config.universe.benchmarks
    .map(symbol => {
      const bars = series.get(symbol);
      if (bars === undefined) return null;
      const dailyRegime = assessIndexRegime(symbol, toPriceBars(bars), {
        ...config.regime,
        sma50Period: config.trendTemplate.sma50Period,
        sma200Period: config.trendTemplate.sma200Period,
        sma50SlopeBars: config.trendTemplate.sma200SlopeBars,
      });
      if (dailyRegime === null) return null;
      const weeks = aggregateWeeklyBars(toDatedDailyBars(bars));
      const weekly = assessWeeklyStructure(weeks, config.weekly);
      return {
        ...dailyRegime,
        weeklyStage: weekly?.stage ?? null,
        sma10w: weekly?.sma10w ?? null,
        sma30w: weekly?.sma30w ?? null,
      };
    })
    .filter((regime): regime is NonNullable<typeof regime> => regime !== null);
  const combined = combineRegimes(regimes);

  const funnel = emptyFunnel(assets.length);
  const liquid: { symbol: string; bars: PriceBar[]; dated: DatedDailyBar[] }[] = [];

  for (const asset of assets) {
    const raw = series.get(asset.symbol);
    if (raw === undefined || !endsOn(raw, tradingDay)) continue;
    const bars = toPriceBars(raw);
    const last = bars[bars.length - 1];
    if (!(last.close >= config.universe.minClosePrice)) continue;
    const dollarVolume = averageDollarVolume(bars, config.universe.dollarVolumeDays);
    if (dollarVolume === null || dollarVolume < config.universe.minDollarVolume) continue;
    liquid.push({ symbol: asset.symbol, bars, dated: toDatedDailyBars(raw) });
  }
  funnel.liquid = liquid.length;

  const scored = liquid.flatMap(entry => {
    const score = momentumScore(entry.bars.map(bar => bar.close));
    return score === null ? [] : [{ symbol: entry.symbol, score }];
  });
  const ratings = assignRsRatings(scored);

  const drafts: Draft[] = [];
  for (const entry of liquid) {
    const adr = computeAdrPct(
      entry.bars.map(bar => ({ high: bar.high, low: bar.low, close: bar.close })),
      config.universe.adrLookbackDays,
    );
    if (adr === null || !passesAdrGate(adr, config.universe.minAdrPct)) continue;
    funnel.adrPass++;

    const weeks = aggregateWeeklyBars(entry.dated);
    const weekly = assessWeeklyStructure(weeks, config.weekly);

    const rs = ratings.get(entry.symbol) ?? null;
    const template = rs === null
      ? null
      : assessTrendTemplate(entry.bars, rs, config.trendTemplate);
    if (template?.passed) {
      funnel.templatePass++;
      if (weekly !== null && weekly.stage === 'STAGE_2') {
        funnel.weeklyTrendPass++;
        const setup = detectChartSetup(entry.bars);
        if (setup !== null) {
          funnel.chartSetups++;
          const draft = tryPublish(
            entry.symbol,
            exchangeBySymbol.get(entry.symbol) ?? 'NASDAQ',
            entry.bars,
            weekly,
            setup,
            rs,
            adr,
            funnel,
          );
          if (draft !== null) drafts.push(draft);
        }
      }
    }

    const episodic = detectEpisodicPivot(entry.bars, config.episodicPivot);
    if (episodic !== null) {
      // Reject episodic gaps trapped below a Stage 4 weekly 30-week MA.
      if (weekly !== null && weekly.close <= weekly.sma30w) continue;
      funnel.episodicCandidates++;
      const draft = tryPublish(
        entry.symbol,
        exchangeBySymbol.get(entry.symbol) ?? 'NASDAQ',
        entry.bars,
        weekly,
        episodic,
        rs,
        adr,
        funnel,
      );
      if (draft !== null) {
        funnel.episodicPass++;
        drafts.push(draft);
      }
    }
  }

  const cards = (await attachCatalysts(drafts, tradingDay))
    .sort((a, b) => b.masterScore - a.masterScore || a.symbol.localeCompare(b.symbol));
  funnel.published = cards.length;
  funnel.episodicPass = cards.filter(card => card.pattern === 'EPISODIC_PIVOT').length;

  const spy = series.get('SPY');
  let benchmarkReturn: number | null = null;
  if (spy !== undefined && spy.length > 21) {
    const last = spy[spy.length - 1].ClosePrice;
    const past = spy[spy.length - 21].ClosePrice;
    if (past > 0) benchmarkReturn = last / past - 1;
  }

  const report: SwingStudyReport = {
    generatedAt: new Date().toISOString(),
    tradingDay,
    benchmarkReturn,
    universeSize: assets.length,
    liquidFiltered: funnel.liquid,
    symbols: cards.map(card => ({ symbol: card.symbol, origin: 'V1_CORE' as const })),
    regimes,
    combinedStatus: combined.status,
    recommendedExposurePct: combined.recommendedExposurePct,
    funnel,
    cards,
  };

  await writeJsonAtomic(path.resolve(config.paths.watchlist), report, { pretty: true });
  const reportDir = path.resolve(config.paths.reports);
  await fs.mkdir(reportDir, { recursive: true });
  const stem = path.join(reportDir, `${tradingDay}-swing-study`);
  await fs.writeFile(`${stem}.md`, formatSwingReport(report), 'utf8');
  await writeJsonAtomic(`${stem}.json`, report, { pretty: true });

  log.info(
    `Scan ${tradingDay}: published ${cards.length} ` +
    `(template ${funnel.templatePass}, weekly Stage 2 ${funnel.weeklyTrendPass}, ` +
    `episodic ${funnel.episodicPass}, overhead supply ${funnel.rejectedOverheadSupply}, ` +
    `wide stop ${funnel.rejectedWideRisk})`,
  );
  await alertInfo(`Radar swing ${tradingDay}`, formatSwingAlert(report));
  return report;
}
