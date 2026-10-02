import { useState, useEffect, useMemo, useRef } from 'react';
import { PDFViewer, pdf } from '@react-pdf/renderer';
import { CetakAmplopPendaftaranModal } from '../components/CetakAmplopPendaftaranModal.tsx';
import { CetakLabelPendaftaranModal } from '../components/CetakLabelPendaftaranModal.tsx';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import { ListPageShell } from '../components/ui/ListPageShell.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { TableRowActions } from '../components/ui/TableRowActions.tsx';
import { useListRefresh } from '../context/ListRefreshContext.tsx';
import { useListQueryParams, useListSearch } from '../hooks/useListQueryParams.ts';
import { useMutationReload } from '../hooks/useMutationReload.ts';
import { usePaginatedList } from '../hooks/usePaginatedList.ts';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.ts';
import { handleFormFieldNavKeyDown } from '../lib/formFieldNav.ts';
import type { PaginatedResponse } from '../lib/pagination.ts';
import { formatRupiah } from '../lib/format.ts';
import { PendaftaranReportDocument } from '../pdf/PendaftaranReportDocument.tsx';
import { PendaftaranKopSuratDocument } from '../pdf/PendaftaranKopSuratDocument.tsx';
import { KwitansiReportDocument, type KwitansiReportData } from '../pdf/KwitansiReportDocument.tsx';
import { KwitansiRincianEditor } from '../components/KwitansiRincianEditor.tsx';
import { loadLogoDataUrl } from '../pdf/loadLogoDataUrl.ts';
import { angkaKeKata, terbilangRupiah } from '../lib/terbilang.ts';
import { getSpeechRecognitionConstructor, type SpeechRecognitionLike } from '../lib/speechRecognition.ts';
import { withIndonesianVoice } from '../lib/speechVoice.ts';
import '../components/ui/ui.css';

function todayDateStr(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

interface PendaftaranUmumItem {
  readonly id: string;
  readonly noRegistrasi: string;
  readonly namaPasien: string;
  readonly umur: string | null;
  readonly jenisKelamin: string | null;
  readonly alamat: string | null;
  readonly telpon: string | null;
  readonly tanggalMasuk: string;
  readonly dokterPengirim: string | null;
  readonly klinis: string | null;
  readonly admin: string | null;
  readonly foto: string | null;
  readonly ruangan: string | null;
  readonly status: 'MENUNGGU' | 'SELESAI';
  readonly biayaPendaftaran: string;
  readonly paymentStatus: 'BELUM_LUNAS' | 'LUNAS';
  readonly petugasKasir: string | null;
}

const RUANGAN_OPTIONS = ['Radiologi', 'USG', 'Laboratorium'] as const;

/** Ambil nomor antrian dari 3 digit terakhir kode registrasi (mis. PH260805003 -> 3). */
function parseAntrianNumber(noRegistrasi: string): number | null {
  const match = /(\d{3})$/.exec(noRegistrasi);
  return match ? Number(match[1]) : null;
}

/** Ucapkan teks lewat speaker dengan suara lembut (pelan & lirih), diulang 2x. */
function speakSoftAntrian(text: string) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  withIndonesianVoice((voice) => {
    window.speechSynthesis.cancel();
    for (let i = 0; i < 2; i += 1) {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = voice?.lang ?? 'id-ID';
      utter.rate = 0.85;
      utter.pitch = 0.9;
      utter.volume = 0.75;
      if (voice) utter.voice = voice;
      window.speechSynthesis.speak(utter);
    }
  });
}

/** Tentukan sapaan (Ananda/Tuan/Nyonya/Saudari) dari umur & jenis kelamin.
 * Anak (di bawah 17 tahun, atau umur dalam bulan/hari) disapa "Ananda".
 * Perempuan dewasa di bawah 25 tahun disapa "Saudari", selain itu "Nyonya".
 * Tanpa data jenis kelamin, sapaan dikosongkan (hanya sebut nama). */
function resolveSapaan(umur: string | null, jenisKelamin: string | null): string {
  const raw = (umur ?? '').toLowerCase();
  const match = /(\d+)/.exec(raw);
  const angka = match ? Number(match[1]) : null;
  const isBulanAtauHari = /(bulan|bln|hari|hr)\b/.test(raw);
  const umurTahun = isBulanAtauHari ? 0 : angka;

  if (umurTahun !== null && umurTahun < 17) return 'Ananda';
  if (jenisKelamin === 'Perempuan') return umurTahun !== null && umurTahun < 25 ? 'Saudari' : 'Nyonya';
  if (jenisKelamin === 'Laki-laki') return 'Tuan';
  return '';
}

/** Singkatan sapaan yang lazim ditulis di depan nama pasien (mis. "Ny. Siti"),
 * supaya dibaca lengkap ("Nyonya Siti") bukan dieja huruf per huruf. Sdri/Sdra
 * dicek lebih dulu supaya tidak tertukar dengan pola lain. */
const SAPAAN_ABBR: ReadonlyArray<readonly [RegExp, string]> = [
  [/^sdri\.?\s+/i, 'Saudari'],
  [/^sdra\.?\s+/i, 'Saudara'],
  [/^ny\.?\s+/i, 'Nyonya'],
  [/^tn\.?\s+/i, 'Tuan'],
  [/^an\.?\s+/i, 'Ananda'],
];

/** Pisahkan sapaan singkatan di depan nama, jika ada (mis. "Ny. Siti" -> {sapaan: "Nyonya", nama: "Siti"}). */
function pisahSapaanDariNama(nama: string): { sapaan: string | null; nama: string } {
  for (const [pattern, label] of SAPAAN_ABBR) {
    if (pattern.test(nama)) {
      return { sapaan: label, nama: nama.replace(pattern, '') };
    }
  }
  return { sapaan: null, nama };
}

/** Umumkan nomor antrian pasien lewat speaker beserta sapaan, namanya, dan
 * ruangan tujuan (dipilih saat pendaftaran; default radiologi kalau kosong). */
function announceAntrianDenganNama(
  nomor: number,
  nama: string,
  umur: string | null,
  jenisKelamin: string | null,
  ruangan: string | null,
) {
  const { sapaan: sapaanDariNama, nama: namaBersih } = pisahSapaanDariNama(nama);
  const sapaan = sapaanDariNama ?? resolveSapaan(umur, jenisKelamin);
  const sebutan = sapaan ? `${sapaan} ${namaBersih}` : namaBersih;
  const tujuanRuangan = ruangan?.trim() || 'radiologi';
  speakSoftAntrian(
    `Nomor antrian ${angkaKeKata(nomor)}, atas nama ${sebutan}. Silakan masuk ke ruangan ${tujuanRuangan}.`,
  );
}

function formatWhatsAppNumber(phone: string | null): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^0-9]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('0')) {
    return '62' + cleaned.slice(1);
  }
  if (cleaned.startsWith('62')) {
    return cleaned;
  }
  return '62' + cleaned;
}

export function PendaftaranUmumPage() {
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

  const queryParams = useListQueryParams({ ...(dateParams as Record<string, string>) }, search);
  const { items, pagination, setPage, loading, error, setError, reload: reloadList } =
    usePaginatedList<PendaftaranUmumItem>('/api/pendaftaran-umum', queryParams);
  const reload = useMutationReload(reloadList);

  const { items: dokterList } = usePaginatedList<{ id: string; nama: string }>('/api/dokter', { limit: '100' });
  const { items: adminList } = usePaginatedList<{ id: string; nama: string }>('/api/admin-klinik', { limit: '100' });

  const { version: listRefreshVersion } = useListRefresh();
  const [todayCount, setTodayCount] = useState(0);

  useEffect(() => {
    const today = todayDateStr();
    apiGet<PaginatedResponse<PendaftaranUmumItem>>(
      `/api/pendaftaran-umum?startDate=${today}&endDate=${today}&limit=1`,
    )
      .then((res) => setTodayCount(res.pagination.total))
      .catch(() => setTodayCount(0));
  }, [listRefreshVersion]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<PendaftaranUmumItem | null>(null);
  const [deleting, setDeleting] = useState<PendaftaranUmumItem | null>(null);
  const [previewItem, setPreviewItem] = useState<PendaftaranUmumItem | null>(null);
  const [kopSuratPreviewItem, setKopSuratPreviewItem] = useState<PendaftaranUmumItem | null>(null);
  const [kwitansiPreviewItem, setKwitansiPreviewItem] = useState<PendaftaranUmumItem | null>(null);
  /** Rincian kwitansi hasil suntingan; null berarti pakai rincian bawaan. */
  const [kwitansiRincian, setKwitansiRincian] = useState<readonly { nama: string; harga: number }[] | null>(null);
  const [amplopPreviewItem, setAmplopPreviewItem] = useState<PendaftaranUmumItem | null>(null);
  const [labelPreviewItem, setLabelPreviewItem] = useState<PendaftaranUmumItem | null>(null);
  const [logoSrc, setLogoSrc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const fotoInputRef = useRef<HTMLInputElement>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceOnRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const activeFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const [formData, setFormData] = useState({
    noRegistrasi: '',
    namaPasien: '',
    umur: '',
    jenisKelamin: '',
    alamat: '',
    telpon: '',
    tanggalMasuk: '',
    dokterPengirim: '',
    klinis: '',
    admin: '',
    foto: '',
    ruangan: '',
    biayaPendaftaran: '',
    paymentStatus: 'BELUM_LUNAS' as 'BELUM_LUNAS' | 'LUNAS',
    petugasKasir: '',
  });

  useEffect(() => {
    void loadLogoDataUrl().then(setLogoSrc).catch(() => setLogoSrc(''));
  }, []);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceOnRef.current = false;
      recognitionRef.current?.stop();
    };
  }, []);

  // <video> cuma ter-mount setelah cameraOn true, jadi srcObject harus
  // dipasang di sini (bukan langsung di handleOpenCamera) supaya elemennya
  // sudah ada di DOM saat stream-nya dipasang.
  useEffect(() => {
    if (cameraOn && cameraVideoRef.current && cameraStreamRef.current) {
      cameraVideoRef.current.srcObject = cameraStreamRef.current;
    }
  }, [cameraOn]);

  function openCreate() {
    setFormData({
      noRegistrasi: '',
      namaPasien: '',
      umur: '',
      jenisKelamin: '',
      alamat: '',
      telpon: '',
      tanggalMasuk: new Date().toISOString().split('T')[0],
      dokterPengirim: '',
      klinis: '',
      admin: '',
      foto: '',
      ruangan: '',
      biayaPendaftaran: '',
      paymentStatus: 'BELUM_LUNAS',
      petugasKasir: '',
    });
    setCreateOpen(true);
    setError(null);
  }

  function openEdit(item: PendaftaranUmumItem) {
    setEditing(item);
    setFormData({
      noRegistrasi: item.noRegistrasi,
      namaPasien: item.namaPasien,
      umur: item.umur || '',
      jenisKelamin: item.jenisKelamin || '',
      alamat: item.alamat || '',
      telpon: item.telpon || '',
      tanggalMasuk: item.tanggalMasuk.split('T')[0],
      dokterPengirim: item.dokterPengirim || '',
      klinis: item.klinis || '',
      admin: item.admin || '',
      foto: item.foto || '',
      ruangan: item.ruangan || '',
      biayaPendaftaran: item.biayaPendaftaran,
      paymentStatus: item.paymentStatus,
      petugasKasir: item.petugasKasir || '',
    });
    setError(null);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  }

  function handleFotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setFormData((prev) => ({ ...prev, foto: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  }

  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    setCameraOn(false);
  }

  function closeModal() {
    stopCamera();
    stopVoice();
    setCreateOpen(false);
    setEditing(null);
  }

  async function handleOpenCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      cameraStreamRef.current = stream;
      setCameraOn(true);
    } catch (err) {
      setError(err instanceof Error ? `Gagal mengakses kamera: ${err.message}` : 'Gagal mengakses kamera.');
    }
  }

  function handleCapturePhoto() {
    const video = cameraVideoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    setFormData((prev) => ({ ...prev, foto: dataUrl }));
  }

  function handleFormFocusCapture(e: React.FocusEvent<HTMLFormElement>) {
    const target = e.target;
    if (
      (target instanceof HTMLInputElement && target.type === 'text') ||
      target instanceof HTMLTextAreaElement
    ) {
      activeFieldRef.current = target;
    }
  }

  function insertTextAtCursor(text: string) {
    const el = activeFieldRef.current;
    const fieldName = el?.name;
    if (!el || !fieldName || !(fieldName in formData)) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const needsSpace = before.length > 0 && !/[\s\n]$/.test(before);
    const insertion = (needsSpace ? ' ' : '') + text;
    const newValue = before + insertion + after;
    const newCursorPos = (before + insertion).length;
    setFormData((prev) => ({ ...prev, [fieldName]: newValue }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCursorPos, newCursorPos);
    });
  }

  function startVoice() {
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) {
      setError('Browser ini tidak mendukung input suara (Speech Recognition).');
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'id-ID';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i]?.[0]?.transcript.trim();
        if (transcript) insertTextAtCursor(transcript);
      }
    };
    recognition.onerror = () => {
      // Error transien (mis. jeda tanpa suara) — biarkan onend yang menangani restart.
    };
    recognition.onend = () => {
      if (voiceOnRef.current) {
        try {
          recognition.start();
        } catch {
          // Sudah berjalan — abaikan.
        }
      }
    };
    recognitionRef.current = recognition;
    voiceOnRef.current = true;
    setVoiceOn(true);
    recognition.start();
  }

  function stopVoice() {
    voiceOnRef.current = false;
    setVoiceOn(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/api/pendaftaran-umum', {
        noRegistrasi: formData.noRegistrasi || undefined,
        namaPasien: formData.namaPasien,
        umur: formData.umur || undefined,
        jenisKelamin: formData.jenisKelamin || undefined,
        alamat: formData.alamat || undefined,
        telpon: formData.telpon || undefined,
        tanggalMasuk: formData.tanggalMasuk,
        dokterPengirim: formData.dokterPengirim || undefined,
        klinis: formData.klinis || undefined,
        admin: formData.admin || undefined,
        foto: formData.foto || undefined,
        ruangan: formData.ruangan || undefined,
        biayaPendaftaran: formData.biayaPendaftaran || undefined,
        paymentStatus: formData.paymentStatus,
        petugasKasir: formData.petugasKasir || undefined,
      });
      closeModal();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat pendaftaran');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPatch(`/api/pendaftaran-umum/${editing.id}`, {
        noRegistrasi: formData.noRegistrasi,
        namaPasien: formData.namaPasien,
        umur: formData.umur || undefined,
        jenisKelamin: formData.jenisKelamin || undefined,
        alamat: formData.alamat || undefined,
        telpon: formData.telpon || undefined,
        tanggalMasuk: formData.tanggalMasuk,
        dokterPengirim: formData.dokterPengirim || undefined,
        klinis: formData.klinis || undefined,
        admin: formData.admin || undefined,
        foto: formData.foto || undefined,
        ruangan: formData.ruangan || undefined,
        biayaPendaftaran: formData.biayaPendaftaran || undefined,
        paymentStatus: formData.paymentStatus,
        petugasKasir: formData.petugasKasir || undefined,
      });
      closeModal();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mengubah pendaftaran');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiDelete(`/api/pendaftaran-umum/${deleting.id}`);
      setDeleting(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus pendaftaran');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTandaiSelesai(item: PendaftaranUmumItem) {
    setError(null);
    try {
      await apiPatch(`/api/pendaftaran-umum/${item.id}`, { status: 'SELESAI' });
      await reload();

      const currentAntrian = parseAntrianNumber(item.noRegistrasi);
      if (currentAntrian === null) return;
      const nextAntrian = currentAntrian + 1;
      const prefix = item.noRegistrasi.slice(0, -3);
      const expectedNextCode = `${prefix}${String(nextAntrian).padStart(3, '0')}`;

      const today = todayDateStr();
      const res = await apiGet<PaginatedResponse<PendaftaranUmumItem>>(
        `/api/pendaftaran-umum?startDate=${today}&endDate=${today}&limit=200`,
      );
      const next = res.items.find((p) => p.noRegistrasi === expectedNextCode && p.status === 'MENUNGGU');
      if (next) {
        announceAntrianDenganNama(nextAntrian, next.namaPasien, next.umur, next.jenisKelamin, next.ruangan);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menandai selesai');
    }
  }

  /** Rincian bawaan kwitansi ini bila belum pernah disunting. */
  function rincianBawaan(item: PendaftaranUmumItem): { nama: string; harga: number }[] {
    return [{ nama: 'Biaya Pendaftaran', harga: Number(item.biayaPendaftaran) }];
  }

  function buildKwitansiData(item: PendaftaranUmumItem): KwitansiReportData {
    const rincian = kwitansiRincian ?? rincianBawaan(item);
    const total = rincian.reduce((jumlah, r) => jumlah + r.harga, 0);
    return {
      logoSrc,
      noKwitansi: item.noRegistrasi,
      tanggal: new Date(item.tanggalMasuk).toLocaleDateString('id-ID'),
      namaPasien: item.namaPasien,
      umur: item.umur || '-',
      alamat: item.alamat || '-',
      dokterPengirim: item.dokterPengirim || '-',
      items: rincian.map((r) => ({ nama: r.nama, hargaFormatted: formatRupiah(r.harga) })),
      totalFormatted: formatRupiah(total),
      terbilang: terbilangRupiah(total),
      paymentStatus: item.paymentStatus,
      kasirNama: item.petugasKasir || '',
    };
  }

  async function handleDownloadKwitansi(item: PendaftaranUmumItem) {
    const data = buildKwitansiData(item);
    const blob = await pdf(<KwitansiReportDocument data={data} />).toBlob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `Kwitansi_${item.noRegistrasi}.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page-frame page-frame--indigo">
    <ListPageShell
      title="Pendaftaran Umum"
      metrics={[
        {
          label: 'Total Pendaftaran',
          value: String(pagination.total),
          tone: 'blue',
          iconKind: 'users',
        },
        {
          label: 'Nomor Antrian',
          value: String(todayCount + 1),
          tone: 'violet',
          iconKind: 'clock',
        },
      ]}
      searchPlaceholder="Cari nama pasien, no registrasi..."
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
          <button
            type="button"
            className={`btn btn--sm ${timeFilter === 'week' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => { setTimeFilter(timeFilter === 'week' ? 'all' : 'week'); setPage(1); }}
            style={timeFilter !== 'week' ? { border: '1px solid var(--color-border)' } : {}}
          >
            🗓️ Pasien Per Minggu
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
        <button
          type="button"
          className="btn btn--primary"
          onClick={openCreate}
          style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
        >
          + Tambah Pendaftaran
        </button>
      }
    >
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>No. Antrian</th>
              <th>Nama Pasien</th>
              <th>Umur</th>
              <th>Alamat</th>
              <th>Telpon</th>
              <th>Dokter Pengirim</th>
              <th>Status</th>
              <th>Bayar</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr style={{ background: '#1d4ed8' }}>
                <td colSpan={9} style={{ textAlign: 'center', padding: '2rem', color: '#ffffff' }}>
                  Belum ada data pendaftaran umum.
                </td>
              </tr>
            ) : (
              items.map((item, idx) => {
                const antrian = parseAntrianNumber(item.noRegistrasi);
                return (
                <tr
                  key={item.id}
                  style={{
                    background: (idx + 1) % 2 === 0 ? '#eef2ff' : '#ffffff',
                    borderBottom: '1px solid rgba(15, 23, 42, 0.18)',
                    color: '#0f172a',
                  }}
                >
                  <td style={{ fontWeight: 700, color: '#1e293b' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span>{antrian ?? '—'}</span>
                      {antrian !== null && (
                        <button
                          type="button"
                          onClick={() =>
                            announceAntrianDenganNama(antrian, item.namaPasien, item.umur, item.jenisKelamin, item.ruangan)
                          }
                          title={`Umumkan: Nomor antrian ${antrian} atas nama ${item.namaPasien}`}
                          style={{
                            background: 'rgba(99, 102, 241, 0.1)',
                            border: '1px solid rgba(99, 102, 241, 0.3)',
                            borderRadius: '4px',
                            color: '#4338ca',
                            cursor: 'pointer',
                            padding: '0.15rem 0.4rem',
                            fontSize: '0.8rem',
                            lineHeight: 1,
                          }}
                        >
                          🔊
                        </button>
                      )}
                    </div>
                  </td>
                  <td><strong>{item.namaPasien}</strong></td>
                  <td>{item.umur || '-'}</td>
                  <td>{item.alamat || '-'}</td>
                  <td>
                    {item.telpon ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span>{item.telpon}</span>
                        <a
                          href={`https://wa.me/${formatWhatsAppNumber(item.telpon)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Chat WhatsApp dengan ${item.namaPasien} (${item.telpon})`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            backgroundColor: '#e0f2fe',
                            color: '#16a34a',
                            border: '1px solid #7dd3fc',
                            padding: '3px 10px',
                            borderRadius: '6px',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            textDecoration: 'none',
                            cursor: 'pointer',
                            boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
                            transition: 'all 0.15s ease',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = '#bae6fd';
                            e.currentTarget.style.borderColor = '#38bdf8';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = '#e0f2fe';
                            e.currentTarget.style.borderColor = '#7dd3fc';
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                          </svg>
                          WhatsApp
                        </a>
                      </div>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td>{item.dokterPengirim || '-'}</td>
                  <td>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '0.2rem 0.6rem',
                        borderRadius: '999px',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        color: item.status === 'SELESAI' ? '#15803d' : '#b45309',
                        background: item.status === 'SELESAI' ? '#f0fdf4' : '#fffbeb',
                        border: `1px solid ${item.status === 'SELESAI' ? '#bbf7d0' : '#fde68a'}`,
                      }}
                    >
                      {item.status === 'SELESAI' ? 'SELESAI' : 'MENUNGGU'}
                    </span>
                  </td>
                  <td>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '0.2rem 0.6rem',
                        borderRadius: '999px',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        color: item.paymentStatus === 'LUNAS' ? '#15803d' : '#b91c1c',
                        background: item.paymentStatus === 'LUNAS' ? '#f0fdf4' : '#fef2f2',
                        border: `1px solid ${item.paymentStatus === 'LUNAS' ? '#bbf7d0' : '#fecaca'}`,
                      }}
                    >
                      {item.paymentStatus === 'LUNAS' ? 'LUNAS' : 'BELUM LUNAS'}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      {item.status === 'MENUNGGU' && (
                        <button
                          type="button"
                          className="btn btn--xs btn--primary"
                          onClick={() => void handleTandaiSelesai(item)}
                          title="Tandai selesai & umumkan nomor antrian berikutnya"
                          style={{ padding: '0.3rem 0.6rem' }}
                        >
                          🔊 Selesai
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn--xs btn--ghost"
                        onClick={() => setKopSuratPreviewItem(item)}
                        title="Cetak formulir dengan kop surat"
                        style={{ border: '1px solid var(--color-border)' }}
                      >
                        📄 Formulir
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs btn--ghost"
                        onClick={() => setAmplopPreviewItem(item)}
                        title="Cetak amplop pendaftaran"
                        style={{ border: '1px solid var(--color-border)' }}
                      >
                        ✉️ Amplop
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs btn--ghost"
                        onClick={() => setLabelPreviewItem(item)}
                        title="Cetak label stiker identitas"
                        style={{ border: '1px solid var(--color-border)' }}
                      >
                        🏷️ Label
                      </button>
                      <button
                        type="button"
                        className="btn btn--xs btn--primary"
                        onClick={() => setKwitansiPreviewItem(item)}
                        title="Pratinjau & cetak kwitansi biaya pendaftaran"
                      >
                        🧾 Kwitansi
                      </button>
                      <TableRowActions
                        onEdit={() => openEdit(item)}
                        onDelete={() => setDeleting(item)}
                        onPrint={() => setPreviewItem(item)}
                        editLabel="Ubah pendaftaran"
                        deleteLabel="Hapus pendaftaran"
                        printLabel="Cetak pendaftaran"
                      />
                    </div>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {(createOpen || editing) && (
        <Modal
          open={true}
          title={editing ? "Ubah Pendaftaran Umum" : "Tambah Pendaftaran Umum"}
          onClose={closeModal}
          size="lg"
          headerColor={editing ? 'default' : 'sky-red'}
        >
          <form
            onSubmit={editing ? handleUpdate : handleCreate}
            onFocus={handleFormFocusCapture}
            style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn btn--sm ${voiceOn ? 'btn--primary' : 'btn--ghost'}`}
                onClick={startVoice}
                disabled={voiceOn}
                style={voiceOn ? undefined : { border: '1px solid var(--color-border)' }}
              >
                🎤 {voiceOn ? 'Voice Aktif — Klik field lalu bicara' : 'Aktifkan Voice'}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={stopVoice}
                disabled={!voiceOn}
                style={{ border: '1px solid var(--color-border)' }}
              >
                🔇 Matikan Voice
              </button>
            </div>
            <fieldset className="legacy-groupbox legacy-groupbox--biru-hitam">
              <legend>Data Pendaftaran</legend>
              <div className="legacy-form-layout">
                <div className="legacy-form-fields" onKeyDown={handleFormFieldNavKeyDown}>
                  <div className="legacy-form-row">
                    <label htmlFor="noRegistrasi">No Registrasi</label>
                    <input
                      id="noRegistrasi"
                      name="noRegistrasi"
                      type="text"
                      value={formData.noRegistrasi}
                      onChange={handleChange}
                      placeholder="Otomatis sistem"
                      disabled={!!editing}
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="namaPasien">Nama Pasien</label>
                    <input
                      id="namaPasien"
                      name="namaPasien"
                      type="text"
                      required
                      value={formData.namaPasien}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="umur">Umur</label>
                    <input
                      id="umur"
                      name="umur"
                      type="text"
                      value={formData.umur}
                      onChange={handleChange}
                      placeholder="mis. 32 tahun / 24 bln"
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="jenisKelamin">Jenis Kelamin</label>
                    <select
                      id="jenisKelamin"
                      name="jenisKelamin"
                      value={formData.jenisKelamin}
                      onChange={handleChange}
                    >
                      <option value="">— Pilih —</option>
                      <option value="Laki-laki">Laki-laki</option>
                      <option value="Perempuan">Perempuan</option>
                    </select>
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="ruangan">Ruangan</label>
                    <select
                      id="ruangan"
                      name="ruangan"
                      value={formData.ruangan}
                      onChange={handleChange}
                    >
                      <option value="">— Pilih Ruangan —</option>
                      {RUANGAN_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="telpon">Telpon</label>
                    <input
                      id="telpon"
                      name="telpon"
                      type="text"
                      value={formData.telpon}
                      onChange={handleChange}
                      placeholder="0812xxxx..."
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="alamat">Alamat</label>
                    <input
                      id="alamat"
                      name="alamat"
                      type="text"
                      value={formData.alamat}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="tanggalMasuk">Tanggal Masuk</label>
                    <input
                      id="tanggalMasuk"
                      name="tanggalMasuk"
                      type="date"
                      required
                      value={formData.tanggalMasuk}
                      onChange={handleChange}
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="dokterPengirim">Dokter Pengirim</label>
                    <select
                      id="dokterPengirim"
                      name="dokterPengirim"
                      value={formData.dokterPengirim}
                      onChange={handleChange}
                    >
                      <option value="">-- Pilih Dokter --</option>
                      {dokterList.map((d) => (
                        <option key={d.id} value={d.nama}>
                          {d.nama}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="admin">Admin Pendaftaran</label>
                    <select
                      id="admin"
                      name="admin"
                      value={formData.admin}
                      onChange={handleChange}
                    >
                      <option value="">-- Pilih Admin --</option>
                      {adminList.map((a) => (
                        <option key={a.id} value={a.nama}>
                          {a.nama}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="klinis">Klinis</label>
                    <input
                      id="klinis"
                      name="klinis"
                      type="text"
                      value={formData.klinis}
                      onChange={handleChange}
                      placeholder="Keluhan / keterangan medis..."
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="biayaPendaftaran">Biaya Pendaftaran</label>
                    <input
                      id="biayaPendaftaran"
                      name="biayaPendaftaran"
                      type="number"
                      min="0"
                      step="500"
                      value={formData.biayaPendaftaran}
                      onChange={handleChange}
                      placeholder="0"
                    />
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="paymentStatus">Status Pembayaran</label>
                    <select
                      id="paymentStatus"
                      name="paymentStatus"
                      value={formData.paymentStatus}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          paymentStatus: e.target.value as 'BELUM_LUNAS' | 'LUNAS',
                        }))
                      }
                    >
                      <option value="BELUM_LUNAS">BELUM LUNAS</option>
                      <option value="LUNAS">LUNAS</option>
                    </select>
                  </div>

                  <div className="legacy-form-row">
                    <label htmlFor="petugasKasir">Petugas Kasir</label>
                    <select
                      id="petugasKasir"
                      name="petugasKasir"
                      value={formData.petugasKasir}
                      onChange={handleChange}
                    >
                      <option value="">-- Pilih Kasir --</option>
                      {adminList.map((a) => (
                        <option key={a.id} value={a.nama}>
                          {a.nama}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="legacy-photo-panel">
                  {cameraOn ? (
                    <div className="legacy-photo-box">
                      <video
                        ref={cameraVideoRef}
                        autoPlay
                        muted
                        playsInline
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    </div>
                  ) : formData.foto ? (
                    <div className="legacy-photo-box">
                      <img src={formData.foto} alt="Foto pasien" />
                      <button
                        type="button"
                        className="legacy-photo-box__remove"
                        onClick={() => setFormData((prev) => ({ ...prev, foto: '' }))}
                        title="Hapus foto"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="legacy-photo-box">
                      <span className="legacy-photo-box__placeholder">📷</span>
                    </div>
                  )}
                  {cameraOn ? (
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button type="button" className="btn btn--primary" onClick={handleCapturePhoto}>
                        Ambil Foto
                      </button>
                      <button type="button" className="btn btn--ghost" onClick={stopCamera}>
                        Stop
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button type="button" className="btn btn--ghost" onClick={() => void handleOpenCamera()}>
                        📷 Buka Kamera
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => fotoInputRef.current?.click()}
                      >
                        Upload File
                      </button>
                    </div>
                  )}
                  <input
                    ref={fotoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFotoChange}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>
            </fieldset>

            <div className="form-actions form-actions--end form-grid--full">
              <button type="submit" className="btn btn--primary" disabled={submitting}>
                {submitting ? 'Menyimpan…' : 'Simpan'}
              </button>
              {editing && (
                <button type="button" className="btn btn--ghost" onClick={() => setPreviewItem(editing)}>
                  Cetak
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={closeModal}
              >
                Batal
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmModal
          open={true}
          title="Hapus Pendaftaran"
          message={`Apakah Anda yakin ingin menghapus pendaftaran "${deleting.namaPasien}"?`}
          confirmLabel="Hapus"
          onConfirm={() => void handleDeleteConfirm()}
          onClose={() => setDeleting(null)}
          loading={submitting}
        />
      )}

      {previewItem && (
        <Modal
          title={`Preview Cetak — ${previewItem.noRegistrasi}`}
          open={true}
          onClose={() => setPreviewItem(null)}
          size="xl"
        >
          <div style={{ width: '100%', height: 'calc(100vh - 12rem)', minHeight: '600px' }}>
            <PDFViewer width="100%" height="100%" className="pdf-viewer">
              <PendaftaranReportDocument
                data={{
                  noRegistrasi: previewItem.noRegistrasi,
                  namaPasien: previewItem.namaPasien,
                  umur: previewItem.umur || '',
                  alamat: previewItem.alamat || '',
                  telpon: previewItem.telpon || '',
                  tanggalMasuk: new Date(previewItem.tanggalMasuk).toLocaleDateString('id-ID'),
                  dokterPengirim: previewItem.dokterPengirim || '',
                  klinis: previewItem.klinis || '',
                  admin: previewItem.admin || '',
                  logoSrc,
                }}
              />
            </PDFViewer>
          </div>
        </Modal>
      )}

      {kopSuratPreviewItem && (
        <Modal
          title={`Preview Formulir — ${kopSuratPreviewItem.noRegistrasi}`}
          open={true}
          onClose={() => setKopSuratPreviewItem(null)}
          size="xl"
        >
          <div style={{ width: '100%', height: 'calc(100vh - 12rem)', minHeight: '600px' }}>
            <PDFViewer width="100%" height="100%" className="pdf-viewer">
              <PendaftaranKopSuratDocument
                data={{
                  noRegistrasi: kopSuratPreviewItem.noRegistrasi,
                  namaPasien: kopSuratPreviewItem.namaPasien,
                  umur: kopSuratPreviewItem.umur || '',
                  alamat: kopSuratPreviewItem.alamat || '',
                  telpon: kopSuratPreviewItem.telpon || '',
                  tanggalMasuk: new Date(kopSuratPreviewItem.tanggalMasuk).toLocaleDateString('id-ID'),
                  dokterPengirim: kopSuratPreviewItem.dokterPengirim || '',
                  klinis: kopSuratPreviewItem.klinis || '',
                  admin: kopSuratPreviewItem.admin || '',
                  logoSrc,
                }}
              />
            </PDFViewer>
          </div>
        </Modal>
      )}

      {kwitansiPreviewItem && (
        <Modal
          title={`Pratinjau Kwitansi — ${kwitansiPreviewItem.noRegistrasi}`}
          open={true}
          onClose={() => {
            setKwitansiPreviewItem(null);
            setKwitansiRincian(null);
          }}
          size="xl"
        >
          <KwitansiRincianEditor
            jenis="PENDAFTARAN_UMUM"
            nomor={kwitansiPreviewItem.noRegistrasi}
            bawaan={rincianBawaan(kwitansiPreviewItem)}
            onChange={setKwitansiRincian}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleDownloadKwitansi(kwitansiPreviewItem)}
              style={{ fontWeight: 600 }}
            >
              ⬇️ Unduh / Cetak Kwitansi
            </button>
          </div>
          <div style={{ width: '100%', height: 'calc(100vh - 14rem)', minHeight: '600px' }}>
            <PDFViewer width="100%" height="100%" className="pdf-viewer">
              <KwitansiReportDocument data={buildKwitansiData(kwitansiPreviewItem)} />
            </PDFViewer>
          </div>
        </Modal>
      )}

      <CetakAmplopPendaftaranModal
        open={!!amplopPreviewItem}
        onClose={() => setAmplopPreviewItem(null)}
        pasien={
          amplopPreviewItem
            ? {
                noRegistrasi: amplopPreviewItem.noRegistrasi,
                namaPasien: amplopPreviewItem.namaPasien,
                umur: amplopPreviewItem.umur,
                alamat: amplopPreviewItem.alamat,
                tanggalMasuk: amplopPreviewItem.tanggalMasuk,
                dokterPengirim: amplopPreviewItem.dokterPengirim,
              }
            : null
        }
      />

      <CetakLabelPendaftaranModal
        open={!!labelPreviewItem}
        onClose={() => setLabelPreviewItem(null)}
        pasien={
          labelPreviewItem
            ? {
                noRegistrasi: labelPreviewItem.noRegistrasi,
                namaPasien: labelPreviewItem.namaPasien,
                umur: labelPreviewItem.umur,
                tanggalMasuk: labelPreviewItem.tanggalMasuk,
                dokterPengirim: labelPreviewItem.dokterPengirim,
              }
            : null
        }
      />
    </ListPageShell>
    </div>
  );
}
