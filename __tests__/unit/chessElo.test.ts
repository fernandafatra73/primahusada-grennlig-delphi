import { describe, expect, test } from 'vitest';
import {
  ELO_AWAL_LAWAN,
  ELO_AWAL_PEMAIN,
  applyEloResult,
  eloDelta,
  expectedScore,
  initialEloState,
  parseEloState,
} from '../../apps/web/src/lib/chessElo.ts';

describe('expectedScore', () => {
  test('is 0.5 between equal ratings', () => {
    expect(expectedScore(1200, 1200)).toBe(0.5);
  });

  test('favours the higher rating', () => {
    expect(expectedScore(1600, 1200)).toBeCloseTo(0.909, 3);
    expect(expectedScore(1200, 1600)).toBeCloseTo(0.091, 3);
  });
});

describe('eloDelta', () => {
  test('moves equal players by half of K on a decisive result', () => {
    expect(eloDelta(1200, 1200, 'menang')).toEqual({ saya: 16, lawan: -16 });
    expect(eloDelta(1200, 1200, 'kalah')).toEqual({ saya: -16, lawan: 16 });
  });

  test('leaves equal players unchanged on a draw', () => {
    expect(eloDelta(1200, 1200, 'seri')).toEqual({ saya: 0, lawan: 0 });
  });

  test('rewards beating a stronger opponent more than a weaker one', () => {
    expect(eloDelta(1200, 2000, 'menang').saya).toBe(32);
    expect(eloDelta(1200, 800, 'menang').saya).toBe(3);
  });

  test('gives the weaker side points for a draw', () => {
    expect(eloDelta(1200, 1600, 'seri')).toEqual({ saya: 13, lawan: -13 });
  });
});

describe('applyEloResult', () => {
  test('updates both ratings and the win count', () => {
    const next = applyEloResult(initialEloState(), 'sedang', 'menang');
    expect(next.rating).toBe(1216);
    expect(next.lawan.sedang).toBe(1184);
    expect(next).toMatchObject({ menang: 1, kalah: 0, seri: 0 });
  });

  test('only changes the rating of the level that was played', () => {
    const next = applyEloResult(initialEloState(), 'sulit', 'kalah');
    expect(next.rating).toBe(1197);
    expect(next.lawan.sulit).toBe(1603);
    expect(next.lawan.mudah).toBe(ELO_AWAL_LAWAN.mudah);
    expect(next.lawan.master).toBe(ELO_AWAL_LAWAN.master);
    expect(next.kalah).toBe(1);
  });

  test('counts draws', () => {
    const next = applyEloResult(initialEloState(), 'sedang', 'seri');
    expect(next).toMatchObject({ rating: ELO_AWAL_PEMAIN, menang: 0, kalah: 0, seri: 1 });
  });

  test('accumulates over several games', () => {
    let state = initialEloState();
    state = applyEloResult(state, 'sedang', 'menang');
    state = applyEloResult(state, 'sedang', 'menang');
    state = applyEloResult(state, 'sedang', 'kalah');
    expect(state).toMatchObject({ menang: 2, kalah: 1, seri: 0 });
    expect(state.rating + state.lawan.sedang).toBe(ELO_AWAL_PEMAIN + ELO_AWAL_LAWAN.sedang);
  });
});

describe('parseEloState', () => {
  test('round-trips a saved state', () => {
    const state = applyEloResult(initialEloState(), 'master', 'seri');
    expect(parseEloState(JSON.stringify(state))).toEqual(state);
  });

  test('falls back to the initial state for missing or broken data', () => {
    const initial = initialEloState();
    expect(parseEloState(null)).toEqual(initial);
    expect(parseEloState('')).toEqual(initial);
    expect(parseEloState('{not json')).toEqual(initial);
    expect(parseEloState('[]')).toEqual(initial);
    expect(parseEloState(JSON.stringify({ rating: '1200' }))).toEqual(initial);
    expect(parseEloState(JSON.stringify({ ...initial, menang: -1 }))).toEqual(initial);
    expect(parseEloState(JSON.stringify({ ...initial, lawan: { mudah: 800 } }))).toEqual(initial);
  });
});
