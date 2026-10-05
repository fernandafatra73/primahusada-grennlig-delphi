import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GoogleGenAI, Type } from '@google/genai';
import {
  Decimal,
  PrismaClientKnownRequestError,
  type TransactionClient,
} from '../generated/prisma/internal/prismaNamespace.js';
import { prisma } from '../lib/prisma.js';
import { calcHariAbsen, calcPersentaseKehadiran, countHariKerja } from '../lib/absensiRekap.js';
import { normalizeCoordinate } from '../lib/geoLocation.js';
import { registrationTimestamp } from '../lib/dateOnly.js';
import { calcTotalSharing, sumHarga } from '../lib/pasienFinance.js';
import { hashPassword } from '../lib/password.js';
import { nextPendaftaranUmumCode, nextRegCode } from '../lib/regCode.js';
import { buildPaginationMeta, parsePagination } from '../lib/pagination.js';
import { normalizeSharingKeterangan, parseSharingNominal } from '../lib/pilihanSharing.js';
import { parsePjBulan } from '../lib/pjLab.js';
import { fetchXauSpotPrice, fetchLatestXauDailyPoint } from '../lib/xausGoldPrice.js';
import { fetchGoldFuturesPrice } from '../lib/goldFuturesPrice.js';
import { computePivotLevels } from '../lib/dailyTradingPivotJob.js';
import { generateContentWithFallback } from './analisaFotoAi.js';
import {
  absensiAdminKlinikListWhere,
  adminKlinikListWhere,
  aiRadiologiGrupListWhere,
  dokterListWhere,
  fotoDashboardListWhere,
  hargaListWhere,
  jenisListWhere,
  karaokeLaguListWhere,
  karyawanKlinikListWhere,
  kesanListWhere,
  logoPerusahaanListWhere,
  expertiseListWhere,
  pasienAntreanWhere,
  pasienDuplikatListWhere,
  pasienListWhere,
  pendaftaranUmumListWhere,
  daftarAkunListWhere,
  daftarTelponListWhere,
  rekeningBankListWhere,
  petugasLabListWhere,
  radiograferListWhere,
  radiologListWhere,
  sharingRadiologListWhere,
  siaranTvListWhere,
  staffListWhere,
  suratKeteranganRujukanListWhere,
  suratKeteranganSehatListWhere,
  suratPeringatanAdminKlinikListWhere,
  tandaTanganElektronikListWhere,
  usgListWhere,
} from '../lib/searchWhere.js';
import { syncPasienDuplikat } from '../lib/pasienDuplikat.js';
import { computeUmur, serializeDecimal } from '../lib/serialize.js';
import { deleteStoredImage, readStoredImageAsDataUrl, saveImageDataUrl } from '../lib/fileStorage.js';

type ListQuery = { page?: string; limit?: string; q?: string };
type StaffListQuery = ListQuery & { role?: string };
type StaffRoleInput = 'ADMIN' | 'KARYAWAN' | 'CEO';
type DepartemenInput = 'PENDAFTARAN' | 'RADIOLOGI' | 'LABORATORIUM' | 'KEUANGAN' | 'FARMASI';
type PasienListQuery = ListQuery & {
  hasilStatus?: string;
  paymentStatus?: string;
  pengirimId?: string;
  startDate?: string;
  endDate?: string;
  modul?: string;
};
type PendaftaranUmumListQuery = ListQuery & {
  startDate?: string;
  endDate?: string;
};
type UsgListQuery = ListQuery & {
  startDate?: string;
  endDate?: string;
};
type SiaranTvKategoriInput = 'NASIONAL' | 'LUAR_NEGERI';
type SiaranTvListQuery = ListQuery & { kategori?: string };

const pasienInclude = {
  pengirim: true,
  radiolog: true,
  pemeriksaan: { include: { jenisPemeriksaan: true } },
  paketLab: { include: { paketLab: true } },
} as const;

const staffPublicSelect = {
  id: true,
  nama: true,
  email: true,
  role: true,
  departemen: true,
} as const;

/// Daftar lagu karaoke tidak menyertakan fileData (base64 file lokal) di
/// listing supaya payload-nya tidak membengkak — dibaca terpisah lewat
/// endpoint /api/karaoke-lagu/:id/file.
const karaokeLaguListSelect = {
  id: true,
  judul: true,
  penyanyi: true,
  url: true,
  hasFile: true,
  createdAt: true,
  updatedAt: true,
} as const;

function badRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ error: message });
}

export async function registerCrudRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>('/api/dokter', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = dokterListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.dokter.count({ where }),
      prisma.dokter.findMany({ where, orderBy: { nama: 'asc' }, skip, take: limit }),
    ]);
    return {
      items: items.map((d) => ({
        ...d,
        defaultSharingAmount: serializeDecimal(d.defaultSharingAmount),
      })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      nama: string;
      spesialisasi?: string;
      noTelepon?: string;
      namaBank?: string;
      noRekening?: string;
      defaultSharingAmount?: number;
    };
  }>('/api/dokter', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.dokter.create({
      data: {
        nama: req.body.nama.trim(),
        spesialisasi: req.body.spesialisasi?.trim() || null,
        noTelepon: req.body.noTelepon?.trim() || null,
        namaBank: req.body.namaBank?.trim() || null,
        noRekening: req.body.noRekening?.trim() || null,
        defaultSharingAmount: req.body.defaultSharingAmount ?? 0,
      },
    });
    return reply.status(201).send({
      item: { ...item, defaultSharingAmount: serializeDecimal(item.defaultSharingAmount) },
    });
  });

  app.delete<{ Params: { id: string } }>('/api/dokter/:id', async (req, reply) => {
    try {
      await prisma.dokter.delete({ where: { id: req.params.id } });
      return { ok: true };
    } catch {
      return reply.status(409).send({ error: 'Dokter masih dipakai pasien' });
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nama?: string;
      spesialisasi?: string;
      noTelepon?: string;
      namaBank?: string;
      noRekening?: string;
      defaultSharingAmount?: number;
    };
  }>('/api/dokter/:id', async (req, reply) => {
    const existing = await prisma.dokter.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Dokter tidak ditemukan' });
    const item = await prisma.dokter.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        spesialisasi: req.body.spesialisasi !== undefined ? req.body.spesialisasi?.trim() || null : existing.spesialisasi,
        noTelepon: req.body.noTelepon !== undefined ? req.body.noTelepon?.trim() || null : existing.noTelepon,
        namaBank: req.body.namaBank !== undefined ? req.body.namaBank?.trim() || null : existing.namaBank,
        noRekening: req.body.noRekening !== undefined ? req.body.noRekening?.trim() || null : existing.noRekening,
        defaultSharingAmount: req.body.defaultSharingAmount ?? existing.defaultSharingAmount,
      },
    });
    return {
      item: { ...item, defaultSharingAmount: serializeDecimal(item.defaultSharingAmount) },
    };
  });

  app.get<{ Querystring: ListQuery }>('/api/karyawan-klinik', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = karyawanKlinikListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.karyawanKlinik.count({ where }),
      prisma.karyawanKlinik.findMany({ where, orderBy: { nama: 'asc' }, skip, take: limit }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: { nama: string; spesialisasi?: string; noTelepon?: string; namaBank?: string; noRekening?: string };
  }>('/api/karyawan-klinik', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.karyawanKlinik.create({
      data: {
        nama: req.body.nama.trim(),
        spesialisasi: req.body.spesialisasi?.trim() || null,
        noTelepon: req.body.noTelepon?.trim() || null,
        namaBank: req.body.namaBank?.trim() || null,
        noRekening: req.body.noRekening?.trim() || null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.delete<{ Params: { id: string } }>('/api/karyawan-klinik/:id', async (req) => {
    await prisma.karyawanKlinik.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.patch<{
    Params: { id: string };
    Body: { nama?: string; spesialisasi?: string; noTelepon?: string; namaBank?: string; noRekening?: string };
  }>('/api/karyawan-klinik/:id', async (req, reply) => {
    const existing = await prisma.karyawanKlinik.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Karyawan tidak ditemukan' });
    const item = await prisma.karyawanKlinik.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        spesialisasi: req.body.spesialisasi !== undefined ? req.body.spesialisasi?.trim() || null : existing.spesialisasi,
        noTelepon: req.body.noTelepon !== undefined ? req.body.noTelepon?.trim() || null : existing.noTelepon,
        namaBank: req.body.namaBank !== undefined ? req.body.namaBank?.trim() || null : existing.namaBank,
        noRekening: req.body.noRekening !== undefined ? req.body.noRekening?.trim() || null : existing.noRekening,
      },
    });
    return { item };
  });

  app.get<{ Querystring: ListQuery }>('/api/radiolog', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = radiologListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.radiolog.count({ where }),
      prisma.radiolog.findMany({ where, orderBy: { nama: 'asc' }, skip, take: limit }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{ Body: { nama: string; noTelepon?: string } }>(
    '/api/radiolog',
    async (req, reply) => {
      if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
      const item = await prisma.radiolog.create({
        data: {
          nama: req.body.nama.trim(),
          noTelepon: req.body.noTelepon?.trim() || null,
        },
      });
      return reply.status(201).send({ item });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/radiolog/:id', async (req, reply) => {
    try {
      await prisma.radiolog.delete({ where: { id: req.params.id } });
      return { ok: true };
    } catch (err: unknown) {
      // SharingRadiolog memakai ON DELETE RESTRICT; Pasien.radiologId otomatis dikosongkan (SET NULL).
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2003') {
        return reply
          .status(409)
          .send({ error: 'Radiolog tidak bisa dihapus karena masih dipakai di data Sharing Radiolog' });
      }
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.status(404).send({ error: 'Radiolog tidak ditemukan' });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: { nama?: string; noTelepon?: string } }>(
    '/api/radiolog/:id',
    async (req, reply) => {
      const existing = await prisma.radiolog.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Radiolog tidak ditemukan' });
      const item = await prisma.radiolog.update({
        where: { id: req.params.id },
        data: {
          nama: req.body.nama?.trim() ?? existing.nama,
          noTelepon: req.body.noTelepon !== undefined ? req.body.noTelepon?.trim() || null : existing.noTelepon,
        },
      });
      return { item };
    },
  );

  app.get('/api/pilihan-sharing', async () => {
    const items = await prisma.pilihanSharing.findMany({ orderBy: { nominal: 'asc' } });
    return { items };
  });

  app.post<{ Body: { nominal?: unknown; keterangan?: unknown } }>('/api/pilihan-sharing', async (req, reply) => {
    const nominal = parseSharingNominal(req.body.nominal);
    if (nominal === null) return badRequest(reply, 'Nominal sharing harus angka bulat 0 atau lebih');
    try {
      const item = await prisma.pilihanSharing.create({
        data: { nominal, keterangan: normalizeSharingKeterangan(req.body.keterangan) },
      });
      return reply.status(201).send({ item });
    } catch (err: unknown) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        return badRequest(reply, `Pilihan sharing dengan nominal ${nominal} sudah ada`);
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: { nominal?: unknown; keterangan?: unknown } }>(
    '/api/pilihan-sharing/:id',
    async (req, reply) => {
      const existing = await prisma.pilihanSharing.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Pilihan sharing tidak ditemukan' });
      let nominal = existing.nominal;
      if (req.body.nominal !== undefined) {
        const parsed = parseSharingNominal(req.body.nominal);
        if (parsed === null) return badRequest(reply, 'Nominal sharing harus angka bulat 0 atau lebih');
        nominal = parsed;
      }
      try {
        const item = await prisma.pilihanSharing.update({
          where: { id: req.params.id },
          data: {
            nominal,
            keterangan:
              req.body.keterangan !== undefined
                ? normalizeSharingKeterangan(req.body.keterangan)
                : existing.keterangan,
          },
        });
        return { item };
      } catch (err: unknown) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          return badRequest(reply, `Pilihan sharing dengan nominal ${nominal} sudah ada`);
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/pilihan-sharing/:id', async (req, reply) => {
    try {
      await prisma.pilihanSharing.delete({ where: { id: req.params.id } });
      return { ok: true };
    } catch (err: unknown) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2025') {
        return reply.status(404).send({ error: 'Pilihan sharing tidak ditemukan' });
      }
      throw err;
    }
  });

  app.get<{ Querystring: ListQuery & { radiologId?: string; tanggal?: string } }>(
    '/api/sharing-radiolog',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const { radiologId, tanggal } = req.query;
      let tanggalRange: { gte: Date; lt: Date } | undefined;
      if (tanggal) {
        const start = new Date(`${tanggal}T00:00:00`);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        tanggalRange = { gte: start, lt: end };
      }
      const where = {
        ...sharingRadiologListWhere(req.query.q),
        ...(radiologId ? { radiologId } : {}),
        ...(tanggalRange ? { createdAt: tanggalRange } : {}),
      };
      const [total, items] = await Promise.all([
        prisma.sharingRadiolog.count({ where }),
        prisma.sharingRadiolog.findMany({
          where,
          include: { radiolog: true },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
      ]);
      return {
        items: items.map((item) => ({
          ...item,
          sharingNominal: serializeDecimal(item.sharingNominal),
          totalSharing: serializeDecimal(item.totalSharing),
        })),
        pagination: buildPaginationMeta(total, page, limit),
      };
    },
  );

  app.post<{
    Body: {
      namaPemeriksaan: string;
      jumlahPemeriksaan?: number;
      sharingNominal: string | number;
      radiologId: string;
    };
  }>('/api/sharing-radiolog', async (req, reply) => {
    if (!req.body.namaPemeriksaan?.trim()) return badRequest(reply, 'namaPemeriksaan wajib diisi');
    if (!req.body.radiologId) return badRequest(reply, 'radiologId wajib diisi');
    const radiolog = await prisma.radiolog.findUnique({ where: { id: req.body.radiologId } });
    if (!radiolog) return badRequest(reply, 'Radiolog tidak ditemukan');
    const jumlahPemeriksaan = req.body.jumlahPemeriksaan ?? 1;
    const sharingNominal = new Decimal(req.body.sharingNominal ?? 0);
    const item = await prisma.sharingRadiolog.create({
      data: {
        namaPemeriksaan: req.body.namaPemeriksaan.trim(),
        jumlahPemeriksaan,
        sharingNominal,
        totalSharing: sharingNominal.mul(jumlahPemeriksaan),
        radiologId: req.body.radiologId,
      },
      include: { radiolog: true },
    });
    return reply.status(201).send({
      item: {
        ...item,
        sharingNominal: serializeDecimal(item.sharingNominal),
        totalSharing: serializeDecimal(item.totalSharing),
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaPemeriksaan?: string;
      jumlahPemeriksaan?: number;
      sharingNominal?: string | number;
      radiologId?: string;
    };
  }>('/api/sharing-radiolog/:id', async (req, reply) => {
    const existing = await prisma.sharingRadiolog.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Sharing radiolog tidak ditemukan' });
    if (req.body.radiologId) {
      const radiolog = await prisma.radiolog.findUnique({ where: { id: req.body.radiologId } });
      if (!radiolog) return badRequest(reply, 'Radiolog tidak ditemukan');
    }
    const jumlahPemeriksaan = req.body.jumlahPemeriksaan ?? existing.jumlahPemeriksaan;
    const sharingNominal =
      req.body.sharingNominal !== undefined ? new Decimal(req.body.sharingNominal) : existing.sharingNominal;
    const item = await prisma.sharingRadiolog.update({
      where: { id: req.params.id },
      data: {
        namaPemeriksaan: req.body.namaPemeriksaan?.trim() ?? existing.namaPemeriksaan,
        jumlahPemeriksaan,
        sharingNominal,
        totalSharing: sharingNominal.mul(jumlahPemeriksaan),
        radiologId: req.body.radiologId ?? existing.radiologId,
      },
      include: { radiolog: true },
    });
    return {
      item: {
        ...item,
        sharingNominal: serializeDecimal(item.sharingNominal),
        totalSharing: serializeDecimal(item.totalSharing),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/sharing-radiolog/:id', async (req) => {
    await prisma.sharingRadiolog.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/ai-radiologi-grup', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = aiRadiologiGrupListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.aiRadiologiGrup.count({ where }),
      prisma.aiRadiologiGrup.findMany({ where, orderBy: { nama: 'asc' }, skip, take: limit }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{ Body: { nama: string } }>('/api/ai-radiologi-grup', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.aiRadiologiGrup.create({ data: { nama: req.body.nama.trim() } });
    return reply.status(201).send({ item });
  });

  app.patch<{ Params: { id: string }; Body: { nama?: string } }>(
    '/api/ai-radiologi-grup/:id',
    async (req, reply) => {
      const existing = await prisma.aiRadiologiGrup.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Grup tidak ditemukan' });
      const item = await prisma.aiRadiologiGrup.update({
        where: { id: req.params.id },
        data: { nama: req.body.nama?.trim() || existing.nama },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/ai-radiologi-grup/:id', async (req) => {
    await prisma.aiRadiologiGrup.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/karaoke-lagu', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = karaokeLaguListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.karaokeLagu.count({ where }),
      prisma.karaokeLagu.findMany({
        where,
        orderBy: { judul: 'asc' },
        skip,
        take: limit,
        select: karaokeLaguListSelect,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.get<{ Params: { id: string } }>('/api/karaoke-lagu/:id/file', async (req, reply) => {
    const item = await prisma.karaokeLagu.findUnique({
      where: { id: req.params.id },
      select: { fileData: true },
    });
    if (!item?.fileData) return reply.status(404).send({ error: 'File lagu tidak ditemukan' });
    const match = item.fileData.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return reply.status(500).send({ error: 'Format file tidak valid' });
    const [, mime, base64] = match;
    const buffer = Buffer.from(base64!, 'base64');
    reply.header('Content-Type', mime);
    reply.header('Content-Length', String(buffer.length));
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(buffer);
  });

  app.post<{
    Body: { judul: string; penyanyi?: string; url?: string; fileData?: string };
  }>('/api/karaoke-lagu', async (req, reply) => {
    if (!req.body.judul?.trim()) return badRequest(reply, 'judul wajib diisi');
    const url = req.body.url?.trim() || null;
    const fileData = req.body.fileData?.trim() || null;
    if (!url && !fileData) return badRequest(reply, 'url atau file lagu wajib diisi');
    const item = await prisma.karaokeLagu.create({
      data: {
        judul: req.body.judul.trim(),
        penyanyi: req.body.penyanyi?.trim() || null,
        url,
        fileData,
        hasFile: fileData !== null,
      },
      select: karaokeLaguListSelect,
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: { judul?: string; penyanyi?: string; url?: string };
  }>('/api/karaoke-lagu/:id', async (req, reply) => {
    const existing = await prisma.karaokeLagu.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Lagu karaoke tidak ditemukan' });
    const item = await prisma.karaokeLagu.update({
      where: { id: req.params.id },
      data: {
        judul: req.body.judul?.trim() || existing.judul,
        penyanyi: req.body.penyanyi !== undefined ? req.body.penyanyi?.trim() || null : existing.penyanyi,
        url: req.body.url?.trim() || existing.url,
      },
      select: karaokeLaguListSelect,
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/karaoke-lagu/:id', async (req) => {
    await prisma.karaokeLagu.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: SiaranTvListQuery }>('/api/siaran-tv', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = siaranTvListWhere(req.query.q, req.query.kategori);
    const [total, items] = await Promise.all([
      prisma.siaranTv.count({ where }),
      prisma.siaranTv.findMany({ where, orderBy: { nama: 'asc' }, skip, take: limit }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: { nama: string; kategori: SiaranTvKategoriInput; url: string };
  }>('/api/siaran-tv', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    if (req.body.kategori !== 'NASIONAL' && req.body.kategori !== 'LUAR_NEGERI') {
      return badRequest(reply, 'kategori tidak valid');
    }
    if (!req.body.url?.trim()) return badRequest(reply, 'url wajib diisi');
    const item = await prisma.siaranTv.create({
      data: {
        nama: req.body.nama.trim(),
        kategori: req.body.kategori,
        url: req.body.url.trim(),
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: { nama?: string; kategori?: SiaranTvKategoriInput; url?: string };
  }>('/api/siaran-tv/:id', async (req, reply) => {
    const existing = await prisma.siaranTv.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Siaran TV tidak ditemukan' });
    if (req.body.kategori !== undefined && req.body.kategori !== 'NASIONAL' && req.body.kategori !== 'LUAR_NEGERI') {
      return badRequest(reply, 'kategori tidak valid');
    }
    const item = await prisma.siaranTv.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() || existing.nama,
        kategori: req.body.kategori ?? existing.kategori,
        url: req.body.url?.trim() || existing.url,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/siaran-tv/:id', async (req) => {
    await prisma.siaranTv.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/petugas-lab', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = petugasLabListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.petugasLab.count({ where }),
      prisma.petugasLab.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.get<{ Params: { id: string } }>('/api/petugas-lab/:id', async (req, reply) => {
    const item = await prisma.petugasLab.findUnique({ where: { id: req.params.id } });
    if (!item) return reply.status(404).send({ error: 'Petugas lab tidak ditemukan' });
    return { item };
  });

  app.post<{ Body: { nama: string; nip?: string; noTelepon?: string; logoTandaTangan?: string } }>(
    '/api/petugas-lab',
    async (req, reply) => {
      if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
      const item = await prisma.petugasLab.create({
        data: {
          nama: req.body.nama.trim(),
          nip: req.body.nip?.trim() || null,
          noTelepon: req.body.noTelepon?.trim() || null,
          logoTandaTangan: req.body.logoTandaTangan || null,
        },
      });
      return reply.status(201).send({ item });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/petugas-lab/:id', async (req) => {
    await prisma.petugasLab.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.patch<{
    Params: { id: string };
    Body: { nama?: string; nip?: string; noTelepon?: string; logoTandaTangan?: string | null };
  }>(
    '/api/petugas-lab/:id',
    async (req, reply) => {
      const existing = await prisma.petugasLab.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Petugas lab tidak ditemukan' });
      const item = await prisma.petugasLab.update({
        where: { id: req.params.id },
        data: {
          nama: req.body.nama?.trim() ?? existing.nama,
          nip: req.body.nip !== undefined ? req.body.nip?.trim() || null : existing.nip,
          noTelepon: req.body.noTelepon !== undefined ? req.body.noTelepon?.trim() || null : existing.noTelepon,
          logoTandaTangan:
            req.body.logoTandaTangan !== undefined ? req.body.logoTandaTangan || null : existing.logoTandaTangan,
        },
      });
      return { item };
    },
  );

  app.get<{ Querystring: ListQuery }>('/api/radiografer', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = radiograferListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.radiografer.count({ where }),
      prisma.radiografer.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{ Body: { nama: string; noHp?: string } }>('/api/radiografer', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.radiografer.create({
      data: {
        nama: req.body.nama.trim(),
        noHp: req.body.noHp?.trim() || null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{ Params: { id: string }; Body: { nama?: string; noHp?: string } }>(
    '/api/radiografer/:id',
    async (req, reply) => {
      const existing = await prisma.radiografer.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Radiografer tidak ditemukan' });
      const item = await prisma.radiografer.update({
        where: { id: req.params.id },
        data: {
          nama: req.body.nama?.trim() ?? existing.nama,
          noHp: req.body.noHp !== undefined ? req.body.noHp?.trim() || null : existing.noHp,
        },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/radiografer/:id', async (req) => {
    await prisma.radiografer.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/expertise', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = expertiseListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.expertise.count({ where }),
      prisma.expertise.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: {
      pemeriksaan?: string;
      klinis?: string;
      namaPenyakit?: string;
      fotoDataUrl?: string;
      kesan?: string;
    };
  }>('/api/expertise', async (req, reply) => {
    const item = await prisma.expertise.create({
      data: {
        pemeriksaan: req.body.pemeriksaan?.trim() || null,
        klinis: req.body.klinis?.trim() || null,
        namaPenyakit: req.body.namaPenyakit?.trim() || null,
        fotoDataUrl: req.body.fotoDataUrl || null,
        kesan: req.body.kesan?.trim() || null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      pemeriksaan?: string;
      klinis?: string;
      namaPenyakit?: string;
      fotoDataUrl?: string;
      kesan?: string;
    };
  }>('/api/expertise/:id', async (req, reply) => {
    const existing = await prisma.expertise.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Expertise tidak ditemukan' });
    const item = await prisma.expertise.update({
      where: { id: req.params.id },
      data: {
        pemeriksaan: req.body.pemeriksaan !== undefined ? req.body.pemeriksaan.trim() || null : existing.pemeriksaan,
        klinis: req.body.klinis !== undefined ? req.body.klinis.trim() || null : existing.klinis,
        namaPenyakit:
          req.body.namaPenyakit !== undefined ? req.body.namaPenyakit.trim() || null : existing.namaPenyakit,
        fotoDataUrl: req.body.fotoDataUrl !== undefined ? req.body.fotoDataUrl || null : existing.fotoDataUrl,
        kesan: req.body.kesan !== undefined ? req.body.kesan.trim() || null : existing.kesan,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/expertise/:id', async (req) => {
    await prisma.expertise.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/admin-klinik', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = adminKlinikListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.adminKlinik.count({ where }),
      prisma.adminKlinik.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  /** Daftar karyawan: data master digabung dengan rekap kehadiran tahun
   * berjalan, supaya kolom Hadir/Absen tidak perlu dihitung ulang di layar. */
  app.get<{ Querystring: { tahun?: string } }>('/api/admin-klinik/daftar-karyawan', async (req) => {
    const tahun = Number(req.query.tahun) || new Date().getFullYear();
    const hariKerja = countHariKerja(tahun);

    const [karyawan, absensi] = await Promise.all([
      prisma.adminKlinik.findMany({ orderBy: { nama: 'asc' } }),
      prisma.absensiAdminKlinik.findMany({
        where: { tanggal: { startsWith: `${tahun}-` } },
        select: { adminKlinikId: true, tanggal: true },
      }),
    ]);

    // Satu orang bisa punya beberapa baris di tanggal yang sama pada data
    // lama, jadi tanggalnya dihitung sebagai himpunan.
    const hariPerOrang = new Map<string, Set<string>>();
    for (const baris of absensi) {
      const kumpulan = hariPerOrang.get(baris.adminKlinikId) ?? new Set<string>();
      kumpulan.add(baris.tanggal);
      hariPerOrang.set(baris.adminKlinikId, kumpulan);
    }

    const items = karyawan.map((orang) => {
      const hadir = hariPerOrang.get(orang.id)?.size ?? 0;
      return {
        ...orang,
        hadir,
        absen: calcHariAbsen(hadir, hariKerja),
        persentase: calcPersentaseKehadiran(hadir, hariKerja),
      };
    });

    return { tahun, hariKerja, items };
  });

  app.post<{
    Body: {
      nama: string;
      nk?: string;
      noHp?: string;
      alamat?: string;
      bagian?: string;
      foto?: string;
      keterangan?: string;
    };
  }>('/api/admin-klinik', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.adminKlinik.create({
      data: {
        nama: req.body.nama.trim(),
        nk: req.body.nk?.trim() || null,
        noHp: req.body.noHp?.trim() || null,
        alamat: req.body.alamat?.trim() || null,
        bagian: req.body.bagian?.trim() || null,
        foto: req.body.foto ? saveImageDataUrl(req.body.foto, 'karyawan') : null,
        keterangan: req.body.keterangan?.trim() || null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nama?: string;
      nk?: string;
      noHp?: string;
      alamat?: string;
      bagian?: string;
      foto?: string;
      keterangan?: string;
      statusHadir?: string | null;
      statusTanggal?: string | null;
    };
  }>('/api/admin-klinik/:id', async (req, reply) => {
    const existing = await prisma.adminKlinik.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Admin klinik tidak ditemukan' });

    const teks = (nilai: string | undefined, lama: string | null): string | null =>
      nilai !== undefined ? nilai.trim() || null : lama;

    const item = await prisma.adminKlinik.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        nk: teks(req.body.nk, existing.nk),
        noHp: teks(req.body.noHp, existing.noHp),
        alamat: teks(req.body.alamat, existing.alamat),
        bagian: teks(req.body.bagian, existing.bagian),
        // Foto lama dipertahankan kalau tidak dikirim sama sekali; dikirim
        // sebagai string kosong berarti fotonya sengaja dihapus.
        foto:
          req.body.foto === undefined
            ? existing.foto
            : req.body.foto === ''
              ? null
              : saveImageDataUrl(req.body.foto, 'karyawan'),
        keterangan: teks(req.body.keterangan, existing.keterangan),
        statusHadir: req.body.statusHadir !== undefined ? req.body.statusHadir : existing.statusHadir,
        statusTanggal: req.body.statusTanggal !== undefined ? req.body.statusTanggal : existing.statusTanggal,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/admin-klinik/:id', async (req) => {
    await prisma.adminKlinik.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Absensi Admin Klinik (tab "Absensi" di halaman Pendaftaran) ──────────

  function todayDateStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  app.get<{ Querystring: ListQuery & { tanggal?: string; tahun?: string } }>(
    '/api/absensi-admin-klinik',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const where = {
        ...absensiAdminKlinikListWhere(req.query.q),
        ...(req.query.tanggal
          ? { tanggal: req.query.tanggal }
          : req.query.tahun
            ? { tanggal: { startsWith: `${req.query.tahun}-` } }
            : {}),
      };
      const [total, items] = await Promise.all([
        prisma.absensiAdminKlinik.count({ where }),
        prisma.absensiAdminKlinik.findMany({
          where,
          orderBy: [{ tanggal: 'desc' }, { namaKaryawan: 'asc' }],
          skip,
          take: limit,
        }),
      ]);
      return { items, pagination: buildPaginationMeta(total, page, limit) };
    },
  );

  // Rekap persentase kehadiran per staff Admin Klinik untuk satu tahun —
  // hari kerja dihitung dari 1 Januari s.d. hari ini (atau 31 Desember untuk
  // tahun yang sudah lewat), hari Minggu dikecualikan.
  app.get<{ Querystring: { tahun?: string } }>('/api/absensi-admin-klinik/rekap', async (req, reply) => {
    const tahun = parseInt(req.query.tahun || String(new Date().getFullYear()), 10);
    if (!Number.isFinite(tahun)) return badRequest(reply, 'tahun tidak valid');

    const hariKerja = countHariKerja(tahun);

    const [adminKlinikList, absensiRows] = await Promise.all([
      prisma.adminKlinik.findMany({ orderBy: { nama: 'asc' } }),
      prisma.absensiAdminKlinik.findMany({ where: { tanggal: { startsWith: `${tahun}-` } } }),
    ]);

    const hadirCountByAdmin = new Map<string, number>();
    for (const row of absensiRows) {
      hadirCountByAdmin.set(row.adminKlinikId, (hadirCountByAdmin.get(row.adminKlinikId) ?? 0) + 1);
    }

    const items = adminKlinikList.map((admin) => {
      const hariHadir = hadirCountByAdmin.get(admin.id) ?? 0;
      const persentase = calcPersentaseKehadiran(hariHadir, hariKerja);
      return { adminKlinikId: admin.id, nama: admin.nama, hariKerja, hariHadir, persentase };
    });

    return { tahun, hariKerja, items };
  });

  app.post<{
    Body: {
      adminKlinikId: string;
      jamDatang?: string;
      jamPulang?: string;
      foto?: string;
      lat?: number;
      lng?: number;
      akurasi?: number;
    };
  }>(
    '/api/absensi-admin-klinik',
    async (req, reply) => {
      if (!req.body.adminKlinikId) return badRequest(reply, 'adminKlinikId wajib diisi');
      const admin = await prisma.adminKlinik.findUnique({ where: { id: req.body.adminKlinikId } });
      if (!admin) return badRequest(reply, 'Admin klinik tidak ditemukan');

      // Foto dan lokasi menempel pada jam yang sedang dicatat: kalau yang
      // diisi jam pulang, keduanya masuk ke kolom pulang.
      const untukPulang = !req.body.jamDatang?.trim() && !!req.body.jamPulang?.trim();
      const foto = req.body.foto ? saveImageDataUrl(req.body.foto, 'absensi') : null;
      const titik = normalizeCoordinate(req.body.lat, req.body.lng, req.body.akurasi);

      try {
        const item = await prisma.absensiAdminKlinik.create({
          data: {
            adminKlinikId: admin.id,
            namaKaryawan: admin.nama,
            tanggal: todayDateStr(),
            jamDatang: req.body.jamDatang?.trim() || null,
            jamPulang: req.body.jamPulang?.trim() || null,
            ...(untukPulang
              ? {
                  fotoPulang: foto,
                  latPulang: titik?.lat ?? null,
                  lngPulang: titik?.lng ?? null,
                  akurasiPulang: titik?.akurasi ?? null,
                }
              : {
                  fotoDatang: foto,
                  latDatang: titik?.lat ?? null,
                  lngDatang: titik?.lng ?? null,
                  akurasiDatang: titik?.akurasi ?? null,
                }),
          },
        });
        return reply.status(201).send({ item });
      } catch (err: unknown) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          return badRequest(reply, 'Absensi untuk karyawan ini hari ini sudah tercatat');
        }
        throw err;
      }
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      jamDatang?: string;
      jamPulang?: string;
      foto?: string;
      lat?: number;
      lng?: number;
      akurasi?: number;
      /** Sisi mana yang sedang direkam fotonya; menentukan kolom tujuan. */
      sisi?: 'datang' | 'pulang';
    };
  }>(
    '/api/absensi-admin-klinik/:id',
    async (req, reply) => {
      const existing = await prisma.absensiAdminKlinik.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Data absensi tidak ditemukan' });

      const untukPulang =
        req.body.sisi === 'pulang' ||
        (req.body.sisi === undefined && req.body.jamPulang !== undefined && req.body.jamDatang === undefined);
      const foto = req.body.foto ? saveImageDataUrl(req.body.foto, 'absensi') : null;
      const titik = normalizeCoordinate(req.body.lat, req.body.lng, req.body.akurasi);

      // Foto/lokasi lama hanya ditimpa kalau ada yang baru dikirim, supaya
      // menyunting jam saja tidak menghapus bukti yang sudah terekam.
      const rekamanBaru = foto || titik ? true : false;

      const item = await prisma.absensiAdminKlinik.update({
        where: { id: req.params.id },
        data: {
          jamDatang: req.body.jamDatang !== undefined ? req.body.jamDatang?.trim() || null : existing.jamDatang,
          jamPulang: req.body.jamPulang !== undefined ? req.body.jamPulang?.trim() || null : existing.jamPulang,
          ...(rekamanBaru && untukPulang
            ? {
                fotoPulang: foto ?? existing.fotoPulang,
                latPulang: titik?.lat ?? existing.latPulang,
                lngPulang: titik?.lng ?? existing.lngPulang,
                akurasiPulang: titik?.akurasi ?? existing.akurasiPulang,
              }
            : {}),
          ...(rekamanBaru && !untukPulang
            ? {
                fotoDatang: foto ?? existing.fotoDatang,
                latDatang: titik?.lat ?? existing.latDatang,
                lngDatang: titik?.lng ?? existing.lngDatang,
                akurasiDatang: titik?.akurasi ?? existing.akurasiDatang,
              }
            : {}),
        },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/absensi-admin-klinik/:id', async (req) => {
    await prisma.absensiAdminKlinik.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Surat Peringatan Admin Klinik (SP1/SP2/SP3, dari tab Absensi) ────────

  app.get<{ Querystring: ListQuery }>('/api/surat-peringatan-admin-klinik', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = suratPeringatanAdminKlinikListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.suratPeringatanAdminKlinik.count({ where }),
      prisma.suratPeringatanAdminKlinik.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);
    return {
      items: items.map((it) => ({ ...it, tanggalSurat: it.tanggalSurat.toISOString().slice(0, 10) })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      namaKaryawan: string;
      jabatan?: string;
      level: string;
      nomorSurat?: string;
      tanggalSurat?: string;
      alasan: string;
      tempatSurat?: string;
      namaPenandatangan?: string;
      jabatanPenandatangan?: string;
    };
  }>('/api/surat-peringatan-admin-klinik', async (req, reply) => {
    if (!req.body.namaKaryawan?.trim()) return badRequest(reply, 'namaKaryawan wajib diisi');
    if (!['SP1', 'SP2', 'SP3'].includes(req.body.level)) {
      return badRequest(reply, 'level harus SP1, SP2, atau SP3');
    }
    if (!req.body.alasan?.trim()) return badRequest(reply, 'alasan wajib diisi');
    const item = await prisma.suratPeringatanAdminKlinik.create({
      data: {
        namaKaryawan: req.body.namaKaryawan.trim(),
        jabatan: req.body.jabatan?.trim() || 'Admin Klinik',
        level: req.body.level,
        nomorSurat: req.body.nomorSurat?.trim() || null,
        tanggalSurat: req.body.tanggalSurat ? new Date(req.body.tanggalSurat) : new Date(),
        alasan: req.body.alasan.trim(),
        tempatSurat: req.body.tempatSurat?.trim() || null,
        namaPenandatangan: req.body.namaPenandatangan?.trim() || null,
        jabatanPenandatangan: req.body.jabatanPenandatangan?.trim() || null,
      },
    });
    return reply.status(201).send({ item: { ...item, tanggalSurat: item.tanggalSurat.toISOString().slice(0, 10) } });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaKaryawan?: string;
      jabatan?: string;
      level?: string;
      nomorSurat?: string;
      tanggalSurat?: string;
      alasan?: string;
      tempatSurat?: string;
      namaPenandatangan?: string;
      jabatanPenandatangan?: string;
    };
  }>('/api/surat-peringatan-admin-klinik/:id', async (req, reply) => {
    const existing = await prisma.suratPeringatanAdminKlinik.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Surat tidak ditemukan' });
    if (req.body.level !== undefined && !['SP1', 'SP2', 'SP3'].includes(req.body.level)) {
      return badRequest(reply, 'level harus SP1, SP2, atau SP3');
    }
    const item = await prisma.suratPeringatanAdminKlinik.update({
      where: { id: req.params.id },
      data: {
        namaKaryawan: req.body.namaKaryawan?.trim() ?? existing.namaKaryawan,
        jabatan: req.body.jabatan?.trim() ?? existing.jabatan,
        level: req.body.level ?? existing.level,
        nomorSurat: req.body.nomorSurat !== undefined ? req.body.nomorSurat?.trim() || null : existing.nomorSurat,
        tanggalSurat: req.body.tanggalSurat ? new Date(req.body.tanggalSurat) : existing.tanggalSurat,
        alasan: req.body.alasan?.trim() ?? existing.alasan,
        tempatSurat: req.body.tempatSurat !== undefined ? req.body.tempatSurat?.trim() || null : existing.tempatSurat,
        namaPenandatangan:
          req.body.namaPenandatangan !== undefined
            ? req.body.namaPenandatangan?.trim() || null
            : existing.namaPenandatangan,
        jabatanPenandatangan:
          req.body.jabatanPenandatangan !== undefined
            ? req.body.jabatanPenandatangan?.trim() || null
            : existing.jabatanPenandatangan,
      },
    });
    return { item: { ...item, tanggalSurat: item.tanggalSurat.toISOString().slice(0, 10) } };
  });

  app.delete<{ Params: { id: string } }>('/api/surat-peringatan-admin-klinik/:id', async (req) => {
    await prisma.suratPeringatanAdminKlinik.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/hitungan-led', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const q = req.query.q?.trim();
    const where = q ? { namaPasien: { contains: q } } : {};
    const [total, items] = await Promise.all([
      prisma.hitunganLed.count({ where }),
      prisma.hitunganLed.findMany({
        where,
        orderBy: { tanggal: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return {
      items: items.map((h) => ({
        id: h.id,
        namaPasien: h.namaPasien,
        jenisKelamin: h.jenisKelamin,
        jamPertama: serializeDecimal(h.jamPertama),
        jamKedua: serializeDecimal(h.jamKedua),
        tanggal: h.tanggal.toISOString(),
      })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      namaPasien: string;
      jenisKelamin: 'L' | 'P';
      jamPertama: number;
      jamKedua: number;
      tanggal?: string;
    };
  }>('/api/hitungan-led', async (req, reply) => {
    const b = req.body;
    if (!b.namaPasien?.trim() || !b.jenisKelamin || b.jamPertama === undefined || b.jamKedua === undefined) {
      return badRequest(reply, 'namaPasien, jenisKelamin, jamPertama, jamKedua wajib diisi');
    }
    const item = await prisma.hitunganLed.create({
      data: {
        namaPasien: b.namaPasien.trim(),
        jenisKelamin: b.jenisKelamin,
        jamPertama: b.jamPertama,
        jamKedua: b.jamKedua,
        tanggal: b.tanggal ? new Date(b.tanggal) : new Date(),
      },
    });
    return reply.status(201).send({
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        jenisKelamin: item.jenisKelamin,
        jamPertama: serializeDecimal(item.jamPertama),
        jamKedua: serializeDecimal(item.jamKedua),
        tanggal: item.tanggal.toISOString(),
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaPasien?: string;
      jenisKelamin?: 'L' | 'P';
      jamPertama?: number;
      jamKedua?: number;
      tanggal?: string;
    };
  }>('/api/hitungan-led/:id', async (req, reply) => {
    const existing = await prisma.hitunganLed.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data hitungan LED tidak ditemukan' });
    const item = await prisma.hitunganLed.update({
      where: { id: req.params.id },
      data: {
        namaPasien: req.body.namaPasien?.trim() ?? existing.namaPasien,
        jenisKelamin: req.body.jenisKelamin ?? existing.jenisKelamin,
        jamPertama: req.body.jamPertama !== undefined ? req.body.jamPertama : existing.jamPertama,
        jamKedua: req.body.jamKedua !== undefined ? req.body.jamKedua : existing.jamKedua,
        tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
      },
    });
    return {
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        jenisKelamin: item.jenisKelamin,
        jamPertama: serializeDecimal(item.jamPertama),
        jamKedua: serializeDecimal(item.jamKedua),
        tanggal: item.tanggal.toISOString(),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/hitungan-led/:id', async (req) => {
    await prisma.hitunganLed.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/kondisi-alat', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const q = req.query.q?.trim();
    const where = q ? { namaPasien: { contains: q } } : {};
    const [total, items] = await Promise.all([
      prisma.kondisiAlat.count({ where }),
      prisma.kondisiAlat.findMany({
        where,
        orderBy: { tanggal: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return {
      items: items.map((k) => ({
        id: k.id,
        namaPasien: k.namaPasien,
        kv: serializeDecimal(k.kv),
        sekon: serializeDecimal(k.sekon),
        mAs: serializeDecimal(k.mAs),
        beratBadan: k.beratBadan !== null ? serializeDecimal(k.beratBadan) : null,
        tanggal: k.tanggal.toISOString(),
      })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      namaPasien: string;
      kv: number;
      sekon: number;
      mAs: number;
      beratBadan?: number;
      tanggal?: string;
    };
  }>('/api/kondisi-alat', async (req, reply) => {
    const b = req.body;
    if (!b.namaPasien?.trim() || b.kv === undefined || b.sekon === undefined || b.mAs === undefined) {
      return badRequest(reply, 'namaPasien, kv, sekon, mAs wajib diisi');
    }
    const item = await prisma.kondisiAlat.create({
      data: {
        namaPasien: b.namaPasien.trim(),
        kv: b.kv,
        sekon: b.sekon,
        mAs: b.mAs,
        beratBadan: b.beratBadan ?? null,
        tanggal: b.tanggal ? new Date(b.tanggal) : new Date(),
      },
    });
    return reply.status(201).send({
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        kv: serializeDecimal(item.kv),
        sekon: serializeDecimal(item.sekon),
        mAs: serializeDecimal(item.mAs),
        beratBadan: item.beratBadan !== null ? serializeDecimal(item.beratBadan) : null,
        tanggal: item.tanggal.toISOString(),
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaPasien?: string;
      kv?: number;
      sekon?: number;
      mAs?: number;
      beratBadan?: number;
      tanggal?: string;
    };
  }>('/api/kondisi-alat/:id', async (req, reply) => {
    const existing = await prisma.kondisiAlat.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data kondisi alat tidak ditemukan' });
    const item = await prisma.kondisiAlat.update({
      where: { id: req.params.id },
      data: {
        namaPasien: req.body.namaPasien?.trim() ?? existing.namaPasien,
        kv: req.body.kv !== undefined ? req.body.kv : existing.kv,
        sekon: req.body.sekon !== undefined ? req.body.sekon : existing.sekon,
        mAs: req.body.mAs !== undefined ? req.body.mAs : existing.mAs,
        beratBadan: req.body.beratBadan !== undefined ? req.body.beratBadan : existing.beratBadan,
        tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
      },
    });
    return {
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        kv: serializeDecimal(item.kv),
        sekon: serializeDecimal(item.sekon),
        mAs: serializeDecimal(item.mAs),
        beratBadan: item.beratBadan !== null ? serializeDecimal(item.beratBadan) : null,
        tanggal: item.tanggal.toISOString(),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/kondisi-alat/:id', async (req) => {
    await prisma.kondisiAlat.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery & { bulan?: string } }>('/api/gaji-karyawan', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const q = req.query.q?.trim();
    const where = {
      ...(q ? { namaKaryawan: { contains: q } } : {}),
      ...(req.query.bulan ? { bulan: req.query.bulan } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.gajiKaryawan.count({ where }),
      prisma.gajiKaryawan.findMany({
        where,
        orderBy: [{ bulan: 'desc' }, { namaKaryawan: 'asc' }],
        skip,
        take: limit,
      }),
    ]);
    return {
      items: items.map((g) => ({
        id: g.id,
        namaKaryawan: g.namaKaryawan,
        jabatan: g.jabatan,
        bulan: g.bulan,
        tanggal: g.tanggal.toISOString(),
        gajiPokok: serializeDecimal(g.gajiPokok),
        tunjangan: serializeDecimal(g.tunjangan),
        potongan: serializeDecimal(g.potongan),
        gajiBersih: serializeDecimal(g.gajiBersih),
      })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      namaKaryawan: string;
      jabatan?: string;
      bulan: string;
      tanggal?: string;
      gajiPokok: number;
      tunjangan?: number;
      potongan?: number;
    };
  }>('/api/gaji-karyawan', async (req, reply) => {
    const b = req.body;
    if (!b.namaKaryawan?.trim() || !b.bulan?.trim() || b.gajiPokok === undefined) {
      return badRequest(reply, 'namaKaryawan, bulan, gajiPokok wajib diisi');
    }
    const gajiPokok = b.gajiPokok;
    const tunjangan = b.tunjangan ?? 0;
    const potongan = b.potongan ?? 0;
    const item = await prisma.gajiKaryawan.create({
      data: {
        namaKaryawan: b.namaKaryawan.trim(),
        jabatan: b.jabatan?.trim() || null,
        bulan: b.bulan.trim(),
        tanggal: b.tanggal ? new Date(b.tanggal) : new Date(),
        gajiPokok,
        tunjangan,
        potongan,
        gajiBersih: gajiPokok + tunjangan - potongan,
      },
    });
    return reply.status(201).send({
      item: {
        id: item.id,
        namaKaryawan: item.namaKaryawan,
        jabatan: item.jabatan,
        bulan: item.bulan,
        tanggal: item.tanggal.toISOString(),
        gajiPokok: serializeDecimal(item.gajiPokok),
        tunjangan: serializeDecimal(item.tunjangan),
        potongan: serializeDecimal(item.potongan),
        gajiBersih: serializeDecimal(item.gajiBersih),
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaKaryawan?: string;
      jabatan?: string;
      bulan?: string;
      tanggal?: string;
      gajiPokok?: number;
      tunjangan?: number;
      potongan?: number;
    };
  }>('/api/gaji-karyawan/:id', async (req, reply) => {
    const existing = await prisma.gajiKaryawan.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data gaji karyawan tidak ditemukan' });
    const gajiPokok = req.body.gajiPokok ?? Number(existing.gajiPokok);
    const tunjangan = req.body.tunjangan ?? Number(existing.tunjangan);
    const potongan = req.body.potongan ?? Number(existing.potongan);
    const item = await prisma.gajiKaryawan.update({
      where: { id: req.params.id },
      data: {
        namaKaryawan: req.body.namaKaryawan?.trim() ?? existing.namaKaryawan,
        jabatan: req.body.jabatan !== undefined ? req.body.jabatan?.trim() || null : existing.jabatan,
        bulan: req.body.bulan?.trim() ?? existing.bulan,
        tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
        gajiPokok,
        tunjangan,
        potongan,
        gajiBersih: gajiPokok + tunjangan - potongan,
      },
    });
    return {
      item: {
        id: item.id,
        namaKaryawan: item.namaKaryawan,
        jabatan: item.jabatan,
        bulan: item.bulan,
        tanggal: item.tanggal.toISOString(),
        gajiPokok: serializeDecimal(item.gajiPokok),
        tunjangan: serializeDecimal(item.tunjangan),
        potongan: serializeDecimal(item.potongan),
        gajiBersih: serializeDecimal(item.gajiBersih),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/gaji-karyawan/:id', async (req) => {
    await prisma.gajiKaryawan.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery & { departemen?: string } }>('/api/karyawan', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const q = req.query.q?.trim();
    const where = {
      ...(req.query.departemen ? { departemen: req.query.departemen } : {}),
      ...(q ? { nama: { contains: q } } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.karyawan.count({ where }),
      prisma.karyawan.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: {
      nama: string;
      jabatan?: string;
      noTelepon?: string;
      alamat?: string;
      departemen: string;
    };
  }>('/api/karyawan', async (req, reply) => {
    const b = req.body;
    if (!b.nama?.trim() || !b.departemen?.trim()) {
      return badRequest(reply, 'nama, departemen wajib diisi');
    }
    const item = await prisma.karyawan.create({
      data: {
        nama: b.nama.trim(),
        jabatan: b.jabatan?.trim() || null,
        noTelepon: b.noTelepon?.trim() || null,
        alamat: b.alamat?.trim() || null,
        departemen: b.departemen.trim(),
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nama?: string;
      jabatan?: string;
      noTelepon?: string;
      alamat?: string;
    };
  }>('/api/karyawan/:id', async (req, reply) => {
    const existing = await prisma.karyawan.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Karyawan tidak ditemukan' });
    const item = await prisma.karyawan.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        jabatan: req.body.jabatan !== undefined ? req.body.jabatan?.trim() || null : existing.jabatan,
        noTelepon:
          req.body.noTelepon !== undefined ? req.body.noTelepon?.trim() || null : existing.noTelepon,
        alamat: req.body.alamat !== undefined ? req.body.alamat?.trim() || null : existing.alamat,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/karyawan/:id', async (req) => {
    await prisma.karyawan.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery & { startDate?: string; endDate?: string } }>(
    '/api/bhp-radiologi',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const q = req.query.q?.trim();
      const { startDate, endDate } = req.query;
      const where = {
        ...(q ? { pemakaian: { contains: q } } : {}),
        ...(startDate || endDate
          ? {
              tanggal: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {}),
              },
            }
          : {}),
      };
      const [total, items] = await Promise.all([
        prisma.bhpRadiologi.count({ where }),
        prisma.bhpRadiologi.findMany({
          where,
          orderBy: { tanggal: 'desc' },
          skip,
          take: limit,
        }),
      ]);
      return {
        items: items.map((b) => ({
          id: b.id,
          tanggal: b.tanggal.toISOString(),
          pemakaian: b.pemakaian,
          harga: serializeDecimal(b.harga),
          dev: serializeDecimal(b.dev),
          fixer: serializeDecimal(b.fixer),
          film: serializeDecimal(b.film),
          amplopKertas: serializeDecimal(b.amplopKertas),
          listrik: serializeDecimal(b.listrik),
          gajiKaryawan: serializeDecimal(b.gajiKaryawan),
          kertasCetak: serializeDecimal(b.kertasCetak),
          amplop: serializeDecimal(b.amplop),
        })),
        pagination: buildPaginationMeta(total, page, limit),
      };
    },
  );

  app.post<{
    Body: {
      tanggal?: string;
      pemakaian: string;
      harga?: number;
      dev?: number;
      fixer?: number;
      film?: number;
      amplopKertas?: number;
      listrik?: number;
      gajiKaryawan?: number;
      kertasCetak?: number;
      amplop?: number;
    };
  }>('/api/bhp-radiologi', async (req, reply) => {
    const b = req.body;
    if (!b.pemakaian?.trim()) {
      return badRequest(reply, 'pemakaian wajib diisi');
    }
    const item = await prisma.bhpRadiologi.create({
      data: {
        tanggal: b.tanggal ? new Date(b.tanggal) : new Date(),
        pemakaian: b.pemakaian.trim(),
        harga: b.harga ?? 0,
        dev: b.dev ?? 0,
        fixer: b.fixer ?? 0,
        film: b.film ?? 0,
        amplopKertas: b.amplopKertas ?? 0,
        listrik: b.listrik ?? 0,
        gajiKaryawan: b.gajiKaryawan ?? 0,
        kertasCetak: b.kertasCetak ?? 0,
        amplop: b.amplop ?? 0,
      },
    });
    return reply.status(201).send({
      item: {
        id: item.id,
        tanggal: item.tanggal.toISOString(),
        pemakaian: item.pemakaian,
        harga: serializeDecimal(item.harga),
        dev: serializeDecimal(item.dev),
        fixer: serializeDecimal(item.fixer),
        film: serializeDecimal(item.film),
        amplopKertas: serializeDecimal(item.amplopKertas),
        listrik: serializeDecimal(item.listrik),
        gajiKaryawan: serializeDecimal(item.gajiKaryawan),
        kertasCetak: serializeDecimal(item.kertasCetak),
        amplop: serializeDecimal(item.amplop),
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      tanggal?: string;
      pemakaian?: string;
      harga?: number;
      dev?: number;
      fixer?: number;
      film?: number;
      amplopKertas?: number;
      listrik?: number;
      gajiKaryawan?: number;
      kertasCetak?: number;
      amplop?: number;
    };
  }>('/api/bhp-radiologi/:id', async (req, reply) => {
    const existing = await prisma.bhpRadiologi.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data BHP radiologi tidak ditemukan' });
    const item = await prisma.bhpRadiologi.update({
      where: { id: req.params.id },
      data: {
        tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
        pemakaian: req.body.pemakaian?.trim() ?? existing.pemakaian,
        harga: req.body.harga !== undefined ? req.body.harga : existing.harga,
        dev: req.body.dev !== undefined ? req.body.dev : existing.dev,
        fixer: req.body.fixer !== undefined ? req.body.fixer : existing.fixer,
        film: req.body.film !== undefined ? req.body.film : existing.film,
        amplopKertas:
          req.body.amplopKertas !== undefined ? req.body.amplopKertas : existing.amplopKertas,
        listrik: req.body.listrik !== undefined ? req.body.listrik : existing.listrik,
        gajiKaryawan:
          req.body.gajiKaryawan !== undefined ? req.body.gajiKaryawan : existing.gajiKaryawan,
        kertasCetak: req.body.kertasCetak !== undefined ? req.body.kertasCetak : existing.kertasCetak,
        amplop: req.body.amplop !== undefined ? req.body.amplop : existing.amplop,
      },
    });
    return {
      item: {
        id: item.id,
        tanggal: item.tanggal.toISOString(),
        pemakaian: item.pemakaian,
        harga: serializeDecimal(item.harga),
        dev: serializeDecimal(item.dev),
        fixer: serializeDecimal(item.fixer),
        film: serializeDecimal(item.film),
        amplopKertas: serializeDecimal(item.amplopKertas),
        listrik: serializeDecimal(item.listrik),
        gajiKaryawan: serializeDecimal(item.gajiKaryawan),
        kertasCetak: serializeDecimal(item.kertasCetak),
        amplop: serializeDecimal(item.amplop),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/bhp-radiologi/:id', async (req) => {
    await prisma.bhpRadiologi.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Pemakaian Film Rontgen (log harian, stok otomatis berkurang) ─────────

  function serializePemakaianFilm(item: {
    id: string;
    tanggal: Date;
    pemakaianHarian: number;
    stok: number;
    tanggalPembelian: Date | null;
    jumlahPembelian: number;
    hargaPembelian: unknown;
  }): {
    id: string;
    tanggal: string;
    pemakaianHarian: number;
    stok: number;
    tanggalPembelian: string | null;
    jumlahPembelian: number;
    hargaPembelian: string | null;
  } {
    return {
      id: item.id,
      tanggal: item.tanggal.toISOString(),
      pemakaianHarian: item.pemakaianHarian,
      stok: item.stok,
      tanggalPembelian: item.tanggalPembelian ? item.tanggalPembelian.toISOString() : null,
      jumlahPembelian: item.jumlahPembelian,
      hargaPembelian: serializeDecimal(item.hargaPembelian as never),
    };
  }

  /** Menghitung ulang saldo `stok` berjalan seluruh baris Pemakaian Film,
   * diurutkan dari tanggal paling awal, setelah baris manapun ditambah,
   * diubah, atau dihapus — supaya stok selalu konsisten dengan urutan tanggal
   * meski data lama diedit. */
  async function recomputePemakaianFilmStok(tx: TransactionClient): Promise<void> {
    const records = await tx.pemakaianFilm.findMany({
      orderBy: [{ tanggal: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, pemakaianHarian: true, jumlahPembelian: true, stok: true },
    });
    let running = 0;
    for (const r of records) {
      running = running - r.pemakaianHarian + r.jumlahPembelian;
      if (running !== r.stok) {
        await tx.pemakaianFilm.update({ where: { id: r.id }, data: { stok: running } });
      }
    }
  }

  app.get<{ Querystring: ListQuery & { startDate?: string; endDate?: string } }>(
    '/api/pemakaian-film',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const { startDate, endDate } = req.query;
      const where = {
        ...(startDate || endDate
          ? {
              tanggal: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {}),
              },
            }
          : {}),
      };
      const [total, items] = await Promise.all([
        prisma.pemakaianFilm.count({ where }),
        prisma.pemakaianFilm.findMany({
          where,
          orderBy: { tanggal: 'desc' },
          skip,
          take: limit,
        }),
      ]);
      return {
        items: items.map(serializePemakaianFilm),
        pagination: buildPaginationMeta(total, page, limit),
      };
    },
  );

  app.post<{
    Body: {
      tanggal?: string;
      pemakaianHarian?: number;
      tanggalPembelian?: string;
      jumlahPembelian?: number;
      hargaPembelian?: number;
    };
  }>('/api/pemakaian-film', async (req, reply) => {
    const b = req.body;
    try {
      const item = await prisma.$transaction(async (tx) => {
        const created = await tx.pemakaianFilm.create({
          data: {
            tanggal: b.tanggal ? new Date(b.tanggal) : new Date(),
            pemakaianHarian: Number(b.pemakaianHarian) || 0,
            tanggalPembelian: b.tanggalPembelian ? new Date(b.tanggalPembelian) : null,
            jumlahPembelian: Number(b.jumlahPembelian) || 0,
            hargaPembelian: b.hargaPembelian ? new Decimal(b.hargaPembelian) : new Decimal(0),
          },
        });
        await recomputePemakaianFilmStok(tx);
        return tx.pemakaianFilm.findUniqueOrThrow({ where: { id: created.id } });
      });
      return reply.status(201).send({ item: serializePemakaianFilm(item) });
    } catch (err) {
      return badRequest(
        reply,
        err instanceof Error ? err.message : 'Gagal menyimpan data pemakaian film',
      );
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      tanggal?: string;
      pemakaianHarian?: number;
      tanggalPembelian?: string | null;
      jumlahPembelian?: number;
      hargaPembelian?: number;
    };
  }>('/api/pemakaian-film/:id', async (req, reply) => {
    const existing = await prisma.pemakaianFilm.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data pemakaian film tidak ditemukan' });
    try {
      const item = await prisma.$transaction(async (tx) => {
        await tx.pemakaianFilm.update({
          where: { id: req.params.id },
          data: {
            tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
            pemakaianHarian:
              req.body.pemakaianHarian !== undefined
                ? Number(req.body.pemakaianHarian)
                : existing.pemakaianHarian,
            tanggalPembelian:
              req.body.tanggalPembelian !== undefined
                ? req.body.tanggalPembelian
                  ? new Date(req.body.tanggalPembelian)
                  : null
                : existing.tanggalPembelian,
            jumlahPembelian:
              req.body.jumlahPembelian !== undefined
                ? Number(req.body.jumlahPembelian)
                : existing.jumlahPembelian,
            hargaPembelian:
              req.body.hargaPembelian !== undefined
                ? new Decimal(req.body.hargaPembelian)
                : existing.hargaPembelian,
          },
        });
        await recomputePemakaianFilmStok(tx);
        return tx.pemakaianFilm.findUniqueOrThrow({ where: { id: req.params.id } });
      });
      return { item: serializePemakaianFilm(item) };
    } catch (err) {
      return badRequest(
        reply,
        err instanceof Error ? err.message : 'Gagal mengubah data pemakaian film',
      );
    }
  });

  app.delete<{ Params: { id: string } }>('/api/pemakaian-film/:id', async (req, reply) => {
    const existing = await prisma.pemakaianFilm.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data pemakaian film tidak ditemukan' });
    await prisma.$transaction(async (tx) => {
      await tx.pemakaianFilm.delete({ where: { id: req.params.id } });
      await recomputePemakaianFilmStok(tx);
    });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>(
    '/api/jenis-pemeriksaan',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const where = jenisListWhere(req.query.q);
      const [total, items] = await Promise.all([
        prisma.jenisPemeriksaan.count({ where }),
        prisma.jenisPemeriksaan.findMany({
          where,
          orderBy: { nama: 'asc' },
          include: { harga: true },
          skip,
          take: limit,
        }),
      ]);
      return {
        items: items.map((j) => ({
          id: j.id,
          nama: j.nama,
          jumlahFilm: j.jumlahFilm,
          harga: j.harga ? serializeDecimal(j.harga.harga) : null,
          detailLayanan: j.harga?.detailLayanan ?? null,
        })),
        pagination: buildPaginationMeta(total, page, limit),
      };
    },
  );

  app.post<{ Body: { nama: string; jumlahFilm?: number; harga?: number; detailLayanan?: string } }>(
    '/api/jenis-pemeriksaan',
    async (req, reply) => {
      if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
      const { harga, detailLayanan, jumlahFilm } = req.body;
      try {
        const item = await prisma.jenisPemeriksaan.create({
          data: {
            nama: req.body.nama.trim(),
            ...(jumlahFilm !== undefined ? { jumlahFilm } : {}),
            ...(harga !== undefined
              ? {
                  harga: {
                    create: {
                      harga,
                      detailLayanan: detailLayanan?.trim() || null,
                    },
                  },
                }
              : {}),
          },
          include: { harga: true },
        });
        return reply.status(201).send({
          item: {
            id: item.id,
            nama: item.nama,
            jumlahFilm: item.jumlahFilm,
            harga: item.harga ? serializeDecimal(item.harga.harga) : null,
            detailLayanan: item.harga?.detailLayanan ?? null,
          },
        });
      } catch (err: unknown) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          return badRequest(reply, `Jenis pemeriksaan "${req.body.nama.trim()}" sudah ada`);
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/jenis-pemeriksaan/:id',
    async (req, reply) => {
      try {
        await prisma.jenisPemeriksaan.delete({ where: { id: req.params.id } });
        return { ok: true };
      } catch {
        return reply.status(409).send({ error: 'Jenis pemeriksaan masih dipakai pasien' });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { nama?: string; jumlahFilm?: number; harga?: number; detailLayanan?: string } }>(
    '/api/jenis-pemeriksaan/:id',
    async (req, reply) => {
      const existing = await prisma.jenisPemeriksaan.findUnique({
        where: { id: req.params.id },
        include: { harga: true },
      });
      if (!existing) return reply.status(404).send({ error: 'Jenis tidak ditemukan' });
      if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');

      try {
        const item = await prisma.$transaction(async (tx) => {
          const jenis = await tx.jenisPemeriksaan.update({
            where: { id: req.params.id },
            data: {
              nama: req.body.nama!.trim(),
              ...(req.body.jumlahFilm !== undefined ? { jumlahFilm: req.body.jumlahFilm } : {}),
            },
          });
          if (req.body.harga !== undefined) {
            await tx.hargaLayanan.upsert({
              where: { jenisPemeriksaanId: req.params.id },
              create: {
                jenisPemeriksaanId: req.params.id,
                harga: req.body.harga,
                detailLayanan: req.body.detailLayanan?.trim() || null,
              },
              update: {
                harga: req.body.harga,
                detailLayanan:
                  req.body.detailLayanan !== undefined
                    ? req.body.detailLayanan?.trim() || null
                    : undefined,
              },
            });
          } else if (req.body.detailLayanan !== undefined && existing.harga) {
            await tx.hargaLayanan.update({
              where: { jenisPemeriksaanId: req.params.id },
              data: { detailLayanan: req.body.detailLayanan?.trim() || null },
            });
          }
          const withHarga = await tx.jenisPemeriksaan.findUnique({
            where: { id: jenis.id },
            include: { harga: true },
          });
          return withHarga!;
        });

        return {
          item: {
            id: item.id,
            nama: item.nama,
            jumlahFilm: item.jumlahFilm,
            harga: item.harga ? serializeDecimal(item.harga.harga) : null,
            detailLayanan: item.harga?.detailLayanan ?? null,
          },
        };
      } catch (err: unknown) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          return badRequest(reply, `Jenis pemeriksaan "${req.body.nama!.trim()}" sudah ada`);
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: ListQuery }>(
    '/api/harga-layanan',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const where = hargaListWhere(req.query.q);
      const [total, items] = await Promise.all([
        prisma.hargaLayanan.count({ where }),
        prisma.hargaLayanan.findMany({
          where,
          include: { jenisPemeriksaan: true },
          orderBy: { jenisPemeriksaan: { nama: 'asc' } },
          skip,
          take: limit,
        }),
      ]);
      return {
        items: items.map((h) => ({
          id: h.id,
          jenisPemeriksaanId: h.jenisPemeriksaanId,
          jenisNama: h.jenisPemeriksaan.nama,
          harga: serializeDecimal(h.harga),
          detailLayanan: h.detailLayanan,
        })),
        pagination: buildPaginationMeta(total, page, limit),
      };
    },
  );

  app.post<{
    Body: { jenisPemeriksaanId: string; harga: number; detailLayanan?: string };
  }>('/api/harga-layanan', async (req, reply) => {
    const { jenisPemeriksaanId, harga, detailLayanan } = req.body;
    if (!jenisPemeriksaanId || harga === undefined) {
      return badRequest(reply, 'jenisPemeriksaanId dan harga wajib');
    }
    const item = await prisma.hargaLayanan.upsert({
      where: { jenisPemeriksaanId },
      create: {
        jenisPemeriksaanId,
        harga,
        detailLayanan: detailLayanan?.trim() || null,
      },
      update: {
        harga,
        detailLayanan: detailLayanan?.trim() || null,
      },
    });
    return reply.status(201).send({
      item: { ...item, harga: serializeDecimal(item.harga) },
    });
  });

  app.delete<{ Params: { id: string } }>('/api/harga-layanan/:id', async (req) => {
    await prisma.hargaLayanan.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { harga?: number; detailLayanan?: string } }>(
    '/api/harga-layanan/:id',
    async (req, reply) => {
      const existing = await prisma.hargaLayanan.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Harga tidak ditemukan' });
      const item = await prisma.hargaLayanan.update({
        where: { id: req.params.id },
        data: {
          harga: req.body.harga ?? existing.harga,
          detailLayanan:
            req.body.detailLayanan !== undefined
              ? req.body.detailLayanan?.trim() || null
              : existing.detailLayanan,
        },
      });
      return { item: { ...item, harga: serializeDecimal(item.harga) } };
    },
  );

  app.get<{ Querystring: ListQuery }>(
    '/api/kesan-template',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const where = kesanListWhere(req.query.q);
      const [total, items] = await Promise.all([
        prisma.kesanTemplate.count({ where }),
        prisma.kesanTemplate.findMany({ where, orderBy: { judul: 'asc' }, skip, take: limit }),
      ]);
      return { items, pagination: buildPaginationMeta(total, page, limit) };
    },
  );

  app.post<{ Body: { judul: string; isi: string; gambar?: string } }>(
    '/api/kesan-template',
    async (req, reply) => {
      if (!req.body.judul?.trim() || !req.body.isi?.trim()) {
        return badRequest(reply, 'judul dan isi wajib');
      }
      const item = await prisma.kesanTemplate.create({
        data: {
          judul: req.body.judul.trim(),
          isi: req.body.isi.trim(),
          gambar: req.body.gambar || null,
        },
      });
      return reply.status(201).send({ item });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/kesan-template/:id', async (req) => {
    await prisma.kesanTemplate.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { judul?: string; isi?: string; gambar?: string } }>(
    '/api/kesan-template/:id',
    async (req, reply) => {
      const existing = await prisma.kesanTemplate.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Template tidak ditemukan' });
      const item = await prisma.kesanTemplate.update({
        where: { id: req.params.id },
        data: {
          judul: req.body.judul?.trim() ?? existing.judul,
          isi: req.body.isi?.trim() ?? existing.isi,
          gambar: req.body.gambar !== undefined ? req.body.gambar || null : existing.gambar,
        },
      });
      return { item };
    },
  );

  // ─── Anatomi (galeri gambar referensi per regio) ───────────────────────────

  app.get<{ Querystring: { regio?: string } }>('/api/anatomi-gambar', async (req) => {
    if (!req.query.regio) return { items: [] };
    const items = await prisma.anatomiGambar.findMany({
      where: { regio: req.query.regio },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        regio: true,
        keterangan: true,
        createdAt: true,
        thumbnail: true,
        // Fallback untuk data lama yang diunggah sebelum ada kolom thumbnail.
        gambar: true,
      },
    });
    // Daftar galeri memuat versi kecil (thumbnail) supaya cepat; versi ukuran
    // penuh dipanggil terpisah lewat GET /api/anatomi-gambar/:id saat di-zoom.
    return {
      items: items.map(({ gambar, thumbnail, ...rest }) => ({
        ...rest,
        gambar: thumbnail ?? gambar,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/anatomi-gambar/:id', async (req, reply) => {
    const item = await prisma.anatomiGambar.findUnique({ where: { id: req.params.id } });
    if (!item) return reply.status(404).send({ error: 'Gambar tidak ditemukan' });
    return { item };
  });

  app.post<{ Body: { regio: string; gambar: string; thumbnail?: string; keterangan?: string } }>(
    '/api/anatomi-gambar',
    async (req, reply) => {
      if (!req.body.regio?.trim() || !req.body.gambar?.trim()) {
        return badRequest(reply, 'regio dan gambar wajib');
      }
      const item = await prisma.anatomiGambar.create({
        data: {
          regio: req.body.regio.trim(),
          gambar: req.body.gambar,
          thumbnail: req.body.thumbnail || req.body.gambar,
          keterangan: req.body.keterangan?.trim() || null,
        },
      });
      return reply.status(201).send({ item });
    },
  );

  app.patch<{ Params: { id: string }; Body: { keterangan?: string } }>(
    '/api/anatomi-gambar/:id',
    async (req, reply) => {
      const existing = await prisma.anatomiGambar.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Gambar tidak ditemukan' });
      const item = await prisma.anatomiGambar.update({
        where: { id: req.params.id },
        data: {
          keterangan: req.body.keterangan !== undefined ? req.body.keterangan.trim() || null : existing.keterangan,
        },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/anatomi-gambar/:id', async (req) => {
    await prisma.anatomiGambar.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Kesan Bacaan (grup > kategori > bacaan, menu cepat isi Kesan) ─────────

  app.get('/api/kesan-bacaan-grup', async () => {
    const items = await prisma.kesanBacaanGrup.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        kategori: {
          orderBy: [{ urutan: 'asc' }, { createdAt: 'asc' }],
          include: { bacaan: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    return { items };
  });

  app.post<{ Body: { nama: string } }>('/api/kesan-bacaan-grup', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama grup wajib');
    const item = await prisma.kesanBacaanGrup.create({ data: { nama: req.body.nama.trim() } });
    return reply.status(201).send({ item });
  });

  app.patch<{ Params: { id: string }; Body: { nama?: string } }>(
    '/api/kesan-bacaan-grup/:id',
    async (req, reply) => {
      const existing = await prisma.kesanBacaanGrup.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Grup tidak ditemukan' });
      const item = await prisma.kesanBacaanGrup.update({
        where: { id: req.params.id },
        data: { nama: req.body.nama?.trim() || existing.nama },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/kesan-bacaan-grup/:id', async (req) => {
    await prisma.kesanBacaanGrup.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.post<{ Body: { grupId: string; nama: string; urutan?: number } }>(
    '/api/kesan-bacaan-kategori',
    async (req, reply) => {
      if (!req.body.grupId || !req.body.nama?.trim()) {
        return badRequest(reply, 'grupId dan nama kategori wajib');
      }
      const grup = await prisma.kesanBacaanGrup.findUnique({ where: { id: req.body.grupId } });
      if (!grup) return badRequest(reply, 'Grup tidak valid');
      const item = await prisma.kesanBacaanKategori.create({
        data: {
          grupId: req.body.grupId,
          nama: req.body.nama.trim(),
          urutan: req.body.urutan ?? 0,
        },
      });
      return reply.status(201).send({ item });
    },
  );

  app.patch<{ Params: { id: string }; Body: { nama?: string } }>(
    '/api/kesan-bacaan-kategori/:id',
    async (req, reply) => {
      const existing = await prisma.kesanBacaanKategori.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Kategori tidak ditemukan' });
      const item = await prisma.kesanBacaanKategori.update({
        where: { id: req.params.id },
        data: { nama: req.body.nama?.trim() || existing.nama },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/kesan-bacaan-kategori/:id', async (req) => {
    await prisma.kesanBacaanKategori.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.post<{ Body: { kategoriId: string; teks: string } }>(
    '/api/kesan-bacaan',
    async (req, reply) => {
      if (!req.body.kategoriId || !req.body.teks?.trim()) {
        return badRequest(reply, 'kategoriId dan teks wajib');
      }
      const kategori = await prisma.kesanBacaanKategori.findUnique({
        where: { id: req.body.kategoriId },
      });
      if (!kategori) return badRequest(reply, 'Kategori tidak valid');
      const item = await prisma.kesanBacaan.create({
        data: { kategoriId: req.body.kategoriId, teks: req.body.teks.trim() },
      });
      return reply.status(201).send({ item });
    },
  );

  app.patch<{ Params: { id: string }; Body: { teks?: string } }>(
    '/api/kesan-bacaan/:id',
    async (req, reply) => {
      const existing = await prisma.kesanBacaan.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Bacaan tidak ditemukan' });
      const item = await prisma.kesanBacaan.update({
        where: { id: req.params.id },
        data: { teks: req.body.teks?.trim() || existing.teks },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/kesan-bacaan/:id', async (req) => {
    await prisma.kesanBacaan.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Playlist Lagu (Musik-PH) ───────────────────────────────────────────────

  app.get('/api/playlist-lagu', async () => {
    const items = await prisma.playlistLagu.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, judul: true, lirik: true, createdAt: true },
    });
    return { items };
  });

  app.get<{ Params: { id: string } }>('/api/playlist-lagu/:id/audio', async (req, reply) => {
    const item = await prisma.playlistLagu.findUnique({
      where: { id: req.params.id },
      select: { audioData: true },
    });
    if (!item) return reply.status(404).send({ error: 'Lagu tidak ditemukan' });
    const match = item.audioData.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) return reply.status(500).send({ error: 'Format audio tidak valid' });
    const [, mime, base64] = match;
    const buffer = Buffer.from(base64!, 'base64');
    reply.header('Content-Type', mime);
    reply.header('Content-Length', String(buffer.length));
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(buffer);
  });

  app.post<{ Body: { judul: string; audioData: string; lirik?: string } }>(
    '/api/playlist-lagu',
    async (req, reply) => {
      if (!req.body.judul?.trim() || !req.body.audioData?.trim()) {
        return badRequest(reply, 'judul dan audioData wajib');
      }
      const item = await prisma.playlistLagu.create({
        data: {
          judul: req.body.judul.trim(),
          audioData: req.body.audioData,
          lirik: req.body.lirik?.trim() || null,
        },
      });
      return reply.status(201).send({ item });
    },
  );

  app.patch<{ Params: { id: string }; Body: { judul?: string; lirik?: string } }>(
    '/api/playlist-lagu/:id',
    async (req, reply) => {
      const existing = await prisma.playlistLagu.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Lagu tidak ditemukan' });
      const item = await prisma.playlistLagu.update({
        where: { id: req.params.id },
        data: {
          judul: req.body.judul?.trim() || existing.judul,
          lirik: req.body.lirik !== undefined ? req.body.lirik.trim() || null : existing.lirik,
        },
      });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/playlist-lagu/:id', async (req) => {
    await prisma.playlistLagu.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Paket Laboratorium ─────────────────────────────────────────────────────

  app.get('/api/paket-lab', async () => {
    const items = await prisma.paketLab.findMany({
      orderBy: { urutan: 'asc' },
      include: { items: { orderBy: { urutan: 'asc' } } },
    });
    return {
      items: items.map((p) => ({
        ...p,
        harga: serializeDecimal(p.harga),
        items: p.items.map((it) => ({
          ...it,
          harga: serializeDecimal(it.harga),
        })),
      })),
    };
  });

  app.post('/api/paket-lab/init-defaults', async () => {
    const defaultSeed = [
      {
        nama: 'Hematologi',
        urutan: 1,
        harga: 150000,
        items: [
          { pemeriksaan: 'Hemoglobin (Hb)', nilaiRujukan: '12 - 16 g/dL', satuan: 'g/dL', harga: 30000, urutan: 1 },
          { pemeriksaan: 'Leukosit (WBC)', nilaiRujukan: '4.000 - 10.000 /µL', satuan: '/µL', harga: 25000, urutan: 2 },
          { pemeriksaan: 'Trombosit (PLT)', nilaiRujukan: '150.000 - 400.000 /µL', satuan: '/µL', harga: 30000, urutan: 3 },
          { pemeriksaan: 'Erytrosit (RBC)', nilaiRujukan: '4,0 - 5,5 juta/µL', satuan: 'juta/µL', harga: 25000, urutan: 4 },
          { pemeriksaan: 'Hematokrit (Ht)', nilaiRujukan: '37 - 48 %', satuan: '%', harga: 25000, urutan: 5 },
          { pemeriksaan: 'MCV', nilaiRujukan: '80 - 100 fL', satuan: 'fL', harga: 20000, urutan: 6 },
          { pemeriksaan: 'MCH', nilaiRujukan: '27 - 34 pg', satuan: 'pg', harga: 20000, urutan: 7 },
          { pemeriksaan: 'MCHC', nilaiRujukan: '32 - 36 g/dL', satuan: 'g/dL', harga: 20000, urutan: 8 },
        ],
      },
      {
        nama: 'Kimia darah',
        urutan: 2,
        harga: 250000,
        items: [
          { pemeriksaan: 'SGOT (AST)', nilaiRujukan: '< 35 U/L', satuan: 'U/L', harga: 35000, urutan: 1 },
          { pemeriksaan: 'SGPT (ALT)', nilaiRujukan: '< 40 U/L', satuan: 'U/L', harga: 35000, urutan: 2 },
          { pemeriksaan: 'Ureum', nilaiRujukan: '15 - 45 mg/dL', satuan: 'mg/dL', harga: 35000, urutan: 3 },
          { pemeriksaan: 'Kreatinin', nilaiRujukan: '0,6 - 1,2 mg/dL', satuan: 'mg/dL', harga: 40000, urutan: 4 },
          { pemeriksaan: 'Asam Urat', nilaiRujukan: '2,4 - 7,0 mg/dL', satuan: 'mg/dL', harga: 35000, urutan: 5 },
          { pemeriksaan: 'Kolesterol Total', nilaiRujukan: '< 200 mg/dL', satuan: 'mg/dL', harga: 35000, urutan: 6 },
          { pemeriksaan: 'Trigliserida', nilaiRujukan: '< 150 mg/dL', satuan: 'mg/dL', harga: 35000, urutan: 7 },
          { pemeriksaan: 'HDL Kolesterol', nilaiRujukan: '> 40 mg/dL', satuan: 'mg/dL', harga: 40000, urutan: 8 },
          { pemeriksaan: 'LDL Kolesterol', nilaiRujukan: '< 100 mg/dL', satuan: 'mg/dL', harga: 40000, urutan: 9 },
          { pemeriksaan: 'Bilirubin Total', nilaiRujukan: '0,2 - 1,2 mg/dL', satuan: 'mg/dL', harga: 35000, urutan: 10 },
        ],
      },
      {
        nama: 'Diabetes',
        urutan: 3,
        harga: 120000,
        items: [
          { pemeriksaan: 'Gula Darah Sewaktu (GDS)', nilaiRujukan: '< 200 mg/dL', satuan: 'mg/dL', harga: 25000, urutan: 1 },
          { pemeriksaan: 'Gula Darah Puasa (GDP)', nilaiRujukan: '70 - 110 mg/dL', satuan: 'mg/dL', harga: 25000, urutan: 2 },
          { pemeriksaan: 'Gula Darah 2 Jam PP', nilaiRujukan: '< 140 mg/dL', satuan: 'mg/dL', harga: 25000, urutan: 3 },
          { pemeriksaan: 'HbA1c', nilaiRujukan: '< 5,7 %', satuan: '%', harga: 80000, urutan: 4 },
        ],
      },
      {
        nama: 'Urinalisa',
        urutan: 4,
        harga: 75000,
        items: [
          { pemeriksaan: 'Warna', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Kuning Muda - Kuning', satuan: '-', harga: 3000, urutan: 1 },
          { pemeriksaan: 'Kejernihan', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Jernih', satuan: '-', harga: 3000, urutan: 2 },
          { pemeriksaan: 'LEU', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 5000, urutan: 3 },
          { pemeriksaan: 'NIT', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 5000, urutan: 4 },
          { pemeriksaan: 'PRO', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 5000, urutan: 5 },
          { pemeriksaan: 'URO', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Normal', satuan: '-', harga: 5000, urutan: 6 },
          { pemeriksaan: 'pH', grup: 'Urinalisa - Makroskopis', nilaiRujukan: '4,5 - 8,0', satuan: '-', harga: 5000, urutan: 7 },
          { pemeriksaan: 'BLO', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 5000, urutan: 8 },
          { pemeriksaan: 'SG', grup: 'Urinalisa - Makroskopis', nilaiRujukan: '1,005 - 1,030', satuan: '-', harga: 5000, urutan: 9 },
          { pemeriksaan: 'KET', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 5000, urutan: 10 },
          { pemeriksaan: 'BIL', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 5000, urutan: 11 },
          { pemeriksaan: 'GLU', grup: 'Urinalisa - Makroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 5000, urutan: 12 },
          { pemeriksaan: 'Sedimen Urine', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: '-', satuan: '-', harga: 3000, urutan: 13 },
          { pemeriksaan: 'Eritrosit (RBC)', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: '0 - 2 /LPB', satuan: '/LPB', harga: 3000, urutan: 14 },
          { pemeriksaan: 'Leukosit (WBC)', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: '0 - 5 /LPB', satuan: '/LPB', harga: 3000, urutan: 15 },
          { pemeriksaan: 'Epitel', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: 'Positif (+)', satuan: '-', harga: 3000, urutan: 16 },
          { pemeriksaan: 'Bakteri', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 3000, urutan: 17 },
          { pemeriksaan: 'Kristal', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 3000, urutan: 18 },
          { pemeriksaan: 'Silinder (Casts)', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 3000, urutan: 19 },
          { pemeriksaan: 'Jamur/Yeast', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 3000, urutan: 20 },
          { pemeriksaan: 'Trichomonas', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: 'Negatif (bila ditemukan)', satuan: '-', harga: 3000, urutan: 21 },
          { pemeriksaan: 'Mucus/Thread', grup: 'Urinalisa - Mikroskopis', nilaiRujukan: 'Negatif', satuan: '-', harga: 3000, urutan: 22 },
        ],
      },
      {
        nama: 'Urin rutin',
        urutan: 5,
        harga: 65000,
        items: [
          { pemeriksaan: 'LEU', nilaiRujukan: 'Negatif', satuan: '-', harga: 6500, urutan: 1 },
          { pemeriksaan: 'NIT', nilaiRujukan: 'Negatif', satuan: '-', harga: 6500, urutan: 2 },
          { pemeriksaan: 'PRO', nilaiRujukan: 'Negatif', satuan: '-', harga: 6500, urutan: 3 },
          { pemeriksaan: 'URO', nilaiRujukan: 'Normal', satuan: '-', harga: 6500, urutan: 4 },
          { pemeriksaan: 'pH', nilaiRujukan: '4,5 - 8,0', satuan: '-', harga: 6500, urutan: 5 },
          { pemeriksaan: 'BLO', nilaiRujukan: 'Negatif', satuan: '-', harga: 6500, urutan: 6 },
          { pemeriksaan: 'SG', nilaiRujukan: '1,005 - 1,030', satuan: '-', harga: 6500, urutan: 7 },
          { pemeriksaan: 'KET', nilaiRujukan: 'Negatif', satuan: '-', harga: 6500, urutan: 8 },
          { pemeriksaan: 'BIL', nilaiRujukan: 'Negatif', satuan: '-', harga: 6500, urutan: 9 },
          { pemeriksaan: 'GLU', nilaiRujukan: 'Negatif', satuan: '-', harga: 6500, urutan: 10 },
        ],
      },
      {
        nama: 'Imunologi',
        urutan: 6,
        harga: 200000,
        items: [
          { pemeriksaan: 'HBsAg', nilaiRujukan: 'Non-Reaktif', satuan: '-', harga: 60000, urutan: 1 },
          { pemeriksaan: 'Anti-HBs', nilaiRujukan: '> 10 mIU/mL', satuan: 'mIU/mL', harga: 70000, urutan: 2 },
          { pemeriksaan: 'Dengue IgG / IgM', nilaiRujukan: 'Negatif', satuan: '-', harga: 120000, urutan: 3 },
          { pemeriksaan: 'Anti-HIV', nilaiRujukan: 'Non-Reaktif', satuan: '-', harga: 90000, urutan: 4 },
          { pemeriksaan: 'TPHA / VDRL', nilaiRujukan: 'Non-Reaktif', satuan: '-', harga: 70000, urutan: 5 },
        ],
      },
      {
        nama: 'Diffcount',
        urutan: 7,
        harga: 50000,
        items: [
          { pemeriksaan: 'Eosinofil', nilaiRujukan: '0 - 3 %', satuan: '%', harga: 10000, urutan: 1 },
          { pemeriksaan: 'Basofil', nilaiRujukan: '0 - 1 %', satuan: '%', harga: 10000, urutan: 2 },
          { pemeriksaan: 'Staff', nilaiRujukan: '0 - 4 %', satuan: '%', harga: 10000, urutan: 3 },
          { pemeriksaan: 'Netrofil Segmen', nilaiRujukan: '50 - 70 %', satuan: '%', harga: 10000, urutan: 4 },
          { pemeriksaan: 'Limposit', nilaiRujukan: '20 - 40 %', satuan: '%', harga: 10000, urutan: 5 },
          { pemeriksaan: 'Monosit', nilaiRujukan: '2 - 8 %', satuan: '%', harga: 10000, urutan: 6 },
        ],
      },
      {
        nama: 'Laju Endap Darah',
        urutan: 8,
        harga: 30000,
        items: [
          { pemeriksaan: 'LED', nilaiRujukan: '< 20 mm/jam', satuan: 'mm/jam', harga: 30000, urutan: 1 },
        ],
      },
      {
        nama: 'Widal',
        urutan: 9,
        harga: 50000,
        items: [
          { pemeriksaan: 'Salmonella Typhi O', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 1 },
          { pemeriksaan: 'Salmonella Paratyphi AO', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 2 },
          { pemeriksaan: 'Salmonella Paratyphi BO', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 3 },
          { pemeriksaan: 'Salmonella Paratyphi CO', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 4 },
          { pemeriksaan: 'Salmonella Typhi H', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 5 },
          { pemeriksaan: 'Salmonella Paratyphi AH', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 6 },
          { pemeriksaan: 'Salmonella Paratyphi BH', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 7 },
          { pemeriksaan: 'Salmonella Paratyphi CH', nilaiRujukan: '(-) Negatif', satuan: 'Titer', harga: 6250, urutan: 8 },
        ],
      },
    ];

    for (const pkg of defaultSeed) {
      let existing = await prisma.paketLab.findUnique({ where: { nama: pkg.nama } });
      if (!existing) {
        existing = await prisma.paketLab.create({
          data: {
            nama: pkg.nama,
            urutan: pkg.urutan,
            harga: new Decimal(pkg.harga),
          },
        });
      }
      const itemCount = await prisma.paketLabItem.count({ where: { paketId: existing.id } });
      if (itemCount === 0) {
        await prisma.paketLabItem.createMany({
          data: pkg.items.map((it) => ({
            paketId: existing.id,
            grup: 'grup' in it ? it.grup : undefined,
            pemeriksaan: it.pemeriksaan,
            nilaiRujukan: it.nilaiRujukan,
            satuan: it.satuan,
            harga: new Decimal(it.harga),
            urutan: it.urutan,
          })),
        });
      }
    }
    return { ok: true };
  });

  app.post<{
    Body: { nama: string; urutan?: number; harga?: string | number };
  }>('/api/paket-lab', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const existing = await prisma.paketLab.findUnique({ where: { nama: req.body.nama.trim() } });
    if (existing) return badRequest(reply, 'Nama paket sudah ada');
    const item = await prisma.paketLab.create({
      data: {
        nama: req.body.nama.trim(),
        urutan: req.body.urutan ?? 0,
        harga: req.body.harga ? new Decimal(req.body.harga) : new Decimal(0),
      },
      include: { items: true },
    });
    return reply.status(201).send({
      item: {
        ...item,
        harga: serializeDecimal(item.harga),
        items: item.items.map((it) => ({ ...it, harga: serializeDecimal(it.harga) })),
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: { nama?: string; urutan?: number; harga?: string | number };
  }>('/api/paket-lab/:id', async (req, reply) => {
    const existing = await prisma.paketLab.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Paket tidak ditemukan' });
    const item = await prisma.paketLab.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        urutan: req.body.urutan ?? existing.urutan,
        harga: req.body.harga !== undefined ? new Decimal(req.body.harga) : existing.harga,
      },
      include: { items: { orderBy: { urutan: 'asc' } } },
    });
    return {
      item: {
        ...item,
        harga: serializeDecimal(item.harga),
        items: item.items.map((it) => ({ ...it, harga: serializeDecimal(it.harga) })),
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/paket-lab/:id', async (req, reply) => {
    try {
      await prisma.paketLab.delete({ where: { id: req.params.id } });
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: 'Paket tidak ditemukan' });
    }
  });

  // Replace all items in a paket (PUT or PATCH = full replace)
  const replaceItemsHandler = async (
    req: FastifyRequest<{
      Params: { id: string };
      Body: {
        items: {
          grup?: string;
          pemeriksaan: string;
          nilaiRujukan?: string;
          satuan?: string;
          harga?: string | number;
          urutan?: number;
        }[];
      };
    }>,
    reply: FastifyReply,
  ) => {
    const existing = await prisma.paketLab.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Paket tidak ditemukan' });
    if (!Array.isArray(req.body.items)) return badRequest(reply, 'items harus berupa array');

    await prisma.$transaction(async (tx) => {
      await tx.paketLabItem.deleteMany({ where: { paketId: req.params.id } });
      if (req.body.items.length > 0) {
        await tx.paketLabItem.createMany({
          data: req.body.items.map((it, i) => ({
            paketId: req.params.id,
            grup: it.grup?.trim() || null,
            pemeriksaan: it.pemeriksaan.trim(),
            nilaiRujukan: it.nilaiRujukan?.trim() ?? '',
            satuan: it.satuan?.trim() ?? '',
            harga: it.harga ? new Decimal(it.harga) : new Decimal(0),
            urutan: it.urutan ?? i,
          })),
        });
      }
    });

    const item = await prisma.paketLab.findUnique({
      where: { id: req.params.id },
      include: { items: { orderBy: { urutan: 'asc' } } },
    });
    return {
      item: item
        ? {
            ...item,
            harga: serializeDecimal(item.harga),
            items: item.items.map((it) => ({ ...it, harga: serializeDecimal(it.harga) })),
          }
        : null,
    };
  };

  app.put('/api/paket-lab/:id/items', replaceItemsHandler);
  app.patch('/api/paket-lab/:id/items', replaceItemsHandler);

  // ────────────────────────────────────────────────────────────────────────────

  app.get<{ Querystring: StaffListQuery }>('/api/staff', async (req) => {

    const { page, limit, skip } = parsePagination(req.query);
    const where = staffListWhere(req.query.q, req.query.role);
    const [total, items] = await Promise.all([
      prisma.staff.count({ where }),
      prisma.staff.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
        select: staffPublicSelect,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: { nama: string; email: string; password: string; role: StaffRoleInput; departemen?: DepartemenInput | null };
  }>(
    '/api/staff',
    async (req, reply) => {
      const { nama, email, password, role, departemen } = req.body;
      if (!nama?.trim() || !email?.trim() || !role || !password?.trim()) {
        return badRequest(reply, 'nama, email, password, role wajib');
      }
      if (password.length < 6) {
        return badRequest(reply, 'password minimal 6 karakter');
      }
      const item = await prisma.staff.create({
        data: {
          nama: nama.trim(),
          email: email.trim().toLowerCase(),
          passwordHash: await hashPassword(password),
          role,
          departemen: departemen ?? null,
        },
        select: staffPublicSelect,
      });
      return reply.status(201).send({ item });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/staff/:id', async (req) => {
    await prisma.staff.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nama?: string;
      email?: string;
      password?: string;
      role?: StaffRoleInput;
      departemen?: DepartemenInput | null;
    };
  }>('/api/staff/:id', async (req, reply) => {
    const existing = await prisma.staff.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Staff tidak ditemukan' });
    if (req.body.password !== undefined && req.body.password.length > 0 && req.body.password.length < 6) {
      return badRequest(reply, 'password minimal 6 karakter');
    }
    const item = await prisma.staff.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        email: req.body.email?.trim().toLowerCase() ?? existing.email,
        ...(req.body.password?.trim()
          ? { passwordHash: await hashPassword(req.body.password) }
          : {}),
        role: req.body.role ?? existing.role,
        departemen: req.body.departemen !== undefined ? req.body.departemen : existing.departemen,
      },
      select: staffPublicSelect,
    });
    return { item };
  });

  // ─── Pendaftaran Umum ─────────────────────────────────────────────────────

  app.get<{ Querystring: PendaftaranUmumListQuery }>('/api/pendaftaran-umum', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = pendaftaranUmumListWhere(req.query);
    const [total, items] = await Promise.all([
      prisma.pendaftaranUmum.count({ where }),
      prisma.pendaftaranUmum.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: {
      noRegistrasi?: string;
      namaPasien: string;
      umur?: string;
      jenisKelamin?: string;
      alamat?: string;
      telpon?: string;
      tanggalMasuk: string;
      dokterPengirim?: string;
      klinis?: string;
      admin?: string;
      foto?: string;
      ruangan?: string;
      biayaPendaftaran?: number | string;
      paymentStatus?: 'BELUM_LUNAS' | 'LUNAS';
      petugasKasir?: string;
    };
  }>('/api/pendaftaran-umum', async (req, reply) => {
    if (!req.body.namaPasien?.trim() || !req.body.tanggalMasuk) {
      return badRequest(reply, 'namaPasien dan tanggalMasuk wajib diisi');
    }
    const noRegistrasi = req.body.noRegistrasi?.trim() || await nextPendaftaranUmumCode(prisma);
    try {
      const item = await prisma.pendaftaranUmum.create({
        data: {
          noRegistrasi,
          namaPasien: req.body.namaPasien.trim(),
          umur: req.body.umur?.trim() || null,
          jenisKelamin: req.body.jenisKelamin?.trim() || null,
          alamat: req.body.alamat?.trim() || null,
          telpon: req.body.telpon?.trim() || null,
          tanggalMasuk: new Date(req.body.tanggalMasuk),
          dokterPengirim: req.body.dokterPengirim?.trim() || null,
          klinis: req.body.klinis?.trim() || null,
          admin: req.body.admin?.trim() || null,
          foto: req.body.foto?.trim() || null,
          ruangan: req.body.ruangan?.trim() || null,
          biayaPendaftaran:
            req.body.biayaPendaftaran !== undefined ? new Decimal(req.body.biayaPendaftaran) : new Decimal(0),
          paymentStatus: req.body.paymentStatus ?? 'BELUM_LUNAS',
          petugasKasir: req.body.petugasKasir?.trim() || null,
        },
      });
      return reply.status(201).send({ item });
    } catch (err: unknown) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        return badRequest(
          reply,
          `Nomor registrasi "${noRegistrasi}" sudah dipakai. Coba simpan ulang untuk mendapat nomor baru.`,
        );
      }
      throw err;
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      noRegistrasi?: string;
      namaPasien?: string;
      umur?: string;
      jenisKelamin?: string;
      alamat?: string;
      telpon?: string;
      tanggalMasuk?: string;
      dokterPengirim?: string;
      klinis?: string;
      admin?: string;
      foto?: string;
      ruangan?: string;
      status?: 'MENUNGGU' | 'SELESAI';
      biayaPendaftaran?: number | string;
      paymentStatus?: 'BELUM_LUNAS' | 'LUNAS';
      petugasKasir?: string;
    };
  }>('/api/pendaftaran-umum/:id', async (req, reply) => {
    const existing = await prisma.pendaftaranUmum.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Pendaftaran tidak ditemukan' });

    try {
      const item = await prisma.pendaftaranUmum.update({
        where: { id: req.params.id },
        data: {
          noRegistrasi: req.body.noRegistrasi?.trim() ?? existing.noRegistrasi,
          namaPasien: req.body.namaPasien?.trim() ?? existing.namaPasien,
          umur: req.body.umur !== undefined ? req.body.umur?.trim() || null : existing.umur,
          jenisKelamin:
            req.body.jenisKelamin !== undefined ? req.body.jenisKelamin?.trim() || null : existing.jenisKelamin,
          alamat: req.body.alamat !== undefined ? req.body.alamat?.trim() || null : existing.alamat,
          telpon: req.body.telpon !== undefined ? req.body.telpon?.trim() || null : existing.telpon,
          tanggalMasuk: req.body.tanggalMasuk ? new Date(req.body.tanggalMasuk) : existing.tanggalMasuk,
          dokterPengirim: req.body.dokterPengirim !== undefined ? req.body.dokterPengirim?.trim() || null : existing.dokterPengirim,
          klinis: req.body.klinis !== undefined ? req.body.klinis?.trim() || null : existing.klinis,
          admin: req.body.admin !== undefined ? req.body.admin?.trim() || null : existing.admin,
          foto: req.body.foto !== undefined ? req.body.foto?.trim() || null : existing.foto,
          ruangan: req.body.ruangan !== undefined ? req.body.ruangan?.trim() || null : existing.ruangan,
          status: req.body.status ?? existing.status,
          biayaPendaftaran:
            req.body.biayaPendaftaran !== undefined
              ? new Decimal(req.body.biayaPendaftaran)
              : existing.biayaPendaftaran,
          paymentStatus: req.body.paymentStatus ?? existing.paymentStatus,
          petugasKasir:
            req.body.petugasKasir !== undefined ? req.body.petugasKasir?.trim() || null : existing.petugasKasir,
        },
      });
      return { item };
    } catch (err: unknown) {
      if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
        return badRequest(reply, `Nomor registrasi "${req.body.noRegistrasi?.trim()}" sudah dipakai oleh pendaftaran lain.`);
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/pendaftaran-umum/:id', async (req) => {
    await prisma.pendaftaranUmum.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: PasienListQuery }>('/api/pasien/summary', async (req) => {
    const where = pasienListWhere(req.query);
    const [totalPasien, menungguHasil, selesai, agg, groups, dokters] = await Promise.all([
      prisma.pasien.count({ where }),
      prisma.pasien.count({ where: { ...where, hasilStatus: 'MENUNGGU_HASIL' } }),
      prisma.pasien.count({ where: { ...where, hasilStatus: 'SELESAI' } }),
      prisma.pasien.aggregate({
        where,
        _sum: { totalHarga: true, totalSharing: true },
      }),
      prisma.pasien.groupBy({
        by: ['pengirimId'],
        where,
        _count: { _all: true },
        _sum: { totalHarga: true, totalSharing: true },
      }),
      prisma.dokter.findMany({ select: { id: true, nama: true } }),
    ]);

    const dokterMap = new Map(dokters.map((d) => [d.id, d.nama]));
    const byDokter = groups
      .map((g) => ({
        id: g.pengirimId,
        nama: dokterMap.get(g.pengirimId) ?? 'Dokter Tidak Dikenal',
        jumlahPasien: g._count._all,
        totalOmset: serializeDecimal(g._sum.totalHarga ?? new Decimal(0)),
        totalSharing: serializeDecimal(g._sum.totalSharing ?? new Decimal(0)),
      }))
      .sort((a, b) => b.jumlahPasien - a.jumlahPasien);

    return {
      totalPasien,
      menungguHasil,
      selesai,
      totalOmzet: serializeDecimal(agg._sum.totalHarga ?? new Decimal(0)),
      totalSharing: serializeDecimal(agg._sum.totalSharing ?? new Decimal(0)),
      byDokter,
    };
  });

  app.get<{ Querystring: PasienListQuery }>('/api/pasien', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = pasienListWhere(req.query);
    const [total, items] = await Promise.all([
      prisma.pasien.count({ where }),
      prisma.pasien.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: pasienInclude,
        skip,
        take: limit,
      }),
    ]);
    return {
      items: items.map(mapPasien),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.get<{ Params: { id: string } }>('/api/pasien/:id', async (req, reply) => {
    const item = await prisma.pasien.findUnique({
      where: { id: req.params.id },
      include: {
        pengirim: true,
        radiolog: true,
        pemeriksaan: { include: { jenisPemeriksaan: true } },
        paketLab: { include: { paketLab: true } },
      },
    });
    if (!item) return reply.status(404).send({ error: 'Pasien tidak ditemukan' });
    return { item: mapPasien(item) };
  });

  app.post<{
    Body: {
      nama: string;
      tanggalLahir: string;
      noTelepon?: string;
      alamat?: string;
      pengirimId: string;
      klinis?: string;
      temuan?: string;
      jenisPemeriksaanIds: string[];
      sharingAmount?: number;
      harga?: number;
      radiologId?: string;
      admin?: string;
      petugasKasir?: string;
      foto?: string;
      asalModul?: 'RADIOLOGI' | 'LABORATORIUM';
      kesan?: string;
      /** Tanggal registrasi YYYY-MM-DD; kosong = sekarang. */
      tanggal?: string;
    };
  }>('/api/pasien', async (req, reply) => {
    const body = req.body;
    if (!body.nama?.trim() || !body.tanggalLahir || !body.pengirimId) {
      return badRequest(reply, 'nama, tanggalLahir, pengirimId wajib');
    }
    const createdAt = registrationTimestamp(body.tanggal, new Date());
    if (!createdAt) return badRequest(reply, 'Tanggal tidak valid (format YYYY-MM-DD)');

    const dokter = await prisma.dokter.findUnique({ where: { id: body.pengirimId } });
    if (!dokter) return badRequest(reply, 'Dokter pengirim tidak valid');

    // Registrasi Laboratorium memilih Paket Lab (model PaketLab), bukan Jenis
    // Pemeriksaan Radiologi (model JenisPemeriksaan) — keduanya punya id yang
    // tidak saling terkait, jadi harga & validasinya harus dicari dari tabel
    // yang sesuai modul asalnya.
    const isLab = body.asalModul === 'LABORATORIUM';

    let totalHarga: Decimal;
    let pemeriksaanData: { jenisPemeriksaanId: string; hargaSnapshot: Decimal }[] = [];
    let paketLabData: { paketLabId: string; hargaSnapshot: Decimal }[] = [];

    if (isLab) {
      const paketRows = body.jenisPemeriksaanIds?.length
        ? await prisma.paketLab.findMany({ where: { id: { in: body.jenisPemeriksaanIds } } })
        : [];
      if (body.jenisPemeriksaanIds?.length && paketRows.length !== body.jenisPemeriksaanIds.length) {
        return badRequest(reply, 'Beberapa paket pemeriksaan lab tidak ditemukan');
      }
      paketLabData = paketRows.map((p) => ({ paketLabId: p.id, hargaSnapshot: p.harga }));
      totalHarga = paketRows.reduce((sum, p) => sum.add(p.harga), new Decimal(0));
    } else {
      const hargaRows = body.jenisPemeriksaanIds?.length ? await prisma.hargaLayanan.findMany({
        where: { jenisPemeriksaanId: { in: body.jenisPemeriksaanIds } },
      }) : [];

      if (body.jenisPemeriksaanIds?.length && hargaRows.length !== body.jenisPemeriksaanIds.length) {
        return badRequest(reply, 'Beberapa jenis pemeriksaan belum punya harga');
      }

      pemeriksaanData = hargaRows.map((h) => ({
        jenisPemeriksaanId: h.jenisPemeriksaanId,
        hargaSnapshot: h.harga,
      }));
      totalHarga = sumHarga(pemeriksaanData);
    }

    if (body.harga !== undefined) {
      totalHarga = new Decimal(body.harga);
    }

    const sharingAmount = new Decimal(body.sharingAmount ?? dokter.defaultSharingAmount);
    const totalSharing = calcTotalSharing(totalHarga, 'FIXED', new Decimal(0), sharingAmount);

    const regCode = await nextRegCode(prisma);
    const item = await prisma.pasien.create({
      data: {
        regCode,
        nama: body.nama.trim(),
        tanggalLahir: new Date(body.tanggalLahir),
        noTelepon: body.noTelepon?.trim() || null,
        alamat: body.alamat?.trim() || null,
        pengirimId: body.pengirimId,
        asalModul: body.asalModul === 'LABORATORIUM' ? 'LABORATORIUM' : 'RADIOLOGI',
        klinis: body.klinis?.trim() || null,
        temuan: body.temuan?.trim() || null,
        kesan: body.kesan?.trim() || null,
        sharingType: 'FIXED',
        sharingPercent: new Decimal(0),
        totalHarga,
        totalSharing,
        radiologId: body.radiologId || null,
        admin: body.admin?.trim() || null,
        petugasKasir: body.petugasKasir?.trim() || null,
        foto: body.foto || null,
        createdAt,
        pemeriksaan: { create: pemeriksaanData },
        paketLab: { create: paketLabData },
      },
      include: {
        pengirim: true,
        radiolog: true,
        pemeriksaan: { include: { jenisPemeriksaan: true } },
        paketLab: { include: { paketLab: true } },
      },
    });

    await syncPasienDuplikat(prisma, item.id);
    return reply.status(201).send({ item: mapPasien(item) });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nama?: string;
      tanggalLahir?: string;
      noTelepon?: string;
      alamat?: string;
      pengirimId?: string;
      klinis?: string;
      temuan?: string;
      hasilStatus?: 'MENUNGGU_HASIL' | 'SELESAI';
      paymentStatus?: 'BELUM_LUNAS' | 'LUNAS';
      radiologId?: string | null;
      sharingAmount?: number;
      harga?: number;
      jenisPemeriksaanIds?: string[];
      admin?: string;
      petugasKasir?: string;
      foto?: string;
      kesan?: string;
      sharingLocked?: boolean;
    };
  }>('/api/pasien/:id', async (req, reply) => {
    const existing = await prisma.pasien.findUnique({
      where: { id: req.params.id },
      include: { pemeriksaan: true },
    });
    if (!existing) return reply.status(404).send({ error: 'Pasien tidak ditemukan' });

    const hasilStatus = req.body.hasilStatus ?? existing.hasilStatus;
    const pengirimId = req.body.pengirimId ?? existing.pengirimId;

    const dokter = await prisma.dokter.findUnique({ where: { id: pengirimId } });
    if (!dokter) return badRequest(reply, 'Dokter pengirim tidak valid');

    let sharingAmount =
      existing.sharingAmount ?? existing.totalSharing;
    if (req.body.sharingAmount !== undefined) {
      sharingAmount = new Decimal(req.body.sharingAmount);
    } else if (req.body.pengirimId && req.body.pengirimId !== existing.pengirimId) {
      sharingAmount = dokter.defaultSharingAmount;
    }

    let totalHarga = existing.totalHarga;
    let newPemeriksaanRows: { jenisPemeriksaanId: string; hargaSnapshot: Decimal }[] | undefined;
    let newPaketLabRows: { paketLabId: string; hargaSnapshot: Decimal }[] | undefined;
    const isLab = existing.asalModul === 'LABORATORIUM';

    if (req.body.jenisPemeriksaanIds !== undefined) {
      if (!req.body.jenisPemeriksaanIds.length) {
        return badRequest(reply, isLab ? 'Pilih minimal satu paket pemeriksaan lab' : 'Pilih minimal satu jenis pemeriksaan');
      }
      if (isLab) {
        const paketRows = await prisma.paketLab.findMany({
          where: { id: { in: req.body.jenisPemeriksaanIds } },
        });
        if (paketRows.length !== req.body.jenisPemeriksaanIds.length) {
          return badRequest(reply, 'Beberapa paket pemeriksaan lab tidak ditemukan');
        }
        newPaketLabRows = paketRows.map((p) => ({ paketLabId: p.id, hargaSnapshot: p.harga }));
        totalHarga = newPaketLabRows.reduce((sum, r) => sum.add(r.hargaSnapshot), new Decimal(0));
      } else {
        const hargaRows = await prisma.hargaLayanan.findMany({
          where: { jenisPemeriksaanId: { in: req.body.jenisPemeriksaanIds } },
        });
        if (hargaRows.length !== req.body.jenisPemeriksaanIds.length) {
          return badRequest(reply, 'Beberapa jenis pemeriksaan belum punya harga');
        }
        newPemeriksaanRows = hargaRows.map((h) => ({
          jenisPemeriksaanId: h.jenisPemeriksaanId,
          hargaSnapshot: h.harga,
        }));
        totalHarga = sumHarga(newPemeriksaanRows);
      }
    }

    if (req.body.harga !== undefined) {
      totalHarga = new Decimal(req.body.harga);
    }

    const totalSharing = calcTotalSharing(totalHarga, 'FIXED', new Decimal(0), sharingAmount);
    const sharingLocked = hasilStatus === 'SELESAI';

    const item = await prisma.$transaction(async (tx) => {
      if (newPemeriksaanRows) {
        await tx.pasienPemeriksaan.deleteMany({ where: { pasienId: existing.id } });
        await tx.pasienPemeriksaan.createMany({
          data: newPemeriksaanRows.map((row) => ({
            pasienId: existing.id,
            jenisPemeriksaanId: row.jenisPemeriksaanId,
            hargaSnapshot: row.hargaSnapshot,
          })),
        });
      }
      if (newPaketLabRows) {
        await tx.pasienPaketLab.deleteMany({ where: { pasienId: existing.id } });
        await tx.pasienPaketLab.createMany({
          data: newPaketLabRows.map((row) => ({
            pasienId: existing.id,
            paketLabId: row.paketLabId,
            hargaSnapshot: row.hargaSnapshot,
          })),
        });
      }
      return tx.pasien.update({
        where: { id: req.params.id },
        data: {
          nama: req.body.nama?.trim() ?? existing.nama,
          tanggalLahir: req.body.tanggalLahir ? new Date(req.body.tanggalLahir) : existing.tanggalLahir,
          noTelepon:
            req.body.noTelepon !== undefined ? req.body.noTelepon?.trim() || null : existing.noTelepon,
          alamat: req.body.alamat !== undefined ? req.body.alamat?.trim() || null : existing.alamat,
          pengirimId,
          klinis: req.body.klinis !== undefined ? req.body.klinis?.trim() || null : existing.klinis,
          temuan: req.body.temuan !== undefined ? req.body.temuan?.trim() || null : existing.temuan,
          kesan: req.body.kesan !== undefined ? req.body.kesan?.trim() || null : existing.kesan,
          hasilStatus,
          paymentStatus: req.body.paymentStatus ?? existing.paymentStatus,
          radiologId:
            req.body.radiologId !== undefined ? req.body.radiologId || null : existing.radiologId,
          admin: req.body.admin !== undefined ? req.body.admin?.trim() || null : existing.admin,
          petugasKasir:
            req.body.petugasKasir !== undefined ? req.body.petugasKasir?.trim() || null : existing.petugasKasir,
          foto: req.body.foto !== undefined ? req.body.foto || null : existing.foto,
          sharingLocked,
          sharingType: 'FIXED',
          sharingPercent: new Decimal(0),
          sharingAmount,
          totalHarga,
          totalSharing,
        },
        include: {
          pengirim: true,
          radiolog: true,
          pemeriksaan: { include: { jenisPemeriksaan: true } },
          paketLab: { include: { paketLab: true } },
        },
      });
    });

    await syncPasienDuplikat(prisma, item.id);

    const autoDelete =
      existing.asalModul === 'RADIOLOGI' &&
      item.hasilStatus === 'SELESAI' &&
      item.paymentStatus === 'LUNAS';
    if (autoDelete) {
      await prisma.pasien.delete({ where: { id: item.id } });
      return { item: mapPasien(item), autoDeleted: true };
    }

    return { item: mapPasien(item) };
  });

  app.delete<{ Params: { id: string } }>('/api/pasien/:id', async (req, reply) => {
    const existing = await prisma.pasien.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Pasien tidak ditemukan' });

    if (existing.asalModul === 'RADIOLOGI' && existing.hasilStatus === 'MENUNGGU_HASIL') {
      return badRequest(
        reply,
        'Tidak bisa menghapus: pasien ini masih menunggu hasil di Pekerjaan Radiolog',
      );
    }

    await syncPasienDuplikat(prisma, existing.id);
    await prisma.pasien.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  /**
   * Hapus semua pasien radiologi yang masih tampil di antrean Pekerjaan Radiolog
   * (asalModul RADIOLOGI, hasilStatus MENUNGGU_HASIL) — menerobos proteksi
   * penghapusan satu-per-satu di atas atas permintaan eksplisit pengguna.
   * Setiap baris tetap diarsipkan ke PasienDuplikat sebelum dihapus.
   */
  app.delete('/api/pasien/bulk-radiolog-antrean', async () => {
    const targets = await prisma.pasien.findMany({
      where: { asalModul: 'RADIOLOGI', hasilStatus: 'MENUNGGU_HASIL' },
      select: { id: true },
    });
    const ids = targets.map((t) => t.id);
    for (const id of ids) {
      await syncPasienDuplikat(prisma, id);
    }
    await prisma.pasien.deleteMany({ where: { id: { in: ids } } });
    // Arsip tidak ikut terhapus, tapi statusnya disamakan jadi SELESAI supaya
    // tidak nyangkut selamanya di antrean Pekerjaan Radiolog (yang memfilter
    // hasilStatus MENUNGGU_HASIL) padahal sumber datanya sudah tidak ada.
    await prisma.pasienDuplikat.updateMany({
      where: { sourcePasienId: { in: ids } },
      data: { hasilStatus: 'SELESAI' },
    });
    return { ok: true, deleted: ids.length };
  });

  app.get<{
    Querystring: ListQuery & {
      modul?: string;
      hasilStatus?: string;
      paymentStatus?: string;
      pengirimNama?: string;
      startDate?: string;
      endDate?: string;
    };
  }>('/api/pasien-duplikat', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = pasienDuplikatListWhere(req.query);
    const [total, items] = await Promise.all([
      prisma.pasienDuplikat.count({ where }),
      prisma.pasienDuplikat.findMany({
        where,
        orderBy: { registeredAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return {
      items: items.map((d) => ({
        id: d.id,
        sourcePasienId: d.sourcePasienId,
        regCode: d.regCode,
        nama: d.nama,
        umur: computeUmur(d.tanggalLahir),
        tanggalLahir: d.tanggalLahir.toISOString().slice(0, 10),
        noTelepon: d.noTelepon,
        alamat: d.alamat,
        pengirimNama: d.pengirimNama,
        radiologNama: d.radiologNama,
        klinis: d.klinis,
        kesan: d.kesan,
        hasilStatus: d.hasilStatus,
        paymentStatus: d.paymentStatus,
        pemeriksaanNama: d.pemeriksaanNama,
        petugasKasir: d.petugasKasir,
        petugasAdminKlinik: d.petugasAdminKlinik,
        totalHarga: serializeDecimal(d.totalHarga),
        totalSharing: serializeDecimal(d.totalSharing),
        createdAt: d.registeredAt.toISOString(),
      })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  /** Ubah data satu baris arsip Duplikat (nama, alamat, dokter pengirim, pemeriksaan, harga, status, tanggal). */
  app.patch<{
    Params: { id: string };
    Body: {
      nama?: string;
      alamat?: string;
      noTelepon?: string;
      pengirimNama?: string;
      pemeriksaanNama?: string;
      petugasKasir?: string;
      petugasAdminKlinik?: string;
      kesan?: string;
      totalHarga?: number;
      totalSharing?: number;
      paymentStatus?: 'BELUM_LUNAS' | 'LUNAS';
      hasilStatus?: 'MENUNGGU_HASIL' | 'SELESAI';
      /** Tanggal arsip (YYYY-MM-DD); jam aslinya dipertahankan. */
      tanggal?: string;
    };
  }>('/api/pasien-duplikat/:id', async (req, reply) => {
    const existing = await prisma.pasienDuplikat.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Arsip tidak ditemukan' });
    const b = req.body;
    let registeredAt = existing.registeredAt;
    if (b.tanggal !== undefined) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.tanggal);
      if (!m) return badRequest(reply, 'Tanggal tidak valid (format YYYY-MM-DD)');
      const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const parsed = new Date(existing.registeredAt);
      parsed.setFullYear(year, month - 1, day);
      if (parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
        return badRequest(reply, 'Tanggal tidak valid');
      }
      registeredAt = parsed;
    }
    const item = await prisma.pasienDuplikat.update({
      where: { id: req.params.id },
      data: {
        nama: b.nama?.trim() ?? existing.nama,
        alamat: b.alamat !== undefined ? b.alamat?.trim() || null : existing.alamat,
        noTelepon: b.noTelepon !== undefined ? b.noTelepon?.trim() || null : existing.noTelepon,
        pengirimNama: b.pengirimNama?.trim() ?? existing.pengirimNama,
        pemeriksaanNama: b.pemeriksaanNama?.trim() ?? existing.pemeriksaanNama,
        petugasKasir: b.petugasKasir !== undefined ? b.petugasKasir?.trim() || null : existing.petugasKasir,
        petugasAdminKlinik:
          b.petugasAdminKlinik !== undefined ? b.petugasAdminKlinik?.trim() || null : existing.petugasAdminKlinik,
        kesan: b.kesan !== undefined ? b.kesan?.trim() || null : existing.kesan,
        totalHarga: b.totalHarga !== undefined ? b.totalHarga : existing.totalHarga,
        totalSharing: b.totalSharing !== undefined ? b.totalSharing : existing.totalSharing,
        paymentStatus: b.paymentStatus ?? existing.paymentStatus,
        hasilStatus: b.hasilStatus ?? existing.hasilStatus,
        registeredAt,
      },
    });
    return {
      item: {
        id: item.id,
        sourcePasienId: item.sourcePasienId,
        regCode: item.regCode,
        nama: item.nama,
        umur: computeUmur(item.tanggalLahir),
        tanggalLahir: item.tanggalLahir.toISOString().slice(0, 10),
        noTelepon: item.noTelepon,
        alamat: item.alamat,
        pengirimNama: item.pengirimNama,
        radiologNama: item.radiologNama,
        klinis: item.klinis,
        kesan: item.kesan,
        hasilStatus: item.hasilStatus,
        paymentStatus: item.paymentStatus,
        pemeriksaanNama: item.pemeriksaanNama,
        petugasKasir: item.petugasKasir,
        petugasAdminKlinik: item.petugasAdminKlinik,
        totalHarga: serializeDecimal(item.totalHarga),
        totalSharing: serializeDecimal(item.totalSharing),
        createdAt: item.registeredAt.toISOString(),
      },
    };
  });

  /** Hapus permanen satu baris arsip Duplikat. */
  app.delete<{ Params: { id: string } }>('/api/pasien-duplikat/:id', async (req, reply) => {
    try {
      await prisma.pasienDuplikat.delete({ where: { id: req.params.id } });
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: 'Arsip tidak ditemukan' });
    }
  });

  /** Hapus permanen semua arsip Duplikat (mis. seluruh arsip Duplikat Radiologi). */
  app.delete<{ Querystring: { modul?: string } }>('/api/pasien-duplikat', async (req, reply) => {
    if (req.query.modul !== 'RADIOLOGI' && req.query.modul !== 'LABORATORIUM') {
      return badRequest(reply, 'Parameter modul (RADIOLOGI/LABORATORIUM) wajib diisi');
    }
    const result = await prisma.pasienDuplikat.deleteMany({
      where: { asalModul: req.query.modul },
    });
    return { ok: true, deleted: result.count };
  });

  app.get<{ Querystring: ListQuery }>(
    '/api/radiolog/antrean',
    async (req) => {
      const { page, limit, skip } = parsePagination(req.query);
      const where = pasienAntreanWhere(req.query.q);
      const [total, items] = await Promise.all([
        prisma.pasien.count({ where }),
        prisma.pasien.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          include: pasienInclude,
          skip,
          take: limit,
        }),
      ]);
      return {
        items: items.map(mapPasien),
        pagination: buildPaginationMeta(total, page, limit),
      };
    },
  );

  app.get<{ Querystring: ListQuery }>('/api/analisa-foto-rontgen', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const q = req.query.q?.trim();
    const where = q ? { namaPasien: { contains: q } } : {};
    const [total, items] = await Promise.all([
      prisma.analisaFotoRontgen.count({ where }),
      prisma.analisaFotoRontgen.findMany({
        where,
        orderBy: { tanggal: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          namaPasien: true,
          regCode: true,
          jenisPemeriksaan: true,
          tanggal: true,
          fotoDataUrl: true,
          ukuranFoto: true,
          kesan: true,
          diagnosa: true,
          isDraftAi: true,
          radiologNama: true,
        },
      }),
    ]);
    return {
      items: items.map((a) => ({
        id: a.id,
        namaPasien: a.namaPasien,
        regCode: a.regCode,
        jenisPemeriksaan: a.jenisPemeriksaan,
        tanggal: a.tanggal.toISOString(),
        fotoDataUrl: a.fotoDataUrl,
        ukuranFoto: a.ukuranFoto,
        kesan: a.kesan,
        diagnosa: a.diagnosa,
        isDraftAi: a.isDraftAi,
        radiologNama: a.radiologNama,
      })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      namaPasien: string;
      regCode?: string;
      jenisPemeriksaan?: string;
      tanggal?: string;
      fotoDataUrl: string;
      ukuranFoto?: string;
      kesan?: string;
      diagnosa?: string;
      isDraftAi?: boolean;
      radiologNama?: string;
    };
  }>('/api/analisa-foto-rontgen', async (req, reply) => {
    const b = req.body;
    if (!b.namaPasien?.trim() || !b.fotoDataUrl?.trim()) {
      return badRequest(reply, 'namaPasien dan fotoDataUrl wajib diisi');
    }
    const item = await prisma.analisaFotoRontgen.create({
      data: {
        namaPasien: b.namaPasien.trim(),
        regCode: b.regCode?.trim() || null,
        jenisPemeriksaan: b.jenisPemeriksaan?.trim() || null,
        tanggal: b.tanggal ? new Date(b.tanggal) : new Date(),
        fotoDataUrl: saveImageDataUrl(b.fotoDataUrl, 'radiologi'),
        ukuranFoto: b.ukuranFoto?.trim() || '3 x 4 cm',
        kesan: b.kesan?.trim() || null,
        diagnosa: b.diagnosa?.trim() || null,
        isDraftAi: b.isDraftAi ?? false,
        radiologNama: b.radiologNama?.trim() || null,
      },
    });
    return reply.status(201).send({
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        regCode: item.regCode,
        jenisPemeriksaan: item.jenisPemeriksaan,
        tanggal: item.tanggal.toISOString(),
        fotoDataUrl: item.fotoDataUrl,
        ukuranFoto: item.ukuranFoto,
        kesan: item.kesan,
        diagnosa: item.diagnosa,
        isDraftAi: item.isDraftAi,
        radiologNama: item.radiologNama,
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaPasien?: string;
      regCode?: string;
      jenisPemeriksaan?: string;
      tanggal?: string;
      fotoDataUrl?: string;
      kesan?: string;
      diagnosa?: string;
      isDraftAi?: boolean;
      radiologNama?: string;
    };
  }>('/api/analisa-foto-rontgen/:id', async (req, reply) => {
    const existing = await prisma.analisaFotoRontgen.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data analisa foto rontgen tidak ditemukan' });
    const fotoDataUrl = req.body.fotoDataUrl ? saveImageDataUrl(req.body.fotoDataUrl, 'radiologi') : existing.fotoDataUrl;
    if (fotoDataUrl !== existing.fotoDataUrl) deleteStoredImage(existing.fotoDataUrl);
    const item = await prisma.analisaFotoRontgen.update({
      where: { id: req.params.id },
      data: {
        namaPasien: req.body.namaPasien?.trim() ?? existing.namaPasien,
        regCode: req.body.regCode !== undefined ? req.body.regCode?.trim() || null : existing.regCode,
        jenisPemeriksaan:
          req.body.jenisPemeriksaan !== undefined
            ? req.body.jenisPemeriksaan?.trim() || null
            : existing.jenisPemeriksaan,
        tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
        fotoDataUrl,
        kesan: req.body.kesan !== undefined ? req.body.kesan?.trim() || null : existing.kesan,
        diagnosa: req.body.diagnosa !== undefined ? req.body.diagnosa?.trim() || null : existing.diagnosa,
        isDraftAi: req.body.isDraftAi ?? existing.isDraftAi,
        radiologNama:
          req.body.radiologNama !== undefined ? req.body.radiologNama?.trim() || null : existing.radiologNama,
      },
    });
    return {
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        regCode: item.regCode,
        jenisPemeriksaan: item.jenisPemeriksaan,
        tanggal: item.tanggal.toISOString(),
        fotoDataUrl: item.fotoDataUrl,
        kesan: item.kesan,
        diagnosa: item.diagnosa,
        isDraftAi: item.isDraftAi,
        radiologNama: item.radiologNama,
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/analisa-foto-rontgen/:id', async (req) => {
    const deleted = await prisma.analisaFotoRontgen.delete({ where: { id: req.params.id } });
    deleteStoredImage(deleted.fotoDataUrl);
    return { ok: true };
  });

  const ANALISA_FOTO_RONTGEN_ALLOWED_IMAGE_MEDIA_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ] as const;
  type AnalisaFotoRontgenImageMediaType = (typeof ANALISA_FOTO_RONTGEN_ALLOWED_IMAGE_MEDIA_TYPES)[number];

  function parseAnalisaFotoRontgenImageDataUrl(
    dataUrl: string,
  ): { readonly mediaType: AnalisaFotoRontgenImageMediaType; readonly data: string } | null {
    const match = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) return null;
    const [, mediaType, data] = match;
    if (!ANALISA_FOTO_RONTGEN_ALLOWED_IMAGE_MEDIA_TYPES.includes(mediaType as AnalisaFotoRontgenImageMediaType)) {
      return null;
    }
    return { mediaType: mediaType as AnalisaFotoRontgenImageMediaType, data: data! };
  }

  const ANALISA_FOTO_RONTGEN_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
      jenisPemeriksaan: {
        type: Type.STRING,
        description:
          'Perkiraan jenis pemeriksaan rontgen yang paling sesuai dengan foto (mis. "Thorax PA", "BNO", "Cranium AP/Lateral"). Isi "Tidak dapat ditentukan" jika tidak jelas.',
      },
      kesan: {
        type: Type.STRING,
        description: 'Kesan (impression) ringkas dari foto, dalam Bahasa Indonesia.',
      },
      diagnosa: {
        type: Type.STRING,
        description: 'Perkiraan diagnosa berdasarkan kesan di atas, dalam Bahasa Indonesia.',
      },
    },
    required: ['jenisPemeriksaan', 'kesan', 'diagnosa'],
  };

  const ANALISA_FOTO_RONTGEN_SYSTEM_PROMPT = `Anda adalah asisten AI yang membantu radiolog/dokter di sebuah klinik membaca foto rontgen untuk membuat DRAFT AWAL kesan & diagnosa, bukan diagnosis final.

Aturan:
- Hasil Anda akan selalu ditampilkan ke pengguna dengan label eksplisit sebagai "draft AI yang wajib ditinjau ulang oleh radiolog/dokter" — Anda tidak perlu menambahkan disclaimer itu sendiri di dalam teks, cukup fokus pada isi kesan & diagnosa.
- "Kesan" adalah kesimpulan/impression singkat dari temuan yang tampak pada foto.
- "Diagnosa" adalah perkiraan diagnosa berdasarkan kesan tersebut.
- Jika gambar buram, tidak jelas, bukan foto rontgen, atau tidak cukup informasi, katakan itu secara eksplisit (mis. "Foto tidak cukup jelas untuk dibaca") alih-alih menebak-nebak.
- Jangan berikan rekomendasi pengobatan, dosis obat, atau resep.
- Tulis dalam Bahasa Indonesia, ringkas, dan gunakan istilah medis yang wajar dipakai radiolog/dokter Indonesia.
- Jawab HANYA sesuai skema JSON yang diberikan.`;

  app.post<{
    Body: { fotoDataUrl?: string; jenisPemeriksaan?: string; namaPasien?: string };
  }>('/api/analisa-foto-rontgen/analyze', async (req, reply) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return reply.status(503).send({
        error: 'Fitur analisa AI belum dikonfigurasi. Admin perlu mengatur GEMINI_API_KEY di server.',
      });
    }

    const { fotoDataUrl, jenisPemeriksaan, namaPasien } = req.body;
    if (!fotoDataUrl?.trim()) {
      return badRequest(reply, 'fotoDataUrl wajib diisi');
    }
    // Untuk foto yang sudah tersimpan (edit tanpa unggah ulang), fotoDataUrl berupa
    // path /uploads/... bukan data URL base64 — baca ulang isinya dari disk.
    const resolvedDataUrl = fotoDataUrl.startsWith('/uploads/')
      ? readStoredImageAsDataUrl(fotoDataUrl)
      : fotoDataUrl;
    if (!resolvedDataUrl) {
      return badRequest(reply, 'File foto tidak ditemukan di server.');
    }
    const parsedImage = parseAnalisaFotoRontgenImageDataUrl(resolvedDataUrl);
    if (!parsedImage) {
      return badRequest(reply, 'Format foto tidak didukung. Gunakan JPEG, PNG, GIF, atau WEBP.');
    }

    const contextLines = [
      namaPasien?.trim() ? `Nama pasien: ${namaPasien.trim()}` : null,
      jenisPemeriksaan?.trim() ? `Jenis pemeriksaan: ${jenisPemeriksaan.trim()}` : null,
    ].filter((line): line is string => Boolean(line));

    try {
      const client = new GoogleGenAI({ apiKey });
      const response = await generateContentWithFallback(client, {
        model: 'gemini-3.6-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: parsedImage.mediaType, data: parsedImage.data } },
              {
                text: [
                  ...contextLines,
                  'Baca foto rontgen di atas dan berikan draft jenis pemeriksaan, kesan (impression ringkas), dan diagnosa sesuai skema JSON.',
                ].join('\n'),
              },
            ],
          },
        ],
        config: {
          systemInstruction: ANALISA_FOTO_RONTGEN_SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: ANALISA_FOTO_RONTGEN_RESPONSE_SCHEMA,
        },
      });

      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
        return reply.status(502).send({
          error: 'AI menolak membaca foto ini. Silakan isi kesan & diagnosa secara manual.',
        });
      }

      const text = response.text;
      if (!text) {
        return reply.status(502).send({ error: 'AI tidak mengembalikan hasil bacaan yang valid.' });
      }

      let parsed: { jenisPemeriksaan?: unknown; kesan?: unknown; diagnosa?: unknown };
      try {
        parsed = JSON.parse(text) as { jenisPemeriksaan?: unknown; kesan?: unknown; diagnosa?: unknown };
      } catch {
        return reply.status(502).send({ error: 'AI mengembalikan format hasil yang tidak valid.' });
      }

      return {
        jenisPemeriksaan: typeof parsed.jenisPemeriksaan === 'string' ? parsed.jenisPemeriksaan : '',
        kesan: typeof parsed.kesan === 'string' ? parsed.kesan : '',
        diagnosa: typeof parsed.diagnosa === 'string' ? parsed.diagnosa : '',
      };
    } catch (err) {
      req.log.error(err, 'Gagal memanggil AI vision untuk analisa foto rontgen');
      return reply.status(502).send({
        error: err instanceof Error ? `Gagal menghubungi layanan AI: ${err.message}` : 'Gagal menghubungi layanan AI',
      });
    }
  });

  app.get<{ Querystring: UsgListQuery }>('/api/usg', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = usgListWhere(req.query);
    const [total, items] = await Promise.all([
      prisma.usg.count({ where }),
      prisma.usg.findMany({
        where,
        orderBy: { tanggal: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          namaPasien: true,
          umur: true,
          alamat: true,
          regCode: true,
          jenisPemeriksaan: true,
          tanggal: true,
          dokterPengirim: true,
          fotoDataUrl: true,
          fotoDataUrl2: true,
          fotoDataUrl3: true,
          fotoDataUrl4: true,
          analisa: true,
          kesan: true,
          radiologNama: true,
        },
      }),
    ]);
    return {
      items: items.map((u) => ({
        id: u.id,
        namaPasien: u.namaPasien,
        umur: u.umur,
        alamat: u.alamat,
        regCode: u.regCode,
        jenisPemeriksaan: u.jenisPemeriksaan,
        tanggal: u.tanggal.toISOString(),
        dokterPengirim: u.dokterPengirim,
        fotoDataUrl: u.fotoDataUrl,
        fotoDataUrl2: u.fotoDataUrl2,
        fotoDataUrl3: u.fotoDataUrl3,
        fotoDataUrl4: u.fotoDataUrl4,
        analisa: u.analisa,
        kesan: u.kesan,
        radiologNama: u.radiologNama,
      })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      namaPasien: string;
      umur?: string;
      alamat?: string;
      regCode?: string;
      jenisPemeriksaan?: string;
      tanggal?: string;
      dokterPengirim?: string;
      fotoDataUrl: string;
      fotoDataUrl2?: string;
      fotoDataUrl3?: string;
      fotoDataUrl4?: string;
      analisa?: string;
      kesan?: string;
      radiologNama?: string;
    };
  }>('/api/usg', async (req, reply) => {
    const b = req.body;
    if (!b.namaPasien?.trim() || !b.fotoDataUrl?.trim()) {
      return badRequest(reply, 'namaPasien dan fotoDataUrl wajib diisi');
    }
    const item = await prisma.usg.create({
      data: {
        namaPasien: b.namaPasien.trim(),
        umur: b.umur?.trim() || null,
        alamat: b.alamat?.trim() || null,
        regCode: b.regCode?.trim() || null,
        jenisPemeriksaan: b.jenisPemeriksaan?.trim() || null,
        tanggal: b.tanggal ? new Date(b.tanggal) : new Date(),
        dokterPengirim: b.dokterPengirim?.trim() || null,
        fotoDataUrl: saveImageDataUrl(b.fotoDataUrl, 'usg'),
        fotoDataUrl2: b.fotoDataUrl2 ? saveImageDataUrl(b.fotoDataUrl2, 'usg') : null,
        fotoDataUrl3: b.fotoDataUrl3 ? saveImageDataUrl(b.fotoDataUrl3, 'usg') : null,
        fotoDataUrl4: b.fotoDataUrl4 ? saveImageDataUrl(b.fotoDataUrl4, 'usg') : null,
        analisa: b.analisa?.trim() || null,
        kesan: b.kesan?.trim() || null,
        radiologNama: b.radiologNama?.trim() || null,
      },
    });
    return reply.status(201).send({
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        umur: item.umur,
        alamat: item.alamat,
        regCode: item.regCode,
        jenisPemeriksaan: item.jenisPemeriksaan,
        tanggal: item.tanggal.toISOString(),
        dokterPengirim: item.dokterPengirim,
        fotoDataUrl: item.fotoDataUrl,
        fotoDataUrl2: item.fotoDataUrl2,
        fotoDataUrl3: item.fotoDataUrl3,
        fotoDataUrl4: item.fotoDataUrl4,
        analisa: item.analisa,
        kesan: item.kesan,
        radiologNama: item.radiologNama,
      },
    });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaPasien?: string;
      umur?: string;
      alamat?: string;
      regCode?: string;
      jenisPemeriksaan?: string;
      tanggal?: string;
      dokterPengirim?: string;
      fotoDataUrl?: string;
      fotoDataUrl2?: string;
      fotoDataUrl3?: string;
      fotoDataUrl4?: string;
      analisa?: string;
      kesan?: string;
      radiologNama?: string;
    };
  }>('/api/usg/:id', async (req, reply) => {
    const existing = await prisma.usg.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data USG tidak ditemukan' });

    const fotoDataUrl = req.body.fotoDataUrl ? saveImageDataUrl(req.body.fotoDataUrl, 'usg') : existing.fotoDataUrl;
    const fotoDataUrl2 =
      req.body.fotoDataUrl2 !== undefined
        ? req.body.fotoDataUrl2
          ? saveImageDataUrl(req.body.fotoDataUrl2, 'usg')
          : null
        : existing.fotoDataUrl2;
    const fotoDataUrl3 =
      req.body.fotoDataUrl3 !== undefined
        ? req.body.fotoDataUrl3
          ? saveImageDataUrl(req.body.fotoDataUrl3, 'usg')
          : null
        : existing.fotoDataUrl3;
    const fotoDataUrl4 =
      req.body.fotoDataUrl4 !== undefined
        ? req.body.fotoDataUrl4
          ? saveImageDataUrl(req.body.fotoDataUrl4, 'usg')
          : null
        : existing.fotoDataUrl4;
    if (fotoDataUrl !== existing.fotoDataUrl) deleteStoredImage(existing.fotoDataUrl);
    if (fotoDataUrl2 !== existing.fotoDataUrl2) deleteStoredImage(existing.fotoDataUrl2);
    if (fotoDataUrl3 !== existing.fotoDataUrl3) deleteStoredImage(existing.fotoDataUrl3);
    if (fotoDataUrl4 !== existing.fotoDataUrl4) deleteStoredImage(existing.fotoDataUrl4);

    const item = await prisma.usg.update({
      where: { id: req.params.id },
      data: {
        namaPasien: req.body.namaPasien?.trim() ?? existing.namaPasien,
        umur: req.body.umur !== undefined ? req.body.umur?.trim() || null : existing.umur,
        alamat: req.body.alamat !== undefined ? req.body.alamat?.trim() || null : existing.alamat,
        regCode: req.body.regCode !== undefined ? req.body.regCode?.trim() || null : existing.regCode,
        jenisPemeriksaan:
          req.body.jenisPemeriksaan !== undefined
            ? req.body.jenisPemeriksaan?.trim() || null
            : existing.jenisPemeriksaan,
        tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
        dokterPengirim:
          req.body.dokterPengirim !== undefined
            ? req.body.dokterPengirim?.trim() || null
            : existing.dokterPengirim,
        fotoDataUrl,
        fotoDataUrl2,
        fotoDataUrl3,
        fotoDataUrl4,
        analisa: req.body.analisa !== undefined ? req.body.analisa?.trim() || null : existing.analisa,
        kesan: req.body.kesan !== undefined ? req.body.kesan?.trim() || null : existing.kesan,
        radiologNama:
          req.body.radiologNama !== undefined ? req.body.radiologNama?.trim() || null : existing.radiologNama,
      },
    });
    return {
      item: {
        id: item.id,
        namaPasien: item.namaPasien,
        umur: item.umur,
        alamat: item.alamat,
        regCode: item.regCode,
        jenisPemeriksaan: item.jenisPemeriksaan,
        tanggal: item.tanggal.toISOString(),
        dokterPengirim: item.dokterPengirim,
        fotoDataUrl: item.fotoDataUrl,
        fotoDataUrl2: item.fotoDataUrl2,
        fotoDataUrl3: item.fotoDataUrl3,
        fotoDataUrl4: item.fotoDataUrl4,
        analisa: item.analisa,
        kesan: item.kesan,
        radiologNama: item.radiologNama,
      },
    };
  });

  app.delete<{ Params: { id: string } }>('/api/usg/:id', async (req) => {
    const deleted = await prisma.usg.delete({ where: { id: req.params.id } });
    deleteStoredImage(deleted.fotoDataUrl);
    deleteStoredImage(deleted.fotoDataUrl2);
    deleteStoredImage(deleted.fotoDataUrl3);
    deleteStoredImage(deleted.fotoDataUrl4);
    return { ok: true };
  });

  // ─── Trading XAU/USD ────────────────────────────────────────────────────

  app.get('/api/trading-harga-xau', async (_req, reply) => {
    try {
      const spot = await fetchXauSpotPrice();
      return spot;
    } catch (err) {
      return reply.status(502).send({
        error: err instanceof Error ? err.message : 'Gagal mengambil harga XAU/USD',
      });
    }
  });

  // Path dipertahankan apa adanya supaya tidak memutus frontend yang sudah
  // memanggilnya, walau sumber datanya kini bukan Binance lagi.
  app.get('/api/trading-harga-binance', async (_req, reply) => {
    try {
      const spot = await fetchGoldFuturesPrice();
      return spot;
    } catch (err) {
      return reply.status(502).send({
        error: err instanceof Error ? err.message : 'Gagal mengambil harga emas berjangka',
      });
    }
  });

  const TRADING_AI_TIMEFRAME_LABELS: Readonly<Record<string, string>> = {
    '15': '15 Menit',
    '30': '30 Menit',
    '60': '1 Jam',
    '240': '4 Jam',
    D: '1 Hari',
  };

  const TRADING_AI_ANALISA_SCHEMA = {
    type: Type.OBJECT,
    properties: {
      bias: {
        type: Type.STRING,
        description: 'Bias arah harga untuk timeframe ini: "BULLISH", "BEARISH", atau "NETRAL".',
      },
      polaCandleDiperhatikan: {
        type: Type.STRING,
        description:
          'Pola candlestick yang perlu diperhatikan/dikonfirmasi trader di chart pada timeframe ini sebelum entry, dalam Bahasa Indonesia. Ini SARAN apa yang harus dicari, BUKAN klaim bahwa pola tersebut sudah muncul.',
      },
      entry: {
        type: Type.STRING,
        description: 'Rentang harga entry yang disarankan (USD), relatif terhadap level pivot/support/resistance yang diberikan.',
      },
      stopLoss: { type: Type.STRING, description: 'Level stop loss yang disarankan (USD).' },
      takeProfit: { type: Type.STRING, description: 'Target take profit yang disarankan (USD), boleh 1-2 target.' },
      confidence: {
        type: Type.NUMBER,
        description: 'Skor keyakinan estimasi ini, 0-100. Karena data terbatas (bukan candle intraday asli), jangan beri skor di atas 65.',
      },
      catatan: {
        type: Type.STRING,
        description:
          'Catatan penting: jelaskan bahwa ini estimasi AI berbasis pivot harian & harga spot (bukan analisa candle intraday real), dan wajib pakai manajemen risiko/stop loss.',
      },
    },
    required: ['bias', 'polaCandleDiperhatikan', 'entry', 'stopLoss', 'takeProfit', 'confidence', 'catatan'],
  };

  const TRADING_AI_SYSTEM_PROMPT = `Anda adalah asisten edukasi trading yang menyusun estimasi analisa teknikal XAU/USD (emas) untuk tujuan pembelajaran, BUKAN nasihat keuangan profesional.

Aturan PENTING:
- Anda hanya diberi harga spot saat ini serta High/Low/Close harian terakhir beserta level pivot point yang sudah dihitung dari data tersebut. Anda TIDAK memiliki data candle intraday asli untuk timeframe yang diminta.
- JANGAN mengklaim melihat pola candle tertentu sudah terbentuk — sebutkan pola yang PERLU DIPERHATIKAN/dikonfirmasi sendiri oleh trader di chart.
- Sesuaikan gaya saran (agresif/scalping untuk timeframe kecil vs swing untuk timeframe besar) dengan timeframe yang diminta, tapi level entry/stop loss/take profit harus tetap masuk akal relatif terhadap level pivot yang diberikan.
- confidence maksimal 65 karena keterbatasan data.
- Selalu ingatkan pentingnya stop loss & manajemen risiko di field catatan.
- Tulis dalam Bahasa Indonesia, ringkas per field.
- Jawab HANYA sesuai skema JSON yang diberikan.`;

  app.post<{ Body: { timeframe?: string } }>('/api/trading-ai-analisa', async (req, reply) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return reply.status(503).send({
        error: 'Fitur AI Analisa belum dikonfigurasi. Admin perlu mengatur GEMINI_API_KEY di server.',
      });
    }

    const timeframe = req.body?.timeframe ?? '';
    const timeframeLabel = TRADING_AI_TIMEFRAME_LABELS[timeframe];
    if (!timeframeLabel) {
      return badRequest(reply, 'timeframe wajib salah satu dari: 15, 30, 60, 240, D');
    }

    let spot: Awaited<ReturnType<typeof fetchXauSpotPrice>>;
    let daily: Awaited<ReturnType<typeof fetchLatestXauDailyPoint>>;
    try {
      [spot, daily] = await Promise.all([fetchXauSpotPrice(), fetchLatestXauDailyPoint()]);
    } catch (err) {
      return reply.status(502).send({
        error: err instanceof Error ? `Gagal mengambil data harga: ${err.message}` : 'Gagal mengambil data harga XAU/USD',
      });
    }
    if (!daily) {
      return reply.status(502).send({ error: 'Data High/Low/Close harian XAU/USD tidak tersedia saat ini.' });
    }

    const { pivot, r1, r2, r3, s1, s2, s3, signal, alasan } = computePivotLevels(daily.high, daily.low, daily.close);

    try {
      const client = new GoogleGenAI({ apiKey });
      const response = await generateContentWithFallback(client, {
        model: 'gemini-3.6-flash',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  `Timeframe yang diminta: ${timeframeLabel}`,
                  `Harga XAU/USD saat ini: $${spot.price}`,
                  `Data harian terakhir (tanggal ${daily.date}): High=${daily.high}, Low=${daily.low}, Close=${daily.close}`,
                  `Pivot Point terhitung: Pivot=${pivot.toFixed(2)}, R1=${r1.toFixed(2)}, R2=${r2.toFixed(2)}, R3=${r3.toFixed(2)}, S1=${s1.toFixed(2)}, S2=${s2.toFixed(2)}, S3=${s3.toFixed(2)}`,
                  `Sinyal pivot harian: ${signal} — ${alasan}`,
                  '',
                  `Susun estimasi analisa teknikal untuk timeframe ${timeframeLabel} sesuai skema JSON.`,
                ].join('\n'),
              },
            ],
          },
        ],
        config: {
          systemInstruction: TRADING_AI_SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: TRADING_AI_ANALISA_SCHEMA,
        },
      });

      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
        return reply.status(502).send({ error: 'AI menolak membuat analisa ini.' });
      }

      const text = response.text;
      if (!text) {
        return reply.status(502).send({ error: 'AI tidak mengembalikan hasil analisa yang valid.' });
      }

      let parsed: {
        bias?: unknown;
        polaCandleDiperhatikan?: unknown;
        entry?: unknown;
        stopLoss?: unknown;
        takeProfit?: unknown;
        confidence?: unknown;
        catatan?: unknown;
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        return reply.status(502).send({ error: 'AI mengembalikan format hasil yang tidak valid.' });
      }

      return {
        timeframe,
        timeframeLabel,
        hargaSaatIni: spot.price,
        hargaUpdatedAt: spot.updatedAt,
        dataHarianTanggal: daily.date,
        pivot: { pivot, r1, r2, r3, s1, s2, s3, signal, alasan },
        bias: typeof parsed.bias === 'string' ? parsed.bias : '',
        polaCandleDiperhatikan: typeof parsed.polaCandleDiperhatikan === 'string' ? parsed.polaCandleDiperhatikan : '',
        entry: typeof parsed.entry === 'string' ? parsed.entry : '',
        stopLoss: typeof parsed.stopLoss === 'string' ? parsed.stopLoss : '',
        takeProfit: typeof parsed.takeProfit === 'string' ? parsed.takeProfit : '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        catatan: typeof parsed.catatan === 'string' ? parsed.catatan : '',
      };
    } catch (err) {
      req.log.error(err, 'Gagal memanggil AI untuk trading AI analisa');
      return reply.status(502).send({
        error: err instanceof Error ? `Gagal menghubungi layanan AI: ${err.message}` : 'Gagal menghubungi layanan AI',
      });
    }
  });

  app.get<{ Querystring: ListQuery }>('/api/trading-jadwal', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const q = req.query.q?.trim();
    const where = q ? { namaEvent: { contains: q } } : {};
    const [total, items] = await Promise.all([
      prisma.tradingJadwal.count({ where }),
      prisma.tradingJadwal.findMany({ where, orderBy: { tanggal: 'asc' }, skip, take: limit }),
    ]);
    return {
      items: items.map((j) => ({ ...j, tanggal: j.tanggal.toISOString() })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{ Body: { tanggal: string; namaEvent: string; keterangan?: string } }>(
    '/api/trading-jadwal',
    async (req, reply) => {
      const b = req.body;
      if (!b.tanggal || !b.namaEvent?.trim()) {
        return badRequest(reply, 'tanggal dan namaEvent wajib diisi');
      }
      const item = await prisma.tradingJadwal.create({
        data: {
          tanggal: new Date(b.tanggal),
          namaEvent: b.namaEvent.trim(),
          keterangan: b.keterangan?.trim() || null,
        },
      });
      return reply.status(201).send({ item: { ...item, tanggal: item.tanggal.toISOString() } });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { tanggal?: string; namaEvent?: string; keterangan?: string };
  }>('/api/trading-jadwal/:id', async (req, reply) => {
    const existing = await prisma.tradingJadwal.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Jadwal tidak ditemukan' });
    const item = await prisma.tradingJadwal.update({
      where: { id: req.params.id },
      data: {
        tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
        namaEvent: req.body.namaEvent?.trim() ?? existing.namaEvent,
        keterangan: req.body.keterangan !== undefined ? req.body.keterangan?.trim() || null : existing.keterangan,
      },
    });
    return { item: { ...item, tanggal: item.tanggal.toISOString() } };
  });

  app.delete<{ Params: { id: string } }>('/api/trading-jadwal/:id', async (req) => {
    await prisma.tradingJadwal.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/trading-analisa', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const [total, items] = await Promise.all([
      prisma.tradingAnalisa.count(),
      prisma.tradingAnalisa.findMany({ orderBy: { tanggal: 'desc' }, skip, take: limit }),
    ]);
    return {
      items: items.map((a) => ({ ...a, tanggal: a.tanggal.toISOString() })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{ Body: { analisa: string; support?: string; resistance?: string; tanggal?: string } }>(
    '/api/trading-analisa',
    async (req, reply) => {
      const b = req.body;
      if (!b.analisa?.trim()) return badRequest(reply, 'analisa wajib diisi');
      const tanggal = b.tanggal ? new Date(b.tanggal) : undefined;
      if (tanggal && isNaN(tanggal.getTime())) return badRequest(reply, 'Tanggal & jam tidak valid');
      const item = await prisma.tradingAnalisa.create({
        data: {
          analisa: b.analisa.trim(),
          support: b.support?.trim() || null,
          resistance: b.resistance?.trim() || null,
          ...(tanggal ? { tanggal } : {}),
        },
      });
      return reply.status(201).send({ item: { ...item, tanggal: item.tanggal.toISOString() } });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { analisa?: string; support?: string; resistance?: string; tanggal?: string };
  }>('/api/trading-analisa/:id', async (req, reply) => {
    const existing = await prisma.tradingAnalisa.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Analisa tidak ditemukan' });
    let tanggal = existing.tanggal;
    if (req.body.tanggal !== undefined) {
      const parsed = new Date(req.body.tanggal);
      if (isNaN(parsed.getTime())) return badRequest(reply, 'Tanggal & jam tidak valid');
      tanggal = parsed;
    }
    const item = await prisma.tradingAnalisa.update({
      where: { id: req.params.id },
      data: {
        analisa: req.body.analisa?.trim() ?? existing.analisa,
        support: req.body.support !== undefined ? req.body.support?.trim() || null : existing.support,
        resistance: req.body.resistance !== undefined ? req.body.resistance?.trim() || null : existing.resistance,
        tanggal,
      },
    });
    return { item: { ...item, tanggal: item.tanggal.toISOString() } };
  });

  app.delete<{ Params: { id: string } }>('/api/trading-analisa/:id', async (req) => {
    await prisma.tradingAnalisa.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Trading Level (Resisten/Support dipantau otomatis vs harga live) ─────

  function serializeTradingLevel(item: {
    id: string;
    resistance: unknown;
    support: unknown;
    keterangan: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): {
    id: string;
    resistance: string | null;
    support: string | null;
    keterangan: string | null;
    createdAt: string;
    updatedAt: string;
  } {
    return {
      id: item.id,
      resistance: serializeDecimal(item.resistance as never),
      support: serializeDecimal(item.support as never),
      keterangan: item.keterangan,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  function parseDecimalInput(value: number | string): InstanceType<typeof Decimal> | null {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return null;
    return new Decimal(value);
  }

  app.get<{ Querystring: ListQuery }>('/api/trading-level', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const [total, items] = await Promise.all([
      prisma.tradingLevel.count(),
      prisma.tradingLevel.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);
    return { items: items.map(serializeTradingLevel), pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{ Body: { resistance: number | string; support: number | string; keterangan?: string } }>(
    '/api/trading-level',
    async (req, reply) => {
      const b = req.body;
      if (b.resistance === undefined || b.resistance === null || b.resistance === '') {
        return badRequest(reply, 'resistance wajib diisi');
      }
      if (b.support === undefined || b.support === null || b.support === '') {
        return badRequest(reply, 'support wajib diisi');
      }
      const resistance = parseDecimalInput(b.resistance);
      const support = parseDecimalInput(b.support);
      if (!resistance) return badRequest(reply, 'resistance harus berupa angka');
      if (!support) return badRequest(reply, 'support harus berupa angka');
      const item = await prisma.tradingLevel.create({
        data: { resistance, support, keterangan: b.keterangan?.trim() || null },
      });
      return reply.status(201).send({ item: serializeTradingLevel(item) });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { resistance?: number | string; support?: number | string; keterangan?: string };
  }>('/api/trading-level/:id', async (req, reply) => {
    const existing = await prisma.tradingLevel.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Level tidak ditemukan' });

    let resistance = existing.resistance;
    if (req.body.resistance !== undefined) {
      const parsed = parseDecimalInput(req.body.resistance);
      if (!parsed) return badRequest(reply, 'resistance harus berupa angka');
      resistance = parsed;
    }
    let support = existing.support;
    if (req.body.support !== undefined) {
      const parsed = parseDecimalInput(req.body.support);
      if (!parsed) return badRequest(reply, 'support harus berupa angka');
      support = parsed;
    }

    const item = await prisma.tradingLevel.update({
      where: { id: req.params.id },
      data: {
        resistance,
        support,
        keterangan: req.body.keterangan !== undefined ? req.body.keterangan?.trim() || null : existing.keterangan,
      },
    });
    return { item: serializeTradingLevel(item) };
  });

  app.delete<{ Params: { id: string } }>('/api/trading-level/:id', async (req) => {
    await prisma.tradingLevel.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Trading MinPlus (harga acuan, peringatan tiap kelipatan $10) ─────────

  function serializeTradingMinPlus(item: {
    id: string;
    hargaAcuan: unknown;
    keterangan: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): {
    id: string;
    hargaAcuan: string | null;
    keterangan: string | null;
    createdAt: string;
    updatedAt: string;
  } {
    return {
      id: item.id,
      hargaAcuan: serializeDecimal(item.hargaAcuan as never),
      keterangan: item.keterangan,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  app.get<{ Querystring: ListQuery }>('/api/trading-minplus', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const [total, items] = await Promise.all([
      prisma.tradingMinPlus.count(),
      prisma.tradingMinPlus.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);
    return { items: items.map(serializeTradingMinPlus), pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{ Body: { hargaAcuan: number | string; keterangan?: string } }>(
    '/api/trading-minplus',
    async (req, reply) => {
      const b = req.body;
      if (b.hargaAcuan === undefined || b.hargaAcuan === null || b.hargaAcuan === '') {
        return badRequest(reply, 'hargaAcuan wajib diisi');
      }
      const hargaAcuan = parseDecimalInput(b.hargaAcuan);
      if (!hargaAcuan) return badRequest(reply, 'hargaAcuan harus berupa angka');
      const item = await prisma.tradingMinPlus.create({
        data: { hargaAcuan, keterangan: b.keterangan?.trim() || null },
      });
      return reply.status(201).send({ item: serializeTradingMinPlus(item) });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { hargaAcuan?: number | string; keterangan?: string };
  }>('/api/trading-minplus/:id', async (req, reply) => {
    const existing = await prisma.tradingMinPlus.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Acuan tidak ditemukan' });

    let hargaAcuan = existing.hargaAcuan;
    if (req.body.hargaAcuan !== undefined) {
      const parsed = parseDecimalInput(req.body.hargaAcuan);
      if (!parsed) return badRequest(reply, 'hargaAcuan harus berupa angka');
      hargaAcuan = parsed;
    }

    const item = await prisma.tradingMinPlus.update({
      where: { id: req.params.id },
      data: {
        hargaAcuan,
        keterangan: req.body.keterangan !== undefined ? req.body.keterangan?.trim() || null : existing.keterangan,
      },
    });
    return { item: serializeTradingMinPlus(item) };
  });

  app.delete<{ Params: { id: string } }>('/api/trading-minplus/:id', async (req) => {
    await prisma.tradingMinPlus.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Trading Harga Beli (target beli, peringatan suara "Beli" saat tersentuh) ─

  function serializeTradingHargaBeli(item: {
    id: string;
    hargaBeli: unknown;
    keterangan: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): {
    id: string;
    hargaBeli: string | null;
    keterangan: string | null;
    createdAt: string;
    updatedAt: string;
  } {
    return {
      id: item.id,
      hargaBeli: serializeDecimal(item.hargaBeli as never),
      keterangan: item.keterangan,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  app.get<{ Querystring: ListQuery }>('/api/trading-harga-beli', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const [total, items] = await Promise.all([
      prisma.tradingHargaBeli.count(),
      prisma.tradingHargaBeli.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);
    return { items: items.map(serializeTradingHargaBeli), pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{ Body: { hargaBeli: number | string; keterangan?: string } }>(
    '/api/trading-harga-beli',
    async (req, reply) => {
      const b = req.body;
      if (b.hargaBeli === undefined || b.hargaBeli === null || b.hargaBeli === '') {
        return badRequest(reply, 'hargaBeli wajib diisi');
      }
      const hargaBeli = parseDecimalInput(b.hargaBeli);
      if (!hargaBeli) return badRequest(reply, 'hargaBeli harus berupa angka');
      const item = await prisma.tradingHargaBeli.create({
        data: { hargaBeli, keterangan: b.keterangan?.trim() || null },
      });
      return reply.status(201).send({ item: serializeTradingHargaBeli(item) });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { hargaBeli?: number | string; keterangan?: string };
  }>('/api/trading-harga-beli/:id', async (req, reply) => {
    const existing = await prisma.tradingHargaBeli.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Target harga beli tidak ditemukan' });

    let hargaBeli = existing.hargaBeli;
    if (req.body.hargaBeli !== undefined) {
      const parsed = parseDecimalInput(req.body.hargaBeli);
      if (!parsed) return badRequest(reply, 'hargaBeli harus berupa angka');
      hargaBeli = parsed;
    }

    const item = await prisma.tradingHargaBeli.update({
      where: { id: req.params.id },
      data: {
        hargaBeli,
        keterangan: req.body.keterangan !== undefined ? req.body.keterangan?.trim() || null : existing.keterangan,
      },
    });
    return { item: serializeTradingHargaBeli(item) };
  });

  app.delete<{ Params: { id: string } }>('/api/trading-harga-beli/:id', async (req) => {
    await prisma.tradingHargaBeli.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get('/api/kop-surat', async () => {
    const item = await prisma.kopSurat.findUnique({ where: { id: 'default' } });
    if (!item) {
      return {
        item: {
          namaKlinik: 'KLINIK PRIMA HUSADA',
          alamat: 'Jl. Siliwangi Ruko Palapa No 2 Parung Kuda',
          telepon: '0857-1932-5557',
          logoDataUrl: null,
        },
      };
    }
    return {
      item: {
        namaKlinik: item.namaKlinik,
        alamat: item.alamat,
        telepon: item.telepon,
        logoDataUrl: item.logoDataUrl,
      },
    };
  });

  app.put<{
    Body: { namaKlinik?: string; alamat?: string; telepon?: string; logoDataUrl?: string | null };
  }>('/api/kop-surat', async (req, reply) => {
    const b = req.body;
    const data = {
      namaKlinik: b.namaKlinik?.trim() || 'KLINIK PRIMA HUSADA',
      alamat: b.alamat?.trim() || '',
      telepon: b.telepon?.trim() || '',
      logoDataUrl: b.logoDataUrl ?? null,
    };
    const item = await prisma.kopSurat.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data },
      update: data,
    });
    return reply.status(200).send({
      item: {
        namaKlinik: item.namaKlinik,
        alamat: item.alamat,
        telepon: item.telepon,
        logoDataUrl: item.logoDataUrl,
      },
    });
  });

  // ─── Pengaturan Pengingat Stock Opname Reagen (Laboratorium) ───────────────

  const DEFAULT_REAGEN_REMINDER_PESAN =
    'Perhatian, sudah tanggal 20. Segera hitung stock opname laboratorium, dan lakukan pembelian jika stok kurang.';

  app.get('/api/reagen-reminder-setting', async () => {
    const item = await prisma.reagenReminderSetting.findUnique({ where: { id: 'default' } });
    if (!item) {
      return { item: { tanggal: 20, pesan: DEFAULT_REAGEN_REMINDER_PESAN } };
    }
    return { item: { tanggal: item.tanggal, pesan: item.pesan } };
  });

  app.put<{
    Body: { tanggal?: number; pesan?: string };
  }>('/api/reagen-reminder-setting', async (req, reply) => {
    const b = req.body;
    const tanggalNum = Number(b.tanggal);
    const data = {
      tanggal: Number.isInteger(tanggalNum) && tanggalNum >= 1 && tanggalNum <= 31 ? tanggalNum : 20,
      pesan: b.pesan?.trim() || DEFAULT_REAGEN_REMINDER_PESAN,
    };
    const item = await prisma.reagenReminderSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...data },
      update: data,
    });
    return reply.status(200).send({ item: { tanggal: item.tanggal, pesan: item.pesan } });
  });

  app.get<{ Querystring: ListQuery }>('/api/tanda-tangan-elektronik', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = tandaTanganElektronikListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.tandaTanganElektronik.count({ where }),
      prisma.tandaTanganElektronik.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: { nama: string; alamat?: string; logoTandaTangan?: string | null };
  }>('/api/tanda-tangan-elektronik', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.tandaTanganElektronik.create({
      data: {
        nama: req.body.nama.trim(),
        alamat: req.body.alamat?.trim() || null,
        logoTandaTangan: req.body.logoTandaTangan ?? null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: { nama?: string; alamat?: string; logoTandaTangan?: string | null };
  }>('/api/tanda-tangan-elektronik/:id', async (req, reply) => {
    const existing = await prisma.tandaTanganElektronik.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Tanda tangan elektronik tidak ditemukan' });
    const item = await prisma.tandaTanganElektronik.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        alamat: req.body.alamat !== undefined ? req.body.alamat?.trim() || null : existing.alamat,
        logoTandaTangan:
          req.body.logoTandaTangan !== undefined ? req.body.logoTandaTangan : existing.logoTandaTangan,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/tanda-tangan-elektronik/:id', async (req) => {
    await prisma.tandaTanganElektronik.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/foto-dashboard', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = fotoDashboardListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.fotoDashboard.count({ where }),
      prisma.fotoDashboard.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: { nama: string; foto?: string | null };
  }>('/api/foto-dashboard', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.fotoDashboard.create({
      data: {
        nama: req.body.nama.trim(),
        foto: req.body.foto ?? null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: { nama?: string; foto?: string | null };
  }>('/api/foto-dashboard/:id', async (req, reply) => {
    const existing = await prisma.fotoDashboard.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Foto dashboard tidak ditemukan' });
    const item = await prisma.fotoDashboard.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        foto: req.body.foto !== undefined ? req.body.foto : existing.foto,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/foto-dashboard/:id', async (req) => {
    await prisma.fotoDashboard.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.get<{ Querystring: ListQuery }>('/api/logo-perusahaan', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = logoPerusahaanListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.logoPerusahaan.count({ where }),
      prisma.logoPerusahaan.findMany({
        where,
        orderBy: { namaKlinik: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: {
      namaKlinik: string;
      alamat?: string | null;
      noTelepon?: string | null;
      email?: string | null;
      penanggungJawab?: string | null;
      logoTandaTangan?: string | null;
      logoPerusahaan?: string | null;
    };
  }>('/api/logo-perusahaan', async (req, reply) => {
    if (!req.body.namaKlinik?.trim()) return badRequest(reply, 'namaKlinik wajib diisi');
    const item = await prisma.logoPerusahaan.create({
      data: {
        namaKlinik: req.body.namaKlinik.trim(),
        alamat: req.body.alamat?.trim() || null,
        noTelepon: req.body.noTelepon?.trim() || null,
        email: req.body.email?.trim() || null,
        penanggungJawab: req.body.penanggungJawab?.trim() || null,
        logoTandaTangan: req.body.logoTandaTangan ?? null,
        logoPerusahaan: req.body.logoPerusahaan ?? null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaKlinik?: string;
      alamat?: string | null;
      noTelepon?: string | null;
      email?: string | null;
      penanggungJawab?: string | null;
      logoTandaTangan?: string | null;
      logoPerusahaan?: string | null;
    };
  }>('/api/logo-perusahaan/:id', async (req, reply) => {
    const existing = await prisma.logoPerusahaan.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Logo perusahaan tidak ditemukan' });
    const item = await prisma.logoPerusahaan.update({
      where: { id: req.params.id },
      data: {
        namaKlinik: req.body.namaKlinik?.trim() ?? existing.namaKlinik,
        alamat: req.body.alamat !== undefined ? req.body.alamat?.trim() || null : existing.alamat,
        noTelepon: req.body.noTelepon !== undefined ? req.body.noTelepon?.trim() || null : existing.noTelepon,
        email: req.body.email !== undefined ? req.body.email?.trim() || null : existing.email,
        penanggungJawab:
          req.body.penanggungJawab !== undefined ? req.body.penanggungJawab?.trim() || null : existing.penanggungJawab,
        logoTandaTangan:
          req.body.logoTandaTangan !== undefined ? req.body.logoTandaTangan : existing.logoTandaTangan,
        logoPerusahaan:
          req.body.logoPerusahaan !== undefined ? req.body.logoPerusahaan : existing.logoPerusahaan,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/logo-perusahaan/:id', async (req) => {
    await prisma.logoPerusahaan.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  /** Catatan PJ Laboratorium: daftar lengkap (jumlahnya kecil, satu-dua baris per bulan) urut bulan. */
  app.get('/api/pj-lab', async () => {
    const items = await prisma.pjLab.findMany({ orderBy: [{ bulan: 'asc' }, { createdAt: 'asc' }] });
    return { items: items.map((p) => ({ ...p, jumlah: serializeDecimal(p.jumlah) })) };
  });

  app.post<{
    Body: { bulan?: string; dokterNama?: string; jumlah?: number | string; adminNama?: string | null };
  }>('/api/pj-lab', async (req, reply) => {
    const bulan = parsePjBulan(req.body.bulan);
    if (!bulan) return badRequest(reply, 'Bulan tidak valid (format YYYY-MM)');
    const dokterNama = req.body.dokterNama?.trim();
    if (!dokterNama) return badRequest(reply, 'Nama dokter wajib diisi');
    const jumlah = parseSharingNominal(req.body.jumlah);
    if (jumlah === null) return badRequest(reply, 'Jumlah tidak valid');
    const item = await prisma.pjLab.create({
      data: { bulan, dokterNama, jumlah, adminNama: req.body.adminNama?.trim() || null },
    });
    return reply.status(201).send({ item: { ...item, jumlah: serializeDecimal(item.jumlah) } });
  });

  app.patch<{
    Params: { id: string };
    Body: { bulan?: string; dokterNama?: string; jumlah?: number | string; adminNama?: string | null };
  }>('/api/pj-lab/:id', async (req, reply) => {
    const existing = await prisma.pjLab.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data PJ tidak ditemukan' });
    let bulan = existing.bulan;
    if (req.body.bulan !== undefined) {
      const parsed = parsePjBulan(req.body.bulan);
      if (!parsed) return badRequest(reply, 'Bulan tidak valid (format YYYY-MM)');
      bulan = parsed;
    }
    let dokterNama = existing.dokterNama;
    if (req.body.dokterNama !== undefined) {
      const trimmed = req.body.dokterNama.trim();
      if (!trimmed) return badRequest(reply, 'Nama dokter wajib diisi');
      dokterNama = trimmed;
    }
    let jumlah: Decimal | number = existing.jumlah;
    if (req.body.jumlah !== undefined) {
      const parsed = parseSharingNominal(req.body.jumlah);
      if (parsed === null) return badRequest(reply, 'Jumlah tidak valid');
      jumlah = parsed;
    }
    const item = await prisma.pjLab.update({
      where: { id: req.params.id },
      data: {
        bulan,
        dokterNama,
        jumlah,
        adminNama:
          req.body.adminNama !== undefined ? req.body.adminNama?.trim() || null : existing.adminNama,
      },
    });
    return { item: { ...item, jumlah: serializeDecimal(item.jumlah) } };
  });

  app.delete<{ Params: { id: string } }>('/api/pj-lab/:id', async (req, reply) => {
    try {
      await prisma.pjLab.delete({ where: { id: req.params.id } });
      return { ok: true };
    } catch {
      return reply.status(404).send({ error: 'Data PJ tidak ditemukan' });
    }
  });

  app.get('/api/autotext', async () => {
    const item = await prisma.autoText.findFirst({ orderBy: { createdAt: 'asc' } });
    return { item };
  });

  app.put<{ Body: { text: string } }>('/api/autotext', async (req, reply) => {
    if (!req.body.text?.trim()) return badRequest(reply, 'text wajib diisi');
    const text = req.body.text.trim();
    const existing = await prisma.autoText.findFirst({ orderBy: { createdAt: 'asc' } });
    const item = existing
      ? await prisma.autoText.update({ where: { id: existing.id }, data: { text } })
      : await prisma.autoText.create({ data: { text } });
    return { item };
  });

  app.get<{ Querystring: ListQuery }>('/api/daftar-telpon', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = daftarTelponListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.daftarTelpon.count({ where }),
      prisma.daftarTelpon.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: {
      nama: string;
      telpon?: string;
      admin?: string;
      password?: string;
      noKontrak?: string;
      namaInstansi?: string;
    };
  }>('/api/daftar-telpon', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'nama wajib diisi');
    const item = await prisma.daftarTelpon.create({
      data: {
        nama: req.body.nama.trim(),
        telpon: req.body.telpon?.trim() || null,
        admin: req.body.admin?.trim() || null,
        password: req.body.password?.trim() || null,
        noKontrak: req.body.noKontrak?.trim() || null,
        namaInstansi: req.body.namaInstansi?.trim() || null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nama?: string;
      telpon?: string;
      admin?: string;
      password?: string;
      noKontrak?: string;
      namaInstansi?: string;
    };
  }>('/api/daftar-telpon/:id', async (req, reply) => {
    const existing = await prisma.daftarTelpon.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data tidak ditemukan' });
    const item = await prisma.daftarTelpon.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() ?? existing.nama,
        telpon: req.body.telpon !== undefined ? req.body.telpon?.trim() || null : existing.telpon,
        admin: req.body.admin !== undefined ? req.body.admin?.trim() || null : existing.admin,
        password: req.body.password !== undefined ? req.body.password?.trim() || null : existing.password,
        noKontrak: req.body.noKontrak !== undefined ? req.body.noKontrak?.trim() || null : existing.noKontrak,
        namaInstansi:
          req.body.namaInstansi !== undefined ? req.body.namaInstansi?.trim() || null : existing.namaInstansi,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/daftar-telpon/:id', async (req) => {
    await prisma.daftarTelpon.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Daftar Akun (kredensial akun sosmed/email dsb, dari halaman Sosmed) ──

  app.get<{ Querystring: ListQuery }>('/api/daftar-akun', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = daftarAkunListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.daftarAkun.count({ where }),
      prisma.daftarAkun.findMany({
        where,
        orderBy: { namaAkun: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: {
      namaAkun: string;
      gmail?: string;
      password?: string;
      nomorHp?: string;
      otentikator?: string;
      passwordGmail?: string;
    };
  }>('/api/daftar-akun', async (req, reply) => {
    if (!req.body.namaAkun?.trim()) return badRequest(reply, 'Nama akun wajib diisi');
    const item = await prisma.daftarAkun.create({
      data: {
        namaAkun: req.body.namaAkun.trim(),
        gmail: req.body.gmail?.trim() || null,
        password: req.body.password?.trim() || null,
        nomorHp: req.body.nomorHp?.trim() || null,
        otentikator: req.body.otentikator?.trim() || null,
        passwordGmail: req.body.passwordGmail?.trim() || null,
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      namaAkun?: string;
      gmail?: string;
      password?: string;
      nomorHp?: string;
      otentikator?: string;
      passwordGmail?: string;
    };
  }>('/api/daftar-akun/:id', async (req, reply) => {
    const existing = await prisma.daftarAkun.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data tidak ditemukan' });
    const item = await prisma.daftarAkun.update({
      where: { id: req.params.id },
      data: {
        namaAkun: req.body.namaAkun?.trim() ?? existing.namaAkun,
        gmail: req.body.gmail !== undefined ? req.body.gmail?.trim() || null : existing.gmail,
        password: req.body.password !== undefined ? req.body.password?.trim() || null : existing.password,
        nomorHp: req.body.nomorHp !== undefined ? req.body.nomorHp?.trim() || null : existing.nomorHp,
        otentikator:
          req.body.otentikator !== undefined ? req.body.otentikator?.trim() || null : existing.otentikator,
        passwordGmail:
          req.body.passwordGmail !== undefined
            ? req.body.passwordGmail?.trim() || null
            : existing.passwordGmail,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/daftar-akun/:id', async (req) => {
    await prisma.daftarAkun.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Rekening Bank (dari halaman Global Warm) ──────────────────────────────

  app.get<{ Querystring: ListQuery }>('/api/rekening-bank', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = rekeningBankListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.rekeningBank.count({ where }),
      prisma.rekeningBank.findMany({
        where,
        orderBy: { nama: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{
    Body: { nama: string; bank: string; noRekening: string };
  }>('/api/rekening-bank', async (req, reply) => {
    if (!req.body.nama?.trim()) return badRequest(reply, 'Nama wajib diisi');
    if (!req.body.bank?.trim()) return badRequest(reply, 'Bank wajib diisi');
    if (!req.body.noRekening?.trim()) return badRequest(reply, 'No rekening wajib diisi');
    const item = await prisma.rekeningBank.create({
      data: {
        nama: req.body.nama.trim(),
        bank: req.body.bank.trim(),
        noRekening: req.body.noRekening.trim(),
      },
    });
    return reply.status(201).send({ item });
  });

  app.patch<{
    Params: { id: string };
    Body: { nama?: string; bank?: string; noRekening?: string };
  }>('/api/rekening-bank/:id', async (req, reply) => {
    const existing = await prisma.rekeningBank.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Data tidak ditemukan' });
    const item = await prisma.rekeningBank.update({
      where: { id: req.params.id },
      data: {
        nama: req.body.nama?.trim() || existing.nama,
        bank: req.body.bank?.trim() || existing.bank,
        noRekening: req.body.noRekening?.trim() || existing.noRekening,
      },
    });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/api/rekening-bank/:id', async (req) => {
    await prisma.rekeningBank.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Galeri Masjid (dari halaman Jam) ───────────────────────────────────────

  app.get<{ Querystring: ListQuery }>('/api/galeri-masjid', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const [total, items] = await Promise.all([
      prisma.galeriMasjid.count(),
      prisma.galeriMasjid.findMany({
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
    ]);
    return { items, pagination: buildPaginationMeta(total, page, limit) };
  });

  app.post<{ Body: { judul: string; gambar: string } }>('/api/galeri-masjid', async (req, reply) => {
    if (!req.body.judul?.trim()) return badRequest(reply, 'Judul wajib diisi');
    if (!req.body.gambar?.trim()) return badRequest(reply, 'Gambar wajib diunggah');
    const item = await prisma.galeriMasjid.create({
      data: { judul: req.body.judul.trim(), gambar: req.body.gambar },
    });
    return reply.status(201).send({ item });
  });

  app.delete<{ Params: { id: string } }>('/api/galeri-masjid/:id', async (req) => {
    await prisma.galeriMasjid.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Hari Libur (Kalender) ──────────────────────────────────────────────────

  app.get<{ Querystring: { year?: string } }>('/api/hari-libur', async (req) => {
    const yearStr = req.query.year || new Date().getFullYear().toString();
    const year = parseInt(yearStr, 10);
    if (isNaN(year)) return { items: [] };
    const items = await prisma.hariLibur.findMany({
      where: { tanggal: { gte: new Date(year, 0, 1), lte: new Date(year, 11, 31, 23, 59, 59, 999) } },
      orderBy: { tanggal: 'asc' },
    });
    return {
      items: items.map((h) => ({
        id: h.id,
        tanggal: h.tanggal.toISOString().slice(0, 10),
        keterangan: h.keterangan,
      })),
    };
  });

  app.post<{ Body: { tanggal: string; keterangan: string } }>(
    '/api/hari-libur',
    async (req, reply) => {
      if (!req.body.tanggal || !req.body.keterangan?.trim()) {
        return badRequest(reply, 'tanggal dan keterangan wajib diisi');
      }
      try {
        const item = await prisma.hariLibur.create({
          data: { tanggal: new Date(req.body.tanggal), keterangan: req.body.keterangan.trim() },
        });
        return reply.status(201).send({
          item: { id: item.id, tanggal: item.tanggal.toISOString().slice(0, 10), keterangan: item.keterangan },
        });
      } catch (err: unknown) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          return badRequest(reply, 'Sudah ada hari libur untuk tanggal tersebut');
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { tanggal?: string; keterangan?: string } }>(
    '/api/hari-libur/:id',
    async (req, reply) => {
      const existing = await prisma.hariLibur.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.status(404).send({ error: 'Hari libur tidak ditemukan' });
      try {
        const item = await prisma.hariLibur.update({
          where: { id: req.params.id },
          data: {
            tanggal: req.body.tanggal ? new Date(req.body.tanggal) : existing.tanggal,
            keterangan: req.body.keterangan?.trim() ?? existing.keterangan,
          },
        });
        return { item: { id: item.id, tanggal: item.tanggal.toISOString().slice(0, 10), keterangan: item.keterangan } };
      } catch (err: unknown) {
        if (err instanceof PrismaClientKnownRequestError && err.code === 'P2002') {
          return badRequest(reply, 'Sudah ada hari libur untuk tanggal tersebut');
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/hari-libur/:id', async (req) => {
    await prisma.hariLibur.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Surat Keterangan Sehat ─────────────────────────────────────────────────

  app.get<{ Querystring: ListQuery }>('/api/surat-keterangan-sehat', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = suratKeteranganSehatListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.suratKeteranganSehat.count({ where }),
      prisma.suratKeteranganSehat.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);
    return {
      items: items.map((it) => ({ ...it, tanggalSurat: it.tanggalSurat.toISOString().slice(0, 10) })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      nomorSurat?: string;
      namaPasien: string;
      tempatTanggalLahir?: string;
      jenisKelamin?: string;
      pekerjaan?: string;
      alamatPasien?: string;
      hasilPemeriksaan?: string;
      keperluan?: string;
      tempatSurat?: string;
      tanggalSurat?: string;
      namaDokter?: string;
      jabatanDokter?: string;
    };
  }>('/api/surat-keterangan-sehat', async (req, reply) => {
    if (!req.body.namaPasien?.trim()) return badRequest(reply, 'namaPasien wajib diisi');
    const item = await prisma.suratKeteranganSehat.create({
      data: {
        nomorSurat: req.body.nomorSurat?.trim() || null,
        namaPasien: req.body.namaPasien.trim(),
        tempatTanggalLahir: req.body.tempatTanggalLahir?.trim() || null,
        jenisKelamin: req.body.jenisKelamin?.trim() || 'Laki-laki',
        pekerjaan: req.body.pekerjaan?.trim() || null,
        alamatPasien: req.body.alamatPasien?.trim() || null,
        hasilPemeriksaan: req.body.hasilPemeriksaan?.trim() || null,
        keperluan: req.body.keperluan?.trim() || null,
        tempatSurat: req.body.tempatSurat?.trim() || null,
        tanggalSurat: req.body.tanggalSurat ? new Date(req.body.tanggalSurat) : new Date(),
        namaDokter: req.body.namaDokter?.trim() || null,
        jabatanDokter: req.body.jabatanDokter?.trim() || null,
      },
    });
    return reply.status(201).send({ item: { ...item, tanggalSurat: item.tanggalSurat.toISOString().slice(0, 10) } });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nomorSurat?: string;
      namaPasien?: string;
      tempatTanggalLahir?: string;
      jenisKelamin?: string;
      pekerjaan?: string;
      alamatPasien?: string;
      hasilPemeriksaan?: string;
      keperluan?: string;
      tempatSurat?: string;
      tanggalSurat?: string;
      namaDokter?: string;
      jabatanDokter?: string;
    };
  }>('/api/surat-keterangan-sehat/:id', async (req, reply) => {
    const existing = await prisma.suratKeteranganSehat.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Surat tidak ditemukan' });
    const item = await prisma.suratKeteranganSehat.update({
      where: { id: req.params.id },
      data: {
        nomorSurat: req.body.nomorSurat !== undefined ? req.body.nomorSurat?.trim() || null : existing.nomorSurat,
        namaPasien: req.body.namaPasien?.trim() ?? existing.namaPasien,
        tempatTanggalLahir:
          req.body.tempatTanggalLahir !== undefined ? req.body.tempatTanggalLahir?.trim() || null : existing.tempatTanggalLahir,
        jenisKelamin: req.body.jenisKelamin?.trim() ?? existing.jenisKelamin,
        pekerjaan: req.body.pekerjaan !== undefined ? req.body.pekerjaan?.trim() || null : existing.pekerjaan,
        alamatPasien: req.body.alamatPasien !== undefined ? req.body.alamatPasien?.trim() || null : existing.alamatPasien,
        hasilPemeriksaan:
          req.body.hasilPemeriksaan !== undefined ? req.body.hasilPemeriksaan?.trim() || null : existing.hasilPemeriksaan,
        keperluan: req.body.keperluan !== undefined ? req.body.keperluan?.trim() || null : existing.keperluan,
        tempatSurat: req.body.tempatSurat !== undefined ? req.body.tempatSurat?.trim() || null : existing.tempatSurat,
        tanggalSurat: req.body.tanggalSurat ? new Date(req.body.tanggalSurat) : existing.tanggalSurat,
        namaDokter: req.body.namaDokter !== undefined ? req.body.namaDokter?.trim() || null : existing.namaDokter,
        jabatanDokter: req.body.jabatanDokter !== undefined ? req.body.jabatanDokter?.trim() || null : existing.jabatanDokter,
      },
    });
    return { item: { ...item, tanggalSurat: item.tanggalSurat.toISOString().slice(0, 10) } };
  });

  app.delete<{ Params: { id: string } }>('/api/surat-keterangan-sehat/:id', async (req) => {
    await prisma.suratKeteranganSehat.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // ─── Surat Keterangan Rujukan ───────────────────────────────────────────────

  app.get<{ Querystring: ListQuery }>('/api/surat-keterangan-rujukan', async (req) => {
    const { page, limit, skip } = parsePagination(req.query);
    const where = suratKeteranganRujukanListWhere(req.query.q);
    const [total, items] = await Promise.all([
      prisma.suratKeteranganRujukan.count({ where }),
      prisma.suratKeteranganRujukan.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);
    return {
      items: items.map((it) => ({ ...it, tanggalSurat: it.tanggalSurat.toISOString().slice(0, 10) })),
      pagination: buildPaginationMeta(total, page, limit),
    };
  });

  app.post<{
    Body: {
      nomorSurat?: string;
      namaPasien: string;
      tempatTanggalLahir?: string;
      jenisKelamin?: string;
      alamatPasien?: string;
      dirujukKe?: string;
      diagnosaKeluhan?: string;
      alasanRujukan?: string;
      tempatSurat?: string;
      tanggalSurat?: string;
      namaDokter?: string;
      jabatanDokter?: string;
    };
  }>('/api/surat-keterangan-rujukan', async (req, reply) => {
    if (!req.body.namaPasien?.trim()) return badRequest(reply, 'namaPasien wajib diisi');
    const item = await prisma.suratKeteranganRujukan.create({
      data: {
        nomorSurat: req.body.nomorSurat?.trim() || null,
        namaPasien: req.body.namaPasien.trim(),
        tempatTanggalLahir: req.body.tempatTanggalLahir?.trim() || null,
        jenisKelamin: req.body.jenisKelamin?.trim() || 'Laki-laki',
        alamatPasien: req.body.alamatPasien?.trim() || null,
        dirujukKe: req.body.dirujukKe?.trim() || null,
        diagnosaKeluhan: req.body.diagnosaKeluhan?.trim() || null,
        alasanRujukan: req.body.alasanRujukan?.trim() || null,
        tempatSurat: req.body.tempatSurat?.trim() || null,
        tanggalSurat: req.body.tanggalSurat ? new Date(req.body.tanggalSurat) : new Date(),
        namaDokter: req.body.namaDokter?.trim() || null,
        jabatanDokter: req.body.jabatanDokter?.trim() || null,
      },
    });
    return reply.status(201).send({ item: { ...item, tanggalSurat: item.tanggalSurat.toISOString().slice(0, 10) } });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      nomorSurat?: string;
      namaPasien?: string;
      tempatTanggalLahir?: string;
      jenisKelamin?: string;
      alamatPasien?: string;
      dirujukKe?: string;
      diagnosaKeluhan?: string;
      alasanRujukan?: string;
      tempatSurat?: string;
      tanggalSurat?: string;
      namaDokter?: string;
      jabatanDokter?: string;
    };
  }>('/api/surat-keterangan-rujukan/:id', async (req, reply) => {
    const existing = await prisma.suratKeteranganRujukan.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'Surat tidak ditemukan' });
    const item = await prisma.suratKeteranganRujukan.update({
      where: { id: req.params.id },
      data: {
        nomorSurat: req.body.nomorSurat !== undefined ? req.body.nomorSurat?.trim() || null : existing.nomorSurat,
        namaPasien: req.body.namaPasien?.trim() ?? existing.namaPasien,
        tempatTanggalLahir:
          req.body.tempatTanggalLahir !== undefined ? req.body.tempatTanggalLahir?.trim() || null : existing.tempatTanggalLahir,
        jenisKelamin: req.body.jenisKelamin?.trim() ?? existing.jenisKelamin,
        alamatPasien: req.body.alamatPasien !== undefined ? req.body.alamatPasien?.trim() || null : existing.alamatPasien,
        dirujukKe: req.body.dirujukKe !== undefined ? req.body.dirujukKe?.trim() || null : existing.dirujukKe,
        diagnosaKeluhan:
          req.body.diagnosaKeluhan !== undefined ? req.body.diagnosaKeluhan?.trim() || null : existing.diagnosaKeluhan,
        alasanRujukan: req.body.alasanRujukan !== undefined ? req.body.alasanRujukan?.trim() || null : existing.alasanRujukan,
        tempatSurat: req.body.tempatSurat !== undefined ? req.body.tempatSurat?.trim() || null : existing.tempatSurat,
        tanggalSurat: req.body.tanggalSurat ? new Date(req.body.tanggalSurat) : existing.tanggalSurat,
        namaDokter: req.body.namaDokter !== undefined ? req.body.namaDokter?.trim() || null : existing.namaDokter,
        jabatanDokter: req.body.jabatanDokter !== undefined ? req.body.jabatanDokter?.trim() || null : existing.jabatanDokter,
      },
    });
    return { item: { ...item, tanggalSurat: item.tanggalSurat.toISOString().slice(0, 10) } };
  });

  app.delete<{ Params: { id: string } }>('/api/surat-keterangan-rujukan/:id', async (req) => {
    await prisma.suratKeteranganRujukan.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}

function mapPasien(
  p: {
    id: string;
    regCode: string;
    nama: string;
    tanggalLahir: Date;
    noTelepon: string | null;
    alamat: string | null;
    klinis: string | null;
    temuan: string | null;
    hasilStatus: string;
    paymentStatus: string;
    sharingAmount: Decimal | null;
    totalHarga: Decimal;
    totalSharing: Decimal;
    sharingLocked: boolean;
    kesan: string | null;
    admin: string | null;
    petugasKasir: string | null;
    foto: string | null;
    createdAt: Date;
    pengirim: { id: string; nama: string };
    radiolog?: { id: string; nama: string } | null;
    pemeriksaan: {
      id: string;
      jenisPemeriksaanId: string;
      hargaSnapshot: Decimal;
      jenisPemeriksaan: { nama: string };
    }[];
    paketLab: {
      id: string;
      paketLabId: string;
      hargaSnapshot: Decimal;
      paketLab: { nama: string };
    }[];
  },
) {
  return {
    id: p.id,
    regCode: p.regCode,
    nama: p.nama,
    umur: computeUmur(p.tanggalLahir),
    tanggalLahir: p.tanggalLahir.toISOString().slice(0, 10),
    noTelepon: p.noTelepon,
    alamat: p.alamat,
    pengirim: p.pengirim,
    klinis: p.klinis,
    temuan: p.temuan,
    hasilStatus: p.hasilStatus,
    paymentStatus: p.paymentStatus,
    sharingAmount: serializeDecimal(p.sharingAmount ?? p.totalSharing),
    totalHarga: serializeDecimal(p.totalHarga),
    totalSharing: serializeDecimal(p.totalSharing),
    sharingLocked: p.sharingLocked,
    kesan: p.kesan,
    admin: p.admin,
    petugasKasir: p.petugasKasir,
    foto: p.foto,
    radiolog: p.radiolog ?? null,
    // Radiologi pakai PasienPemeriksaan (relasi ke JenisPemeriksaan), Laboratorium
    // pakai PasienPaketLab (relasi ke PaketLab) — keduanya digabung jadi satu
    // array `pemeriksaan` yang seragam supaya frontend tidak perlu tahu bedanya.
    pemeriksaan: [
      ...p.pemeriksaan.map((x) => ({
        id: x.id,
        jenisPemeriksaanId: x.jenisPemeriksaanId,
        nama: x.jenisPemeriksaan.nama,
        harga: serializeDecimal(x.hargaSnapshot),
      })),
      ...p.paketLab.map((x) => ({
        id: x.id,
        jenisPemeriksaanId: x.paketLabId,
        nama: x.paketLab.nama,
        harga: serializeDecimal(x.hargaSnapshot),
      })),
    ],
    createdAt: p.createdAt.toISOString(),
  };
}
