import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  HeuristicRegimeClassifier,
  buildRegimeSnapshot,
  getEffectiveRiskPerTradePct,
  getMinRiskRewardRatio,
  getRegime,
  resetRegimeSnapshotForTests,
  resolveRegimeScaling,
  setRegimeSnapshotForTests,
} from './regimeModel';
import type { RegimeFeatures } from './types';

const classifier = new HeuristicRegimeClassifier({
  choppySpyAdrPct: 1.2,
  choppyVixMin: 18,
});

describe('HeuristicRegimeClassifier', () => {
  it('returns UNKNOWN when VIX or ADR missing', () => {
    assert.equal(
      classifier.classify({
        vixLast: null,
        spyAdr14d: 1.5,
        premarketGlobalVolumeProxy: 1_000_000,
      }),
      'UNKNOWN',
    );
    assert.equal(
      classifier.classify({
        vixLast: 20,
        spyAdr14d: null,
        premarketGlobalVolumeProxy: null,
      }),
      'UNKNOWN',
    );
  });

  it('returns CHOPPY when ADR and VIX both elevated', () => {
    assert.equal(
      classifier.classify({
        vixLast: 20,
        spyAdr14d: 1.5,
        premarketGlobalVolumeProxy: 500_000,
      }),
      'CHOPPY',
    );
  });

  it('returns TRENDING otherwise', () => {
    assert.equal(
      classifier.classify({
        vixLast: 14,
        spyAdr14d: 0.8,
        premarketGlobalVolumeProxy: 2_000_000,
      }),
      'TRENDING',
    );
  });
});

describe('resolveRegimeScaling (VIX / regime → risk / TP)', () => {
  const base = {
    baseRiskPerTradePct: 0.05,
    baseMinRiskRewardRatio: 2,
    vixRiskHalveThreshold: 25,
    choppyRr: 1.5,
  };

  it('halves risk when VIX > 25 (5% → 2.5%)', () => {
    const s = resolveRegimeScaling({
      ...base,
      regime: 'TRENDING',
      vixLast: 26,
    });
    assert.equal(s.effectiveRiskPerTradePct, 0.025);
    assert.equal(s.minRiskRewardRatio, 2);
  });

  it('forces R:R 1.5 when CHOPPY', () => {
    const s = resolveRegimeScaling({
      ...base,
      regime: 'CHOPPY',
      vixLast: 20,
    });
    assert.equal(s.effectiveRiskPerTradePct, 0.05);
    assert.equal(s.minRiskRewardRatio, 1.5);
  });

  it('combines CHOPPY RR with VIX risk halve', () => {
    const s = resolveRegimeScaling({
      ...base,
      regime: 'CHOPPY',
      vixLast: 30,
    });
    assert.equal(s.effectiveRiskPerTradePct, 0.025);
    assert.equal(s.minRiskRewardRatio, 1.5);
  });

  it('UNKNOWN keeps nominal RR; still halves on high VIX', () => {
    const s = resolveRegimeScaling({
      ...base,
      regime: 'UNKNOWN',
      vixLast: 28,
    });
    assert.equal(s.effectiveRiskPerTradePct, 0.025);
    assert.equal(s.minRiskRewardRatio, 2);
  });

  it('UNKNOWN without VIX stays at 5% / 2.0', () => {
    const s = resolveRegimeScaling({
      ...base,
      regime: 'UNKNOWN',
      vixLast: null,
    });
    assert.equal(s.effectiveRiskPerTradePct, 0.05);
    assert.equal(s.minRiskRewardRatio, 2);
  });
});

describe('buildRegimeSnapshot', () => {
  it('embeds features and scaling', () => {
    const features: RegimeFeatures = {
      vixLast: 26,
      spyAdr14d: 1.4,
      premarketGlobalVolumeProxy: 900_000,
    };
    const snap = buildRegimeSnapshot({
      features,
      regime: 'CHOPPY',
      predictedAt: '2026-08-10T13:15:00.000Z',
      applied: true,
      baseRiskPerTradePct: 0.05,
      baseMinRiskRewardRatio: 2,
      vixRiskHalveThreshold: 25,
      choppyRr: 1.5,
    });
    assert.equal(snap.effectiveRiskPerTradePct, 0.025);
    assert.equal(snap.minRiskRewardRatio, 1.5);
    assert.equal(snap.features.vixLast, 26);
    assert.equal(snap.applied, true);
  });
});

describe('RegimeRiskScaler getters', () => {
  beforeEach(() => {
    resetRegimeSnapshotForTests();
  });

  it('defaults to config nominal when no applied snapshot', () => {
    assert.equal(getEffectiveRiskPerTradePct(), 0.05);
    assert.equal(getMinRiskRewardRatio(), 2);
    assert.equal(getRegime(), 'UNKNOWN');
  });

  it('ignores shadow / unapplied snapshots', () => {
    setRegimeSnapshotForTests(
      buildRegimeSnapshot({
        features: {
          vixLast: 30,
          spyAdr14d: 1.5,
          premarketGlobalVolumeProxy: 1,
        },
        regime: 'CHOPPY',
        predictedAt: '2026-08-10T13:15:00.000Z',
        applied: false,
        baseRiskPerTradePct: 0.05,
        baseMinRiskRewardRatio: 2,
        vixRiskHalveThreshold: 25,
        choppyRr: 1.5,
      }),
    );
    assert.equal(getEffectiveRiskPerTradePct(), 0.05);
    assert.equal(getMinRiskRewardRatio(), 2);
    assert.equal(getRegime(), 'UNKNOWN');
  });

  it('applies risk/RR from an applied snapshot', () => {
    setRegimeSnapshotForTests(
      buildRegimeSnapshot({
        features: {
          vixLast: 30,
          spyAdr14d: 1.5,
          premarketGlobalVolumeProxy: 1,
        },
        regime: 'CHOPPY',
        predictedAt: '2026-08-10T13:15:00.000Z',
        applied: true,
        baseRiskPerTradePct: 0.05,
        baseMinRiskRewardRatio: 2,
        vixRiskHalveThreshold: 25,
        choppyRr: 1.5,
      }),
    );
    assert.equal(getEffectiveRiskPerTradePct(), 0.025);
    assert.equal(getMinRiskRewardRatio(), 1.5);
    assert.equal(getRegime(), 'CHOPPY');
  });
});
