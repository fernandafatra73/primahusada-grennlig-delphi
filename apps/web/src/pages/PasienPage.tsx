import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { PDFViewer, pdf } from '@react-pdf/renderer';
import { CetakALModal, type CetakALPasien } from '../components/CetakALModal.tsx';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { ModalFormFooter } from '../components/ui/ModalFormFooter.tsx';
import { ListPageShell } from '../components/ui/ListPageShell.tsx';
import { TableRowActions } from '../components/ui/TableRowActions.tsx';
import { KesanRegioPicker } from '../components/KesanRegioPicker.tsx';
import { PendaftaranReportDocument } from '../pdf/PendaftaranReportDocument.tsx';
import { KwitansiReportDocument, type KwitansiReportData } from '../pdf/KwitansiReportDocument.tsx';
import { loadLogoDataUrl } from '../pdf/loadLogoDataUrl.ts';
import { parseKlinisData, serializeKlinisData } from '../lib/penunjang.ts';
import { useListQueryParams, useListSearch } from '../hooks/useListQueryParams.ts';
import { useListRefresh } from '../context/ListRefreshContext.tsx';
import { useMutationReload } from '../hooks/useMutationReload.ts';
import { usePaginatedList } from '../hooks/usePaginatedList.ts';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.ts';
import { isValidBirthDate } from '../lib/birthDate.ts';
import { clampClinicalInput } from '../lib/clinicalText.ts';
import { readFileAsDataUrl, validateFotoFile } from '../lib/fotoUpload.ts';
import { formatAiFotoAnalisa, formatTbScreeningAnalisa } from '../lib/aiFotoAnalisa.ts';
import { AiHasilActions } from '../components/AiHasilActions.tsx';
import { TabelAiModal } from '../components/TabelAiModal.tsx';
import { FotoAnalisaTabel } from '../components/FotoAnalisaTabel.tsx';
import { applyPhotoAdjustments } from '../lib/imageAdjust.ts';
import { formatSharingShort } from '../lib/pilihanSharing.ts';
import { handleFormFieldNavKeyDown } from '../lib/formFieldNav.ts';
import {
  computeAutoSharingAmount,
  computeUmurYears,
  formatDateShort,
  formatRupiah,
  formatUmurDetail,
  formatUmurTahun,
  parseUmurManualToTanggalLahir,
} from '../lib/format.ts';
import { terbilangRupiah } from '../lib/terbilang.ts';
import { printPasienReport } from '../lib/pasienPrint.ts';
import type { PaginatedResponse } from '../lib/pagination.ts';
import '../components/ui/ui.css';

interface Dokter {
  readonly id: string;
  readonly nama: string;
  readonly defaultSharingAmount: string;
}

interface Radiolog {
  readonly id: string;
  readonly nama: string;
  readonly noTelepon?: string | null;
}

interface PilihanSharing {
  readonly id: string;
  readonly nominal: number;
  readonly keterangan: string | null;
}

interface RadiologFormState {
  readonly mode: 'add' | 'edit';
  readonly id: string | null;
  readonly nama: string;
  readonly noTelepon: string;
}

interface SharingOptionFormState {
  readonly mode: 'add' | 'edit';
  readonly id: string | null;
  /** Nominal sebelum diedit, untuk memindahkan pilihan yang sedang dipakai di form ke nominal barunya. */
  readonly originalNominal: number | null;
  readonly nominal: string;
  readonly keterangan: string;
}

interface Jenis {
  readonly id: string;
  readonly nama: string;
  readonly harga: string | null;
  readonly jumlahFilm: number;
}

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
  readonly foto: string | null;
}

/** Kunci zoom pratinjau foto di modal Ubah Pendaftaran Umum. Berbagi state dengan
 * foto di tabel (yang memakai id cuid baris), jadi dipilih nilai yang tidak mungkin bentrok. */
const EDIT_PENDAFTARAN_FOTO_ZOOM_ID = 'edit-pendaftaran-foto';

interface Staff {
  readonly id: string;
  readonly nama: string;
}

interface PasienRow {
  readonly id: string;
  readonly regCode: string;
  readonly nama: string;
  readonly umur: number;
  readonly tanggalLahir: string;
  readonly alamat: string | null;
  readonly petugasKasir: string | null;
  readonly pengirim: { readonly id: string; readonly nama: string };
  readonly pemeriksaan: readonly { readonly nama: string; readonly harga: string }[];
  readonly totalHarga: string;
  readonly totalSharing: string;
  readonly hasilStatus: 'MENUNGGU_HASIL' | 'SELESAI';
  readonly paymentStatus: 'BELUM_LUNAS' | 'LUNAS';
  readonly klinis?: string | null;
  readonly temuan?: string | null;
  readonly kesan?: string | null;
  readonly foto?: string | null;
  readonly createdAt: string;
}

interface PemeriksaanItem {
  readonly id: string;
  readonly jenisPemeriksaanId: string;
  readonly nama: string;
  readonly harga: string;
}

interface PasienDetail extends PasienRow {
  readonly noTelepon: string | null;
  readonly alamat: string | null;
  readonly klinis: string | null;
  readonly temuan: string | null;
  readonly kesan: string | null;
  readonly admin: string | null;
  readonly foto: string | null;
  readonly createdAt: string;
  readonly radiolog: { readonly id: string; readonly nama: string } | null;
  readonly sharingAmount: string;
  readonly sharingLocked: boolean;
  readonly pemeriksaan: readonly PemeriksaanItem[];
}

interface PasienSummary {
  readonly totalPasien: number;
  readonly menungguHasil: number;
  readonly selesai: number;
  readonly totalOmzet: string;
  readonly totalSharing: string;
}

interface TbIndicator {
  readonly key: string;
  readonly label: string;
  readonly persen: number;
  readonly keterangan: string;
}

interface TbAreaTemuan {
  readonly kondisi: string;
  readonly ymin: number;
  readonly xmin: number;
  readonly ymax: number;
  readonly xmax: number;
}

/** Bentuk hasil skrining bersifat sama untuk semua "model" (jenis
 * pemeriksaan) di dropdown AI Banding 2, tapi isi `indikator` berbeda-beda —
 * thorax menilai infiltrate/consolidation/dst., USG Abdomen menilai per
 * organ, Lumbo Sacral menilai per kondisi tulang belakang, dst. (ditentukan
 * di backend sesuai model yang dipilih). */
interface TbScreeningResult {
  readonly diagnosis: string;
  readonly confidenceScore: number;
  readonly ringkasan: string;
  readonly areaTemuan: readonly TbAreaTemuan[];
  readonly indikator: readonly TbIndicator[];
}

interface TbCondition {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

const TB_ABNORMALITY_THRESHOLD = 30;

const TB_CONDITION_STYLE: Record<string, { readonly label: string; readonly color: string }> = {
  tbc: { label: 'TBC', color: '#ef4444' },
  pneumonia: { label: 'Pneumonia', color: '#22c55e' },
  bronchopneumonia: { label: 'Bronchopneumonia', color: '#3b82f6' },
  bronchitis: { label: 'Bronchitis', color: '#eab308' },
};

/** Deteksi kelainan utama dari hasil skrining untuk pewarnaan foto rontgen,
 * berurutan berdasarkan prioritas — TBC didahulukan karena itu tujuan utama
 * skrining, baru diikuti indikator lain yang skornya melewati ambang. Kotak
 * pewarnaan ini hanya berlaku untuk hasil skrining thorax (areaTemuan cuma
 * diisi backend untuk model thorax), jadi pada model lain fungsi ini akan
 * selalu mengembalikan array kosong secara alami. */
function getAiBanding2Conditions(result: TbScreeningResult): readonly TbCondition[] {
  const conditions: TbCondition[] = [];
  const persenOf = (key: string) => result.indikator.find((ind) => ind.key === key)?.persen ?? 0;
  if (/tbc|tuberk/i.test(result.diagnosis) && result.confidenceScore >= TB_ABNORMALITY_THRESHOLD) {
    conditions.push({ key: 'tbc', ...TB_CONDITION_STYLE.tbc! });
  }
  if (persenOf('pneumonia') >= TB_ABNORMALITY_THRESHOLD) {
    conditions.push({ key: 'pneumonia', ...TB_CONDITION_STYLE.pneumonia! });
  }
  if (persenOf('bronchopneumonia') >= TB_ABNORMALITY_THRESHOLD) {
    conditions.push({ key: 'bronchopneumonia', ...TB_CONDITION_STYLE.bronchopneumonia! });
  }
  if (persenOf('bronchitis') >= TB_ABNORMALITY_THRESHOLD) {
    conditions.push({ key: 'bronchitis', ...TB_CONDITION_STYLE.bronchitis! });
  }
  return conditions;
}

/** Pilihan model AI Banding 2 (nilai `model` untuk /api/analisa-foto-ai/tb-screening),
 * dipakai bersama oleh modal AI Banding 2 dan modal Edit³. */
const AI_BANDING2_MODEL_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'v1', label: 'Model Version 1' },
  { value: 'v2', label: 'Model Version 2' },
  { value: 'lumbosacral', label: 'Lumbo Sacral' },
  { value: 'genu', label: 'Genu' },
  { value: 'knee', label: 'Knee' },
  { value: 'ankle', label: 'Ankle' },
  { value: 'cranium', label: 'Cranium' },
  { value: 'cervikal', label: 'Cervikal' },
  { value: 'bno', label: 'BNO' },
  { value: 'femur', label: 'Femur' },
  { value: 'cruris', label: 'Cruris' },
  { value: 'anthebrachi', label: 'Anthebrachi' },
  { value: 'usg-abdomen', label: 'USG Abdomen' },
  { value: 'usg-mammae', label: 'USG Mammae' },
];

/** Gaya tombol kecil ＋ ✎ 🗑 di samping dropdown master data pada modal Registrasi Radiologi Baru. */
/** Tanggal hari ini (zona waktu perangkat) dalam format input type="date". */
function todayLocalIso(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

const MASTER_ACTION_BUTTON_STYLE = {
  border: '1px solid var(--color-border)',
  flex: '0 0 auto',
  padding: '0.2rem 0.45rem',
} as const;

const HASIL_TABS = [
  { id: 'all', label: 'Semua data' },
  { id: 'MENUNGGU_HASIL', label: 'Menunggu hasil' },
  { id: 'SELESAI', label: 'Selesai' },
] as const;

export function PasienPage() {
  const { search, setSearch } = useListSearch();
  const [hasilTab, setHasilTab] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [dokterFilter, setDokterFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState<'all'|'today'|'week'>('all');

  const dateParams = useMemo(() => {
    if (timeFilter === 'all') return {};
    const now = new Date();
    // Use local time for dates
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
    return {};
  }, [timeFilter]);

  const queryParams = useListQueryParams(
    {
      modul: 'RADIOLOGI',
      ...(hasilTab !== 'all' ? { hasilStatus: hasilTab } : {}),
      ...(paymentFilter ? { paymentStatus: paymentFilter } : {}),
      ...(dokterFilter ? { pengirimId: dokterFilter } : {}),
      ...(dateParams as Record<string, string>),
    },
    search,
  );

  const { version: listRefreshVersion } = useListRefresh();
  const { items, pagination, setPage, loading, error, reload: reloadList, setError } =
    usePaginatedList<PasienRow>('/api/pasien', queryParams);
  const reload = useMutationReload(reloadList);
  const [dokter, setDokter] = useState<Dokter[]>([]);
  const [radiologList, setRadiologList] = useState<Radiolog[]>([]);
  const [pilihanSharingList, setPilihanSharingList] = useState<PilihanSharing[]>([]);
  const [radiologForm, setRadiologForm] = useState<RadiologFormState | null>(null);
  const [radiologFormError, setRadiologFormError] = useState<string | null>(null);
  const [radiologSaving, setRadiologSaving] = useState(false);
  const [radiologDeleteTarget, setRadiologDeleteTarget] = useState<Radiolog | null>(null);
  const [radiologDeleting, setRadiologDeleting] = useState(false);
  const [sharingOptionForm, setSharingOptionForm] = useState<SharingOptionFormState | null>(null);
  const [sharingOptionError, setSharingOptionError] = useState<string | null>(null);
  const [sharingOptionSaving, setSharingOptionSaving] = useState(false);
  const [sharingOptionDeleteTarget, setSharingOptionDeleteTarget] = useState<PilihanSharing | null>(null);
  const [sharingOptionDeleting, setSharingOptionDeleting] = useState(false);
  const [jenis, setJenis] = useState<Jenis[]>([]);
  const [pendaftaranList, setPendaftaranList] = useState<PendaftaranUmumItem[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [selectedPendaftaranId, setSelectedPendaftaranId] = useState('');
  const [mastersError, setMastersError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [zoomedFotoId, setZoomedFotoId] = useState<string | null>(null);
  const [fotoUploadingId, setFotoUploadingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const [kwitansiItem, setKwitansiItem] = useState<PasienRow | null>(null);
  const [kesanItem, setKesanItem] = useState<PasienRow | null>(null);
  const [kesanEditText, setKesanEditText] = useState('');
  const [kesanSaving, setKesanSaving] = useState(false);
  const [kesanError, setKesanError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [quickEditOpen, setQuickEditOpen] = useState(false);
  const [quickEditId, setQuickEditId] = useState<string | null>(null);
  const [quickEditNama, setQuickEditNama] = useState('');
  const [quickEditPemeriksaan, setQuickEditPemeriksaan] = useState('');
  const [quickEditKesan, setQuickEditKesan] = useState('');
  const [quickEditSaving, setQuickEditSaving] = useState(false);
  const [quickEditError, setQuickEditError] = useState<string | null>(null);
  const [fotoEditTarget, setFotoEditTarget] = useState<{ readonly id: string; readonly nama: string } | null>(null);
  const [fotoEditFoto, setFotoEditFoto] = useState('');
  const [fotoEditSaving, setFotoEditSaving] = useState(false);
  const [fotoEditError, setFotoEditError] = useState<string | null>(null);
  const [fotoEditAnalisa, setFotoEditAnalisa] = useState('');
  const [fotoEditAnalyzing, setFotoEditAnalyzing] = useState<'ai' | 'banding2' | null>(null);
  const [fotoEditTbModel, setFotoEditTbModel] = useState('');
  const [fotoEditAnalisaCopied, setFotoEditAnalisaCopied] = useState(false);
  const [aiFotoOpen, setAiFotoOpen] = useState(false);
  const [aiFotoDataUrl, setAiFotoDataUrl] = useState('');
  const [aiFotoAnalyzing, setAiFotoAnalyzing] = useState(false);
  const [aiFotoError, setAiFotoError] = useState<string | null>(null);
  const [aiFotoNamaPenyakit, setAiFotoNamaPenyakit] = useState('');
  const [aiFotoKesan, setAiFotoKesan] = useState('');
  const [aiBanding2Open, setAiBanding2Open] = useState(false);
  const [tabelAiOpen, setTabelAiOpen] = useState(false);
  const [aiBanding2Model, setAiBanding2Model] = useState('');
  const [aiBanding2DataUrl, setAiBanding2DataUrl] = useState('');
  const [aiBanding2DragOver, setAiBanding2DragOver] = useState(false);
  const [aiBanding2Analyzing, setAiBanding2Analyzing] = useState(false);
  const [aiBanding2Error, setAiBanding2Error] = useState<string | null>(null);
  const [aiBanding2Result, setAiBanding2Result] = useState<TbScreeningResult | null>(null);
  // Foto asli (belum dipengaruhi slider) — ketajaman/densitas/kontras selalu dihitung ulang dari sini,
  // supaya foto yang dikirim ke AI (sebelum didiagnosa) adalah versi yang sudah diatur.
  const [aiBanding2RawDataUrl, setAiBanding2RawDataUrl] = useState('');
  const [aiBanding2Contrast, setAiBanding2Contrast] = useState(0);
  const [aiBanding2Brightness, setAiBanding2Brightness] = useState(0);
  const [aiBanding2Detail, setAiBanding2Detail] = useState(0);
  const [aiBanding2AdjustingPhoto, setAiBanding2AdjustingPhoto] = useState(false);
  const [nama, setNama] = useState('');
  const [tanggalLahir, setTanggalLahir] = useState('');
  const [umurManual, setUmurManual] = useState('');
  const [noTelepon, setNoTelepon] = useState('');
  const [alamat, setAlamat] = useState('');
  const [pengirimId, setPengirimId] = useState('');
  const [klinis, setKlinis] = useState('');
  const [temuan, setTemuan] = useState('');
  const [kesan, setKesan] = useState('');
  /** Tanggal registrasi baru (YYYY-MM-DD, zona lokal); default hari ini. */
  const [tanggalRegistrasi, setTanggalRegistrasi] = useState(todayLocalIso);
  const [admin, setAdmin] = useState('');
  const [foto, setFoto] = useState('');
  const [hargaManual, setHargaManual] = useState('0');
  const [hargaMode, setHargaMode] = useState('custom');
  const [savedPasien, setSavedPasien] = useState<CetakALPasien | null>(null);
  const [cetakAL, setCetakAL] = useState<{ open: boolean; mode: 'amplop' | 'label' }>({
    open: false,
    mode: 'amplop',
  });
  const [pendaftaranEditing, setPendaftaranEditing] = useState<PendaftaranUmumItem | null>(null);
  const [pendaftaranDeleting, setPendaftaranDeleting] = useState<PendaftaranUmumItem | null>(null);
  const [pendaftaranPreview, setPendaftaranPreview] = useState<PendaftaranUmumItem | null>(null);
  const [pendaftaranLogoSrc, setPendaftaranLogoSrc] = useState('');
  const [pendaftaranSubmitting, setPendaftaranSubmitting] = useState(false);
  const [pendaftaranForm, setPendaftaranForm] = useState({
    namaPasien: '',
    umur: '',
    telpon: '',
    alamat: '',
    dokterPengirim: '',
    admin: '',
    foto: '',
  });
  const [pendaftaranFotoError, setPendaftaranFotoError] = useState<string | null>(null);
  const [radiologId, setRadiologId] = useState('');
  const [hasilStatus, setHasilStatus] = useState<'MENUNGGU_HASIL' | 'SELESAI'>('MENUNGGU_HASIL');
  const [paymentStatus, setPaymentStatus] = useState<'BELUM_LUNAS' | 'LUNAS'>('BELUM_LUNAS');
  const [selectedJenis, setSelectedJenis] = useState<string[]>([]);
  const existingTambahanRef = useRef<{ radTambahan: string[]; labTambahan: string[] }>({
    radTambahan: [],
    labTambahan: [],
  });
  const [sharingAmount, setSharingAmount] = useState('0');
  const [sharingMode, setSharingMode] = useState<string>('auto');
  const [jenisModalMode, setJenisModalMode] = useState<'add' | 'edit' | null>(null);
  const [editingJenisItem, setEditingJenisItem] = useState<Jenis | null>(null);
  const [editingJenisNama, setEditingJenisNama] = useState('');
  const [editingJenisHarga, setEditingJenisHarga] = useState('');
  const [editingJenisJumlahFilm, setEditingJenisJumlahFilm] = useState('1');
  const [savingJenis, setSavingJenis] = useState(false);
  const [jenisError, setJenisError] = useState<string | null>(null);

  const [bhpModalOpen, setBhpModalOpen] = useState(false);
  const [bhpForm, setBhpForm] = useState({
    tanggal: new Date().toISOString().split('T')[0]!,
    pemakaian: '',
    harga: '0',
    dev: '1000',
    fixer: '1000',
    film: '38000',
    amplopKertas: '1000',
    listrik: '2000',
    gajiKaryawan: '2500000',
    kertasCetak: '2000',
    amplop: '2000',
  });
  const [savingBhp, setSavingBhp] = useState(false);
  const [bhpError, setBhpError] = useState<string | null>(null);

  const umurYears = useMemo(() => {
    if (!isValidBirthDate(tanggalLahir)) return 0;
    return computeUmurYears(tanggalLahir) ?? 0;
  }, [tanggalLahir]);

  const selectedDokter = useMemo(() => dokter.find((d) => d.id === pengirimId), [dokter, pengirimId]);

  const autoSharingAmount = useMemo(() => {
    const selectedNames = selectedJenis
      .map((id) => jenis.find((j) => j.id === id)?.nama || '')
      .filter(Boolean);
    return computeAutoSharingAmount(
      selectedDokter?.nama,
      selectedNames,
      umurYears,
      selectedDokter?.defaultSharingAmount || '0',
    );
  }, [selectedDokter, selectedJenis, jenis, umurYears]);

  useEffect(() => {
    if (sharingMode === 'auto') {
      setSharingAmount(autoSharingAmount);
    }
  }, [sharingMode, autoSharingAmount]);

  const [summary, setSummary] = useState<PasienSummary | null>(null);

  const estimate = useMemo(() => {
    const totalHarga = selectedJenis.reduce((sum, id) => {
      const row = jenis.find((j) => j.id === id);
      return sum + Number(row?.harga ?? 0);
    }, 0);
    const amt = Number(sharingAmount);
    const totalSharing = Number.isFinite(amt) ? amt : 0;
    return { totalHarga, totalSharing };
  }, [selectedJenis, jenis, sharingAmount]);

  const loadMasters = useCallback(async () => {
    setMastersError(null);
    try {
      const [dokterRes, jenisRes, radiologRes, pendaftaranRes, staffRes, pilihanSharingRes] = await Promise.all([
        apiGet<PaginatedResponse<Dokter>>('/api/dokter?page=1&limit=200'),
        apiGet<PaginatedResponse<Jenis>>('/api/jenis-pemeriksaan?page=1&limit=200'),
        apiGet<PaginatedResponse<Radiolog>>('/api/radiolog?page=1&limit=200'),
        apiGet<PaginatedResponse<PendaftaranUmumItem>>('/api/pendaftaran-umum?page=1&limit=300').catch(() => ({ items: [] })),
        apiGet<PaginatedResponse<Staff>>('/api/admin-klinik?page=1&limit=200').catch(() => ({ items: [] })),
        apiGet<{ items: PilihanSharing[] }>('/api/pilihan-sharing').catch(() => ({ items: [] })),
      ]);
      setDokter(dokterRes.items);
      setJenis(jenisRes.items.filter((j) => j.harga !== null));
      setRadiologList(radiologRes.items);
      setPendaftaranList(pendaftaranRes.items);
      setStaffList(staffRes.items);
      setPilihanSharingList(pilihanSharingRes.items);
    } catch (err: unknown) {
      setMastersError(err instanceof Error ? err.message : 'Gagal memuat master data');
    }
  }, []);

  useEffect(() => {
    void loadMasters();
  }, [loadMasters, listRefreshVersion]);

  useEffect(() => {
    void loadLogoDataUrl().then(setPendaftaranLogoSrc).catch(() => setPendaftaranLogoSrc(''));
  }, []);

  function openEditPendaftaran(item: PendaftaranUmumItem) {
    setPendaftaranEditing(item);
    setPendaftaranForm({
      namaPasien: item.namaPasien,
      umur: item.umur || '',
      telpon: item.telpon || '',
      alamat: item.alamat || '',
      dokterPengirim: item.dokterPengirim || '',
      admin: item.admin || '',
      foto: item.foto || '',
    });
    setPendaftaranFotoError(null);
  }

  async function handleEditPendaftaranFotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Dikosongkan supaya memilih file yang sama lagi tetap memicu onChange.
    input.value = '';
    if (!file) return;
    const invalid = validateFotoFile(file);
    if (invalid) {
      setPendaftaranFotoError(invalid);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setPendaftaranForm((prev) => ({ ...prev, foto: dataUrl }));
      setPendaftaranFotoError(null);
    } catch (err: unknown) {
      setPendaftaranFotoError(err instanceof Error ? err.message : 'Gagal membaca file foto');
    }
  }

  async function submitEditPendaftaran(e: FormEvent) {
    e.preventDefault();
    if (!pendaftaranEditing) return;
    setPendaftaranSubmitting(true);
    setError(null);
    try {
      await apiPatch(`/api/pendaftaran-umum/${pendaftaranEditing.id}`, {
        namaPasien: pendaftaranForm.namaPasien,
        umur: pendaftaranForm.umur || undefined,
        telpon: pendaftaranForm.telpon || undefined,
        alamat: pendaftaranForm.alamat || undefined,
        dokterPengirim: pendaftaranForm.dokterPengirim || undefined,
        admin: pendaftaranForm.admin || undefined,
        // Selalu dikirim: string kosong berarti foto dihapus (API menyimpannya sebagai null).
        foto: pendaftaranForm.foto,
      });
      // Form registrasi menyalin foto saat baris dipilih, jadi perbarui juga bila baris ini sedang dipilih.
      if (selectedPendaftaranId === pendaftaranEditing.id) setFoto(pendaftaranForm.foto);
      setPendaftaranEditing(null);
      await loadMasters();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah data pendaftaran');
    } finally {
      setPendaftaranSubmitting(false);
    }
  }

  async function confirmDeletePendaftaran() {
    if (!pendaftaranDeleting) return;
    setPendaftaranSubmitting(true);
    setError(null);
    try {
      await apiDelete(`/api/pendaftaran-umum/${pendaftaranDeleting.id}`);
      setPendaftaranDeleting(null);
      await loadMasters();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus data pendaftaran');
    } finally {
      setPendaftaranSubmitting(false);
    }
  }

  function openRadiologForm(mode: 'add' | 'edit') {
    const target = mode === 'edit' ? radiologList.find((r) => r.id === radiologId) : undefined;
    if (mode === 'edit' && !target) return;
    setRadiologForm({
      mode,
      id: target?.id ?? null,
      nama: target?.nama ?? '',
      noTelepon: target?.noTelepon ?? '',
    });
    setRadiologFormError(null);
  }

  async function submitRadiologForm(e: FormEvent) {
    e.preventDefault();
    if (!radiologForm) return;
    // PATCH /api/radiolog menyimpan nama kosong apa adanya, jadi dicegah di sini.
    if (!radiologForm.nama.trim()) {
      setRadiologFormError('Nama radiolog wajib diisi');
      return;
    }
    setRadiologSaving(true);
    setRadiologFormError(null);
    try {
      const body = { nama: radiologForm.nama.trim(), noTelepon: radiologForm.noTelepon };
      if (radiologForm.mode === 'add') {
        const res = await apiPost<{ item: Radiolog }>('/api/radiolog', body);
        setRadiologId(res.item.id);
      } else if (radiologForm.id) {
        await apiPatch(`/api/radiolog/${radiologForm.id}`, body);
      }
      setRadiologForm(null);
      await loadMasters();
    } catch (err: unknown) {
      setRadiologFormError(err instanceof Error ? err.message : 'Gagal menyimpan radiolog');
    } finally {
      setRadiologSaving(false);
    }
  }

  async function confirmDeleteRadiolog() {
    if (!radiologDeleteTarget) return;
    setRadiologDeleting(true);
    setFormError(null);
    try {
      await apiDelete(`/api/radiolog/${radiologDeleteTarget.id}`);
      if (radiologId === radiologDeleteTarget.id) setRadiologId('');
      await loadMasters();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Gagal menghapus radiolog');
    } finally {
      setRadiologDeleting(false);
      setRadiologDeleteTarget(null);
    }
  }

  function openSharingOptionForm(mode: 'add' | 'edit') {
    const target = mode === 'edit' ? pilihanSharingList.find((o) => String(o.nominal) === sharingMode) : undefined;
    if (mode === 'edit' && !target) return;
    setSharingOptionForm({
      mode,
      id: target?.id ?? null,
      originalNominal: target?.nominal ?? null,
      nominal: target ? String(target.nominal) : '',
      keterangan: target?.keterangan ?? '',
    });
    setSharingOptionError(null);
  }

  async function submitSharingOptionForm(e: FormEvent) {
    e.preventDefault();
    if (!sharingOptionForm) return;
    setSharingOptionSaving(true);
    setSharingOptionError(null);
    try {
      // Nominal dikirim apa adanya; API yang memvalidasi (bilangan bulat, tidak negatif, tidak dobel).
      const body = { nominal: sharingOptionForm.nominal, keterangan: sharingOptionForm.keterangan };
      const res =
        sharingOptionForm.mode === 'edit' && sharingOptionForm.id
          ? await apiPatch<{ item: PilihanSharing }>(`/api/pilihan-sharing/${sharingOptionForm.id}`, body)
          : await apiPost<{ item: PilihanSharing }>('/api/pilihan-sharing', body);
      // Pilihan baru, atau pilihan yang sedang dipakai lalu diedit, langsung diterapkan ke form.
      if (sharingOptionForm.mode === 'add' || sharingMode === String(sharingOptionForm.originalNominal)) {
        setSharingMode(String(res.item.nominal));
        setSharingAmount(String(res.item.nominal));
      }
      setSharingOptionForm(null);
      await loadMasters();
    } catch (err: unknown) {
      setSharingOptionError(err instanceof Error ? err.message : 'Gagal menyimpan pilihan sharing');
    } finally {
      setSharingOptionSaving(false);
    }
  }

  async function confirmDeleteSharingOption() {
    if (!sharingOptionDeleteTarget) return;
    setSharingOptionDeleting(true);
    setFormError(null);
    try {
      await apiDelete(`/api/pilihan-sharing/${sharingOptionDeleteTarget.id}`);
      // Nominal yang sudah terisi di form tetap dipakai; hanya pilihannya yang hilang dari daftar.
      if (sharingMode === String(sharingOptionDeleteTarget.nominal)) setSharingMode('custom');
      await loadMasters();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Gagal menghapus pilihan sharing');
    } finally {
      setSharingOptionDeleting(false);
      setSharingOptionDeleteTarget(null);
    }
  }

  async function handleUploadPendaftaranFoto(item: PendaftaranUmumItem, e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Dikosongkan supaya memilih file yang sama lagi tetap memicu onChange.
    input.value = '';
    if (!file) return;
    const invalid = validateFotoFile(file);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setFotoUploadingId(item.id);
    setFormError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await apiPatch(`/api/pendaftaran-umum/${item.id}`, { foto: dataUrl });
      // Form registrasi menyalin foto saat baris dipilih, jadi perbarui juga bila baris ini sedang dipilih.
      if (selectedPendaftaranId === item.id) setFoto(dataUrl);
      await loadMasters();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Gagal mengunggah foto');
    } finally {
      setFotoUploadingId(null);
    }
  }

  const loadSummary = useCallback(async () => {
    try {
      const res = await apiGet<PasienSummary>('/api/pasien/summary');
      setSummary(res);
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary, items.length]);

  function onPengirimChange(id: string, applyTemplate = true) {
    setPengirimId(id);
    if (!applyTemplate) return;
    const dok = dokter.find((d) => d.id === id);
    if (dok) {
      setSharingAmount(dok.defaultSharingAmount);
      setSharingMode('auto');
    }
  }

  function handlePendaftaranSelect(id: string) {
    setSelectedPendaftaranId(id);
    const p = pendaftaranList.find(x => x.id === id);
    if (!p) {
      setNama('');
      setAlamat('');
      setNoTelepon('');
      setKlinis('');
      setTanggalLahir('');
      setUmurManual('');
      setPengirimId('');
      setSharingAmount('0');
      setSharingMode('auto');
      setAdmin('');
      setFoto('');
      return;
    }

    setNama(p.namaPasien);
    setAlamat(p.alamat || '');
    setNoTelepon(p.telpon || '');
    setKlinis(p.klinis || '');
    setAdmin(p.admin || '');
    setFoto(p.foto || '');

    if (p.umur) {
      const tanggal = parseUmurManualToTanggalLahir(p.umur);
      setUmurManual(p.umur);
      setTanggalLahir(tanggal ?? '');
    } else {
      setTanggalLahir('');
      setUmurManual('');
    }
    
    if (p.dokterPengirim) {
      const dok = dokter.find(d => d.nama.toLowerCase() === p.dokterPengirim!.toLowerCase());
      if (dok) {
        setPengirimId(dok.id);
        setSharingAmount(dok.defaultSharingAmount);
      } else {
        setPengirimId('');
        setSharingAmount('0');
      }
    } else {
      setPengirimId('');
      setSharingAmount('0');
    }
  }

  function resetForm() {
    setNama('');
    setTanggalLahir('');
    setUmurManual('');
    setNoTelepon('');
    setAlamat('');
    setPengirimId(dokter[0]?.id ?? '');
    setSharingAmount(dokter[0]?.defaultSharingAmount ?? '0');
    setSharingMode('auto');
    setKlinis('');
    setTemuan('');
    setKesan('');
    setTanggalRegistrasi(todayLocalIso());
    setAdmin('');
    setFoto('');
    setHargaManual('0');
    setHargaMode('custom');
    setRadiologId('');
    setHasilStatus('MENUNGGU_HASIL');
    setPaymentStatus('BELUM_LUNAS');
    setSelectedJenis([]);
    existingTambahanRef.current = { radTambahan: [], labTambahan: [] };
    setEditingId(null);
    setSelectedPendaftaranId('');
    setSavedPasien(null);
    setFormError(null);
  }

  function handleUmurManualChange(value: string) {
    setUmurManual(value);
    const tanggal = parseUmurManualToTanggalLahir(value);
    if (tanggal) setTanggalLahir(tanggal);
  }

  function toggleJenis(id: string) {
    setSelectedJenis((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function openEdit(id: string) {
    setError(null);
    setFormError(null);
    try {
      const res = await apiGet<{ item: PasienDetail }>(`/api/pasien/${id}`);
      const p = res.item;
      const parsedKlinis = parseKlinisData(p.klinis);
      setEditingId(p.id);
      setNama(p.nama);
      setTanggalLahir(p.tanggalLahir);
      setUmurManual(String(p.umur));
      setNoTelepon(p.noTelepon ?? '');
      setAlamat(p.alamat ?? '');
      setPengirimId(p.pengirim.id);
      setKlinis(parsedKlinis.text);
      existingTambahanRef.current = {
        radTambahan: parsedKlinis.radTambahan,
        labTambahan: parsedKlinis.labTambahan,
      };
      setTemuan(p.temuan ?? '');
      setKesan(p.kesan ?? '');
      setAdmin(p.admin ?? '');
      setFoto(p.foto ?? '');
      setRadiologId(p.radiolog?.id ?? '');
      setHasilStatus(p.hasilStatus);
      setPaymentStatus(p.paymentStatus);
      const currentSharing = p.sharingAmount;
      setSharingAmount(currentSharing);
      const dok = dokter.find((d) => d.id === p.pengirim.id);
      const selNames = p.pemeriksaan
        .map((x) => jenis.find((j) => j.id === x.jenisPemeriksaanId)?.nama || '')
        .filter(Boolean);
      const computedAuto = computeAutoSharingAmount(
        dok?.nama,
        selNames,
        computeUmurYears(p.tanggalLahir) ?? 0,
        dok?.defaultSharingAmount || '0'
      );
      if (currentSharing === computedAuto) {
        setSharingMode('auto');
      } else if (['18000', '20000', '33000', '35000', '58000', '88000', '50000', '0'].includes(currentSharing)) {
        setSharingMode(currentSharing);
      } else {
        setSharingMode('custom');
      }
      setSelectedJenis(p.pemeriksaan.map((x) => x.jenisPemeriksaanId));
      setEditOpen(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal memuat detail pasien');
    }
  }

  function openKesan(p: PasienRow) {
    setKesanError(null);
    setKesanEditText(p.kesan ?? '');
    setKesanItem(p);
  }

  async function submitKesan() {
    if (!kesanItem) return;
    setKesanSaving(true);
    setKesanError(null);
    try {
      await apiPatch(`/api/pasien/${kesanItem.id}`, { kesan: kesanEditText });
      setKesanItem(null);
      await reload();
    } catch (err: unknown) {
      setKesanError(err instanceof Error ? err.message : 'Gagal menyimpan kesan');
    } finally {
      setKesanSaving(false);
    }
  }

  async function openQuickEdit(id: string) {
    setQuickEditError(null);
    try {
      const res = await apiGet<{ item: PasienDetail }>(`/api/pasien/${id}`);
      setQuickEditId(res.item.id);
      setQuickEditNama(res.item.nama);
      setQuickEditPemeriksaan(res.item.pemeriksaan.map((x) => x.nama).join(', ') || '—');
      setQuickEditKesan(res.item.kesan ?? '');
      setQuickEditOpen(true);
    } catch (err: unknown) {
      setQuickEditError(err instanceof Error ? err.message : 'Gagal memuat detail pasien');
    }
  }

  async function submitQuickEdit(e: FormEvent) {
    e.preventDefault();
    if (!quickEditId) return;
    setQuickEditSaving(true);
    setQuickEditError(null);
    try {
      await apiPatch(`/api/pasien/${quickEditId}`, {
        nama: quickEditNama,
        kesan: quickEditKesan,
      });
      setQuickEditOpen(false);
      await reload();
    } catch (err: unknown) {
      setQuickEditError(err instanceof Error ? err.message : 'Gagal menyimpan perubahan');
    } finally {
      setQuickEditSaving(false);
    }
  }

  function openFotoEdit(p: PasienRow) {
    setFotoEditTarget({ id: p.id, nama: p.nama });
    setFotoEditFoto(p.foto ?? '');
    setFotoEditError(null);
    setFotoEditAnalisa('');
    setFotoEditTbModel('');
  }

  async function handleFotoEditFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Dikosongkan supaya memilih file yang sama lagi tetap memicu onChange.
    input.value = '';
    if (!file) return;
    const invalid = validateFotoFile(file);
    if (invalid) {
      setFotoEditError(invalid);
      return;
    }
    try {
      setFotoEditFoto(await readFileAsDataUrl(file));
      setFotoEditError(null);
      // Analisa sebelumnya milik foto lama.
      setFotoEditAnalisa('');
    } catch (err: unknown) {
      setFotoEditError(err instanceof Error ? err.message : 'Gagal membaca file foto');
    }
  }

  async function submitFotoEdit(e: FormEvent) {
    e.preventDefault();
    if (!fotoEditTarget) return;
    setFotoEditSaving(true);
    setFotoEditError(null);
    try {
      // String kosong berarti foto dihapus (API menyimpannya sebagai null).
      await apiPatch(`/api/pasien/${fotoEditTarget.id}`, { foto: fotoEditFoto });
      setFotoEditTarget(null);
      await reload();
    } catch (err: unknown) {
      setFotoEditError(err instanceof Error ? err.message : 'Gagal menyimpan foto');
    } finally {
      setFotoEditSaving(false);
    }
  }

  async function handleFotoEditAnalyze() {
    if (!fotoEditFoto) return;
    setFotoEditAnalyzing('ai');
    setFotoEditError(null);
    try {
      const res = await apiPost<{ namaPenyakit: string; kesan: string }>('/api/analisa-foto-ai/analyze', {
        fotoDataUrl: fotoEditFoto,
      });
      setFotoEditAnalisa(formatAiFotoAnalisa(res));
    } catch (err: unknown) {
      setFotoEditError(err instanceof Error ? err.message : 'Gagal menganalisa foto dengan AI');
    } finally {
      setFotoEditAnalyzing(null);
    }
  }

  async function handleFotoEditAiBanding2() {
    if (!fotoEditFoto) return;
    if (!fotoEditTbModel) {
      setFotoEditError('Pilih model AI Banding 2 terlebih dahulu.');
      return;
    }
    setFotoEditAnalyzing('banding2');
    setFotoEditError(null);
    try {
      const res = await apiPost<TbScreeningResult>('/api/analisa-foto-ai/tb-screening', {
        fotoDataUrl: fotoEditFoto,
        model: fotoEditTbModel,
      });
      setFotoEditAnalisa(formatTbScreeningAnalisa(res));
    } catch (err: unknown) {
      setFotoEditError(err instanceof Error ? err.message : 'Gagal menganalisa foto dengan AI Banding 2');
    } finally {
      setFotoEditAnalyzing(null);
    }
  }

  async function handleCopyFotoEditAnalisa() {
    if (!fotoEditAnalisa) return;
    try {
      await navigator.clipboard.writeText(fotoEditAnalisa);
      setFotoEditAnalisaCopied(true);
      setTimeout(() => setFotoEditAnalisaCopied(false), 1500);
    } catch (err: unknown) {
      setFotoEditError(err instanceof Error ? `Gagal menyalin analisa: ${err.message}` : 'Gagal menyalin analisa');
    }
  }

  function openAiFotoModal() {
    setAiFotoDataUrl('');
    setAiFotoError(null);
    setAiFotoNamaPenyakit('');
    setAiFotoKesan('');
    setAiFotoOpen(true);
  }

  function handleAiFotoFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAiFotoDataUrl(reader.result);
        setAiFotoError(null);
        setAiFotoNamaPenyakit('');
        setAiFotoKesan('');
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleAiFotoAnalyze() {
    if (!aiFotoDataUrl) {
      setAiFotoError('Unggah foto terlebih dahulu sebelum memulai analisa AI.');
      return;
    }
    setAiFotoAnalyzing(true);
    setAiFotoError(null);
    try {
      const res = await apiPost<{ namaPenyakit: string; kesan: string }>('/api/analisa-foto-ai/analyze', {
        fotoDataUrl: aiFotoDataUrl,
      });
      setAiFotoNamaPenyakit(res.namaPenyakit);
      setAiFotoKesan(res.kesan);
    } catch (err) {
      setAiFotoError(err instanceof Error ? err.message : 'Gagal menganalisa foto dengan AI');
    } finally {
      setAiFotoAnalyzing(false);
    }
  }

  function handleSaveAiFotoKesan() {
    resetForm();
    setKesan(
      aiFotoNamaPenyakit.trim()
        ? `Kemungkinan: ${aiFotoNamaPenyakit.trim()}\n\n${aiFotoKesan}`
        : aiFotoKesan,
    );
    setAiFotoOpen(false);
    setAddOpen(true);
  }

  useEffect(() => {
    if (!aiBanding2RawDataUrl) return;
    let cancelled = false;
    setAiBanding2AdjustingPhoto(true);
    applyPhotoAdjustments(aiBanding2RawDataUrl, {
      contrast: aiBanding2Contrast,
      brightness: aiBanding2Brightness,
      detail: aiBanding2Detail,
    })
      .then((result) => {
        if (!cancelled) setAiBanding2DataUrl(result);
      })
      .catch(() => {
        if (!cancelled) setAiBanding2DataUrl(aiBanding2RawDataUrl);
      })
      .finally(() => {
        if (!cancelled) setAiBanding2AdjustingPhoto(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aiBanding2RawDataUrl, aiBanding2Contrast, aiBanding2Brightness, aiBanding2Detail]);

  function openAiBanding2Modal() {
    setAiBanding2Model('');
    setAiBanding2DataUrl('');
    setAiBanding2RawDataUrl('');
    setAiBanding2Contrast(0);
    setAiBanding2Brightness(0);
    setAiBanding2Detail(0);
    setAiBanding2DragOver(false);
    setAiBanding2Error(null);
    setAiBanding2Result(null);
    setAiBanding2Open(true);
  }

  function loadAiBanding2File(file: File) {
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) {
      setAiBanding2Error('Format foto tidak didukung. Gunakan PNG, JPG, atau JPEG.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAiBanding2Contrast(0);
        setAiBanding2Brightness(0);
        setAiBanding2Detail(0);
        setAiBanding2RawDataUrl(reader.result);
        setAiBanding2DataUrl(reader.result);
        setAiBanding2Error(null);
        setAiBanding2Result(null);
      }
    };
    reader.readAsDataURL(file);
  }

  function handleAiBanding2FileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadAiBanding2File(file);
  }

  function handleAiBanding2Drop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setAiBanding2DragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadAiBanding2File(file);
  }

  async function handleAiBanding2Analyze() {
    if (!aiBanding2Model) {
      setAiBanding2Error('Pilih model version terlebih dahulu.');
      return;
    }
    if (!aiBanding2DataUrl) {
      setAiBanding2Error('Unggah foto rontgen terlebih dahulu sebelum memulai analisa AI.');
      return;
    }
    setAiBanding2Analyzing(true);
    setAiBanding2Error(null);
    try {
      const res = await apiPost<TbScreeningResult>('/api/analisa-foto-ai/tb-screening', {
        fotoDataUrl: aiBanding2DataUrl,
        model: aiBanding2Model,
      });
      setAiBanding2Result(res);
    } catch (err) {
      setAiBanding2Error(err instanceof Error ? err.message : 'Gagal menganalisa foto dengan AI');
    } finally {
      setAiBanding2Analyzing(false);
    }
  }

  function handleSaveAiBanding2Kesan() {
    if (!aiBanding2Result) return;
    resetForm();
    setKesan(
      `Kemungkinan: ${aiBanding2Result.diagnosis} (Skor keyakinan: ${aiBanding2Result.confidenceScore}%)\n\n${aiBanding2Result.ringkasan}`,
    );
    setAiBanding2Open(false);
    setAddOpen(true);
  }

  function handlePrintAiBanding2() {
    if (!aiBanding2Result || !aiBanding2DataUrl) return;
    const win = window.open('', '_blank', 'width=850,height=700');
    if (!win) return;
    const rows = aiBanding2Result.indikator
      .map((ind) => `<tr><td>${ind.label}</td><td>${ind.persen}%</td><td>${ind.keterangan}</td></tr>`)
      .join('');
    win.document.write(`<!DOCTYPE html><html><head><title>Hasil AI Banding 2</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
        h1 { font-size: 20px; margin-bottom: 4px; }
        .score { font-size: 28px; font-weight: 700; color: #ea580c; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; font-size: 13px; }
        img { max-width: 320px; margin-top: 12px; border: 1px solid #cbd5e1; }
        .note { font-size: 11px; color: #64748b; font-style: italic; margin-top: 16px; }
      </style>
      </head><body>
        <h1>Hasil AI Banding 2 — Skrining TB</h1>
        <div class="score">${aiBanding2Result.diagnosis} — ${aiBanding2Result.confidenceScore}%</div>
        <p>${aiBanding2Result.ringkasan}</p>
        <img src="${aiBanding2DataUrl}" alt="X-Ray" />
        <table>
          <thead><tr><th>Indikator</th><th>Skor</th><th>Keterangan</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="note">Catatan: Hasil analisa AI ini adalah draft skrining awal dan wajib ditinjau ulang oleh radiolog, bukan diagnosis final.</p>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  async function handlePrint(id: string) {
    setPrintingId(id);
    setError(null);
    try {
      await printPasienReport(id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal membuat PDF');
    } finally {
      setPrintingId(null);
    }
  }

  function buildKwitansiData(p: PasienRow): KwitansiReportData {
    return {
      logoSrc: pendaftaranLogoSrc,
      noKwitansi: p.regCode,
      tanggal: formatDateShort(p.createdAt),
      namaPasien: p.nama,
      umur: formatUmurDetail(p.tanggalLahir),
      alamat: p.alamat || '—',
      dokterPengirim: p.pengirim.nama,
      items: p.pemeriksaan.map((x) => ({ nama: x.nama, hargaFormatted: formatRupiah(x.harga) })),
      totalFormatted: formatRupiah(p.totalHarga),
      terbilang: terbilangRupiah(p.totalHarga),
      paymentStatus: p.paymentStatus,
      kasirNama: p.petugasKasir || '',
    };
  }

  async function handleDownloadKwitansi(p: PasienRow) {
    const blob = await pdf(<KwitansiReportDocument data={buildKwitansiData(p)} />).toBlob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Kwitansi_${p.regCode}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function onSubmitAdd(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!isValidBirthDate(tanggalLahir)) {
      setFormError('Format umur tidak dikenali. Gunakan mis. "32 tahun", "6 bulan", atau "10 hari".');
      return;
    }
    setSaving(true);
    try {
      const res = await apiPost<{ item: CetakALPasien }>('/api/pasien', {
        nama,
        tanggalLahir,
        noTelepon,
        alamat,
        pengirimId,
        klinis: serializeKlinisData(klinis, [], []),
        temuan: temuan || undefined,
        jenisPemeriksaanIds: selectedJenis,
        sharingAmount: Number(sharingAmount),
        harga: Number(hargaManual) || 0,
        radiologId: radiologId || undefined,
        admin: admin || undefined,
        foto: foto || undefined,
        kesan: kesan || undefined,
        tanggal: tanggalRegistrasi || undefined,
      });
      setSavedPasien(res.item);
      await reload({ resetPage: true });
      await loadSummary();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function onSubmitEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setFormError(null);
    if (!isValidBirthDate(tanggalLahir)) {
      setFormError('Format umur tidak dikenali. Gunakan mis. "32 tahun", "6 bulan", atau "10 hari".');
      return;
    }
    if (selectedJenis.length === 0) {
      setFormError('Pilih minimal satu jenis pemeriksaan');
      return;
    }
    setSaving(true);
    try {
      await apiPatch(`/api/pasien/${editingId}`, {
        nama,
        tanggalLahir,
        noTelepon,
        alamat,
        pengirimId,
        klinis: serializeKlinisData(
          klinis,
          existingTambahanRef.current.radTambahan,
          existingTambahanRef.current.labTambahan,
        ),
        temuan,
        hasilStatus,
        paymentStatus,
        sharingAmount: Number(sharingAmount),
        jenisPemeriksaanIds: selectedJenis,
        kesan,
        admin: admin || undefined,
        radiologId: radiologId || null,
        foto: foto || undefined,
      });
      setEditOpen(false);
      resetForm();
      await reload();
      await loadSummary();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Gagal menyimpan perubahan');
    } finally {
      setSaving(false);
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
      await loadSummary();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus');
    } finally {
      setDeleteLoading(false);
    }
  }

  function openBhpModal() {
    setBhpForm({
      tanggal: new Date().toISOString().split('T')[0]!,
      pemakaian: '',
      harga: '0',
      dev: '1000',
      fixer: '1000',
      film: '38000',
      amplopKertas: '1000',
      listrik: '2000',
      gajiKaryawan: '2500000',
      kertasCetak: '2000',
      amplop: '2000',
    });
    setBhpError(null);
    setBhpModalOpen(true);
  }

  async function handleBhpSubmit(e: FormEvent) {
    e.preventDefault();
    setSavingBhp(true);
    setBhpError(null);
    try {
      await apiPost('/api/bhp-radiologi', {
        tanggal: bhpForm.tanggal,
        pemakaian: bhpForm.pemakaian,
        harga: Number(bhpForm.harga) || 0,
        dev: Number(bhpForm.dev) || 0,
        fixer: Number(bhpForm.fixer) || 0,
        film: Number(bhpForm.film) || 0,
        amplopKertas: Number(bhpForm.amplopKertas) || 0,
        listrik: Number(bhpForm.listrik) || 0,
        gajiKaryawan: Number(bhpForm.gajiKaryawan) || 0,
        kertasCetak: Number(bhpForm.kertasCetak) || 0,
        amplop: Number(bhpForm.amplop) || 0,
      });
      setBhpModalOpen(false);
    } catch (err) {
      setBhpError(err instanceof Error ? err.message : 'Gagal menyimpan data BHP');
    } finally {
      setSavingBhp(false);
    }
  }

  function openAddJenisModal() {
    setEditingJenisItem(null);
    setEditingJenisNama('');
    setEditingJenisHarga('');
    setEditingJenisJumlahFilm('1');
    setJenisError(null);
    setJenisModalMode('add');
  }

  function openEditJenisModal(j: Jenis) {
    setEditingJenisItem(j);
    setEditingJenisNama(j.nama);
    setEditingJenisHarga(j.harga ?? '');
    setEditingJenisJumlahFilm(String(j.jumlahFilm));
    setJenisError(null);
    setJenisModalMode('edit');
  }

  async function onSubmitEditJenis(e: FormEvent) {
    e.preventDefault();
    if (!editingJenisNama.trim()) {
      setJenisError('Nama jenis pemeriksaan wajib diisi');
      return;
    }
    if (!editingJenisHarga.trim() || isNaN(Number(editingJenisHarga))) {
      setJenisError('Harga layanan wajib diisi dengan angka valid');
      return;
    }
    setSavingJenis(true);
    setJenisError(null);
    try {
      if (jenisModalMode === 'add') {
        await apiPost('/api/jenis-pemeriksaan', {
          nama: editingJenisNama.trim(),
          harga: Number(editingJenisHarga),
          jumlahFilm: Number(editingJenisJumlahFilm) || 1,
        });
      } else if (editingJenisItem) {
        await apiPatch(`/api/jenis-pemeriksaan/${editingJenisItem.id}`, {
          nama: editingJenisNama.trim(),
          harga: Number(editingJenisHarga),
          jumlahFilm: Number(editingJenisJumlahFilm) || 1,
        });
      }
      setJenisModalMode(null);
      await loadMasters();
    } catch (err: unknown) {
      setJenisError(err instanceof Error ? err.message : 'Gagal menyimpan jenis pemeriksaan');
    } finally {
      setSavingJenis(false);
    }
  }

  const selectedPilihanSharing = pilihanSharingList.find((o) => String(o.nominal) === sharingMode);
  // Nominal yang tidak ada lagi di daftar (mis. pilihannya sudah dihapus) ditampilkan sebagai Manual.
  const sharingSelectValue =
    sharingMode === 'auto' || sharingMode === 'custom' || selectedPilihanSharing ? sharingMode : 'custom';

  const jenisPemeriksaanField = (
    <div className="form-field form-grid--span-3" style={{ marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <label style={{ fontWeight: 600, color: '#0369a1' }}>
            Tabel Jenis Pemeriksaan, Harga & Sharing
          </label>
          {/* Tombol "+ Tambah" per baris tidak muncul saat daftar kosong, jadi sediakan juga di judul tabel. */}
          <button
            type="button"
            className="btn btn--xs btn--primary"
            onClick={openAddJenisModal}
            title="Tambah jenis pemeriksaan baru"
          >
            + Tambah Pemeriksaan
          </button>
        </div>
        <span style={{ fontWeight: 600, color: '#0f172a' }}>
          Total Bayar: <span style={{ color: '#0284c7' }}>{formatRupiah(estimate.totalHarga)}</span>
        </span>
      </div>
      <div
        style={{
          border: '1px solid #e0e7ff',
          borderRadius: '8px',
          overflow: 'hidden',
          background: '#ffffff',
          boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
        }}
      >
        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 0 }}>
          <thead style={{ background: '#f0f9ff', color: '#0369a1', borderBottom: '2px solid #bae6fd' }}>
            <tr>
              <th style={{ width: '70px', textAlign: 'center', padding: '10px' }}>Pilih</th>
              <th style={{ textAlign: 'left', padding: '10px' }}>Jenis Pemeriksaan</th>
              <th style={{ width: '80px', textAlign: 'center', padding: '10px' }}>Film</th>
              <th style={{ width: '150px', textAlign: 'right', padding: '10px' }}>Harga</th>
              <th style={{ width: '150px', textAlign: 'right', padding: '10px' }}>Sharing</th>
              <th style={{ width: '160px', textAlign: 'center', padding: '10px' }}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {jenis.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '1.5rem', color: '#64748b' }}>
                  Belum ada data jenis pemeriksaan.
                </td>
              </tr>
            ) : (
              jenis.map((j) => {
                const isChecked = selectedJenis.includes(j.id);
                const itemHarga = Number(j.harga ?? 0);
                const itemSharing = isChecked ? Number(sharingAmount) || 0 : 0;
                return (
                  <tr
                    key={j.id}
                    onClick={() => toggleJenis(j.id)}
                    style={{
                      cursor: 'pointer',
                      backgroundColor: isChecked ? '#eff6ff' : 'transparent',
                      transition: 'background-color 0.15s ease',
                      borderBottom: '1px solid #f1f5f9',
                    }}
                  >
                    <td style={{ textAlign: 'center', padding: '10px' }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleJenis(j.id)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                      />
                    </td>
                    <td style={{ padding: '10px', fontWeight: isChecked ? 600 : 400, color: '#1e293b' }}>
                      {j.nama}
                    </td>
                    <td style={{ textAlign: 'center', padding: '10px', fontWeight: isChecked ? 600 : 400, color: '#0f172a' }}>
                      {j.jumlahFilm}
                    </td>
                    <td style={{ textAlign: 'right', padding: '10px', fontWeight: isChecked ? 600 : 400, color: '#0f172a' }}>
                      {formatRupiah(itemHarga)}
                    </td>
                    <td style={{ textAlign: 'right', padding: '10px', fontWeight: isChecked ? 600 : 400, color: isChecked ? '#0284c7' : '#64748b' }}>
                      {isChecked
                        ? formatRupiah(itemSharing)
                        : `Otomatis (${formatRupiah(Number(computeAutoSharingAmount(selectedDokter?.nama, [j.nama], umurYears, selectedDokter?.defaultSharingAmount || '0')) || 0)})`}
                    </td>
                    <td style={{ textAlign: 'center', padding: '10px' }}>
                      <div style={{ display: 'inline-flex', gap: '0.35rem' }}>
                        <button
                          type="button"
                          className="btn btn--xs btn--secondary"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditJenisModal(j);
                          }}
                          style={{
                            padding: '0.25rem 0.55rem',
                            fontSize: '0.78rem',
                            borderRadius: '6px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            border: '1px solid var(--color-border)',
                            background: '#ffffff',
                            color: '#0f172a',
                            fontWeight: 500,
                          }}
                          title="Edit jenis pemeriksaan & harga"
                        >
                          ✎ Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--xs btn--primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            openAddJenisModal();
                          }}
                          style={{
                            padding: '0.25rem 0.55rem',
                            fontSize: '0.78rem',
                            borderRadius: '6px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            fontWeight: 600,
                          }}
                          title="Tambah jenis pemeriksaan baru"
                        >
                          + Tambah
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {selectedJenis.length > 0 ? (
            <tfoot style={{ background: '#f8fafc', fontWeight: 600, borderTop: '2px solid #cbd5e1' }}>
              <tr>
                <td colSpan={2} style={{ padding: '10px', textAlign: 'right', color: '#334155' }}>
                  Total Terpilih ({selectedJenis.length} pemeriksaan):
                </td>
                <td style={{ padding: '10px', textAlign: 'center', color: '#0f172a' }}>
                  {jenis
                    .filter((j) => selectedJenis.includes(j.id))
                    .reduce((sum, j) => sum + j.jumlahFilm, 0)}
                </td>
                <td style={{ padding: '10px', textAlign: 'right', color: '#0f172a' }}>
                  {formatRupiah(estimate.totalHarga)}
                </td>
                <td style={{ padding: '10px', textAlign: 'right', color: '#0284c7' }}>
                  {formatRupiah(estimate.totalSharing)}
                </td>
                <td style={{ padding: '10px' }}></td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );

  const financePreview =
    selectedJenis.length > 0 ? (
      <div className="form-field finance-preview">
        <span className="finance-preview__label">Perkiraan tagihan</span>
        <div className="finance-preview__row">
          <span>Total layanan</span>
          <strong>{formatRupiah(estimate.totalHarga)}</strong>
        </div>
        <div className="finance-preview__row">
          <span>Sharing</span>
          <strong>{formatRupiah(estimate.totalSharing)}</strong>
        </div>
      </div>
    ) : null;

  const umurPreview = useMemo(() => {
    if (!isValidBirthDate(tanggalLahir)) {
      return null;
    }
    return umurYears;
  }, [tanggalLahir, umurYears]);

  const patientFields = (
    <fieldset className="legacy-groupbox groupbox--abu-abu form-grid--span-3">
      <legend>Data Pasien</legend>
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.75rem 1.25rem' }}
      >
        <div className="form-field">
          <label htmlFor="nama">Nama</label>
          <input id="nama" required value={nama} onChange={(e) => setNama(e.target.value)} />
        </div>
        <div className="form-field">
          <label htmlFor="umur-edit-manual">Umur</label>
          <input
            id="umur-edit-manual"
            type="text"
            placeholder="mis. 32 tahun / 6 bulan / 10 hari"
            value={umurManual}
            onChange={(e) => handleUmurManualChange(e.target.value)}
          />
          <span className="form-hint">
            {umurPreview === null ? 'Atau pilih tanggal lahir' : `≈ ${formatUmurTahun(umurPreview)}`}
          </span>
        </div>
        <div className="form-field">
          <label htmlFor="telp">No telepon</label>
          <input id="telp" value={noTelepon} onChange={(e) => setNoTelepon(e.target.value)} />
        </div>
        <div className="form-field" style={{ gridColumn: '1' }}>
          <label htmlFor="alamat">Alamat</label>
          <input id="alamat" value={alamat} onChange={(e) => setAlamat(e.target.value)} />
        </div>
        <div className="form-field" style={{ gridColumn: '2' }}>
          <label htmlFor="sharing-select">Pilihan Nominal Sharing</label>
          <select
            id="sharing-select"
            value={sharingSelectValue}
            onChange={(e) => {
              const val = e.target.value;
              setSharingMode(val);
              if (val === 'auto') {
                setSharingAmount(autoSharingAmount);
              } else if (val !== 'custom') {
                setSharingAmount(val);
              }
            }}
          >
            <option value="auto">
              ⚡ Otomatis ({formatRupiah(Number(autoSharingAmount) || 0)} — Sesuai Rumus Dokter, Umur &amp; Pemeriksaan)
            </option>
            {pilihanSharingList.map((opt) => (
              <option key={opt.id} value={String(opt.nominal)}>
                {`${formatRupiah(opt.nominal)}${opt.keterangan ? ` — ${opt.keterangan}` : ''}`}
              </option>
            ))}
            <option value="custom">✎ Input Manual / Lainnya...</option>
          </select>
        </div>
        <div className="form-field" style={{ gridColumn: '3' }}>
          <label htmlFor="sharing">Nominal Sharing (Rp)</label>
          <input
            id="sharing"
            type="number"
            min="0"
            step="1"
            value={sharingAmount}
            onChange={(e) => {
              setSharingAmount(e.target.value);
              setSharingMode('custom');
            }}
          />
        </div>
        <div className="form-field" style={{ gridColumn: '4' }}>
          <span className="form-field__static-label">Total Bayar</span>
          <p className="form-field__static-value">{formatRupiah(estimate.totalHarga)}</p>
        </div>
      </div>
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: '0.75rem 1.25rem', marginTop: '0.75rem' }}
      >
        <div className="form-field">
          <label htmlFor="pengirim">Dokter pengirim</label>
          <select
            id="pengirim"
            required
            value={pengirimId}
            onChange={(e) => onPengirimChange(e.target.value, true)}
          >
            <option value="">Pilih dokter</option>
            {dokter.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nama}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="radiolog">Radiolog</label>
          <select id="radiolog" value={radiologId} onChange={(e) => setRadiologId(e.target.value)}>
            <option value="">Pilih radiolog</option>
            {radiologList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nama}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="admin">Admin Pendaftaran</label>
          <select id="admin" value={admin} onChange={(e) => setAdmin(e.target.value)}>
            <option value="">Pilih admin</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.nama}>
                {s.nama}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="hasil">Status hasil</label>
          <select
            id="hasil"
            value={hasilStatus}
            onChange={(e) => setHasilStatus(e.target.value as 'MENUNGGU_HASIL' | 'SELESAI')}
          >
            <option value="MENUNGGU_HASIL">Menunggu hasil</option>
            <option value="SELESAI">Selesai</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="bayar">Status pembayaran</label>
          <select
            id="bayar"
            value={paymentStatus}
            onChange={(e) => setPaymentStatus(e.target.value as 'BELUM_LUNAS' | 'LUNAS')}
          >
            <option value="BELUM_LUNAS">Belum lunas</option>
            <option value="LUNAS">Lunas</option>
          </select>
        </div>
      </div>
    </fieldset>
  );

  const klinisField = (
    <div className="form-field" style={{ gridColumn: '1' }}>
      <label htmlFor="klinis">Klinis</label>
      <textarea
        id="klinis"
        rows={2}
        value={klinis}
        onChange={(e) => setKlinis(clampClinicalInput(e.target.value))}
      />
    </div>
  );

  const temuanField = (
    <div className="form-field" style={{ gridColumn: '1' }}>
      <label htmlFor="temuan">Temuan</label>
      <textarea
        id="temuan"
        rows={2}
        value={temuan}
        onChange={(e) => setTemuan(clampClinicalInput(e.target.value))}
        placeholder="Temuan radiologi (tampil di Cetak Terbaru)..."
      />
    </div>
  );

  const kesanField = (
    <div className="form-field form-grid--span-2">
      <label htmlFor="kesan">Kesan</label>
      <textarea
        id="kesan"
        rows={3}
        value={kesan}
        onChange={(e) => setKesan(clampClinicalInput(e.target.value))}
        placeholder="Isi kesan radiologi..."
      />
    </div>
  );

  const displayError = error ?? mastersError;

  const metrics = summary
    ? [
        {
          label: 'Total pasien',
          value: String(summary.totalPasien),
          tone: 'blue' as const,
          iconKind: 'users' as const,
        },
        {
          label: 'Menunggu hasil',
          value: String(summary.menungguHasil),
          tone: 'amber' as const,
          iconKind: 'clock' as const,
        },
        {
          label: 'Selesai',
          value: String(summary.selesai),
          tone: 'green' as const,
          iconKind: 'check' as const,
        },
        {
          label: 'Omzet',
          value: formatRupiah(summary.totalOmzet),
          tone: 'slate' as const,
          iconKind: 'currency' as const,
        },
        {
          label: 'Komisi',
          value: formatRupiah(summary.totalSharing),
          tone: 'violet' as const,
          iconKind: 'percent' as const,
        },
      ]
    : undefined;

  return (
    <>
      <ListPageShell
        title="Manajemen Pasien"
        subtitle="Registrasi, status hasil, dan pembayaran pasien radiologi"
        action={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button type="button" className="aifoto-analyze-btn" onClick={openAiFotoModal} style={{ padding: '0.5rem 0.9rem', fontSize: '0.8rem' }}>
              ✨ AI Foto
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setTabelAiOpen(true)}
              style={{ border: '1px solid var(--color-border)' }}
              title="Arsip hasil analisa AI yang sudah disimpan"
            >
              🗂️ Tabel AI
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={openAiBanding2Modal}
              style={{ border: '1px solid var(--color-border)' }}
              title="Analisa TB X-Ray dengan AI (pilih model version)"
            >
              🩻 AI Banding 2
            </button>
            <button
              type="button"
              className={`btn btn--sm ${timeFilter === 'today' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => {
                setTimeFilter(timeFilter === 'today' ? 'all' : 'today');
                setPage(1);
              }}
              style={timeFilter !== 'today' ? { border: '1px solid var(--color-border)' } : {}}
            >
              📅 Hari Ini
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={openBhpModal}
              style={{ border: '1px solid var(--color-border)' }}
            >
              + Tambah BHP
            </button>
            <button
              type="button"
              className={`btn btn--sm ${timeFilter === 'week' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => {
                setTimeFilter(timeFilter === 'week' ? 'all' : 'week');
                setPage(1);
              }}
              style={timeFilter !== 'week' ? { border: '1px solid var(--color-border)' } : {}}
            >
              📅 7 Hari Terakhir
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                resetForm();
                setAddOpen(true);
              }}
            >
              + Registrasi Radiologi
            </button>
          </div>
        }
        metrics={metrics}
        tabs={HASIL_TABS.map((t) => ({ id: t.id, label: t.label }))}
        activeTab={hasilTab}
        onTabChange={setHasilTab}
        selects={[
          {
            id: 'filter-bayar',
            label: 'Pembayaran',
            value: paymentFilter,
            placeholder: 'Semua',
            options: [
              { value: 'BELUM_LUNAS', label: 'Belum lunas' },
              { value: 'LUNAS', label: 'Lunas' },
            ],
            onChange: setPaymentFilter,
          },
          {
            id: 'filter-dokter',
            label: 'Dokter pengirim',
            value: dokterFilter,
            placeholder: 'Semua dokter',
            options: dokter.map((d) => ({ value: d.id, label: d.nama })),
            onChange: setDokterFilter,
          },
        ]}
        searchPlaceholder="Cari nama, no. reg, telepon…"
        searchValue={search}
        onSearchChange={setSearch}
        onRefresh={() => void reload()}
        error={displayError}
        loading={loading}
        pagination={pagination}
        onPageChange={setPage}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>Foto</th>
              <th>Nama</th>
              <th>Umur</th>
              <th>Pengirim</th>
              <th>Pemeriksaan</th>
              <th>Hasil</th>
              <th>Bayar</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={8}>Belum ada pasien.</td>
              </tr>
            ) : (
              items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.foto ? (
                      <img
                        src={p.foto}
                        alt={`Foto ${p.nama}`}
                        className={`pasien-foto-thumb${zoomedFotoId === p.id ? ' pasien-foto-thumb--zoomed' : ''}`}
                        onDoubleClick={() => setZoomedFotoId((current) => (current === p.id ? null : p.id))}
                        title="Klik 2 kali untuk perbesar/perkecil"
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{p.nama}</td>
                  <td>{formatUmurDetail(p.tanggalLahir)}</td>
                  <td>{p.pengirim.nama}</td>
                  <td>
                    <div>{p.pemeriksaan.map((x) => x.nama).join(', ')}</div>
                    {(() => {
                      const parsed = parseKlinisData(p.klinis);
                      const parts: string[] = [];
                      if (parsed.radTambahan.length > 0)
                        parts.push(`+ Rad: ${parsed.radTambahan.join(', ')}`);
                      if (parsed.labTambahan.length > 0)
                        parts.push(`+ Lab: ${parsed.labTambahan.join(', ')}`);
                      return parts.length > 0 ? (
                        <div
                          style={{
                            fontSize: '0.78rem',
                            color: 'var(--color-primary)',
                            marginTop: '0.15rem',
                          }}
                        >
                          {parts.join(' | ')}
                        </div>
                      ) : null;
                    })()}
                  </td>
                  <td>
                    <span
                      className={`badge ${p.hasilStatus === 'SELESAI' ? 'badge--ok' : 'badge--pending'}`}
                    >
                      {p.hasilStatus === 'SELESAI' ? 'Selesai' : 'Menunggu'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${p.paymentStatus === 'LUNAS' ? 'badge--ok' : 'badge--unpaid'}`}
                    >
                      {p.paymentStatus === 'LUNAS' ? 'Lunas' : 'Belum'}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <button
                        type="button"
                        className="btn btn--xs btn--ghost"
                        onClick={() => void openQuickEdit(p.id)}
                        title="Edit cepat: nama & kesan"
                        style={{ border: '1px solid var(--color-border)' }}
                      >
                        Edit²
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs btn--ghost"
                        onClick={() => openFotoEdit(p)}
                        title="Edit foto pasien (12 cm x 12 cm)"
                        style={{ border: '1px solid var(--color-border)' }}
                      >
                        Edit³
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs btn--ghost"
                        onClick={() => openKesan(p)}
                        title="Lihat & Edit Kesan Radiologi"
                        style={{ border: '1px solid var(--color-border)' }}
                      >
                        📝 Kesan
                      </button>
                      <TableRowActions
                        onPrint={() => void handlePrint(p.id)}
                        onEdit={() => void openEdit(p.id)}
                        onDelete={() => setDeleteTarget({ id: p.id, label: p.nama })}
                        printLabel={
                          printingId === p.id ? 'Membuat PDF…' : 'Cetak hasil radiologi'
                        }
                      />
                      <button
                        type="button"
                        className="btn btn--xs btn--ghost"
                        onClick={() => setKwitansiItem(p)}
                        title="Kwitansi"
                        style={{ border: '1px solid var(--color-border)' }}
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
      </ListPageShell>

      <Modal
        open={addOpen}
        title="Registrasi Radiologi Baru"
        onClose={() => setAddOpen(false)}
        size="xl"
        // Hanya modal ini yang bertema biru muda; halamannya tetap memakai tema umum.
        className="radiolog-lightblue-scope"
      >
        <form onSubmit={(e) => void onSubmitAdd(e)} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <fieldset className="legacy-groupbox">
            <legend>Data Registrasi Radiologi</legend>
            <div className="legacy-form-layout" onKeyDown={handleFormFieldNavKeyDown}>
              <div className="legacy-form-fields">
                <div className="legacy-form-row">
                  <label htmlFor="reg-no">No Registrasi</label>
                  <input id="reg-no" type="text" value="Otomatis sistem" disabled />
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="nama">Nama Pasien</label>
                  <input id="nama" required value={nama} onChange={(e) => setNama(e.target.value)} />
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="umur-manual">Umur</label>
                  <input
                    id="umur-manual"
                    type="text"
                    required
                    placeholder="mis. 32 tahun / 6 bulan / 10 hari"
                    value={umurManual}
                    onChange={(e) => handleUmurManualChange(e.target.value)}
                  />
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="reg-alamat">Alamat</label>
                  <input id="reg-alamat" value={alamat} onChange={(e) => setAlamat(e.target.value)} />
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="pemeriksaan-select">Pemeriksaan</label>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <select
                      id="pemeriksaan-select"
                      value={selectedJenis[0] ?? ''}
                      style={{ flex: '1 1 auto' }}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedJenis(val ? [val] : []);
                        const selected = jenis.find((j) => j.id === val);
                        const hargaValue = selected?.harga ?? '0';
                        setHargaManual(hargaValue);
                        setHargaMode(hargaValue);
                      }}
                    >
                      <option value="">Pilih pemeriksaan</option>
                      {jenis.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.nama}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn--xs btn--primary"
                      style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
                      onClick={openAddJenisModal}
                      title="Tambah jenis pemeriksaan & harga baru"
                    >
                      + Tambah
                    </button>
                  </div>
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="reg-tanggal">Tanggal</label>
                  <input
                    id="reg-tanggal"
                    type="date"
                    required
                    value={tanggalRegistrasi}
                    onChange={(e) => setTanggalRegistrasi(e.target.value)}
                  />
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="reg-pengirim">Pengirim</label>
                  <select
                    id="reg-pengirim"
                    required
                    value={pengirimId}
                    onChange={(e) => setPengirimId(e.target.value)}
                  >
                    <option value="">Pilih dokter pengirim</option>
                    {dokter.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.nama}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="legacy-form-row" style={{ alignItems: 'flex-start' }}>
                  <label htmlFor="reg-klinis" style={{ paddingTop: '0.4rem' }}>Klinis</label>
                  <textarea
                    id="reg-klinis"
                    rows={2}
                    value={klinis}
                    onChange={(e) => setKlinis(clampClinicalInput(e.target.value))}
                    placeholder="Keterangan klinis..."
                  />
                </div>
                <div className="legacy-form-row" style={{ alignItems: 'flex-start' }}>
                  <label htmlFor="reg-temuan" style={{ paddingTop: '0.4rem' }}>Temuan</label>
                  <textarea
                    id="reg-temuan"
                    rows={2}
                    value={temuan}
                    onChange={(e) => setTemuan(clampClinicalInput(e.target.value))}
                    placeholder="Temuan radiologi (tampil di Cetak Terbaru)..."
                  />
                </div>
              </div>

              <div className="legacy-form-fields">
                <div className="legacy-form-row">
                  <label htmlFor="radiolog">Radiolog</label>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <select
                      id="radiolog"
                      value={radiologId}
                      style={{ flex: '1 1 auto' }}
                      onChange={(e) => setRadiologId(e.target.value)}
                    >
                      <option value="">Pilih radiolog</option>
                      {radiologList.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.nama}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={MASTER_ACTION_BUTTON_STYLE}
                      onClick={() => openRadiologForm('add')}
                      title="Tambah radiolog"
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={MASTER_ACTION_BUTTON_STYLE}
                      disabled={!radiologId}
                      onClick={() => openRadiologForm('edit')}
                      title="Edit radiolog yang dipilih"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={MASTER_ACTION_BUTTON_STYLE}
                      disabled={!radiologId}
                      onClick={() => {
                        const target = radiologList.find((r) => r.id === radiologId);
                        if (target) setRadiologDeleteTarget(target);
                      }}
                      title="Hapus radiolog yang dipilih"
                    >
                      🗑
                    </button>
                  </div>
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="harga">Harga</label>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <select
                      id="harga-select"
                      value={hargaMode}
                      style={{ flex: '1 1 auto' }}
                      title="Pilihan harga radiologi"
                      onChange={(e) => {
                        const val = e.target.value;
                        setHargaMode(val);
                        if (val !== 'custom') setHargaManual(val);
                      }}
                    >
                      <option value="custom">✎ Manual</option>
                      {jenis.map((j) => (
                        <option key={j.id} value={j.harga ?? '0'}>
                          {j.nama} — {formatRupiah(j.harga ?? 0)}
                        </option>
                      ))}
                    </select>
                    <input
                      id="harga"
                      type="number"
                      min="0"
                      step="1"
                      style={{ flex: '0 0 110px' }}
                      value={hargaManual}
                      onChange={(e) => {
                        setHargaManual(e.target.value);
                        setHargaMode('custom');
                      }}
                    />
                  </div>
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="sharing">Sharing</label>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <select
                      id="sharing-select"
                      value={sharingSelectValue}
                      style={{ flex: '0 0 auto', width: '2.4rem' }}
                      title="Pilihan nominal sharing"
                      onChange={(e) => {
                        const val = e.target.value;
                        setSharingMode(val);
                        if (val === 'auto') {
                          setSharingAmount(autoSharingAmount);
                        } else if (val !== 'custom') {
                          setSharingAmount(val);
                        }
                      }}
                    >
                      <option value="auto">⚡</option>
                      {pilihanSharingList.map((opt) => (
                        <option key={opt.id} value={String(opt.nominal)} title={opt.keterangan ?? undefined}>
                          {formatSharingShort(opt.nominal)}
                        </option>
                      ))}
                      <option value="custom">✎</option>
                    </select>
                    <input
                      id="sharing"
                      type="number"
                      min="0"
                      step="1"
                      value={sharingAmount}
                      onChange={(e) => {
                        setSharingAmount(e.target.value);
                        setSharingMode('custom');
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={MASTER_ACTION_BUTTON_STYLE}
                      onClick={() => openSharingOptionForm('add')}
                      title="Tambah pilihan sharing"
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={MASTER_ACTION_BUTTON_STYLE}
                      disabled={!selectedPilihanSharing}
                      onClick={() => openSharingOptionForm('edit')}
                      title="Edit pilihan sharing yang dipilih"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={MASTER_ACTION_BUTTON_STYLE}
                      disabled={!selectedPilihanSharing}
                      onClick={() => {
                        if (selectedPilihanSharing) setSharingOptionDeleteTarget(selectedPilihanSharing);
                      }}
                      title="Hapus pilihan sharing yang dipilih"
                    >
                      🗑
                    </button>
                  </div>
                </div>
                <div className="legacy-form-row">
                  <label htmlFor="reg-total-sharing">Total Sharing</label>
                  {/* Server menyimpan sharing FIXED, jadi total sharing registrasi = nominal sharing. */}
                  <input
                    id="reg-total-sharing"
                    type="text"
                    readOnly
                    value={formatRupiah(Number(sharingAmount) || 0)}
                    style={{ fontWeight: 700 }}
                  />
                </div>
                <div className="legacy-form-row" style={{ alignItems: 'flex-start' }}>
                  <label htmlFor="kesan" style={{ paddingTop: '0.4rem' }}>Kesan</label>
                  <textarea
                    id="kesan"
                    rows={3}
                    value={kesan}
                    onChange={(e) => setKesan(clampClinicalInput(e.target.value))}
                    placeholder="Isi kesan radiologi..."
                  />
                </div>
              </div>

              {formError && <div className="alert alert--error">{formError}</div>}

              <div className="legacy-button-rail">
                <button type="submit" className="btn btn--primary" disabled={saving || savedPasien !== null}>
                  {saving ? 'Menyimpan…' : savedPasien ? 'Tersimpan ✓' : 'Simpan'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!savedPasien}
                  onClick={() => {
                    if (!savedPasien) return;
                    setAddOpen(false);
                    void openEdit(savedPasien.id);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!savedPasien}
                  onClick={() => savedPasien && void handlePrint(savedPasien.id)}
                >
                  Cetak Hasil
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!savedPasien}
                  onClick={() => setCetakAL({ open: true, mode: 'amplop' })}
                >
                  Cetak Amplop
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!savedPasien}
                  onClick={() => setCetakAL({ open: true, mode: 'label' })}
                >
                  Cetak Label
                </button>
              </div>
            </div>

            <div style={{ marginTop: '1.25rem' }}>
              <label style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--color-text-body)' }}>
                Ambil Data Dari Pendaftaran Umum
              </label>
              <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
                <table className="data-table" style={{ marginBottom: 0 }}>
                  <thead>
                    <tr>
                      <th>Pilih</th>
                      <th>Foto</th>
                      <th>No Registrasi</th>
                      <th>Nama</th>
                      <th>Umur</th>
                      <th>Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendaftaranList.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: 'center', padding: '1rem' }}>
                          Belum ada data pendaftaran umum.
                        </td>
                      </tr>
                    ) : (
                      pendaftaranList.map((p) => (
                        <tr
                          key={p.id}
                          onClick={() => handlePendaftaranSelect(p.id)}
                          style={{
                            cursor: 'pointer',
                            backgroundColor: selectedPendaftaranId === p.id ? 'var(--color-primary-soft)' : 'transparent',
                          }}
                        >
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="radio"
                              name="pilih-pendaftaran"
                              checked={selectedPendaftaranId === p.id}
                              onChange={() => handlePendaftaranSelect(p.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td>
                            {/* Klik pada foto/tombol unggah tidak ikut memilih baris, supaya
                                memperbesar atau mengunggah foto tidak langsung mengisi form registrasi. */}
                            <div
                              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {p.foto ? (
                                <img
                                  src={p.foto}
                                  alt={`Foto ${p.namaPasien}`}
                                  className={`pasien-foto-thumb${zoomedFotoId === p.id ? ' pasien-foto-thumb--zoomed' : ''}`}
                                  onDoubleClick={() => setZoomedFotoId((current) => (current === p.id ? null : p.id))}
                                  title="Klik 2 kali untuk perbesar/perkecil"
                                />
                              ) : (
                                '—'
                              )}
                              <label
                                className="btn btn--xs btn--ghost"
                                style={{
                                  border: '1px solid var(--color-border)',
                                  whiteSpace: 'nowrap',
                                  cursor: fotoUploadingId !== null ? 'wait' : 'pointer',
                                }}
                                title="Unggah foto (JPEG, PNG, GIF, atau WEBP, maks. 10 MB)"
                              >
                                {fotoUploadingId === p.id ? 'Mengunggah…' : p.foto ? '📤 Ganti foto' : '📤 Unggah foto'}
                                <input
                                  type="file"
                                  accept="image/jpeg,image/png,image/gif,image/webp"
                                  disabled={fotoUploadingId !== null}
                                  onChange={(e) => void handleUploadPendaftaranFoto(p, e)}
                                  style={{ display: 'none' }}
                                />
                              </label>
                            </div>
                          </td>
                          <td>{p.noRegistrasi}</td>
                          <td>{p.namaPasien}</td>
                          <td>{p.umur || '-'}</td>
                          <td>
                            <div onClick={(e) => e.stopPropagation()}>
                              <TableRowActions
                                onEdit={() => openEditPendaftaran(p)}
                                onDelete={() => setPendaftaranDeleting(p)}
                                onPrint={() => setPendaftaranPreview(p)}
                                editLabel="Ubah pendaftaran"
                                deleteLabel="Hapus pendaftaran"
                                printLabel="Cetak pendaftaran"
                              />
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </fieldset>
        </form>
      </Modal>

      <Modal
        open={pendaftaranEditing !== null}
        title="Ubah Pendaftaran Umum"
        onClose={() => setPendaftaranEditing(null)}
      >
        <form onSubmit={(e) => void submitEditPendaftaran(e)} className="form-grid">
          <div className="form-field form-field--full">
            <label htmlFor="pu-nama">Nama *</label>
            <input
              id="pu-nama"
              required
              value={pendaftaranForm.namaPasien}
              onChange={(e) => setPendaftaranForm((prev) => ({ ...prev, namaPasien: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="pu-umur">Umur</label>
            <input
              id="pu-umur"
              placeholder="mis. 32 tahun / 6 bulan / 10 hari"
              value={pendaftaranForm.umur}
              onChange={(e) => setPendaftaranForm((prev) => ({ ...prev, umur: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="pu-telpon">Telpon</label>
            <input
              id="pu-telpon"
              value={pendaftaranForm.telpon}
              onChange={(e) => setPendaftaranForm((prev) => ({ ...prev, telpon: e.target.value }))}
            />
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="pu-alamat">Alamat</label>
            <input
              id="pu-alamat"
              value={pendaftaranForm.alamat}
              onChange={(e) => setPendaftaranForm((prev) => ({ ...prev, alamat: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="pu-dokter">Dokter Pengirim</label>
            <select
              id="pu-dokter"
              value={pendaftaranForm.dokterPengirim}
              onChange={(e) => setPendaftaranForm((prev) => ({ ...prev, dokterPengirim: e.target.value }))}
            >
              <option value="">-- Pilih Dokter --</option>
              {dokter.map((d) => (
                <option key={d.id} value={d.nama}>
                  {d.nama}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="pu-admin">Admin</label>
            <select
              id="pu-admin"
              value={pendaftaranForm.admin}
              onChange={(e) => setPendaftaranForm((prev) => ({ ...prev, admin: e.target.value }))}
            >
              <option value="">-- Pilih Admin --</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.nama}>
                  {s.nama}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field form-field--full">
            <label htmlFor="pu-foto">Foto</label>
            {pendaftaranFotoError && <div className="alert alert--error">{pendaftaranFotoError}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {pendaftaranForm.foto ? (
                <img
                  src={pendaftaranForm.foto}
                  alt={`Foto ${pendaftaranForm.namaPasien}`}
                  className={`pasien-foto-thumb${zoomedFotoId === EDIT_PENDAFTARAN_FOTO_ZOOM_ID ? ' pasien-foto-thumb--zoomed' : ''}`}
                  onDoubleClick={() =>
                    setZoomedFotoId((current) =>
                      current === EDIT_PENDAFTARAN_FOTO_ZOOM_ID ? null : EDIT_PENDAFTARAN_FOTO_ZOOM_ID,
                    )
                  }
                  title="Klik 2 kali untuk perbesar/perkecil"
                />
              ) : (
                <span>Belum ada foto</span>
              )}
              <label
                htmlFor="pu-foto"
                className="btn btn--xs btn--ghost"
                style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap', cursor: 'pointer' }}
                title="Pilih foto (JPEG, PNG, GIF, atau WEBP, maks. 10 MB)"
              >
                {pendaftaranForm.foto ? '📤 Ganti foto' : '📤 Pilih foto'}
              </label>
              <input
                id="pu-foto"
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={(e) => void handleEditPendaftaranFotoChange(e)}
                style={{ display: 'none' }}
              />
              {pendaftaranForm.foto && (
                <button
                  type="button"
                  className="btn btn--xs btn--ghost"
                  style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
                  onClick={() => setPendaftaranForm((prev) => ({ ...prev, foto: '' }))}
                >
                  🗑 Hapus foto
                </button>
              )}
            </div>
          </div>
          <ModalFormFooter
            onCancel={() => setPendaftaranEditing(null)}
            submitLabel="Simpan Perubahan"
            loading={pendaftaranSubmitting}
          />
        </form>
      </Modal>

      <ConfirmModal
        open={pendaftaranDeleting !== null}
        title="Hapus Pendaftaran"
        message={`Apakah Anda yakin ingin menghapus pendaftaran "${pendaftaranDeleting?.namaPasien ?? ''}"?`}
        confirmLabel="Hapus"
        onConfirm={() => void confirmDeletePendaftaran()}
        onClose={() => setPendaftaranDeleting(null)}
        loading={pendaftaranSubmitting}
      />

      {pendaftaranPreview && (
        <Modal
          title={`Preview Cetak — ${pendaftaranPreview.noRegistrasi}`}
          open={true}
          onClose={() => setPendaftaranPreview(null)}
          size="xl"
        >
          <div style={{ width: '100%', height: 'calc(100vh - 12rem)', minHeight: '600px' }}>
            <PDFViewer width="100%" height="100%" className="pdf-viewer">
              <PendaftaranReportDocument
                data={{
                  noRegistrasi: pendaftaranPreview.noRegistrasi,
                  namaPasien: pendaftaranPreview.namaPasien,
                  umur: pendaftaranPreview.umur || '',
                  alamat: pendaftaranPreview.alamat || '',
                  telpon: pendaftaranPreview.telpon || '',
                  tanggalMasuk: new Date(pendaftaranPreview.tanggalMasuk).toLocaleDateString('id-ID'),
                  dokterPengirim: pendaftaranPreview.dokterPengirim || '',
                  klinis: pendaftaranPreview.klinis || '',
                  admin: pendaftaranPreview.admin || '',
                  logoSrc: pendaftaranLogoSrc,
                }}
              />
            </PDFViewer>
          </div>
        </Modal>
      )}

      <CetakALModal
        open={cetakAL.open}
        initialMode={cetakAL.mode}
        pasien={savedPasien}
        onClose={() => setCetakAL((prev) => ({ ...prev, open: false }))}
      />

      <Modal open={editOpen} title="Ubah Data Pasien" onClose={() => setEditOpen(false)} size="xl">
        <form onSubmit={(e) => void onSubmitEdit(e)} className="form-grid form-grid--wide">
          {patientFields}
          {klinisField}
          {temuanField}
          {kesanField}
          {jenisPemeriksaanField}
          {formError && <div className="alert alert--error form-grid--full">{formError}</div>}
          <div
            className="form-grid--span-3"
            style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}
          >
            {financePreview}
            <div style={{ marginLeft: 'auto' }}>
              <ModalFormFooter
                onCancel={() => setEditOpen(false)}
                submitLabel="Simpan perubahan"
                loading={saving}
              />
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        open={deleteTarget !== null}
        title="Hapus pasien"
        message={`Yakin hapus "${deleteTarget?.label ?? ''}"? Tindakan ini tidak bisa dibatalkan.`}
        loading={deleteLoading}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
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
        open={kesanItem !== null}
        title={kesanItem ? `Kesan Radiologi — ${kesanItem.nama} (${kesanItem.regCode})` : 'Kesan Radiologi'}
        onClose={() => setKesanItem(null)}
        size="md"
      >
        {kesanItem && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {kesanError && <div className="alert alert--error">{kesanError}</div>}
            <div className="form-field">
              <label htmlFor="kesan-item-textarea">Kesan & Saran Radiologi</label>
              <textarea
                id="kesan-item-textarea"
                value={kesanEditText}
                onChange={(e) => setKesanEditText(clampClinicalInput(e.target.value))}
                placeholder="Isi kesan radiologi..."
                rows={6}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button type="button" className="btn btn--ghost" onClick={() => setKesanItem(null)}>
                Batal
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void submitKesan()}
                disabled={kesanSaving}
              >
                {kesanSaving ? 'Menyimpan…' : '💾 Simpan'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={quickEditOpen}
        title="Edit Cepat: Nama & Kesan"
        onClose={() => setQuickEditOpen(false)}
        size="xl"
        headerColor="orange"
      >
        <form onSubmit={(e) => void submitQuickEdit(e)} className="form-grid">
          {quickEditError && (
            <div className="alert alert--error form-grid--full">{quickEditError}</div>
          )}

          <div className="form-field form-grid--full">
            <KesanRegioPicker
              onSelect={(teks) =>
                setQuickEditKesan((prev) => clampClinicalInput(prev ? prev + '\n\n' + teks : teks))
              }
            />
          </div>

          <div className="form-field">
            <label htmlFor="qe-nama">Nama pasien</label>
            <input
              id="qe-nama"
              required
              value={quickEditNama}
              onChange={(e) => setQuickEditNama(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="qe-pemeriksaan">Pemeriksaan</label>
            <input id="qe-pemeriksaan" value={quickEditPemeriksaan} disabled />
          </div>
          <div className="form-field form-grid--full">
            <label htmlFor="qe-kesan">Kesan</label>
            <textarea
              id="qe-kesan"
              rows={4}
              value={quickEditKesan}
              onChange={(e) => setQuickEditKesan(clampClinicalInput(e.target.value))}
              placeholder="Isi kesan radiologi..."
            />
          </div>
          <ModalFormFooter
            onCancel={() => setQuickEditOpen(false)}
            submitLabel="Simpan"
            loading={quickEditSaving}
          />
        </form>
      </Modal>

      <Modal
        open={fotoEditTarget !== null}
        title={`Edit³: Foto Pasien${fotoEditTarget ? ` — ${fotoEditTarget.nama}` : ''}`}
        onClose={() => setFotoEditTarget(null)}
        size="xl"
        headerColor="orange"
      >
        <form onSubmit={(e) => void submitFotoEdit(e)} className="form-grid">
          {fotoEditError && <div className="alert alert--error form-grid--full">{fotoEditError}</div>}
          <div
            className="form-grid--full"
            style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-start' }}
          >
            <div className="form-field">
              <label htmlFor="fe-foto">Foto (12 cm x 12 cm)</label>
              {fotoEditFoto ? (
                <img
                  src={fotoEditFoto}
                  alt={`Foto ${fotoEditTarget?.nama ?? 'pasien'}`}
                  className="pasien-foto-12cm"
                />
              ) : (
                <div className="pasien-foto-12cm">Belum ada foto</div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                <label
                  htmlFor="fe-foto"
                  className="btn btn--xs btn--ghost"
                  style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  title="Pilih foto (JPEG, PNG, GIF, atau WEBP, maks. 10 MB)"
                >
                  {fotoEditFoto ? '📤 Ganti foto' : '📤 Pilih foto'}
                </label>
                <input
                  id="fe-foto"
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  // Dinonaktifkan selama analisa supaya hasil AI tidak tertempel ke foto yang berbeda.
                  disabled={fotoEditAnalyzing !== null}
                  onChange={(e) => void handleFotoEditFileChange(e)}
                  style={{ display: 'none' }}
                />
                {fotoEditFoto && (
                  <>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
                      disabled={fotoEditAnalyzing !== null}
                      onClick={() => {
                        setFotoEditFoto('');
                        setFotoEditAnalisa('');
                      }}
                    >
                      🗑 Hapus foto
                    </button>
                    <button
                      type="button"
                      className="aifoto-analyze-btn"
                      style={{ padding: '0.35rem 0.8rem', fontSize: '0.78rem' }}
                      disabled={fotoEditAnalyzing !== null}
                      onClick={() => void handleFotoEditAnalyze()}
                    >
                      {fotoEditAnalyzing === 'ai' ? '⏳ Menganalisa…' : '✨ Analisa AI'}
                    </button>
                    <select
                      aria-label="Model AI Banding 2"
                      value={fotoEditTbModel}
                      disabled={fotoEditAnalyzing !== null}
                      onChange={(e) => setFotoEditTbModel(e.target.value)}
                      style={{ fontSize: '0.78rem', padding: '0.3rem' }}
                    >
                      <option value="">Model AI Banding 2</option>
                      {AI_BANDING2_MODEL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
                      disabled={fotoEditAnalyzing !== null || !fotoEditTbModel}
                      onClick={() => void handleFotoEditAiBanding2()}
                      title="Analisa TB X-Ray dengan AI (pilih model terlebih dahulu)"
                    >
                      {fotoEditAnalyzing === 'banding2' ? '⏳ Menganalisa…' : '🩻 AI Banding 2'}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="form-field" style={{ flex: '1 1 260px', minWidth: 0 }}>
              <label htmlFor="fe-analisa">Analisa</label>
              <textarea
                id="fe-analisa"
                readOnly
                value={fotoEditAnalisa}
                placeholder={fotoEditFoto ? 'Klik "✨ Analisa AI" untuk menganalisa foto.' : 'Pilih foto terlebih dahulu.'}
                style={{ minHeight: '12cm', resize: 'vertical' }}
              />
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn--xs btn--ghost"
                  style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
                  disabled={!fotoEditAnalisa}
                  onClick={() => void handleCopyFotoEditAnalisa()}
                  title="Salin hasil analisa ke clipboard"
                >
                  {fotoEditAnalisaCopied ? '✓ Tersalin' : '📋 Salin'}
                </button>
                <button
                  type="button"
                  className="btn btn--xs btn--ghost"
                  style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }}
                  disabled={!fotoEditAnalisa || fotoEditAnalyzing !== null}
                  onClick={() => {
                    setFotoEditAnalisa('');
                    setFotoEditAnalisaCopied(false);
                  }}
                  title="Kosongkan kolom analisa"
                >
                  🗑 Hapus analisa
                </button>
              </div>
              <span className="form-hint">
                Draft AI — wajib ditinjau radiolog/dokter. Simpan ke arsip di bawah bila ingin
                disimpan.
              </span>
            </div>
          </div>

          {fotoEditTarget && (
            <FotoAnalisaTabel
              pasienId={fotoEditTarget.id}
              namaPasien={fotoEditTarget.nama}
              fotoSaatIni={fotoEditFoto}
              analisaSaatIni={fotoEditAnalisa}
              onMuat={(foto, analisa) => {
                setFotoEditFoto(foto);
                setFotoEditAnalisa(analisa);
              }}
            />
          )}

          <ModalFormFooter
            onCancel={() => setFotoEditTarget(null)}
            submitLabel="Simpan"
            loading={fotoEditSaving}
          />
        </form>
      </Modal>

      <TabelAiModal open={tabelAiOpen} onClose={() => setTabelAiOpen(false)} />

      <Modal open={aiFotoOpen} title="✨ AI Foto — Analisa & Isi Kesan Otomatis" onClose={() => setAiFotoOpen(false)} size="xl">
        <div className="form-grid">
          {aiFotoError && <div className="alert alert--error form-grid--full">{aiFotoError}</div>}

          <div className="form-field form-grid--full">
            <label htmlFor="pasien-ai-foto">Foto</label>
            {!aiFotoDataUrl ? (
              <label htmlFor="pasien-ai-foto" className="aifoto-upload" style={{ cursor: 'pointer' }}>
                <span className="aifoto-upload__icon">📤</span>
                <strong>Klik untuk unggah foto</strong>
                <p className="aifoto-upload__hint">JPEG, PNG, GIF, atau WEBP</p>
              </label>
            ) : (
              <div className="aifoto-preview">
                <img src={aiFotoDataUrl} alt="Preview foto" />
              </div>
            )}
            <input
              id="pasien-ai-foto"
              type="file"
              accept="image/*"
              onChange={handleAiFotoFileChange}
              style={aiFotoDataUrl ? { marginTop: '0.5rem' } : { display: 'none' }}
            />
          </div>

          <div className="form-field form-grid--full">
            <button
              type="button"
              className="aifoto-analyze-btn"
              disabled={aiFotoAnalyzing || !aiFotoDataUrl}
              onClick={() => void handleAiFotoAnalyze()}
            >
              {aiFotoAnalyzing ? '⏳ Menganalisa foto...' : '✨ Start — Analisa Foto dengan AI'}
            </button>
          </div>

          {(aiFotoNamaPenyakit || aiFotoKesan) && (
            <>
              <div className="form-field form-grid--full">
                <label htmlFor="pasien-ai-penyakit">Nama Penyakit</label>
                <input
                  id="pasien-ai-penyakit"
                  value={aiFotoNamaPenyakit}
                  onChange={(e) => setAiFotoNamaPenyakit(e.target.value)}
                />
              </div>
              <div className="form-field form-grid--full">
                <label htmlFor="pasien-ai-kesan">Kesan</label>
                <textarea
                  id="pasien-ai-kesan"
                  rows={4}
                  value={aiFotoKesan}
                  onChange={(e) => setAiFotoKesan(e.target.value)}
                />
              </div>
              <AiHasilActions
                namaPasien={nama}
                pemeriksaan="AI Foto"
                namaPenyakit={aiFotoNamaPenyakit}
                fotoDataUrl={aiFotoDataUrl}
                kesan={aiFotoKesan}
              />
              <div className="form-field form-grid--full">
                <button type="button" className="btn btn--primary" onClick={handleSaveAiFotoKesan}>
                  Simpan &amp; Isi Kesan Pasien
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal open={aiBanding2Open} title="🩻 AI Banding 2 — TB X-ray Analysis with AI" onClose={() => setAiBanding2Open(false)} size="xl">
        <div className="form-grid">
          {aiBanding2Error && <div className="alert alert--error form-grid--full">{aiBanding2Error}</div>}

          <div className="form-field">
            <label htmlFor="tbscan-model">Model Version</label>
            <select
              id="tbscan-model"
              value={aiBanding2Model}
              onChange={(e) => setAiBanding2Model(e.target.value)}
            >
              <option value="">Select Model Version</option>
              {AI_BANDING2_MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="tbscan-upload">Upload X-Ray Image</label>
            <label
              htmlFor="tbscan-upload"
              className={`tbscan-upload${aiBanding2DragOver ? ' tbscan-upload--dragover' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setAiBanding2DragOver(true);
              }}
              onDragLeave={() => setAiBanding2DragOver(false)}
              onDrop={handleAiBanding2Drop}
            >
              <span className="tbscan-upload__icon">🖼️</span>
              <strong>Upload X-Ray Image or drag and drop</strong>
              <p className="tbscan-upload__hint">PNG, JPG, JPEG</p>
            </label>
            <input
              id="tbscan-upload"
              type="file"
              accept="image/png,image/jpeg"
              onChange={handleAiBanding2FileChange}
              style={{ display: 'none' }}
            />
            {aiBanding2DataUrl && (
              <div className="tbscan-preview">
                <img src={aiBanding2DataUrl} alt="Preview X-Ray" style={{ opacity: aiBanding2AdjustingPhoto ? 0.6 : 1 }} />
                {aiBanding2AdjustingPhoto && <p className="aifoto-upload__hint">Memproses foto…</p>}
              </div>
            )}

            {aiBanding2RawDataUrl && (
              <div className="aifoto-adjust">
                <div className="aifoto-adjust__row">
                  <label htmlFor="tbscan-ketajaman">Ketajaman / Detail</label>
                  <input
                    id="tbscan-ketajaman"
                    type="range"
                    min={0}
                    max={100}
                    value={aiBanding2Detail}
                    onChange={(e) => setAiBanding2Detail(Number(e.target.value))}
                  />
                  <span className="aifoto-adjust__value">{aiBanding2Detail}</span>
                </div>
                <div className="aifoto-adjust__row">
                  <label htmlFor="tbscan-densitas">Densitas</label>
                  <input
                    id="tbscan-densitas"
                    type="range"
                    min={-50}
                    max={50}
                    value={aiBanding2Brightness}
                    onChange={(e) => setAiBanding2Brightness(Number(e.target.value))}
                  />
                  <span className="aifoto-adjust__value">{aiBanding2Brightness}</span>
                </div>
                <div className="aifoto-adjust__row">
                  <label htmlFor="tbscan-kontras">Kontras (Paru ↔ Tulang)</label>
                  <input
                    id="tbscan-kontras"
                    type="range"
                    min={-50}
                    max={50}
                    value={aiBanding2Contrast}
                    onChange={(e) => setAiBanding2Contrast(Number(e.target.value))}
                  />
                  <span className="aifoto-adjust__value">{aiBanding2Contrast}</span>
                </div>
                <p className="tbscan-upload__hint" style={{ margin: '0.25rem 0 0' }}>
                  Geser Kontras ke kiri untuk kontras paru (jaringan lunak), ke kanan untuk kontras tulang.
                </p>
              </div>
            )}
          </div>

          <div className="form-field form-grid--full">
            <button
              type="button"
              className="aifoto-analyze-btn"
              disabled={aiBanding2Analyzing || aiBanding2AdjustingPhoto || !aiBanding2DataUrl || !aiBanding2Model}
              onClick={() => void handleAiBanding2Analyze()}
            >
              {aiBanding2Analyzing ? '⏳ Menganalisa...' : '▶ Analyze'}
            </button>
          </div>

          {aiBanding2Result && (
            <div className="form-grid--full">
              <div className="tbscan-panel">
                <div className="tbscan-card">
                  <div className="tbscan-diagnosis-row">
                    <h4 style={{ margin: 0 }}>AI Diagnosis</h4>
                    <span className="tbscan-score-label">Confidence Score</span>
                  </div>
                  <div className="tbscan-diagnosis-row">
                    <span className="tbscan-diagnosis-label">{aiBanding2Result.diagnosis || '—'}</span>
                    <span className="tbscan-score">
                      <span className="tbscan-score-value">{aiBanding2Result.confidenceScore}%</span>
                    </span>
                  </div>
                  <div className="tbscan-progress-track">
                    <div
                      className="tbscan-progress-fill"
                      style={{ width: `${Math.min(100, Math.max(0, aiBanding2Result.confidenceScore))}%` }}
                    />
                  </div>
                  <p className="tbscan-summary">{aiBanding2Result.ringkasan}</p>
                  <p className="tbscan-note">
                    Note: This AI analysis is used as an initial screening tool and does not replace professional
                    medical evaluation. Please consult a healthcare professional for a definitive diagnosis.
                  </p>
                </div>

                <div className="tbscan-card tbscan-xray">
                  <h4 style={{ textAlign: 'center' }}>X-Ray Image</h4>
                  {(() => {
                    const conditions = getAiBanding2Conditions(aiBanding2Result);
                    return (
                      <>
                        <div className="tbscan-xray-frame">
                          <img src={aiBanding2DataUrl} alt="X-Ray" />
                          {aiBanding2Result.areaTemuan.map((area, idx) => {
                            const style = TB_CONDITION_STYLE[area.kondisi];
                            if (!style) return null;
                            const top = Math.min(100, Math.max(0, area.ymin / 10));
                            const left = Math.min(100, Math.max(0, area.xmin / 10));
                            const height = Math.min(100 - top, Math.max(0, (area.ymax - area.ymin) / 10));
                            const width = Math.min(100 - left, Math.max(0, (area.xmax - area.xmin) / 10));
                            return (
                              <div
                                key={`${area.kondisi}-${idx}`}
                                className="tbscan-xray-box"
                                style={{
                                  top: `${top}%`,
                                  left: `${left}%`,
                                  width: `${width}%`,
                                  height: `${height}%`,
                                  borderColor: style.color,
                                  background: `${style.color}33`,
                                }}
                              >
                                <span className="tbscan-xray-box__label" style={{ background: style.color }}>
                                  {style.label}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        {conditions.length > 0 && (
                          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'center', marginTop: '0.75rem' }}>
                            {conditions.map((c) => (
                              <span
                                key={c.key}
                                style={{
                                  fontSize: '0.72rem',
                                  fontWeight: 700,
                                  padding: '0.2rem 0.55rem',
                                  borderRadius: '999px',
                                  color: c.color,
                                  background: `${c.color}22`,
                                  border: `1px solid ${c.color}`,
                                }}
                              >
                                ● {c.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>

              <div className="tbscan-card" style={{ marginTop: '1rem' }}>
                <h4>Detailed Indicators</h4>
                <div className="tbscan-indicator-grid">
                  {aiBanding2Result.indikator.map((item) => {
                    const isDanger = item.persen >= TB_ABNORMALITY_THRESHOLD;
                    return (
                      <div className="tbscan-indicator" key={item.key}>
                        <div className="tbscan-indicator-head">
                          <span>{item.label}</span>
                          <span className={isDanger ? 'tbscan-indicator-percent--danger' : 'tbscan-indicator-percent--ok'}>
                            {item.persen}%
                          </span>
                        </div>
                        <div className="tbscan-progress-track">
                          <div
                            className={`tbscan-progress-fill ${isDanger ? 'tbscan-progress-fill--danger' : 'tbscan-progress-fill--ok'}`}
                            style={{ width: `${Math.min(100, Math.max(0, item.persen))}%` }}
                          />
                        </div>
                        {item.keterangan && <p className="tbscan-indicator-desc">{item.keterangan}</p>}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={handlePrintAiBanding2}
                  style={{ border: '1px solid var(--color-border)' }}
                >
                  🖨️ Print Results
                </button>
                <button type="button" className="btn btn--sm btn--primary" onClick={handleSaveAiBanding2Kesan}>
                  Simpan ke Kesan
                </button>
              </div>
              <AiHasilActions
                namaPasien={nama}
                pemeriksaan="AI Banding 2 — Skrining TB"
                namaPenyakit={aiBanding2Result.diagnosis}
                fotoDataUrl={aiBanding2DataUrl}
                kesan={formatTbScreeningAnalisa(aiBanding2Result)}
              />
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={jenisModalMode !== null}
        title={
          jenisModalMode === 'add'
            ? 'Tambah Jenis Pemeriksaan, Harga & Sharing'
            : 'Ubah Jenis Pemeriksaan, Harga & Sharing'
        }
        onClose={() => setJenisModalMode(null)}
        size="md"
      >
        <form onSubmit={(e) => void onSubmitEditJenis(e)} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.25rem 0' }}>
          {jenisError ? <div className="alert alert--error">{jenisError}</div> : null}
          <div className="form-field">
            <label htmlFor="edit-jenis-nama">Nama Jenis Pemeriksaan</label>
            <input
              id="edit-jenis-nama"
              type="text"
              value={editingJenisNama}
              onChange={(e) => setEditingJenisNama(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="edit-jenis-harga">Harga Layanan (Rp)</label>
            <input
              id="edit-jenis-harga"
              type="number"
              min="0"
              step="1"
              value={editingJenisHarga}
              onChange={(e) => setEditingJenisHarga(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="edit-jenis-jumlah-film">Jumlah Film</label>
            <input
              id="edit-jenis-jumlah-film"
              type="number"
              min="1"
              step="1"
              value={editingJenisJumlahFilm}
              onChange={(e) => setEditingJenisJumlahFilm(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label>Ketentuan Sharing Dokter (Otomatis)</label>
            <div
              style={{
                padding: '0.6rem 0.8rem',
                backgroundColor: '#f0f9ff',
                border: '1px solid #bae6fd',
                borderRadius: '6px',
                color: '#0369a1',
                fontWeight: 600,
              }}
            >
              Otomatis (
              {formatRupiah(
                Number(
                  computeAutoSharingAmount(
                    selectedDokter?.nama,
                    [editingJenisNama],
                    umurYears,
                    selectedDokter?.defaultSharingAmount || '0',
                  ),
                ) || 0,
              )}
              ) — Sesuai Usia &amp; Pemeriksaan
            </div>
          </div>
          <ModalFormFooter
            onCancel={() => setJenisModalMode(null)}
            submitLabel={jenisModalMode === 'add' ? 'Tambah' : 'Simpan perubahan'}
            loading={savingJenis}
          />
        </form>
      </Modal>

      <Modal
        open={radiologForm !== null}
        title={radiologForm?.mode === 'edit' ? 'Ubah Radiolog' : 'Tambah Radiolog'}
        onClose={() => setRadiologForm(null)}
      >
        <form onSubmit={(e) => void submitRadiologForm(e)} className="form-grid">
          {radiologFormError && <div className="alert alert--error form-grid--full">{radiologFormError}</div>}
          <div className="form-field">
            <label htmlFor="radiolog-form-nama">Nama *</label>
            <input
              id="radiolog-form-nama"
              required
              value={radiologForm?.nama ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                setRadiologForm((prev) => (prev ? { ...prev, nama: value } : prev));
              }}
            />
          </div>
          <div className="form-field">
            <label htmlFor="radiolog-form-telp">No HP</label>
            <input
              id="radiolog-form-telp"
              value={radiologForm?.noTelepon ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                setRadiologForm((prev) => (prev ? { ...prev, noTelepon: value } : prev));
              }}
            />
          </div>
          <ModalFormFooter
            onCancel={() => setRadiologForm(null)}
            submitLabel={radiologForm?.mode === 'edit' ? 'Simpan perubahan' : 'Tambah'}
            loading={radiologSaving}
          />
        </form>
      </Modal>

      <ConfirmModal
        open={radiologDeleteTarget !== null}
        title="Hapus Radiolog"
        message={`Hapus radiolog "${radiologDeleteTarget?.nama ?? ''}"? Pasien yang memakai radiolog ini akan kehilangan data radiolognya. Radiolog yang sudah punya data Sharing Radiolog tidak bisa dihapus.`}
        confirmLabel="Hapus"
        onConfirm={() => void confirmDeleteRadiolog()}
        onClose={() => setRadiologDeleteTarget(null)}
        loading={radiologDeleting}
      />

      <Modal
        open={sharingOptionForm !== null}
        title={sharingOptionForm?.mode === 'edit' ? 'Ubah Pilihan Sharing' : 'Tambah Pilihan Sharing'}
        onClose={() => setSharingOptionForm(null)}
      >
        <form onSubmit={(e) => void submitSharingOptionForm(e)} className="form-grid">
          {sharingOptionError && <div className="alert alert--error form-grid--full">{sharingOptionError}</div>}
          <div className="form-field">
            <label htmlFor="sharing-option-nominal">Nominal (Rp) *</label>
            <input
              id="sharing-option-nominal"
              type="number"
              min="0"
              step="1"
              required
              value={sharingOptionForm?.nominal ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                setSharingOptionForm((prev) => (prev ? { ...prev, nominal: value } : prev));
              }}
            />
          </div>
          <div className="form-field">
            <label htmlFor="sharing-option-keterangan">Keterangan</label>
            <input
              id="sharing-option-keterangan"
              placeholder="mis. Thorax Dewasa — dr. Anna Diah"
              value={sharingOptionForm?.keterangan ?? ''}
              onChange={(e) => {
                const value = e.target.value;
                setSharingOptionForm((prev) => (prev ? { ...prev, keterangan: value } : prev));
              }}
            />
          </div>
          <ModalFormFooter
            onCancel={() => setSharingOptionForm(null)}
            submitLabel={sharingOptionForm?.mode === 'edit' ? 'Simpan perubahan' : 'Tambah'}
            loading={sharingOptionSaving}
          />
        </form>
      </Modal>

      <ConfirmModal
        open={sharingOptionDeleteTarget !== null}
        title="Hapus Pilihan Sharing"
        message={`Hapus pilihan sharing ${formatRupiah(sharingOptionDeleteTarget?.nominal ?? 0)}${sharingOptionDeleteTarget?.keterangan ? ` (${sharingOptionDeleteTarget.keterangan})` : ''}? Nominal sharing pasien yang sudah tersimpan tidak berubah.`}
        confirmLabel="Hapus"
        onConfirm={() => void confirmDeleteSharingOption()}
        onClose={() => setSharingOptionDeleteTarget(null)}
        loading={sharingOptionDeleting}
      />

      <Modal open={bhpModalOpen} title="Tambah Data BHP Radiologi" onClose={() => setBhpModalOpen(false)}>
        <form onSubmit={(e) => void handleBhpSubmit(e)} className="form-grid">
          {bhpError ? (
            <div className="alert alert--error form-field--full">{bhpError}</div>
          ) : null}
          <div className="form-field form-field--full">
            <label htmlFor="bhp-quick-pemakaian">Pemakaian *</label>
            <input
              id="bhp-quick-pemakaian"
              required
              placeholder="Contoh: Pemakaian BHP Rontgen Thorax"
              value={bhpForm.pemakaian}
              onChange={(e) => setBhpForm((f) => ({ ...f, pemakaian: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-tanggal">Tanggal *</label>
            <input
              id="bhp-quick-tanggal"
              type="date"
              required
              value={bhpForm.tanggal}
              onChange={(e) => setBhpForm((f) => ({ ...f, tanggal: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-harga">Harga (Rp)</label>
            <input
              id="bhp-quick-harga"
              type="number"
              min="0"
              step="1"
              value={bhpForm.harga}
              onChange={(e) => setBhpForm((f) => ({ ...f, harga: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-dev">Dev (Rp)</label>
            <input
              id="bhp-quick-dev"
              type="number"
              min="0"
              step="1"
              value={bhpForm.dev}
              onChange={(e) => setBhpForm((f) => ({ ...f, dev: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-fixer">Fixer (Rp)</label>
            <input
              id="bhp-quick-fixer"
              type="number"
              min="0"
              step="1"
              value={bhpForm.fixer}
              onChange={(e) => setBhpForm((f) => ({ ...f, fixer: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-film">Film Setiap Pemeriksaan (Rp)</label>
            <input
              id="bhp-quick-film"
              type="number"
              min="0"
              step="1"
              value={bhpForm.film}
              onChange={(e) => setBhpForm((f) => ({ ...f, film: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-amplop-kertas">Amplop Kertas (Rp)</label>
            <input
              id="bhp-quick-amplop-kertas"
              type="number"
              min="0"
              step="1"
              value={bhpForm.amplopKertas}
              onChange={(e) => setBhpForm((f) => ({ ...f, amplopKertas: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-listrik">Listrik (Rp)</label>
            <input
              id="bhp-quick-listrik"
              type="number"
              min="0"
              step="1"
              value={bhpForm.listrik}
              onChange={(e) => setBhpForm((f) => ({ ...f, listrik: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-gaji-karyawan">Gaji Karyawan (Rp)</label>
            <input
              id="bhp-quick-gaji-karyawan"
              type="number"
              min="0"
              step="1"
              value={bhpForm.gajiKaryawan}
              onChange={(e) => setBhpForm((f) => ({ ...f, gajiKaryawan: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-kertas-cetak">Kertas Cetak (Rp)</label>
            <input
              id="bhp-quick-kertas-cetak"
              type="number"
              min="0"
              step="1"
              value={bhpForm.kertasCetak}
              onChange={(e) => setBhpForm((f) => ({ ...f, kertasCetak: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="bhp-quick-amplop">Amplop (Rp)</label>
            <input
              id="bhp-quick-amplop"
              type="number"
              min="0"
              step="1"
              value={bhpForm.amplop}
              onChange={(e) => setBhpForm((f) => ({ ...f, amplop: e.target.value }))}
            />
          </div>
          <ModalFormFooter
            onCancel={() => setBhpModalOpen(false)}
            submitLabel="Simpan"
            loading={savingBhp}
          />
        </form>
      </Modal>
    </>
  );
}
