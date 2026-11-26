import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTheoreticalPlan, scoreSetup } from '../src/swingScoring';
import { formatSwingReport } from '../src/reportFormatter';
import type { SwingSetup, SwingStudyReport } from '../src/types';

const setup: SwingSetup = {
  pattern: 'VCP',
  state: 'FORMING_AT_PIVOT',
  pivot: 50,
  stop: 47,
  rvol: 0.6,
  thesis: 'VCP test',
  volumeDryUpRatio: 0.4,
  contractionDepths: [0.2, 0.08, 0.04],
};

describe('scoreSetup', () => {
  it('scores a tight leader above a nameless base', () => {
    const strong = scoreSetup({
      rsRating: 95,
      setup,
      riskPct: 0.04,
      adrPct: 6,
      distanceFromHigh52wPct: 0.05,
    });
    const weak = scoreSetup({
      rsRating: 10,
      setup: { ...setup, volumeDryUpRatio: 1.2, contractionDepths: [] },
      riskPct: 0.07,
      adrPct: 4,
      distanceFromHigh52wPct: 0.24,
    });
    assert.ok(strong.masterScore > weak.masterScore);
    assert.ok(strong.grade === 'A+' || strong.grade === 'A');
  });
});

describe('buildTheoreticalPlan', () => {
  it('sizes from the pivot when the base has not broken out', () => {
    const plan = buildTheoreticalPlan(setup, 49, 100_000, 0.01, 0.2);
    assert.ok(plan);
    assert.equal(plan.entry, 50);
    assert.equal(plan.qty, Math.floor(1000 / 3));
    assert.equal(plan.target2r, 50 + 2 * 3);
  });

  it('returns null when the stop is not under the entry', () => {
    assert.equal(
      buildTheoreticalPlan({ ...setup, stop: 60 }, 49, 100_000, 0.01, 0.2),
      null,
    );
  });
});

describe('formatSwingReport', () => {
  it('names the regime and each published card', () => {
    const report: SwingStudyReport = {
      generatedAt: '2026-11-25T21:00:00.000Z',
      tradingDay: '2026-11-25',
      benchmarkReturn: 0.01,
      universeSize: 100,
      liquidFiltered: 10,
      symbols: [{ symbol: 'ACME', origin: 'V1_CORE' }],
      regimes: [{
        symbol: 'SPY',
        status: 'CONFIRMED_UPTREND',
        close: 500,
        sma50: 480,
        sma200: 450,
        sma50Rising: true,
        distributionDays: 2,
        recommendedExposurePct: 100,
      }],
      combinedStatus: 'CONFIRMED_UPTREND',
      recommendedExposurePct: 100,
      funnel: {
        universe: 100,
        liquid: 10,
        adrPass: 4,
        templatePass: 2,
        weeklyTrendPass: 2,
        chartSetups: 1,
        episodicCandidates: 0,
        episodicPass: 0,
        rejectedOverheadSupply: 0,
        rejectedWideRisk: 1,
        published: 1,
      },
      cards: [{
        symbol: 'ACME',
        exchange: 'NASDAQ',
        pattern: 'VCP',
        state: 'FORMING_AT_PIVOT',
        grade: 'A',
        masterScore: 72,
        close: 49,
        pivot: 50,
        stop: 47,
        riskPct: 0.06,
        entry: 50,
        target2r: 56,
        target3r: 59,
        referenceQty: 100,
        rsRating: 88,
        adrPct: 5,
        rvol: 0.5,
        distanceFromHigh52wPct: 0.04,
        ema10: 48,
        ema20: 47,
        sma50: 45,
        weeklyStage: 'STAGE_2',
        sma10w: 46,
        sma30w: 41,
        sma40w: 39,
        weeklyMaAligned: true,
        tightWeeksCount: 3,
        weeklySupport: 46,
        weeklyResistance: null,
        weeklyBlueSky: true,
        roomToResistanceR: null,
        thesis: 'three contractions',
        catalystHeadline: null,
        tradingViewUrl: 'https://www.tradingview.com/chart/?symbol=NASDAQ:ACME',
      }],
    };
    const text = formatSwingReport(report);
    assert.match(text, /ACME/);
    assert.match(text, /tendance confirmée/);
    assert.match(text, /Phase 2 \(avancée\)/);
    assert.match(text, /Voie libre \(Blue Sky\)/);
    assert.match(text, /aucun ordre/);
  });
});
