const NAMA_BULAN = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
] as const;

/** "2026-09" → "September 2026"; teks lain dikembalikan apa adanya. */
export function formatBulanId(bulan: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(bulan);
  const nama = m ? NAMA_BULAN[Number(m[2]) - 1] : undefined;
  return m && nama ? `${nama} ${m[1]}` : bulan;
}
