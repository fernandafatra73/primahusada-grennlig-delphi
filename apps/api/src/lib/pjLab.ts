/** Bulan PJ Lab dalam format YYYY-MM (bulan 01..12); null bila tidak valid. */
export function parsePjBulan(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const m = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return trimmed;
}
