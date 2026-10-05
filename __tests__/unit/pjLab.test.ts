import { describe, expect, test } from 'vitest';
import { parsePjBulan } from '../../apps/api/src/lib/pjLab.ts';
import { formatBulanId } from '../../apps/web/src/lib/pjLab.ts';

describe('parsePjBulan', () => {
  test('accepts YYYY-MM with a month from 01 to 12', () => {
    expect(parsePjBulan('2026-01')).toBe('2026-01');
    expect(parsePjBulan(' 2026-12 ')).toBe('2026-12');
  });

  test('rejects out-of-range months, other formats and non-strings', () => {
    expect(parsePjBulan('2026-00')).toBeNull();
    expect(parsePjBulan('2026-13')).toBeNull();
    expect(parsePjBulan('2026-9')).toBeNull();
    expect(parsePjBulan('2026-09-01')).toBeNull();
    expect(parsePjBulan('')).toBeNull();
    expect(parsePjBulan(202609)).toBeNull();
    expect(parsePjBulan(undefined)).toBeNull();
  });
});

describe('formatBulanId', () => {
  test('formats YYYY-MM as an Indonesian month name and year', () => {
    expect(formatBulanId('2026-01')).toBe('Januari 2026');
    expect(formatBulanId('2026-09')).toBe('September 2026');
    expect(formatBulanId('2026-12')).toBe('Desember 2026');
  });

  test('returns the input unchanged when it is not a valid month', () => {
    expect(formatBulanId('2026-13')).toBe('2026-13');
    expect(formatBulanId('abc')).toBe('abc');
  });
});
