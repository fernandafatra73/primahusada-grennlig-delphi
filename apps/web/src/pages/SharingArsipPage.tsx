import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import { ListPageShell } from '../components/ui/ListPageShell.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { ModalFormFooter } from '../components/ui/ModalFormFooter.tsx';
import { SharingPdfPreviewModal } from '../components/ui/SharingPdfPreviewModal.tsx';
import { TableRowActions } from '../components/ui/TableRowActions.tsx';
import {
  useListQueryParams,
  useListSearch,
} from '../hooks/useListQueryParams.ts';
import { useMutationReload } from '../hooks/useMutationReload.ts';
import { usePaginatedList } from '../hooks/usePaginatedList.ts';
import { apiDelete, apiGet, apiPatch } from '../lib/api.ts';
import { formatDateShort, formatRupiah } from '../lib/format.ts';
import type { PaginatedResponse } from '../lib/pagination.ts';
import {
  generateSharingArsipReportBlob,
  printSharingArsipReport,
} from '../pdf/printSharingArsipReport.tsx';
import {
  generateSharingRingkasanReportBlob,
  printSharingRingkasanReport,
} from '../pdf/printSharingRingkasanReport.tsx';
import type { SharingRingkasanReportItem } from '../pdf/SharingRingkasanReportDocument.tsx';
import '../components/ui/ui.css';

interface DokterItem {
  readonly id: string;
  readonly nama: string;
}

interface ArsipPasienItem {
  readonly id: string;
  readonly regCode: string;
  readonly nama: string;
  readonly umur: number;
  readonly alamat: string | null;
  readonly pengirimNama: string;
  readonly pemeriksaanNama: string;
  readonly petugasAdminKlinik: string | null;
  readonly paymentStatus: 'BELUM_LUNAS' | 'LUNAS';
  readonly totalHarga: string;
  readonly totalSharing: string;
  readonly createdAt: string;
}

type PeriodType = 'all' | 'today' | 'week' | 'month' | 'custom';

function getPeriodDates(
  period: PeriodType,
  customStart: string,
  customEnd: string,
) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;

  if (period === 'custom') {
    return { startDate: customStart, endDate: customEnd };
  }
  if (period === 'today') {
    return { startDate: todayStr, endDate: todayStr };
  }
  if (period === 'week') {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    const sy = start.getFullYear();
    const sm = String(start.getMonth() + 1).padStart(2, '0');
    const sd = String(start.getDate()).padStart(2, '0');
    return { startDate: `${sy}-${sm}-${sd}`, endDate: todayStr };
  }
  if (period === 'month') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const fy = firstDay.getFullYear();
    const fm = String(firstDay.getMonth() + 1).padStart(2, '0');
    const fd = String(firstDay.getDate()).padStart(2, '0');
    return { startDate: `${fy}-${fm}-${fd}`, endDate: todayStr };
  }
  return { startDate: '', endDate: '' };
}

/** ISO timestamp → YYYY-MM-DD dalam zona waktu lokal, untuk input type="date". */
function toLocalDateInput(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface SharingArsipPageProps {
  readonly modul: 'RADIOLOGI' | 'LABORATORIUM';
}

export function SharingArsipPage({ modul }: SharingArsipPageProps) {
  const { search, setSearch } = useListSearch();
  const [dokterList, setDokterList] = useState<DokterItem[]>([]);
  const [selectedDokterNama, setSelectedDokterNama] = useState<string>('all');
  const [period, setPeriod] = useState<PeriodType>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [adminNama, setAdminNama] = useState('');
  const [isSharingEi, setIsSharingEi] = useState(false);

  const sharingEiDokterNames = useMemo(
    () =>
      dokterList
        .filter((d) => /eva christiani/i.test(d.nama) || /iman/i.test(d.nama))
        .map((d) => d.nama),
    [dokterList],
  );

  useEffect(() => {
    const saved = localStorage.getItem('sharing_admin_nama');
    if (saved) setAdminNama(saved);
  }, []);

  function handleAdminNamaChange(value: string) {
    setAdminNama(value);
    localStorage.setItem('sharing_admin_nama', value);
  }

  const { startDate, endDate } = useMemo(
    () => getPeriodDates(period, customStart, customEnd),
    [period, customStart, customEnd],
  );

  const listParams = useMemo(() => {
    const params: Record<string, string> = { modul };
    if (isSharingEi) {
      if (sharingEiDokterNames.length > 0) {
        params.pengirimNama = sharingEiDokterNames.join(',');
      }
    } else if (selectedDokterNama !== 'all') {
      params.pengirimNama = selectedDokterNama;
    }
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    return params;
  }, [modul, selectedDokterNama, startDate, endDate, isSharingEi, sharingEiDokterNames]);

  const queryParams = useListQueryParams(listParams, search);
  const {
    items,
    pagination,
    setPage,
    loading,
    error,
    setError,
    reload: reloadList,
  } = usePaginatedList<ArsipPasienItem>('/api/pasien-duplikat', queryParams);
  const reload = useMutationReload(reloadList);

  const [editing, setEditing] = useState<ArsipPasienItem | null>(null);
  const [editForm, setEditForm] = useState({
    tanggal: '',
    nama: '',
    alamat: '',
    pengirimNama: '',
    pemeriksaanNama: '',
    petugasAdminKlinik: '',
    totalHarga: '0',
    totalSharing: '0',
    paymentStatus: 'BELUM_LUNAS' as 'BELUM_LUNAS' | 'LUNAS',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ArsipPasienItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await apiDelete(`/api/pasien-duplikat/${deleteTarget.id}`);
      setDeleteTarget(null);
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus arsip');
    } finally {
      setDeleting(false);
    }
  }

  function openEdit(item: ArsipPasienItem) {
    setEditForm({
      tanggal: toLocalDateInput(item.createdAt),
      nama: item.nama,
      alamat: item.alamat ?? '',
      pengirimNama: item.pengirimNama,
      pemeriksaanNama: item.pemeriksaanNama,
      petugasAdminKlinik: item.petugasAdminKlinik ?? '',
      totalHarga: item.totalHarga,
      totalSharing: item.totalSharing,
      paymentStatus: item.paymentStatus,
    });
    setError(null);
    setEditing(item);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSavingEdit(true);
    setError(null);
    try {
      await apiPatch(`/api/pasien-duplikat/${editing.id}`, {
        tanggal: editForm.tanggal,
        nama: editForm.nama,
        alamat: editForm.alamat || undefined,
        pengirimNama: editForm.pengirimNama,
        pemeriksaanNama: editForm.pemeriksaanNama,
        petugasAdminKlinik: editForm.petugasAdminKlinik || undefined,
        totalHarga: Number(editForm.totalHarga) || 0,
        totalSharing: Number(editForm.totalSharing) || 0,
        paymentStatus: editForm.paymentStatus,
      });
      setEditing(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan perubahan arsip');
    } finally {
      setSavingEdit(false);
    }
  }

  const loadDokterList = useCallback(async () => {
    try {
      const res = await apiGet<PaginatedResponse<DokterItem>>(
        '/api/dokter?page=1&limit=200',
      );
      setDokterList(res.items);
    } catch {
      setDokterList([]);
    }
  }, []);

  useEffect(() => {
    void loadDokterList();
  }, [loadDokterList]);

  const totalPendapatan = useMemo(
    () => items.reduce((sum, item) => sum + (Number(item.totalHarga) || 0), 0),
    [items],
  );

  const totalSharing = useMemo(
    () => items.reduce((sum, item) => sum + (Number(item.totalSharing) || 0), 0),
    [items],
  );

  const [printingPdf, setPrintingPdf] = useState(false);
  const [previewingPdf, setPreviewingPdf] = useState(false);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewFilename, setPreviewFilename] = useState('Laporan_Sharing.pdf');

  const moduleLabel = modul === 'RADIOLOGI' ? 'Radiologi' : 'Laboratorium';

  const periodeLabel = useMemo(() => {
    if (period === 'today') return 'Hari Ini';
    if (period === 'week') return 'Minggu Ini';
    if (period === 'month') return 'Bulan Ini';
    if (period === 'custom') {
      return `${formatDateShort(customStart || '—')} s/d ${formatDateShort(customEnd || '—')}`;
    }
    return 'Semua Periode';
  }, [period, customStart, customEnd]);

  function findMostCommonPetugasAdminKlinik(list: readonly ArsipPasienItem[]): string {
    const counts = new Map<string, number>();
    for (const p of list) {
      const nama = p.petugasAdminKlinik?.trim();
      if (!nama) continue;
      counts.set(nama, (counts.get(nama) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [nama, count] of counts) {
      if (count > bestCount) {
        best = nama;
        bestCount = count;
      }
    }
    return best;
  }

  async function fetchAllPasienDuplikat(params: Record<string, string>): Promise<ArsipPasienItem[]> {
    const all: ArsipPasienItem[] = [];
    let page = 1;
    const limit = 100;
    for (;;) {
      const query = new URLSearchParams({ ...params, page: String(page), limit: String(limit) });
      const res = await apiGet<PaginatedResponse<ArsipPasienItem>>(`/api/pasien-duplikat?${query.toString()}`);
      all.push(...res.items);
      if (res.items.length === 0 || all.length >= res.pagination.total) break;
      page += 1;
    }
    return all;
  }

  async function buildRingkasanReportInput() {
    const { startDate: sd, endDate: ed } = getPeriodDates('week', '', '');
    const params: Record<string, string> = { modul };
    if (sharingEiDokterNames.length > 0) params.pengirimNama = sharingEiDokterNames.join(',');
    if (sd) params.startDate = sd;
    if (ed) params.endDate = ed;

    const allItems = sharingEiDokterNames.length > 0 ? await fetchAllPasienDuplikat(params) : [];
    const sortedItems = [...allItems].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    const pdfItems: SharingRingkasanReportItem[] = sortedItems.map((p, idx) => ({
      no: idx + 1,
      nama: p.nama,
      umur: p.umur,
      alamat: p.alamat || '—',
      tanggal: formatDateShort(p.createdAt),
      totalSharingFormatted: formatRupiah(p.totalSharing),
    }));

    const totalSharingSum = allItems.reduce((sum, i) => sum + (Number(i.totalSharing) || 0), 0);

    return {
      moduleLabel,
      dokterNama: sharingEiDokterNames.join(' & ') || 'Dr. Eva Christiani & Dr. Iman Purnawan',
      periodeLabel: 'Minggu Ini',
      tanggalCetak: formatDateShort(new Date().toISOString()),
      items: pdfItems,
      totalPasien: allItems.length,
      totalSharingFormatted: formatRupiah(totalSharingSum),
      adminNama: findMostCommonPetugasAdminKlinik(allItems) || adminNama,
    };
  }

  function buildReportInput() {
    const todayStr = formatDateShort(new Date().toISOString());
    const pdfItems = items.map((p, idx) => ({
      no: (pagination.page - 1) * pagination.limit + idx + 1,
      nama: p.nama,
      tanggal: formatDateShort(p.createdAt),
      alamat: p.alamat || '—',
      pemeriksaan: p.pemeriksaanNama || '—',
      totalSharingFormatted: formatRupiah(p.totalSharing),
    }));

    return {
      moduleLabel,
      dokterNama:
        selectedDokterNama === 'all' ? 'Semua Dokter' : selectedDokterNama,
      periodeLabel,
      tanggalCetak: todayStr,
      items: pdfItems,
      totalPasien: pagination.total,
      totalSharingFormatted: formatRupiah(totalSharing),
      adminNama: findMostCommonPetugasAdminKlinik(items) || adminNama,
    };
  }

  async function handlePrintPdf() {
    setPrintingPdf(true);
    try {
      if (isSharingEi) {
        await printSharingRingkasanReport(await buildRingkasanReportInput());
      } else {
        await printSharingArsipReport(buildReportInput());
      }
    } catch (err) {
      console.error('Gagal mencetak PDF sharing:', err);
    } finally {
      setPrintingPdf(false);
    }
  }

  async function handlePreviewPdf() {
    setPreviewingPdf(true);
    try {
      if (isSharingEi) {
        const input = await buildRingkasanReportInput();
        const blob = await generateSharingRingkasanReportBlob(input);
        setPreviewFilename('Laporan_Sharing_E_I.pdf');
        setPreviewBlob(blob);
        setPreviewModalOpen(true);
      } else {
        const input = buildReportInput();
        const blob = await generateSharingArsipReportBlob(input);
        const cleanDokter =
          input.dokterNama.trim().replace(/[/\\?%*:|"<>]/g, '_') || 'Dokter';
        setPreviewFilename(`Laporan_Sharing_${moduleLabel}_${cleanDokter}.pdf`);
        setPreviewBlob(blob);
        setPreviewModalOpen(true);
      }
    } catch (err) {
      console.error('Gagal membuat pratinjau PDF sharing:', err);
    } finally {
      setPreviewingPdf(false);
    }
  }

  const title = modul === 'RADIOLOGI' ? 'Sharing Radiologi' : 'Sharing Lab';
  const subtitle =
    modul === 'RADIOLOGI'
      ? 'Laporan pasien & pendapatan radiologi per dokter pengirim, dari arsip Duplikat Radiologi'
      : 'Laporan pasien & pendapatan laboratorium per dokter pengirim, dari arsip Duplikat Lab';

  return (
    <>
      <ListPageShell
        title={title}
        subtitle={subtitle}
        metrics={[
          {
            label: 'Total pasien',
            value: String(pagination.total),
            tone: 'blue',
            iconKind: 'clipboard',
          },
          {
            label: 'Dokter dipilih',
            value: isSharingEi
              ? 'Sharing E&I'
              : selectedDokterNama === 'all'
                ? 'Semua Dokter'
                : selectedDokterNama,
            tone: 'green',
            iconKind: 'document',
          },
          {
            label: 'Total pendapatan',
            value: formatRupiah(totalPendapatan),
            tone: 'violet',
            iconKind: 'percent',
          },
          {
            label: 'Total sharing',
            value: formatRupiah(totalSharing),
            tone: 'amber',
            iconKind: 'percent',
          },
        ]}
        searchPlaceholder="Cari nama pasien, reg code, alamat..."
        searchValue={search}
        onSearchChange={setSearch}
        onRefresh={() => void reload()}
        error={error}
        loading={loading}
        pagination={pagination}
        onPageChange={setPage}
      >
        <div className="filter-bar" style={{ marginBottom: '1.25rem' }}>
          <div className="form-field" style={{ minWidth: '220px' }}>
            <label htmlFor="filter-dokter-arsip">Dokter Pengirim</label>
            <select
              id="filter-dokter-arsip"
              value={selectedDokterNama}
              onChange={(e) => {
                setSelectedDokterNama(e.target.value);
                setIsSharingEi(false);
                setPage(1);
              }}
            >
              <option value="all">Semua Dokter Pengirim</option>
              {dokterList.map((d) => (
                <option key={d.id} value={d.nama}>
                  {d.nama}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label>Periode Waktu</label>
            <div className="filter-pills">
              <button
                type="button"
                className={`filter-pill ${period === 'all' && !isSharingEi ? 'filter-pill--active' : ''}`}
                onClick={() => {
                  setPeriod('all');
                  setIsSharingEi(false);
                  setPage(1);
                }}
              >
                Semua
              </button>
              <button
                type="button"
                className={`filter-pill ${period === 'today' && !isSharingEi ? 'filter-pill--active' : ''}`}
                onClick={() => {
                  setPeriod('today');
                  setIsSharingEi(false);
                  setPage(1);
                }}
              >
                Pasien Hari Ini
              </button>
              <button
                type="button"
                className={`filter-pill ${period === 'week' && !isSharingEi ? 'filter-pill--active' : ''}`}
                onClick={() => {
                  setPeriod('week');
                  setIsSharingEi(false);
                  setPage(1);
                }}
              >
                Pasien Minggu Ini
              </button>
              <button
                type="button"
                className={`filter-pill ${period === 'month' && !isSharingEi ? 'filter-pill--active' : ''}`}
                onClick={() => {
                  setPeriod('month');
                  setIsSharingEi(false);
                  setPage(1);
                }}
              >
                Pasien Bulan Ini
              </button>
              <button
                type="button"
                className={`filter-pill ${period === 'custom' && !isSharingEi ? 'filter-pill--active' : ''}`}
                onClick={() => {
                  setPeriod('custom');
                  setIsSharingEi(false);
                  setPage(1);
                }}
              >
                Kustom
              </button>
              {modul === 'LABORATORIUM' && (
                <button
                  type="button"
                  className={`filter-pill ${isSharingEi ? 'filter-pill--active' : ''}`}
                  onClick={() => {
                    setPeriod('week');
                    setIsSharingEi(true);
                    setPage(1);
                  }}
                  title="Gabungkan sharing Dr. Eva Christiani & Dr. Iman Purnawan dalam 1 laporan mingguan"
                >
                  Sharing E&amp;I
                </button>
              )}
            </div>
          </div>

          {period === 'custom' && (
            <>
              <div className="form-field">
                <label htmlFor="arsip-start-date">Dari Tanggal</label>
                <input
                  id="arsip-start-date"
                  type="date"
                  value={customStart}
                  onChange={(e) => {
                    setCustomStart(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <div className="form-field">
                <label htmlFor="arsip-end-date">Sampai Tanggal</label>
                <input
                  id="arsip-end-date"
                  type="date"
                  value={customEnd}
                  onChange={(e) => {
                    setCustomEnd(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </>
          )}

          <div className="form-field">
            <label htmlFor="arsip-admin-nama">Nama Admin</label>
            <input
              id="arsip-admin-nama"
              type="text"
              placeholder="Nama petugas admin"
              value={adminNama}
              onChange={(e) => handleAdminNamaChange(e.target.value)}
            />
          </div>

          <div
            className="form-field"
            style={{
              alignSelf: 'flex-end',
              marginLeft: 'auto',
              display: 'flex',
              gap: '0.5rem',
            }}
          >
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handlePrintPdf()}
              disabled={printingPdf || previewingPdf}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <span>🖨️</span>
              {printingPdf ? 'Membuat PDF...' : 'Cetak PDF'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void handlePreviewPdf()}
              disabled={previewingPdf || printingPdf}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <span>👁️</span>
              {previewingPdf ? 'Memuat Pratinjau...' : 'Preview PDF'}
            </button>
          </div>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '50px' }}>No</th>
              <th>Tanggal &amp; No. Reg</th>
              <th>Nama Pasien</th>
              <th>Dokter Pengirim</th>
              <th>Pemeriksaan</th>
              <th style={{ textAlign: 'right' }}>Total Harga</th>
              <th style={{ textAlign: 'right' }}>Total Sharing</th>
              <th style={{ width: '110px', textAlign: 'center' }}>Bayar</th>
              <th style={{ width: '70px' }}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  style={{
                    textAlign: 'center',
                    padding: '2.5rem',
                    color: '#64748b',
                  }}
                >
                  Belum ada data arsip untuk kriteria ini.
                </td>
              </tr>
            ) : (
              items.map((p, idx) => {
                const isLunas = p.paymentStatus === 'LUNAS';
                return (
                  <tr key={p.id}>
                    <td>
                      {(pagination.page - 1) * pagination.limit + idx + 1}
                    </td>
                    <td>
                      <div style={{ fontWeight: 700, color: '#0369a1' }}>
                        {p.regCode}
                      </div>
                      <div style={{ fontSize: '0.82rem', color: '#64748b' }}>
                        {formatDateShort(p.createdAt)}
                      </div>
                    </td>
                    <td>
                      <strong>{p.nama}</strong>
                      {p.alamat && (
                        <div
                          style={{
                            fontSize: '0.78rem',
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          {p.alamat}
                        </div>
                      )}
                    </td>
                    <td>{p.pengirimNama}</td>
                    <td>{p.pemeriksaanNama || '—'}</td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 600,
                        color: 'var(--color-primary)',
                      }}
                    >
                      {formatRupiah(p.totalHarga)}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 600,
                        color: '#b45309',
                      }}
                    >
                      {formatRupiah(p.totalSharing)}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '0.2rem 0.6rem',
                          borderRadius: '999px',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          color: isLunas ? '#15803d' : '#b91c1c',
                          background: isLunas ? '#f0fdf4' : '#fef2f2',
                          border: `1px solid ${isLunas ? '#bbf7d0' : '#fecaca'}`,
                        }}
                      >
                        {isLunas ? 'LUNAS' : 'BELUM LUNAS'}
                      </span>
                    </td>
                    <td>
                      <TableRowActions
                        onEdit={() => openEdit(p)}
                        editLabel="Ubah data arsip"
                        onDelete={() => setDeleteTarget(p)}
                        deleteLabel="Hapus arsip"
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={5} style={{ textAlign: 'right', fontWeight: 700 }}>
                  Total Pendapatan (halaman ini)
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    fontWeight: 700,
                    color: 'var(--color-primary)',
                  }}
                >
                  {formatRupiah(totalPendapatan)}
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    fontWeight: 700,
                    color: '#b45309',
                  }}
                >
                  {formatRupiah(totalSharing)}
                </td>
                <td />
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </ListPageShell>

      {editing && (
        <Modal
          open={true}
          title={`Ubah Data Arsip — ${editing.regCode}`}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={(e) => void handleEditSubmit(e)} className="form-grid">
            <div className="form-field form-field--full">
              <label htmlFor="sharing-edit-tanggal">Tanggal *</label>
              <input
                id="sharing-edit-tanggal"
                type="date"
                required
                value={editForm.tanggal}
                onChange={(e) => setEditForm((f) => ({ ...f, tanggal: e.target.value }))}
              />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="sharing-edit-nama">Nama Pasien *</label>
              <input
                id="sharing-edit-nama"
                required
                value={editForm.nama}
                onChange={(e) => setEditForm((f) => ({ ...f, nama: e.target.value }))}
              />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="sharing-edit-alamat">Alamat</label>
              <input
                id="sharing-edit-alamat"
                value={editForm.alamat}
                onChange={(e) => setEditForm((f) => ({ ...f, alamat: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="sharing-edit-pengirim">Dokter Pengirim *</label>
              <input
                id="sharing-edit-pengirim"
                required
                value={editForm.pengirimNama}
                onChange={(e) => setEditForm((f) => ({ ...f, pengirimNama: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="sharing-edit-pemeriksaan">Pemeriksaan *</label>
              <input
                id="sharing-edit-pemeriksaan"
                required
                value={editForm.pemeriksaanNama}
                onChange={(e) => setEditForm((f) => ({ ...f, pemeriksaanNama: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="sharing-edit-harga">Total Harga (Rp) *</label>
              <input
                id="sharing-edit-harga"
                type="number"
                min="0"
                step="1"
                required
                value={editForm.totalHarga}
                onChange={(e) => setEditForm((f) => ({ ...f, totalHarga: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="sharing-edit-sharing">Total Sharing (Rp) *</label>
              <input
                id="sharing-edit-sharing"
                type="number"
                min="0"
                step="1"
                required
                value={editForm.totalSharing}
                onChange={(e) => setEditForm((f) => ({ ...f, totalSharing: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="sharing-edit-petugas-admin">Petugas Admin Klinik</label>
              <input
                id="sharing-edit-petugas-admin"
                value={editForm.petugasAdminKlinik}
                onChange={(e) => setEditForm((f) => ({ ...f, petugasAdminKlinik: e.target.value }))}
              />
            </div>
            <div className="form-field">
              <label htmlFor="sharing-edit-bayar">Status Bayar *</label>
              <select
                id="sharing-edit-bayar"
                required
                value={editForm.paymentStatus}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    paymentStatus: e.target.value as 'BELUM_LUNAS' | 'LUNAS',
                  }))
                }
              >
                <option value="BELUM_LUNAS">Belum Lunas</option>
                <option value="LUNAS">Lunas</option>
              </select>
            </div>
            <ModalFormFooter
              onCancel={() => setEditing(null)}
              submitLabel="Simpan Perubahan"
              loading={savingEdit}
            />
          </form>
        </Modal>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        title={`Hapus Arsip ${title}`}
        message={`Yakin hapus permanen arsip "${deleteTarget?.nama ?? ''}" (${deleteTarget?.regCode ?? ''})? Tindakan ini tidak bisa dibatalkan.`}
        loading={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeleteConfirm()}
      />

      <SharingPdfPreviewModal
        open={previewModalOpen}
        blob={previewBlob}
        filename={previewFilename}
        onClose={() => setPreviewModalOpen(false)}
        title={`Pratinjau Laporan Sharing ${moduleLabel}`}
        onEdit={() => setPreviewModalOpen(false)}
      />
    </>
  );
}
