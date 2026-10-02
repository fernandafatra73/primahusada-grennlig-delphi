import { computeUmurYears, parseUmurManualToTanggalLahir } from './format.ts';

/** Kolom Pendaftaran Umum yang dipakai untuk mengisi form Rad2. */
export interface Rad2PendaftaranSource {
  readonly namaPasien: string;
  readonly umur: string | null;
  readonly alamat: string | null;
  readonly dokterPengirim: string | null;
  readonly klinis: string | null;
}

export interface Rad2PendaftaranFields {
  readonly nama: string;
  readonly umur: string;
  readonly alamat: string;
  readonly pengirim: string;
  readonly klinis: string;
}

/**
 * Umur di Pendaftaran Umum berupa teks bebas ("62 Thn", "36 Thn 4 bln",
 * "6 bulan"), sedangkan Rad2 menyimpan tahun penuh. Null kalau teksnya tidak
 * dikenali, supaya form tidak diisi angka yang salah.
 */
export function parseUmurTahun(value: string | null): number | null {
  if (!value) return null;
  const tanggalLahir = parseUmurManualToTanggalLahir(value);
  return tanggalLahir ? computeUmurYears(tanggalLahir) : null;
}

/** Nilai form Rad2 dari satu data pendaftaran; kolom kosong jadi string kosong. */
export function rad2FieldsFromPendaftaran(source: Rad2PendaftaranSource): Rad2PendaftaranFields {
  const umur = parseUmurTahun(source.umur);
  return {
    nama: source.namaPasien,
    umur: umur === null ? '' : String(umur),
    alamat: source.alamat ?? '',
    pengirim: source.dokterPengirim ?? '',
    klinis: source.klinis ?? '',
  };
}
