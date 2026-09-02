import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBarToVwap,
  computeVwap,
  emptyVwapAccumulator,
  removeBarFromVwap,
  typicalPrice,
  vwapFromAccumulator,
} from '../src/sessionVwap';

const a = { high: 10, low: 8, close: 9, volume: 100 };
const b = { high: 12, low: 10, close: 11, volume: 300 };

describe('session VWAP accumulator', () => {
  it('matches a full-bar computeVwap after sequential adds', () => {
    let acc = emptyVwapAccumulator();
    acc = addBarToVwap(acc, a);
    acc = addBarToVwap(acc, b);
    assert.equal(vwapFromAccumulator(acc), computeVwap([a, b]));
  });

  it('replacing the last bar does not double-count', () => {
    const first = { high: 10, low: 8, close: 9, volume: 100 };
    const revised = { high: 10, low: 8, close: 9.5, volume: 140 };
    let acc = addBarToVwap(emptyVwapAccumulator(), first);
    acc = addBarToVwap(removeBarFromVwap(acc, first), revised);
    assert.equal(vwapFromAccumulator(acc), computeVwap([revised]));
  });

  it('returns null on empty or zero-volume history', () => {
    assert.equal(computeVwap([]), null);
    assert.equal(computeVwap([{ high: 1, low: 1, close: 1, volume: 0 }]), null);
    assert.equal(typicalPrice(a), 9);
  });
});
