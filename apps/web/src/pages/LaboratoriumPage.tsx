import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { PDFViewer, pdf } from '@react-pdf/renderer';
import { ListPageShell } from '../components/ui/ListPageShell.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import { CetakAmplopLabModal, type CetakAmplopLabPasien } from '../components/CetakAmplopLabModal.tsx';
import type { AppViewId } from '../config/navigation.ts';
import { useListQueryParams, useListSearch } from '../hooks/useListQueryParams.ts';
import { useMutationReload } from '../hooks/useMutationReload.ts';
import { usePaginatedList } from '../hooks/usePaginatedList.ts';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../lib/api.ts';
import { handleFormFieldNavKeyDown } from '../lib/formFieldNav.ts';
import { formatDateShort, formatRupiah, formatUmurDetail, formatUmurTahun, parseUmurManualToTanggalLahir } from '../lib/format.ts';
import { terbilangRupiah } from '../lib/terbilang.ts';
import type { PaginatedResponse } from '../lib/pagination.ts';
import { LabReportDocument, type LabReportData } from '../pdf/LabReportDocument.tsx';
import { KwitansiReportDocument, type KwitansiReportData } from '../pdf/KwitansiReportDocument.tsx';
import { loadLogoDataUrl } from '../pdf/loadLogoDataUrl.ts';
import { printLabReport, type LabReportPrintOptions } from '../pdf/printLabReport.tsx';
import {
  DEFAULT_LAB_TABLE_ROWS,
  PAKET_PEMERIKSAAN_LAB,
  applyLabPackage,
  lookupLabReference,
  groupLabRowsForPdf,
  parseLabKesan,
  serializeLabKesan,
  isLabResultAbnormal,
  formatAbnormalResult,
  type LabTableRow,
  type ParsedLabData,
} from '../lib/labKesan.ts';
import { serializeKlinisData } from '../lib/penunjang.ts';
import { PjLabModal } from '../components/PjLabModal.tsx';
import '../components/ui/ui.css';

export {
  DEFAULT_LAB_TABLE_ROWS,
  PAKET_PEMERIKSAAN_LAB,
  applyLabPackage,
  lookupLabReference,
  groupLabRowsForPdf,
  parseLabKesan,
  serializeLabKesan,
  isLabResultAbnormal,
  formatAbnormalResult,
  type LabTableRow,
  type ParsedLabData,
};

interface LabPasienItem {
  readonly id: string;
  readonly regCode: string;
  readonly nama: string;
  readonly umur: number;
  readonly jenisKelamin: 'L' | 'P';
  readonly tanggalLahir: string;
  readonly alamat: string | null;
  readonly noTelepon: string | null;
  readonly createdAt: string;
  readonly klinis: string | null;
  readonly kesan: string | null;
  readonly hasilStatus: 'MENUNGGU_HASIL' | 'SELESAI';
  readonly paymentStatus: 'BELUM_LUNAS' | 'LUNAS';
  readonly petugasKasir: string | null;
  readonly totalHarga: string;
  readonly pengirim: { readonly id: string; readonly nama: string };
  readonly radiolog: { readonly id: string; readonly nama: string } | null;
  readonly pemeriksaan: readonly { readonly id: string; readonly jenisPemeriksaanId: string; readonly nama: string; readonly harga: string }[];
}

interface PetugasLabItem {
  readonly id: string;
  readonly nama: string;
  readonly nip: string | null;
  readonly noTelepon: string | null;
}

interface Dokter {
  readonly id: string;
  readonly nama: string;
  readonly defaultSharingAmount: string;
}

interface Staff { readonly id: string; readonly nama: string; readonly role: string; }

interface PendaftaranUmumItem {
  readonly id: string;
  readonly noRegistrasi: string;
  readonly namaPasien: string;
  readonly umur: string | null;
  readonly alamat: string | null;
  readonly telpon: string | null;
  readonly dokterPengirim: string | null;
  readonly klinis: string | null;
  readonly tanggalMasuk: string;
  readonly admin: string | null;
}

interface PaketLabItemData {
  readonly id: string;
  readonly grup: string | null;
  readonly pemeriksaan: string;
  readonly nilaiRujukan: string;
  readonly urutan: number;
}

interface PaketLabData {
  readonly id: string;
  readonly nama: string;
  readonly urutan: number;
  readonly harga?: string;
  readonly items: readonly PaketLabItemData[];
}

function formatDateDisplay(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return dateStr;
  }
}

interface LaboratoriumPageProps {
  readonly onNavigate?: (view: AppViewId) => void;
}

export function LaboratoriumPage({ onNavigate }: LaboratoriumPageProps) {
  const { search, setSearch } = useListSearch();
  const [timeFilter, setTimeFilter] = useState<'all' | 'today' | 'week' | 'custom'>('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const dateParams = useMemo(() => {
    if (timeFilter === 'all') return {};
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    if (timeFilter === 'today') {
      return { startDate: todayStr, endDate: todayStr };
    }
    if (timeFilter === 'week') {
      const start = new Date(now);
      start.setDate(now.getDate() - 7);
      const sy = start.getFullYear();
      const sm = String(start.getMonth() + 1).padStart(2, '0');
      const sd = String(start.getDate()).padStart(2, '0');
      return { startDate: `${sy}-${sm}-${sd}`, endDate: todayStr };
    }
    if (timeFilter === 'custom') {
      return {
        ...(customStart ? { startDate: customStart } : {}),
        ...(customEnd ? { endDate: customEnd } : {}),
      };
    }
    return {};
  }, [timeFilter, customStart, customEnd]);

  const queryParams = useListQueryParams(
    { modul: 'LABORATORIUM', ...(dateParams as Record<string, string>) },
    search,
  );
  const { items, pagination, setPage, loading, error, setError, reload: reloadList } =
    usePaginatedList<LabPasienItem>('/api/pasien', queryParams);
  const reload = useMutationReload(reloadList);

  const [selected, setSelected] = useState<LabPasienItem | null>(null);
  const [previewItem, setPreviewItem] = useState<LabPasienItem | null>(null);
  const [amplopItem, setAmplopItem] = useState<LabPasienItem | null>(null);
  const [kwitansiItem, setKwitansiItem] = useState<LabPasienItem | null>(null);
  const [labRows, setLabRows] = useState<LabTableRow[]>([]);
  const [readingFotoHasil, setReadingFotoHasil] = useState(false);
  const [readFotoHasilError, setReadFotoHasilError] = useState<string | null>(null);
  const [fotoHasilPreview, setFotoHasilPreview] = useState<string | null>(null);
  const [jumlahDiffcount, setJumlahDiffcount] = useState<number | null>(null);
  const [analisList, setAnalisList] = useState<PetugasLabItem[]>([]);
  const [analisId, setAnalisId] = useState('');
  const [analisNama, setAnalisNama] = useState('');
  const [hasilStatus, setHasilStatus] = useState<'MENUNGGU_HASIL' | 'SELESAI'>('MENUNGGU_HASIL');
  const [paymentStatus, setPaymentStatus] = useState<'BELUM_LUNAS' | 'LUNAS'>('BELUM_LUNAS');
  const [editPaketIds, setEditPaketIds] = useState<string[]>([]);
  const [editUmurManual, setEditUmurManual] = useState('');
  const [editTanggalLahir, setEditTanggalLahir] = useState('');
  const [editPengirimId, setEditPengirimId] = useState('');
  const [editAlamat, setEditAlamat] = useState('');
  const [saving, setSaving] = useState(false);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [logoSrc, setLogoSrc] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Edit Cepat state
  const [quickEditItem, setQuickEditItem] = useState<LabPasienItem | null>(null);
  const [qeNama, setQeNama] = useState('');
  const [qeUmurManual, setQeUmurManual] = useState('');
  const [qeTanggalLahir, setQeTanggalLahir] = useState('');
  const [qeAlamat, setQeAlamat] = useState('');
  const [qePengirimId, setQePengirimId] = useState('');
  const [qeHargaManual, setQeHargaManual] = useState('0');
  const [qeHargaMode, setQeHargaMode] = useState('custom');
  const [qeSharingAmount, setQeSharingAmount] = useState('0');
  const [qeSharingMode, setQeSharingMode] = useState('custom');
  const [qeTotalSharing, setQeTotalSharing] = useState('0');
  const [qeAnalisId, setQeAnalisId] = useState('');
  const [qeSaving, setQeSaving] = useState(false);
  const [qeError, setQeError] = useState<string | null>(null);

  // Registrasi Lab state
  const [regModalOpen, setRegModalOpen] = useState(false);
  const [dokterList, setDokterList] = useState<Dokter[]>([]);
    const [pendaftaranList, setPendaftaranList] = useState<PendaftaranUmumItem[]>([]);
  const [regSaving, setRegSaving] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  
    const [regNama, setRegNama] = useState('');
  const [regTanggalLahir, setRegTanggalLahir] = useState('');
  const [regUmurManual, setRegUmurManual] = useState('');
  const [regNoTelepon, setRegNoTelepon] = useState('');
  const [regAlamat, setRegAlamat] = useState('');
  const [regKlinis, setRegKlinis] = useState('');
  const [regPengirimId, setRegPengirimId] = useState('');
  const [regSharingAmount, setRegSharingAmount] = useState('0');
  const [regSharingMode, setRegSharingMode] = useState('custom');
  const [regHargaManual, setRegHargaManual] = useState('0');
  const [regHargaMode, setRegHargaMode] = useState('custom');
  const [regAdmin, setRegAdmin] = useState('');
  const [regAnalisId, setRegAnalisId] = useState('');
  const [regLabRows, setRegLabRows] = useState<LabTableRow[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);

  // Master Paket state
  const [paketModalOpen, setPaketModalOpen] = useState(false);
  const [pjModalOpen, setPjModalOpen] = useState(false);
  const [paketList, setPaketList] = useState<PaketLabData[]>([]);
  const [paketLoading, setPaketLoading] = useState(false);
  const [editPaket, setEditPaket] = useState<PaketLabData | null>(null);
  const [editItemRows, setEditItemRows] = useState<{ grup: string; pemeriksaan: string; nilaiRujukan: string }[]>([]);
  const [newPaketNama, setNewPaketNama] = useState('');
  const [paketSaving, setPaketSaving] = useState(false);
  const [paketError, setPaketError] = useState<string | null>(null);
  const [deletePaketTarget, setDeletePaketTarget] = useState<PaketLabData | null>(null);
  const [deletePaketLoading, setDeletePaketLoading] = useState(false);

  const editTotalHarga = useMemo(
    () =>
      paketList
        .filter((p) => editPaketIds.includes(p.id))
        .reduce((sum, p) => sum + Number(p.harga ?? 0), 0),
    [paketList, editPaketIds],
  );

  const loadAnalis = useCallback(async () => {
    try {
      const res = await apiGet<PaginatedResponse<PetugasLabItem>>('/api/petugas-lab?page=1&limit=200');
      setAnalisList(res.items);
    } catch {
      setAnalisList([]);
    }
  }, []);

  const loadPaketList = useCallback(async () => {
    setPaketLoading(true);
    try {
      const res = await apiGet<{ items: PaketLabData[] }>('/api/paket-lab');
      setPaketList(res.items);
    } catch {
      setPaketList([]);
    } finally {
      setPaketLoading(false);
    }
  }, []);

  const loadRegistrationMasters = useCallback(async () => {
    try {
      const [pendRes, dokRes, staffRes] = await Promise.all([
        apiGet<PaginatedResponse<PendaftaranUmumItem>>('/api/pendaftaran-umum?page=1&limit=300'),
        apiGet<PaginatedResponse<Dokter>>('/api/dokter?page=1&limit=200'),
        apiGet<PaginatedResponse<Staff>>('/api/staff?page=1&limit=200'),
      ]);
      setPendaftaranList(pendRes.items);
      setDokterList(dokRes.items);
      setStaffList(staffRes.items);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadAnalis();
    void loadPaketList();
    void loadRegistrationMasters();
    void loadLogoDataUrl().then(setLogoSrc).catch(() => setLogoSrc(''));
  }, [loadAnalis, loadPaketList, loadRegistrationMasters]);

  function openEdit(item: LabPasienItem) {
    setSelected(item);
    const parsed = parseLabKesan(item.kesan);
    setLabRows(parsed.rows.length > 0 ? parsed.rows : Array.from(DEFAULT_LAB_TABLE_ROWS));
    setAnalisId(parsed.analisId || '');
    setAnalisNama(parsed.analisNama || '');
    setHasilStatus(item.hasilStatus);
    setPaymentStatus(item.paymentStatus);
    setEditPaketIds(item.pemeriksaan.map((x) => x.jenisPemeriksaanId));
    setEditTanggalLahir(item.tanggalLahir);
    setEditUmurManual(String(item.umur));
    setEditPengirimId(item.pengirim.id);
    setEditAlamat(item.alamat ?? '');
    setFotoHasilPreview(null);
    setReadFotoHasilError(null);
    setJumlahDiffcount(null);
  }

  function buildKwitansiData(item: LabPasienItem): KwitansiReportData {
    return {
      logoSrc,
      noKwitansi: item.regCode,
      tanggal: formatDateShort(item.createdAt),
      namaPasien: item.nama,
      umur: formatUmurDetail(item.tanggalLahir),
      alamat: item.alamat || '—',
      dokterPengirim: item.pengirim.nama,
      items: item.pemeriksaan.map((x) => ({ nama: x.nama, hargaFormatted: formatRupiah(x.harga) })),
      totalFormatted: formatRupiah(item.totalHarga),
      terbilang: terbilangRupiah(item.totalHarga),
      paymentStatus: item.paymentStatus,
      kasirNama: item.petugasKasir || '',
    };
  }

  async function handleDownloadKwitansi(item: LabPasienItem) {
    const blob = await pdf(<KwitansiReportDocument data={buildKwitansiData(item)} />).toBlob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Kwitansi_${item.regCode}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function handleEditUmurManualChange(value: string) {
    setEditUmurManual(value);
    const tanggal = parseUmurManualToTanggalLahir(value);
    if (tanggal) setEditTanggalLahir(tanggal);
  }

  function handleQeUmurManualChange(value: string) {
    setQeUmurManual(value);
    const tanggal = parseUmurManualToTanggalLahir(value);
    if (tanggal) setQeTanggalLahir(tanggal);
  }

  async function openQuickEdit(item: LabPasienItem) {
    setQuickEditItem(item);
    setQeError(null);
    setQeNama(item.nama);
    setQeUmurManual(String(item.umur));
    setQeTanggalLahir(item.tanggalLahir);
    setQeAlamat(item.alamat ?? '');
    setQePengirimId(item.pengirim.id);
    const parsed = parseLabKesan(item.kesan);
    setQeAnalisId(parsed.analisId || '');
    setQeHargaMode('custom');
    setQeSharingMode('custom');
    try {
      const res = await apiGet<{ item: { totalHarga: string; totalSharing: string; sharingAmount: string } }>(
        `/api/pasien/${item.id}`,
      );
      setQeHargaManual(String(Math.round(Number(res.item.totalHarga))));
      setQeSharingAmount(String(Math.round(Number(res.item.sharingAmount))));
      setQeTotalSharing(res.item.totalSharing);
    } catch {
      setQeHargaManual('0');
      setQeSharingAmount('0');
      setQeTotalSharing('0');
    }
  }

  async function submitQuickEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!quickEditItem) return;
    setQeSaving(true);
    setQeError(null);
    try {
      const parsed = parseLabKesan(quickEditItem.kesan);
      const selectedAnalis = analisList.find((a) => a.id === qeAnalisId);
      const serializedKesan = serializeLabKesan(parsed.rows, parsed.catatan, selectedAnalis?.nama ?? '', qeAnalisId);
      await apiPatch(`/api/pasien/${quickEditItem.id}`, {
        nama: qeNama,
        tanggalLahir: qeTanggalLahir || undefined,
        alamat: qeAlamat,
        pengirimId: qePengirimId,
        harga: Number(qeHargaManual) || 0,
        sharingAmount: Number(qeSharingAmount) || 0,
        kesan: serializedKesan,
      });
      setQuickEditItem(null);
      await reload();
    } catch (err: unknown) {
      setQeError(err instanceof Error ? err.message : 'Gagal menyimpan');
    } finally {
      setQeSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setError(null);
    try {
      await apiDelete(`/api/pasien/${deleteTarget.id}`);
      setDeleteTarget(null);
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus');
    } finally {
      setDeleteLoading(false);
    }
  }

  function handleRowChange(index: number, field: keyof LabTableRow, value: string) {
    setLabRows((prev) => {
      const updated = [...prev];
      const target = updated[index];
      if (target) {
        let nextRow = { ...target, [field]: value };
        if (field === 'pemeriksaan') {
          const match = lookupLabReference(value, paketList);
          if (match) {
            nextRow = {
              ...nextRow,
              klasifikasi: match.klasifikasi,
              nilaiRujukan: match.nilaiRujukan,
            };
          }
        }
        updated[index] = nextRow;
      }
      return updated;
    });
  }

  function handleAddRow() {
    setLabRows((prev) => [
      ...prev,
      { id: String(Date.now()), klasifikasi: '', pemeriksaan: '', hasil: '', nilaiRujukan: '' },
    ]);
  }

  // Menambah baris pemeriksaan baru langsung di dalam satu klasifikasi,
  // disisipkan tepat setelah baris terakhir klasifikasi tsb supaya baris
  // per klasifikasi tetap berurutan (grouping saat cetak PDF bergantung
  // pada baris klasifikasi yang sama berurutan, lihat groupLabRowsForPdf).
  function handleAddRowInGroup(klasifikasi: string) {
    setLabRows((prev) => {
      const newRow: LabTableRow = { id: String(Date.now()), klasifikasi, pemeriksaan: '', hasil: '', nilaiRujukan: '' };
      let lastIndex = -1;
      prev.forEach((row, i) => {
        if ((row.klasifikasi || '').trim().toLowerCase() === klasifikasi.trim().toLowerCase()) {
          lastIndex = i;
        }
      });
      if (lastIndex === -1) return [...prev, newRow];
      const updated = [...prev];
      updated.splice(lastIndex + 1, 0, newRow);
      return updated;
    });
  }

  function handleRemoveRow(index: number) {
    setLabRows((prev) => prev.filter((_, i) => i !== index));
  }

  function handleClearRows() {
    setLabRows([]);
  }

  function handleFotoHasilFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setReadFotoHasilError(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setFotoHasilPreview(reader.result);
    };
    reader.readAsDataURL(file);
  }

  async function handleProcessFotoHasil() {
    if (!fotoHasilPreview) return;
    const parameterNames = labRows.map((r) => r.pemeriksaan).filter((p) => p.trim());
    if (parameterNames.length === 0) return;
    setReadingFotoHasil(true);
    setReadFotoHasilError(null);
    setJumlahDiffcount(null);
    try {
      // Dibaca pakai AI vision (Gemini) — OCR biasa kurang akurat untuk foto
      // asli (pencahayaan/sudut/font alat berbeda-beda).
      const res = await apiPost<{ results: readonly { pemeriksaan: string; hasil: string }[] }>(
        '/api/analisa-lab-ai/read-foto',
        { fotoDataUrl: fotoHasilPreview, parameterNames },
      );
      setLabRows((prev) =>
        prev.map((row) => {
          const match = res.results.find(
            (r) => r.pemeriksaan.trim().toLowerCase() === row.pemeriksaan.trim().toLowerCase(),
          );
          return match && match.hasil ? { ...row, hasil: match.hasil } : row;
        }),
      );
    } catch (err) {
      setReadFotoHasilError(err instanceof Error ? err.message : 'Gagal membaca teks dari foto');
    } finally {
      setReadingFotoHasil(false);
    }
  }

  // Jumlahkan hasil keenam baris Diffcount yang ada SAAT INI di tabel (baik
  // dari hasil baca foto maupun yang diketik/diubah manual) — supaya bisa
  // dicek kapan saja hasilnya sudah pas 100% atau belum.
  function handleHitungDiffcount() {
    const total = labRows
      .filter((r) => r.klasifikasi === 'Diffcount')
      .reduce((sum, r) => sum + (Number(r.hasil.replace(',', '.')) || 0), 0);
    setJumlahDiffcount(total);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const selectedAnalis = analisList.find((a) => a.id === analisId);
      const finalAnalisNama = selectedAnalis ? selectedAnalis.nama : analisNama;
      const formattedRows = labRows.map((r) => ({
        ...r,
        hasil: formatAbnormalResult(r.hasil, r.nilaiRujukan, selected?.jenisKelamin),
      }));
      const serialized = serializeLabKesan(formattedRows, '', finalAnalisNama, analisId);
      await apiPatch(`/api/pasien/${selected.id}`, {
        kesan: serialized,
        hasilStatus,
        paymentStatus,
        jenisPemeriksaanIds: editPaketIds.length > 0 ? editPaketIds : undefined,
        tanggalLahir: editTanggalLahir || undefined,
        pengirimId: editPengirimId || undefined,
        alamat: editAlamat,
      });
      setSelected(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan hasil laboratorium');
    } finally {
      setSaving(false);
    }
  }

  async function handlePrint(item: LabPasienItem, options?: LabReportPrintOptions) {
    setPrintingId(item.id);
    try {
      await printLabReport(item.id, options);
    } catch (err) {
      console.error('Print error:', err);
    } finally {
      setPrintingId(null);
    }
  }


  function handlePendaftaranSelect(id: string) {
    const p = pendaftaranList.find(x => x.id === id);
    if (!p) {
      setRegNama('');
      setRegAlamat('');
      setRegNoTelepon('');
      setRegKlinis('');
      setRegTanggalLahir('');
      setRegUmurManual('');
      setRegPengirimId('');
      setRegSharingAmount('0');
      setRegAdmin('');
      return;
    }
    setRegNama(p.namaPasien || '');
    setRegAlamat(p.alamat || '');
    setRegNoTelepon(p.telpon || '');
    setRegKlinis(p.klinis || '');
    if (p.umur) {
      const tanggal = parseUmurManualToTanggalLahir(p.umur);
      setRegUmurManual(p.umur);
      setRegTanggalLahir(tanggal ?? '');
    } else {
      setRegTanggalLahir('');
      setRegUmurManual('');
    }
    if (p.dokterPengirim) {
      const dok = dokterList.find(d => d.nama.toLowerCase().includes(p.dokterPengirim!.toLowerCase()));
      if (dok) { setRegPengirimId(dok.id); setRegSharingAmount(dok.defaultSharingAmount); }
      else { setRegPengirimId(''); setRegSharingAmount('0'); }
    } else {
      setRegPengirimId(''); setRegSharingAmount('0');
    }
    if (p.admin) {
      const st = staffList.find(s => s.nama.toLowerCase().includes(p.admin!.toLowerCase()));
      if (st) setRegAdmin(st.id);
      else setRegAdmin(p.admin);
    } else {
      setRegAdmin('');
    }
  }

  function handleRegUmurManualChange(value: string) {
    setRegUmurManual(value);
    const tanggal = parseUmurManualToTanggalLahir(value);
    if (tanggal) setRegTanggalLahir(tanggal);
  }

  async function handleRegisterPasien(e: React.FormEvent) {
    e.preventDefault();
    setRegError(null);
    if (!regTanggalLahir) {
      setRegError('Format umur tidak dikenali. Gunakan mis. "32 tahun", "6 bulan", atau "10 hari".');
      return;
    }
    setRegSaving(true);
    try {
      const res = await apiPost<{ item: { id: string } }>('/api/pasien', {
        nama: regNama,
        tanggalLahir: regTanggalLahir,
        noTelepon: regNoTelepon || undefined,
        alamat: regAlamat || undefined,
        pengirimId: regPengirimId,
        klinis: serializeKlinisData(regKlinis, [], []),
        jenisPemeriksaanIds: undefined,
        sharingAmount: Number(regSharingAmount),
        harga: Number(regHargaManual) || 0,
        admin: regAdmin || undefined,
        asalModul: 'LABORATORIUM',
      });

      if (regLabRows.length > 0) {
        const selectedAnalis = analisList.find((a) => a.id === regAnalisId);
        const analisNama = selectedAnalis ? selectedAnalis.nama : '';
        const serialized = serializeLabKesan(regLabRows, regKlinis, analisNama, regAnalisId);
        
        await apiPatch(`/api/pasien/${res.item.id}`, {
          kesan: serialized,
          hasilStatus: 'SELESAI',
        });
      }

      setRegModalOpen(false);
      await reload({ resetPage: true });
    } catch (err: unknown) {
      setRegError(err instanceof Error ? err.message : 'Gagal mendaftar pasien');
    } finally {
      setRegSaving(false);
    }
  }

  async function handleCreatePaket(e: React.FormEvent) {
    e.preventDefault();
    if (!newPaketNama.trim()) return;
    setPaketSaving(true);
    setPaketError(null);
    try {
      await apiPost<{ item: PaketLabData }>('/api/paket-lab', { nama: newPaketNama.trim() });
      setNewPaketNama('');
      await loadPaketList();
    } catch (err: unknown) {
      setPaketError(err instanceof Error ? err.message : 'Gagal membuat paket');
    } finally {
      setPaketSaving(false);
    }
  }

  async function handleDeletePaket() {
    if (!deletePaketTarget) return;
    setDeletePaketLoading(true);
    setPaketError(null);
    try {
      await apiDelete(`/api/paket-lab/${deletePaketTarget.id}`);
      setDeletePaketTarget(null);
      if (editPaket?.id === deletePaketTarget.id) setEditPaket(null);
      await loadPaketList();
    } catch (err: unknown) {
      setPaketError(err instanceof Error ? err.message : 'Gagal menghapus paket');
    } finally {
      setDeletePaketLoading(false);
    }
  }

  async function handleSavePaketItems() {
    if (!editPaket) return;
    setPaketSaving(true);
    setPaketError(null);
    try {
      await apiPut(`/api/paket-lab/${editPaket.id}/items`, {
        items: editItemRows
          .filter((r) => r.pemeriksaan.trim() !== '')
          .map((r, i) => ({ grup: r.grup || undefined, pemeriksaan: r.pemeriksaan, nilaiRujukan: r.nilaiRujukan, urutan: i })),
      });
      await loadPaketList();
      setEditPaket(null);
    } catch (err: unknown) {
      setPaketError(err instanceof Error ? err.message : 'Gagal menyimpan item paket');
    } finally {
      setPaketSaving(false);
    }
  }

  function openEditPaket(p: PaketLabData) {
    setEditPaket(p);
    setEditItemRows(
      p.items.length > 0
        ? p.items.map((it) => ({ grup: it.grup ?? '', pemeriksaan: it.pemeriksaan, nilaiRujukan: it.nilaiRujukan }))
        : [{ grup: '', pemeriksaan: '', nilaiRujukan: '' }],
    );
    setPaketError(null);
  }

  function applyPaketFromDB(p: PaketLabData) {
    const newRows: LabTableRow[] = p.items.map((it, i) => ({
      id: `db-${p.id}-${i}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      klasifikasi: it.grup?.trim() || p.nama,
      pemeriksaan: it.pemeriksaan,
      hasil: '',
      nilaiRujukan: it.nilaiRujukan,
    }));
    setLabRows((prev) => {
      const filtered = prev.filter((r) => r.pemeriksaan.trim() !== '' || r.hasil.trim() !== '');
      return [...filtered, ...newRows];
    });
  }

  const waitingCount = items.filter((i) => i.hasilStatus === 'MENUNGGU_HASIL').length;
  const doneCount = items.filter((i) => i.hasilStatus === 'SELESAI').length;

  // Build preview data from previewItem (read from saved kesan)
  const previewData: LabReportData | null = previewItem
    ? (() => {
        const parsed = parseLabKesan(previewItem.kesan);
        return {
          logoSrc,
          regCode: previewItem.regCode,
          dokterNama: previewItem.pengirim?.nama || '—',
          tanggalPemeriksaan: formatDateDisplay(previewItem.createdAt),
          namaPasien: previewItem.nama,
          umurLabel: `${formatUmurTahun(previewItem.umur)} (${previewItem.jenisKelamin})`,
          alamat: previewItem.alamat || '—',
          labResultsText: undefined,
          rows: groupLabRowsForPdf(parsed.rows, previewItem.jenisKelamin),
          petugasLabNama: parsed.analisNama || undefined,
        };
      })()
    : null;

  return (
    <ListPageShell
      title="Registrasi Lab"
      metrics={[
        {
          label: 'Total registrasi pasien',
          value: String(pagination.total),
          tone: 'blue',
          iconKind: 'clipboard',
        },
        {
          label: 'Menunggu hasil lab',
          value: String(waitingCount),
          tone: 'violet',
          iconKind: 'stethoscope',
        },
        {
          label: 'Selesai pemeriksaan',
          value: String(doneCount),
          tone: 'green',
          iconKind: 'document',
        },
      ]}
      searchPlaceholder="Cari nama pasien, reg code, alamat..."
      searchValue={search}
      onSearchChange={setSearch}
      onRefresh={() => void reload()}
      filterExtra={
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn--sm ${timeFilter === 'today' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => { setTimeFilter(timeFilter === 'today' ? 'all' : 'today'); setPage(1); }}
            style={timeFilter !== 'today' ? { border: '1px solid var(--color-border)' } : {}}
          >
            📅 Pasien Hari Ini
          </button>
          {onNavigate && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => onNavigate('hitungan-led')}
              style={{ border: '1px solid var(--color-border)' }}
              title="Buka Hitungan LED"
            >
              🧮 Hitungan LED
            </button>
          )}
          <button
            type="button"
            className={`btn btn--sm ${timeFilter === 'week' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => { setTimeFilter(timeFilter === 'week' ? 'all' : 'week'); setPage(1); }}
            style={timeFilter !== 'week' ? { border: '1px solid var(--color-border)' } : {}}
          >
            🗓️ Pasien Minggu Ini
          </button>
          <button
            type="button"
            className={`btn btn--sm ${timeFilter === 'custom' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setTimeFilter(timeFilter === 'custom' ? 'all' : 'custom')}
            style={timeFilter !== 'custom' ? { border: '1px solid var(--color-border)' } : {}}
          >
            🔧 Custom
          </button>
          <button
            type="button"
            className={`btn btn--sm ${timeFilter === 'all' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => { setTimeFilter('all'); setPage(1); }}
            style={timeFilter !== 'all' ? { border: '1px solid var(--color-border)' } : {}}
          >
            Lihat Semua
          </button>
          {timeFilter === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <input
                type="date"
                value={customStart}
                onChange={(e) => { setCustomStart(e.target.value); setPage(1); }}
                style={{ padding: '0.35rem 0.5rem', borderRadius: '6px', border: '1px solid var(--color-border)' }}
                aria-label="Tanggal mulai"
              />
              <span>–</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => { setCustomEnd(e.target.value); setPage(1); }}
                style={{ padding: '0.35rem 0.5rem', borderRadius: '6px', border: '1px solid var(--color-border)' }}
                aria-label="Tanggal akhir"
              />
            </div>
          )}
        </div>
      }
      error={error}
      loading={loading}
      pagination={pagination}
      onPageChange={setPage}
      action={
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setPaketModalOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            ⚙️ Master Paket
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => setPjModalOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
            title="Catatan PJ Laboratorium per bulan & cetak dengan kop surat"
          >
            📋 PJ
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
                            setRegNama('');
              setRegTanggalLahir('');
              setRegUmurManual('');
              setRegNoTelepon('');
              setRegAlamat('');
              setRegKlinis('');
              setRegPengirimId('');
                            setRegSharingAmount('0');
              setRegSharingMode('custom');
              setRegHargaManual('0');
              setRegHargaMode('custom');
              setRegAdmin('');
              setRegAnalisId('');
              setRegLabRows([]);
              setRegError(null);
              setRegModalOpen(true);
              void loadRegistrationMasters();
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            + Registrasi Pasien Lab
          </button>
        </div>
      }
    >
      <table className="data-table">
        <thead>
          <tr>
            <th>No</th>
            <th>Nama Pasien</th>
            <th>Umur / JK</th>
            <th>Dokter Pengirim</th>
            <th>Status Hasil</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ textAlign: 'center', padding: '2rem' }}>
                Belum ada data pendaftaran pasien laboratorium.
              </td>
            </tr>
          ) : (
            items.map((item, idx) => (
              <tr key={item.id}>
                <td>{(pagination.page - 1) * pagination.limit + idx + 1}</td>
                <td>
                  <strong>{item.nama}</strong>
                  <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                    {item.alamat || '—'}
                  </div>
                </td>
                <td>
                  {formatUmurDetail(item.tanggalLahir)} ({item.jenisKelamin})
                </td>
                <td>{item.pengirim.nama}</td>
                <td>
                  <span
                    className={`badge ${item.hasilStatus === 'SELESAI' ? 'badge--ok' : 'badge--pending'}`}
                  >
                    {item.hasilStatus === 'SELESAI' ? 'SELESAI' : 'MENUNGGU HASIL'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => openEdit(item)}
                    >
                      ⚡ Hasil Lab
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void openQuickEdit(item)}
                      title="Edit Cepat"
                    >
                      ✏️ Edit Cepat
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setDeleteTarget({ id: item.id, label: item.nama })}
                      style={{ border: '1px solid var(--color-border)', color: '#ef4444' }}
                      title="Hapus Registrasi Pasien"
                    >
                      🗑️ Hapus
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={() => setPreviewItem(item)}
                      title="Preview & Cetak hasil lab"
                    >
                      🖨️ Preview & Cetak
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setAmplopItem(item)}
                      title="Cetak Amplop Hasil Laboratorium"
                    >
                      ✉️ Amplop
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => setKwitansiItem(item)}
                      title="Kwitansi"
                    >
                      🧾 Kwitansi
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Edit Modal: form only, no preview */}
      {selected && (
        <Modal
          title={`Input Hasil Laboratorium — ${selected.nama} (${selected.regCode})`}
          open={true}
          onClose={() => setSelected(null)}
          size="xl"
        >
          {/* Top section: Form full-width */}
          <form onSubmit={(e) => void handleSave(e)}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem 1.25rem', marginBottom: '1rem' }}>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="lab-hasil-foto">Foto Hasil Pemeriksaan (opsional)</label>
                <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                  Unggah foto print out alat/hasil manual — dibaca dengan AI dan mengisi otomatis kolom Hasil
                  di tabel bawah sesuai nama pemeriksaannya. Periksa ulang hasilnya karena bacaan otomatis ini
                  bisa saja tidak tepat.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                  <input id="lab-hasil-foto" type="file" accept="image/*" onChange={handleFotoHasilFileChange} />
                  {fotoHasilPreview && (
                    <>
                      <img
                        src={fotoHasilPreview}
                        alt="Preview foto hasil pemeriksaan"
                        style={{ height: '60px', borderRadius: '6px', border: '1px solid var(--color-border)' }}
                      />
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={readingFotoHasil}
                        onClick={() => void handleProcessFotoHasil()}
                      >
                        {readingFotoHasil ? '⏳ Membaca teks...' : '📷 Baca Teks dari Foto'}
                      </button>
                    </>
                  )}
                  {labRows.some((r) => r.klasifikasi === 'Diffcount') && (
                    <>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        title="Jumlahkan hasil Eosinofil+Basofil+Staff+Netrofil Segmen+Limposit+Monosit yang ada di tabel saat ini"
                        onClick={handleHitungDiffcount}
                      >
                        🧮 Jumlah Diffcount
                      </button>
                      {jumlahDiffcount !== null && (
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '999px',
                            background: 'var(--color-bg-page)',
                            border: '1px solid var(--color-border)',
                          }}
                        >
                          Jumlah Diffcount: {jumlahDiffcount}%
                        </span>
                      )}
                    </>
                  )}
                </div>
                {readFotoHasilError && (
                  <p className="alert alert--error" style={{ margin: '0.4rem 0 0' }}>
                    {readFotoHasilError}
                  </p>
                )}
              </div>

              {/* Interactive Table for Lab Tests (full width) */}
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <label style={{ margin: 0, fontWeight: 'bold' }}>Tabel Hasil Pemeriksaan (Pemeriksaan | Hasil | Nilai Rujukan)</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                    
                    {(paketList.length > 0
                      ? paketList
                      : PAKET_PEMERIKSAAN_LAB.map((p) => ({
                          id: p.id,
                          nama: p.label,
                          urutan: 0,
                          items: p.items.map((it, idx) => ({
                            id: `${idx}`,
                            grup: it.grup?.trim() || p.label,
                            pemeriksaan: it.pemeriksaan,
                            nilaiRujukan: it.nilaiRujukan,
                            urutan: idx,
                          })),
                        }))
                    ).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => applyPaketFromDB(p)}
                        title={`Terapkan paket: ${p.nama}`}
                        style={{ background: '#e0f2fe', color: '#0369a1', border: '1px solid #38bdf8', fontWeight: 700 }}
                      >
                        ⚡ {p.nama}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={handleAddRow}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                    >
                      <span>+</span> Tambah Baris
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={handleClearRows}
                      title="Hapus semua baris hasil pemeriksaan"
                      style={{ border: '1px solid var(--color-border)', color: '#ef4444' }}
                    >
                      Kosongkan
                    </button>
                  </div>
                </div>
                <div style={{ overflowY: 'auto', maxHeight: '240px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-card)' }}>
                  <table className="data-table" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
                    <thead>
                      <tr>
                        <th style={{ width: '25%' }}>Klasifikasi Pemeriksaan</th>
                        <th style={{ width: '30%' }}>Pemeriksaan</th>
                        <th style={{ width: '20%' }}>Hasil</th>
                        <th style={{ width: '20%' }}>Nilai Rujukan</th>
                        <th style={{ width: '5%', textAlign: 'center' }}>Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        // Kelompokkan baris berurutan dengan klasifikasi yang sama,
                        // supaya tiap klasifikasi punya tombol "+" sendiri untuk
                        // menambah pemeriksaan tepat di grupnya.
                        const groups: { klasifikasi: string; entries: { row: LabTableRow; index: number }[] }[] = [];
                        labRows.forEach((row, index) => {
                          const klas = (row.klasifikasi || '').trim();
                          const last = groups[groups.length - 1];
                          if (last && last.klasifikasi.toLowerCase() === klas.toLowerCase()) {
                            last.entries.push({ row, index });
                          } else {
                            groups.push({ klasifikasi: klas, entries: [{ row, index }] });
                          }
                        });

                        // Klasifikasi bisa berisi beberapa jenjang "Induk - Anak"
                        // (mis. "Urinalisa - Makroskopis"). Setiap jenjang
                        // ditampilkan sebagai baris judul sendiri (makin dalam jenjangnya,
                        // makin kecil & menjorok), dan hanya dicetak ulang saat berbeda
                        // dari grup sebelumnya (gaya breadcrumb) supaya judul induk yang
                        // sama tidak berulang-ulang.
                        const headerStyleForDepth = (depth: number): CSSProperties =>
                          depth === 0
                            ? {
                                padding: '0.4rem 0.4rem 0.1rem',
                                fontWeight: 800,
                                fontSize: '0.88rem',
                                color: '#0c4a6e',
                                background: '#e0f2fe',
                                borderTop: '2px solid #38bdf8',
                              }
                            : depth === 1
                              ? {
                                  padding: '0.3rem 0.4rem 0.1rem 0.7rem',
                                  fontWeight: 700,
                                  fontSize: '0.84rem',
                                  color: '#0369a1',
                                  background: '#f0f9ff',
                                }
                              : {
                                  padding: `0.15rem 0.4rem 0.2rem ${0.7 + depth * 0.35}rem`,
                                  fontWeight: 600,
                                  fontSize: '0.8rem',
                                  color: '#0369a1',
                                  fontStyle: 'italic',
                                };

                        let lastLevels: string[] = [];
                        return groups.map((group, gi) => {
                          const levels = group.klasifikasi
                            .split(' - ')
                            .map((s) => s.trim())
                            .filter((s) => s !== '');
                          let diffFrom = 0;
                          while (
                            diffFrom < levels.length &&
                            diffFrom < lastLevels.length &&
                            levels[diffFrom].toLowerCase() === lastLevels[diffFrom].toLowerCase()
                          ) {
                            diffFrom++;
                          }
                          const headersToShow = levels.length > 1 ? levels.slice(diffFrom) : [];
                          lastLevels = levels;

                          return (
                          <Fragment key={`${group.klasifikasi}-${gi}`}>
                            {headersToShow.map((levelText, li) => (
                              <tr key={`h-${diffFrom + li}`}>
                                <td colSpan={5} style={headerStyleForDepth(diffFrom + li)}>
                                  {levelText}
                                </td>
                              </tr>
                            ))}
                            {group.entries.map(({ row, index }) => (
                              <tr key={row.id}>
                                <td style={{ padding: '0.3rem 0.4rem' }}>
                                  <input
                                    type="text"
                                    list="list-klasifikasi-lab"
                                    value={row.klasifikasi || ''}
                                    onChange={(e) => handleRowChange(index, 'klasifikasi', e.target.value)}
                                    placeholder="Klasifikasi..."
                                    style={{ width: '100%', padding: '0.3rem 0.45rem', fontSize: '0.83rem', backgroundColor: '#e0f2fe', color: '#0369a1', fontWeight: 600, border: '1px solid #38bdf8', borderRadius: '4px' }}
                                  />
                                </td>
                                <td style={{ padding: '0.3rem 0.4rem' }}>
                                  <input
                                    type="text"
                                    list="list-pemeriksaan-lab"
                                    value={row.pemeriksaan}
                                    onChange={(e) => handleRowChange(index, 'pemeriksaan', e.target.value)}
                                    placeholder="Nama pemeriksaan..."
                                    style={{ width: '100%', padding: '0.3rem 0.45rem', fontSize: '0.83rem', fontWeight: 600 }}
                                  />
                                </td>
                                <td style={{ padding: '0.3rem 0.4rem' }}>
                                  <input
                                    type="text"
                                    value={row.hasil}
                                    onChange={(e) => handleRowChange(index, 'hasil', e.target.value)}
                                    onBlur={(e) => {
                                      const formatted = formatAbnormalResult(
                                        e.target.value,
                                        row.nilaiRujukan,
                                        previewItem?.jenisKelamin,
                                      );
                                      if (formatted !== row.hasil) {
                                        handleRowChange(index, 'hasil', formatted);
                                      }
                                    }}
                                    placeholder="Hasil lab..."
                                    style={{
                                      width: '100%',
                                      padding: '0.3rem 0.45rem',
                                      fontSize: '0.83rem',
                                      fontWeight: 'bold',
                                      color: isLabResultAbnormal(
                                        row.hasil,
                                        row.nilaiRujukan,
                                        previewItem?.jenisKelamin,
                                      )
                                        ? '#dc2626'
                                        : 'var(--color-primary)',
                                      background: isLabResultAbnormal(
                                        row.hasil,
                                        row.nilaiRujukan,
                                        previewItem?.jenisKelamin,
                                      )
                                        ? '#fef2f2'
                                        : undefined,
                                    }}
                                  />
                                </td>
                                <td style={{ padding: '0.3rem 0.4rem' }}>
                                  <input
                                    type="text"
                                    value={row.nilaiRujukan}
                                    onChange={(e) => handleRowChange(index, 'nilaiRujukan', e.target.value)}
                                    placeholder="Nilai rujukan..."
                                    style={{ width: '100%', padding: '0.3rem 0.45rem', fontSize: '0.83rem' }}
                                  />
                                </td>
                                <td style={{ padding: '0.3rem 0.4rem', textAlign: 'center' }}>
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    onClick={() => handleRemoveRow(index)}
                                    title="Hapus baris"
                                    style={{ color: '#ef4444', padding: '0.2rem 0.45rem' }}
                                  >
                                    ✕
                                  </button>
                                </td>
                              </tr>
                            ))}
                            {group.klasifikasi && (
                              <tr>
                                <td colSpan={5} style={{ padding: '0.15rem 0.4rem 0.35rem' }}>
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm"
                                    onClick={() => handleAddRowInGroup(group.klasifikasi)}
                                    title={`Tambah pemeriksaan di klasifikasi ${group.klasifikasi}`}
                                    style={{ color: '#0369a1', fontSize: '0.78rem', padding: '0.15rem 0.4rem' }}
                                  >
                                    + Tambah pemeriksaan ({group.klasifikasi})
                                  </button>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                  <datalist id="list-klasifikasi-lab">
                    {Array.from(
                      new Set([
                        ...paketList.map((p) => p.nama),
                        ...PAKET_PEMERIKSAAN_LAB.map((p) => p.label),
                      ]),
                    ).map((label) => (
                      <option key={label} value={label} />
                    ))}
                  </datalist>
                  <datalist id="list-pemeriksaan-lab">
                    {Array.from(
                      new Set([
                        ...paketList.flatMap((p) => p.items.map((it) => it.pemeriksaan)),
                        ...PAKET_PEMERIKSAAN_LAB.flatMap((p) => p.items.map((it) => it.pemeriksaan)),
                      ]),
                    ).map((pem) => (
                      <option key={pem} value={pem} />
                    ))}
                  </datalist>
                </div>
              </div>

              {/* Paket Pemeriksaan Lab (bisa diubah) */}
              <div
                className="form-field"
                style={{
                  gridColumn: '1 / -1',
                  padding: '0.75rem',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-card)',
                }}
              >
                <label style={{ fontWeight: 600, marginBottom: '0.5rem', display: 'block' }}>
                  Pilih Jenis Pemeriksaan Lab (Paket)
                </label>
                <div className="checkbox-list" style={{ flexDirection: 'row', flexWrap: 'wrap', maxHeight: '150px', overflowY: 'auto' }}>
                  {paketList.map((p) => (
                    <label key={p.id} style={{ minWidth: '220px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <input
                          type="checkbox"
                          checked={editPaketIds.includes(p.id)}
                          onChange={() => {
                            setEditPaketIds((prev) =>
                              prev.includes(p.id) ? prev.filter((id) => id !== p.id) : [...prev, p.id],
                            );
                          }}
                        />
                        {p.nama}
                      </span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                        {formatRupiah(p.harga ?? '0')}
                      </span>
                    </label>
                  ))}
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: '0.75rem',
                    paddingTop: '0.6rem',
                    borderTop: '1px dashed var(--color-border)',
                    fontWeight: 700,
                  }}
                >
                  <span>Total Harga Pemeriksaan</span>
                  <span style={{ color: 'var(--color-primary)' }}>{formatRupiah(editTotalHarga)}</span>
                </div>
              </div>

              {/* Umur, Dokter Pengirim & Alamat */}
              <div
                style={{
                  gridColumn: '1 / -1',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr',
                  gap: '0.75rem 1.25rem',
                }}
              >
                <div className="form-field">
                  <label htmlFor="lab-edit-umur">Umur</label>
                  <input
                    id="lab-edit-umur"
                    type="text"
                    placeholder="mis. 32 tahun / 6 bulan / 10 hari"
                    value={editUmurManual}
                    onChange={(e) => handleEditUmurManualChange(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="lab-edit-pengirim">Dokter Pengirim</label>
                  <select
                    id="lab-edit-pengirim"
                    value={editPengirimId}
                    onChange={(e) => setEditPengirimId(e.target.value)}
                  >
                    <option value="">-- Pilih Dokter --</option>
                    {dokterList.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.nama}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor="lab-edit-alamat">Alamat</label>
                  <input
                    id="lab-edit-alamat"
                    type="text"
                    value={editAlamat}
                    onChange={(e) => setEditAlamat(e.target.value)}
                  />
                </div>
              </div>

              {/* Analis Pemeriksa, Status Hasil & Status Pembayaran sejajar */}
              <div
                style={{
                  gridColumn: '1 / -1',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr',
                  gap: '0.75rem 1.25rem',
                }}
              >
                <div className="form-field">
                  <label htmlFor="lab-analis-pemeriksa">Analis Pemeriksa</label>
                  <select
                    id="lab-analis-pemeriksa"
                    value={analisId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setAnalisId(id);
                      const found = analisList.find((a) => a.id === id);
                      if (found) setAnalisNama(found.nama);
                      else setAnalisNama('');
                    }}
                  >
                    <option value="">Pilih analis laboratorium...</option>
                    {analisList.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.nama} {a.nip ? `(NIP: ${a.nip})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label htmlFor="lab-hasil-status">Status Hasil</label>
                  <select id="lab-hasil-status" value={hasilStatus}
                    onChange={(e) => setHasilStatus(e.target.value as 'MENUNGGU_HASIL' | 'SELESAI')}>
                    <option value="MENUNGGU_HASIL">MENUNGGU HASIL</option>
                    <option value="SELESAI">SELESAI</option>
                  </select>
                </div>

                <div className="form-field">
                  <label htmlFor="lab-payment-status">Status Pembayaran</label>
                  <select id="lab-payment-status" value={paymentStatus}
                    onChange={(e) => setPaymentStatus(e.target.value as 'BELUM_LUNAS' | 'LUNAS')}>
                    <option value="BELUM_LUNAS">BELUM LUNAS</option>
                    <option value="LUNAS">LUNAS</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Footer: Simpan + Batal */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', borderTop: '1px solid var(--color-border)', paddingTop: '1rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setSelected(null)}
              >
                Batal
              </button>
              <button
                type="submit"
                className="btn btn--secondary"
                disabled={saving}
              >
                {saving ? 'Menyimpan...' : '💾 Simpan Hasil Lab'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Preview-only Modal */}
      {previewItem && previewData && (
        <Modal
          title={`Preview Hasil Lab — ${previewItem.nama} (${previewItem.regCode})`}
          open={true}
          onClose={() => setPreviewItem(null)}
          size="xl"
        >
          {/* Header: label + Cetak button */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <label style={{ fontWeight: 'bold', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
              🖨️ Pratinjau Cetak PDF
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => { setPreviewItem(null); openEdit(previewItem); }}
              >
                ✏️ Edit Hasil
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void handlePrint(previewItem, { pageSize: 'A4', showSignature: true })}
                disabled={printingId === previewItem.id}
                title="Cetak dengan ukuran kertas A4"
              >
                🖨️ Cetak A4
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => void handlePrint(previewItem, { pageSize: 'F4', showSignature: true })}
                disabled={printingId === previewItem.id}
                title="Cetak dengan ukuran kertas F4 (folio)"
              >
                🖨️ Cetak F4
              </button>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => void handlePrint(previewItem, { pageSize: 'A4', showSignature: false })}
                disabled={printingId === previewItem.id}
                title="Cetak tanpa blok tanda tangan Analis"
              >
                ✎ Tanpa TTD
              </button>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => void handlePrint(previewItem, { pageSize: 'A4', showSignature: true })}
                disabled={printingId === previewItem.id}
                title="Cetak dengan blok tanda tangan Analis"
              >
                ✍️ Dengan TTD
              </button>
              {printingId === previewItem.id && (
                <span style={{ alignSelf: 'center', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                  Membuat PDF...
                </span>
              )}
            </div>
          </div>

          {/* Full-width PDF Viewer */}
          <div style={{
            width: '100%',
            height: '600px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-card)',
            overflow: 'hidden',
            background: '#525659',
            boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)',
          }}>
            <PDFViewer style={{ width: '100%', height: '100%', border: 'none' }}>
              <LabReportDocument data={previewData} />
            </PDFViewer>
          </div>
        </Modal>
      )}

      <PjLabModal open={pjModalOpen} onClose={() => setPjModalOpen(false)} />

      {/* ─── Master Paket Pemeriksaan Modal ─────────────────────────────────── */}
      <Modal
        open={paketModalOpen}
        title="Master Paket Pemeriksaan Laboratorium"
        onClose={() => { setPaketModalOpen(false); setEditPaket(null); setPaketError(null); }}
        size="xl"
      >
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '1.25rem', minHeight: '400px' }}>
          {/* Left: daftar paket */}
          <div style={{ borderRight: '1px solid var(--color-border)', paddingRight: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <form onSubmit={(e) => void handleCreatePaket(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>Buat Paket Baru</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  type="text"
                  value={newPaketNama}
                  onChange={(e) => setNewPaketNama(e.target.value)}
                  placeholder="Nama paket..."
                  style={{ flex: 1, padding: '0.45rem 0.65rem', fontSize: '0.85rem', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-button)' }}
                />
                <button type="submit" className="btn btn--primary btn--sm" disabled={paketSaving || !newPaketNama.trim()}>
                  {paketSaving ? '...' : '+'}
                </button>
              </div>
            </form>
            {paketError && <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: 0 }}>{paketError}</p>}
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)', borderTop: '1px solid var(--color-border)', paddingTop: '0.6rem' }}>
              Daftar Paket ({paketList.length})
            </div>
            {paketLoading ? (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>Memuat...</p>
            ) : paketList.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', fontStyle: 'italic' }}>Belum ada paket</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', overflowY: 'auto', maxHeight: '320px' }}>
                {paketList.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.5rem 0.65rem',
                      borderRadius: 'var(--radius-button)',
                      background: editPaket?.id === p.id ? 'var(--color-primary-soft)' : 'var(--color-bg-page)',
                      border: `1px solid ${editPaket?.id === p.id ? 'var(--color-primary)' : 'var(--color-border)'}`,
                      cursor: 'pointer',
                    }}
                    onClick={() => openEditPaket(p)}
                  >
                    <span style={{ fontSize: '0.85rem', fontWeight: editPaket?.id === p.id ? 600 : 400 }}>{p.nama}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setDeletePaketTarget(p); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '0.9rem', padding: '0 0.25rem', lineHeight: 1 }}
                      title="Hapus paket"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: edit items paket */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {!editPaket ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)', fontStyle: 'italic', fontSize: '0.9rem' }}>
                Pilih paket di kiri untuk mengedit item pemeriksaannya
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <h4 style={{ margin: 0, fontSize: '0.95rem' }}>Items: <strong>{editPaket.nama}</strong></h4>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setEditItemRows((r) => [...r, { grup: '', pemeriksaan: '', nilaiRujukan: '' }])}
                  >
                    + Tambah Baris
                  </button>
                </div>
                <div style={{ overflowY: 'auto', maxHeight: '320px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-card)' }}>
                  <table className="data-table" style={{ fontSize: '0.83rem', marginBottom: 0 }}>
                    <thead>
                      <tr>
                        <th style={{ width: '25%' }}>Grup/Header</th>
                        <th style={{ width: '40%' }}>Nama Pemeriksaan</th>
                        <th style={{ width: '25%' }}>Nilai Rujukan</th>
                        <th style={{ width: '10%', textAlign: 'center' }}>Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {editItemRows.map((row, i) => (
                        <tr key={i}>
                          <td style={{ padding: '0.25rem 0.4rem' }}>
                            <input
                              type="text"
                              value={row.grup}
                              onChange={(e) => setEditItemRows((r) => r.map((x, j) => j === i ? { ...x, grup: e.target.value } : x))}
                              placeholder="Grup (opsional)"
                              style={{ width: '100%', padding: '0.25rem 0.4rem', fontSize: '0.82rem', border: '1px solid var(--color-border)', borderRadius: '4px' }}
                            />
                          </td>
                          <td style={{ padding: '0.25rem 0.4rem' }}>
                            <input
                              type="text"
                              value={row.pemeriksaan}
                              onChange={(e) => setEditItemRows((r) => r.map((x, j) => j === i ? { ...x, pemeriksaan: e.target.value } : x))}
                              placeholder="Nama pemeriksaan"
                              style={{ width: '100%', padding: '0.25rem 0.4rem', fontSize: '0.82rem', border: '1px solid var(--color-border)', borderRadius: '4px', fontWeight: 500 }}
                            />
                          </td>
                          <td style={{ padding: '0.25rem 0.4rem' }}>
                            <input
                              type="text"
                              value={row.nilaiRujukan}
                              onChange={(e) => setEditItemRows((r) => r.map((x, j) => j === i ? { ...x, nilaiRujukan: e.target.value } : x))}
                              placeholder="Nilai rujukan"
                              style={{ width: '100%', padding: '0.25rem 0.4rem', fontSize: '0.82rem', border: '1px solid var(--color-border)', borderRadius: '4px' }}
                            />
                          </td>
                          <td style={{ padding: '0.25rem 0.4rem', textAlign: 'center' }}>
                            <button
                              type="button"
                              onClick={() => setEditItemRows((r) => r.filter((_, j) => j !== i))}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '1rem' }}
                              title="Hapus baris"
                            >✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', borderTop: '1px solid var(--color-border)', paddingTop: '0.75rem' }}>
                  <button type="button" className="btn btn--ghost" onClick={() => setEditPaket(null)}>Batal</button>
                  <button type="button" className="btn btn--primary" disabled={paketSaving} onClick={() => void handleSavePaketItems()}>
                    {paketSaving ? 'Menyimpan...' : '💾 Simpan Items'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </Modal>

      {/* Modal Registrasi Lab */}
      {regModalOpen && (
        <Modal
          title="Registrasi Pasien Laboratorium"
          open={true}
          onClose={() => setRegModalOpen(false)}
          size="lg"
        >
          <form onSubmit={(e) => void handleRegisterPasien(e)} className="form-grid" onKeyDown={handleFormFieldNavKeyDown}>
            <div className="form-field form-field--full" style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: '1px solid var(--color-border)' }}>
              <label style={{ fontWeight: 600, color: 'var(--color-primary)' }}>Pilih dari Pendaftaran Umum (Opsional)</label>
              <select 
                onChange={(e) => {
                  handlePendaftaranSelect(e.target.value);
                }}
                style={{ marginTop: '0.5rem' }}
              >
                <option value="">-- Ketik Data Baru / Manual --</option>
                {pendaftaranList.map(p => (
                  <option key={p.id} value={p.id}>{p.namaPasien} - {p.telpon || 'Tanpa No.Telp'}</option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="rNama">Nama Pasien *</label>
              <input id="rNama" required value={regNama} onChange={(e) => setRegNama(e.target.value)} />
            </div>

            <div className="form-field">
              <label htmlFor="rUmurManual">Umur *</label>
              <input
                id="rUmurManual"
                type="text"
                required
                placeholder="mis. 32 tahun / 6 bulan / 10 hari"
                value={regUmurManual}
                onChange={(e) => handleRegUmurManualChange(e.target.value)}
              />
            </div>

            <div className="form-field">
              <label htmlFor="rDok">Dokter Pengirim *</label>
              <select id="rDok" required value={regPengirimId} onChange={(e) => {
                const id = e.target.value;
                setRegPengirimId(id);
                const d = dokterList.find(x => x.id === id);
                if (d) setRegSharingAmount(d.defaultSharingAmount);
              }}>
                <option value="">-- Pilih Dokter --</option>
                {dokterList.map(d => (
                  <option key={d.id} value={d.id}>{d.nama}</option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="rHarga">Harga</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <select
                  id="rHarga-select"
                  value={regHargaMode}
                  style={{ flex: '1 1 auto' }}
                  title="Pilihan harga lab"
                  onChange={(e) => {
                    const val = e.target.value;
                    setRegHargaMode(val);
                    if (val !== 'custom') setRegHargaManual(val);
                  }}
                >
                  <option value="custom">✎ Manual</option>
                  {paketList.map((p) => (
                    <option key={p.id} value={p.harga ?? '0'}>
                      {p.nama} — {formatRupiah(p.harga ?? 0)}
                    </option>
                  ))}
                </select>
                <input
                  id="rHarga"
                  type="number"
                  min="0"
                  step="1"
                  style={{ flex: '0 0 110px' }}
                  value={regHargaManual}
                  onChange={(e) => {
                    setRegHargaManual(e.target.value);
                    setRegHargaMode('custom');
                  }}
                />
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="rSharing">Sharing</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <select
                  id="rSharing-select"
                  value={regSharingMode}
                  style={{ flex: '0 0 auto', width: '2.4rem' }}
                  title="Pilihan nominal sharing"
                  onChange={(e) => {
                    const val = e.target.value;
                    setRegSharingMode(val);
                    if (val !== 'custom') setRegSharingAmount(val);
                  }}
                >
                  <option value="custom">✎</option>
                  <option value="18000">18rb</option>
                  <option value="20000">20rb</option>
                  <option value="33000">33rb</option>
                  <option value="35000">35rb</option>
                  <option value="58000">58rb</option>
                  <option value="88000">88rb</option>
                  <option value="50000">50rb</option>
                  <option value="0">0</option>
                </select>
                <input
                  id="rSharing"
                  type="number"
                  min="0"
                  step="1"
                  value={regSharingAmount}
                  onChange={(e) => {
                    setRegSharingAmount(e.target.value);
                    setRegSharingMode('custom');
                  }}
                />
              </div>
            </div>

            {regError && <div className="alert alert--error form-field--full">{regError}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', borderTop: '1px solid var(--color-border)', paddingTop: '1rem', marginTop: '0.5rem', gridColumn: '1 / -1' }}>
              <button type="button" className="btn btn--ghost" onClick={() => setRegModalOpen(false)}>
                Batal
              </button>
              <button type="submit" className="btn btn--primary" disabled={regSaving}>
                {regSaving ? 'Menyimpan...' : '💾 Registrasi Pasien'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <ConfirmModal
        open={deletePaketTarget !== null}
        title="Hapus Paket"
        message={`Yakin hapus paket "${deletePaketTarget?.nama ?? ''}"? Semua item di dalamnya juga akan terhapus.`}
        loading={deletePaketLoading}
        onClose={() => setDeletePaketTarget(null)}
        onConfirm={() => void handleDeletePaket()}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title="Hapus Registrasi Pasien"
        message={`Yakin hapus registrasi "${deleteTarget?.label ?? ''}"? Tindakan ini tidak bisa dibatalkan.`}
        loading={deleteLoading}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />

      <CetakAmplopLabModal
        open={amplopItem !== null}
        onClose={() => setAmplopItem(null)}
        pasien={amplopItem as CetakAmplopLabPasien | null}
      />

      {kwitansiItem && (
        <Modal
          title={`Pratinjau Kwitansi — ${kwitansiItem.regCode}`}
          open={true}
          onClose={() => setKwitansiItem(null)}
          size="xl"
        >
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleDownloadKwitansi(kwitansiItem)}
              style={{ fontWeight: 600 }}
            >
              ⬇️ Unduh / Cetak Kwitansi
            </button>
          </div>
          <div style={{ width: '100%', height: 'calc(100vh - 14rem)', minHeight: '600px' }}>
            <PDFViewer width="100%" height="100%" className="pdf-viewer">
              <KwitansiReportDocument data={buildKwitansiData(kwitansiItem)} />
            </PDFViewer>
          </div>
        </Modal>
      )}

      <Modal
        open={quickEditItem !== null}
        title="Edit Cepat"
        onClose={() => setQuickEditItem(null)}
      >
        <form onSubmit={(e) => void submitQuickEdit(e)} className="form-grid">
          {qeError && <div className="alert alert--error form-field--full">{qeError}</div>}

          <div className="form-field form-field--full">
            <label htmlFor="qe-nama">Nama *</label>
            <input id="qe-nama" required value={qeNama} onChange={(e) => setQeNama(e.target.value)} />
          </div>

          <div className="form-field">
            <label htmlFor="qe-umur">Umur</label>
            <input
              id="qe-umur"
              type="text"
              placeholder="mis. 32 tahun / 6 bulan / 10 hari"
              value={qeUmurManual}
              onChange={(e) => handleQeUmurManualChange(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="qe-alamat">Alamat</label>
            <input id="qe-alamat" value={qeAlamat} onChange={(e) => setQeAlamat(e.target.value)} />
          </div>

          <div className="form-field form-field--full">
            <label htmlFor="qe-dokter">Dokter Pengirim</label>
            <select id="qe-dokter" value={qePengirimId} onChange={(e) => setQePengirimId(e.target.value)}>
              <option value="">-- Pilih Dokter --</option>
              {dokterList.map((d) => (
                <option key={d.id} value={d.id}>{d.nama}</option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="qe-harga">Harga</label>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <select
                id="qe-harga-select"
                value={qeHargaMode}
                style={{ flex: '1 1 auto' }}
                title="Pilihan harga lab"
                onChange={(e) => {
                  const val = e.target.value;
                  setQeHargaMode(val);
                  if (val !== 'custom') setQeHargaManual(val);
                }}
              >
                <option value="custom">✎ Manual</option>
                {paketList.map((p) => (
                  <option key={p.id} value={p.harga ?? '0'}>
                    {p.nama} — {formatRupiah(p.harga ?? 0)}
                  </option>
                ))}
              </select>
              <input
                id="qe-harga"
                type="number"
                min="0"
                step="1"
                style={{ flex: '0 0 110px' }}
                value={qeHargaManual}
                onChange={(e) => {
                  setQeHargaManual(e.target.value);
                  setQeHargaMode('custom');
                }}
              />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="qe-sharing">Sharing</label>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <select
                id="qe-sharing-select"
                value={qeSharingMode}
                style={{ flex: '0 0 auto', width: '2.4rem' }}
                title="Pilihan nominal sharing"
                onChange={(e) => {
                  const val = e.target.value;
                  setQeSharingMode(val);
                  if (val !== 'custom') setQeSharingAmount(val);
                }}
              >
                <option value="custom">✎</option>
                <option value="18000">18rb</option>
                <option value="20000">20rb</option>
                <option value="33000">33rb</option>
                <option value="35000">35rb</option>
                <option value="58000">58rb</option>
                <option value="88000">88rb</option>
                <option value="50000">50rb</option>
                <option value="0">0</option>
              </select>
              <input
                id="qe-sharing"
                type="number"
                min="0"
                step="1"
                value={qeSharingAmount}
                onChange={(e) => {
                  setQeSharingAmount(e.target.value);
                  setQeSharingMode('custom');
                }}
              />
            </div>
          </div>

          <div className="form-field">
            <span className="form-field__static-label">Total Sharing</span>
            <p className="form-field__static-value">{formatRupiah(qeTotalSharing)}</p>
          </div>

          <div className="form-field form-field--full">
            <label htmlFor="qe-analis">Analis</label>
            <select id="qe-analis" value={qeAnalisId} onChange={(e) => setQeAnalisId(e.target.value)}>
              <option value="">-- Pilih Analis --</option>
              {analisList.map((a) => (
                <option key={a.id} value={a.id}>{a.nama}</option>
              ))}
            </select>
          </div>

          <div className="form-actions form-actions--end form-field--full">
            <button type="submit" className="btn btn--primary" disabled={qeSaving}>
              {qeSaving ? 'Menyimpan…' : 'Simpan'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setQuickEditItem(null)}>
              Batal
            </button>
          </div>
        </form>
      </Modal>
    </ListPageShell>
  );
}
