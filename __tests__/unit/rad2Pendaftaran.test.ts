import { describe, expect, test } from 'vitest';
import { parseUmurTahun, rad2FieldsFromPendaftaran } from '../../apps/web/src/lib/rad2Pendaftaran.ts';

describe('parseUmurTahun', () => {
  test('reads plain numbers as years', () => {
    expect(parseUmurTahun('62')).toBe(62);
  });

  test('reads the year part of free-text ages', () => {
    expect(parseUmurTahun('62 Thn')).toBe(62);
    expect(parseUmurTahun('36 Thn 4 bln')).toBe(36);
    expect(parseUmurTahun('5 tahun')).toBe(5);
  });

  test('returns 0 for ages under one year', () => {
    expect(parseUmurTahun('6 bulan')).toBe(0);
    expect(parseUmurTahun('10 hari')).toBe(0);
  });

  test('returns null for empty or unrecognised text', () => {
    expect(parseUmurTahun(null)).toBeNull();
    expect(parseUmurTahun('')).toBeNull();
    expect(parseUmurTahun('dewasa')).toBeNull();
  });
});

describe('rad2FieldsFromPendaftaran', () => {
  test('maps registration columns onto Rad2 form fields', () => {
    expect(
      rad2FieldsFromPendaftaran({
        namaPasien: 'Tn Soleh',
        umur: '56 Thn',
        alamat: 'Kp Cipanengah',
        dokterPengirim: 'Dr. Luar',
        klinis: 'Batuk lama',
      }),
    ).toEqual({
      nama: 'Tn Soleh',
      umur: '56',
      alamat: 'Kp Cipanengah',
      pengirim: 'Dr. Luar',
      klinis: 'Batuk lama',
    });
  });

  test('leaves missing columns empty', () => {
    expect(
      rad2FieldsFromPendaftaran({
        namaPasien: 'Budi',
        umur: null,
        alamat: null,
        dokterPengirim: null,
        klinis: null,
      }),
    ).toEqual({ nama: 'Budi', umur: '', alamat: '', pengirim: '', klinis: '' });
  });
});
