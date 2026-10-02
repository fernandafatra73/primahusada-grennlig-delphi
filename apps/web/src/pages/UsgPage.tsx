import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import { ListPageShell } from '../components/ui/ListPageShell.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { UsgIdentifikasiModal } from '../components/UsgIdentifikasiModal.tsx';
import { CetakALModal, type CetakALPasien } from '../components/CetakALModal.tsx';
import { KesanEditorModal } from '../components/KesanEditorModal.tsx';
import { IconPencil, IconPrint, IconTrash } from '../components/icons/ActionIcons.tsx';
import { useListQueryParams, useListSearch } from '../hooks/useListQueryParams.ts';
import { useMutationReload } from '../hooks/useMutationReload.ts';
import { usePaginatedList } from '../hooks/usePaginatedList.ts';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.ts';
import { handleFormFieldNavKeyDown } from '../lib/formFieldNav.ts';
import { UsgReportDocument, type UsgReportData } from '../pdf/UsgReportDocument.tsx';
import { UsgKertasKecilReportDocument } from '../pdf/UsgKertasKecilReportDocument.tsx';
import { UsgKesanReportDocument, type UsgKesanReportData } from '../pdf/UsgKesanReportDocument.tsx';
import { loadLogoDataUrl } from '../pdf/loadLogoDataUrl.ts';
import { loadSignatureDataUrl } from '../pdf/loadSignatureDataUrl.ts';
import { pdf } from '@react-pdf/renderer';
import '../components/ui/ui.css';

interface UsgItem {
  readonly id: string;
  readonly namaPasien: string;
  readonly umur: string | null;
  readonly alamat: string | null;
  readonly regCode: string | null;
  readonly jenisPemeriksaan: string | null;
  readonly tanggal: string;
  readonly dokterPengirim: string | null;
  readonly fotoDataUrl: string;
  readonly fotoDataUrl2: string | null;
  readonly fotoDataUrl3: string | null;
  readonly fotoDataUrl4: string | null;
  readonly analisa: string | null;
  readonly kesan: string | null;
  readonly radiologNama: string | null;
}

interface RadiologOption {
  readonly id: string;
  readonly nama: string;
}

interface DokterOption {
  readonly id: string;
  readonly nama: string;
}

interface PendaftaranOption {
  readonly id: string;
  readonly noRegistrasi: string;
  readonly namaPasien: string;
  readonly umur: string | null;
  readonly alamat: string | null;
  readonly dokterPengirim: string | null;
}

interface KopSuratData {
  readonly namaKlinik: string;
  readonly alamat: string;
  readonly telepon: string;
  readonly logoDataUrl: string | null;
}

function formatTanggalDisplay(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  } catch {
    return dateStr;
  }
}

const emptyForm = {
  namaPasien: '',
  umur: '',
  alamat: '',
  regCode: '',
  jenisPemeriksaan: '',
  tanggal: new Date().toISOString().split('T')[0]!,
  dokterPengirim: '',
  fotoDataUrl: '',
  fotoDataUrl2: '',
  fotoDataUrl3: '',
  fotoDataUrl4: '',
  analisa: '',
  kesan: '',
  radiologNama: '',
};

export function UsgPage() {
  const { search, setSearch } = useListSearch();
  const [timeFilter, setTimeFilter] = useState<'all' | 'today' | 'week' | 'month'>('all');

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
    const daysAgo = timeFilter === 'week' ? 7 : 30;
    const start = new Date(now);
    start.setDate(now.getDate() - daysAgo);
    const sy = start.getFullYear();
    const sm = String(start.getMonth() + 1).padStart(2, '0');
    const sd = String(start.getDate()).padStart(2, '0');
    return { startDate: `${sy}-${sm}-${sd}`, endDate: todayStr };
  }, [timeFilter]);

  const queryParams = useListQueryParams({ ...(dateParams as Record<string, string>) }, search);
  const {
    items,
    pagination,
    setPage,
    loading,
    error,
    setError,
    reload: reloadList,
  } = usePaginatedList<UsgItem>('/api/usg', queryParams);
  const reload = useMutationReload(reloadList);

  const [identifikasiOpen, setIdentifikasiOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UsgItem | null>(null);
  const [deleting, setDeleting] = useState<UsgItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [printChoice, setPrintChoice] = useState<UsgItem | null>(null);
  const [printingKesanId, setPrintingKesanId] = useState<string | null>(null);
  const [amplopItem, setAmplopItem] = useState<UsgItem | null>(null);
  /** Kartu USG yang kesannya sedang diedit langsung (disimpan ke server). */
  const [kesanTarget, setKesanTarget] = useState<UsgItem | null>(null);
  const [kesanSaving, setKesanSaving] = useState(false);
  const [kesanError, setKesanError] = useState<string | null>(null);
  /** Editor kesan untuk form tambah/ubah; hasilnya hanya mengisi form. */
  const [formKesanOpen, setFormKesanOpen] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewBlobKecil, setPreviewBlobKecil] = useState<Blob | null>(null);
  const [previewBlobNoSignature, setPreviewBlobNoSignature] = useState<Blob | null>(null);
  const [previewFilename, setPreviewFilename] = useState('usg.pdf');

  const [radiologOptions, setRadiologOptions] = useState<RadiologOption[]>([]);
  const [dokterOptions, setDokterOptions] = useState<DokterOption[]>([]);
  const [pendaftaranOptions, setPendaftaranOptions] = useState<PendaftaranOption[]>([]);
  const [kopSurat, setKopSurat] = useState<KopSuratData | null>(null);
  const [logoFallback, setLogoFallback] = useState('');

  const loadRadiologOptions = useCallback(async () => {
    try {
      const res = await apiGet<{ items: RadiologOption[] }>('/api/radiolog?limit=200');
      setRadiologOptions(res.items);
    } catch {
      setRadiologOptions([]);
    }
  }, []);

  const loadDokterOptions = useCallback(async () => {
    try {
      const res = await apiGet<{ items: DokterOption[] }>('/api/dokter?limit=200');
      setDokterOptions(res.items);
    } catch {
      setDokterOptions([]);
    }
  }, []);

  const loadPendaftaranOptions = useCallback(async () => {
    try {
      const res = await apiGet<{ items: PendaftaranOption[] }>('/api/pendaftaran-umum?limit=200');
      setPendaftaranOptions(res.items);
    } catch {
      setPendaftaranOptions([]);
    }
  }, []);

  const loadKopSurat = useCallback(async () => {
    try {
      const [res, logo] = await Promise.all([
        apiGet<{ item: KopSuratData }>('/api/kop-surat'),
        loadLogoDataUrl().catch(() => ''),
      ]);
      setKopSurat(res.item);
      setLogoFallback(logo);
    } catch {
      setKopSurat(null);
    }
  }, []);

  useEffect(() => {
    void loadRadiologOptions();
    void loadDokterOptions();
    void loadPendaftaranOptions();
    void loadKopSurat();
  }, [loadRadiologOptions, loadDokterOptions, loadPendaftaranOptions, loadKopSurat]);

  function resetForm() {
    setForm(emptyForm);
    setError(null);
    setEditing(null);
    setFormOpen(false);
  }

  function openCreate() {
    setForm(emptyForm);
    setError(null);
    setEditing(null);
    setFormOpen(true);
    document.getElementById('usg-form-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openEdit(item: UsgItem) {
    setForm({
      namaPasien: item.namaPasien,
      umur: item.umur ?? '',
      alamat: item.alamat ?? '',
      regCode: item.regCode ?? '',
      jenisPemeriksaan: item.jenisPemeriksaan ?? '',
      tanggal: item.tanggal.split('T')[0]!,
      dokterPengirim: item.dokterPengirim ?? '',
      fotoDataUrl: item.fotoDataUrl,
      fotoDataUrl2: item.fotoDataUrl2 ?? '',
      fotoDataUrl3: item.fotoDataUrl3 ?? '',
      fotoDataUrl4: item.fotoDataUrl4 ?? '',
      analisa: item.analisa ?? '',
      kesan: item.kesan ?? '',
      radiologNama: item.radiologNama ?? '',
    });
    setError(null);
    setEditing(item);
    setFormOpen(true);
    document.getElementById('usg-form-top')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleFotoFileChange(
    field: 'fotoDataUrl' | 'fotoDataUrl2' | 'fotoDataUrl3' | 'fotoDataUrl4',
    e: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setForm((f) => ({ ...f, [field]: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fotoDataUrl) {
      setError('Foto USG wajib diunggah');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        namaPasien: form.namaPasien,
        umur: form.umur || undefined,
        alamat: form.alamat || undefined,
        regCode: form.regCode || undefined,
        jenisPemeriksaan: form.jenisPemeriksaan || undefined,
        tanggal: form.tanggal,
        dokterPengirim: form.dokterPengirim || undefined,
        fotoDataUrl: form.fotoDataUrl,
        fotoDataUrl2: form.fotoDataUrl2 || undefined,
        fotoDataUrl3: form.fotoDataUrl3 || undefined,
        fotoDataUrl4: form.fotoDataUrl4 || undefined,
        analisa: form.analisa || undefined,
        kesan: form.kesan || undefined,
        radiologNama: form.radiologNama || undefined,
      };
      const wasEditing = editing !== null;
      if (editing) {
        await apiPatch(`/api/usg/${editing.id}`, body);
      } else {
        await apiPost('/api/usg', body);
      }
      resetForm();
      await reload({ resetPage: !wasEditing });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan data USG');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiDelete(`/api/usg/${deleting.id}`);
      setDeleting(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus data USG');
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePrint(item: UsgItem, maxPhotos: 1 | 2 | 4) {
    setPrintChoice(null);
    setPrintingId(item.id);
    try {
      const [logoRes, signatureRes, kopSuratRes] = await Promise.all([
        loadLogoDataUrl().catch(() => ''),
        loadSignatureDataUrl().catch(() => undefined),
        apiGet<{ item: KopSuratData }>('/api/kop-surat').catch(() => null),
      ]);
      const photos = [item.fotoDataUrl, item.fotoDataUrl2 ?? '', item.fotoDataUrl3 ?? '', item.fotoDataUrl4 ?? ''].slice(
        0,
        maxPhotos,
      );
      const data: UsgReportData = {
        logoSrc: kopSuratRes?.item.logoDataUrl || logoRes,
        signatureSrc: signatureRes,
        namaKlinik: kopSuratRes?.item.namaKlinik || 'KLINIK PRIMA HUSADA',
        alamatKlinik: kopSuratRes?.item.alamat || '',
        teleponKlinik: kopSuratRes?.item.telepon || '',
        namaPasien: item.namaPasien,
        umur: item.umur || '',
        alamat: item.alamat || '',
        regCode: item.regCode || '',
        jenisPemeriksaan: item.jenisPemeriksaan || '',
        tanggalLabel: formatTanggalDisplay(item.tanggal),
        dokterPengirim: item.dokterPengirim || '',
        fotoDataUrl: photos[0] || '',
        fotoDataUrl2: photos[1] || '',
        fotoDataUrl3: photos[2] || '',
        fotoDataUrl4: photos[3] || '',
        analisa: item.analisa || '',
        kesan: item.kesan || '',
        radiologNama: item.radiologNama || '',
        tanggalCetak: new Date().toLocaleDateString('id-ID', {
          day: '2-digit', month: 'long', year: 'numeric',
        }),
      };
      const [blob, blobKecil, blobNoSignature] = await Promise.all([
        pdf(<UsgReportDocument data={data} />).toBlob(),
        pdf(<UsgKertasKecilReportDocument data={data} />).toBlob(),
        pdf(<UsgReportDocument data={{ ...data, signatureSrc: undefined }} />).toBlob(),
      ]);
      setPreviewBlob(blob);
      setPreviewBlobKecil(blobKecil);
      setPreviewBlobNoSignature(blobNoSignature);
      setPreviewFilename(`USG_${item.namaPasien}.pdf`);
    } finally {
      setPrintingId(null);
    }
  }

  async function handleKesanSave(kesan: string) {
    if (!kesanTarget) return;
    setKesanSaving(true);
    setKesanError(null);
    try {
      // API USG mengabaikan field yang tidak dikirim, jadi cukup kirim kesan.
      await apiPatch(`/api/usg/${kesanTarget.id}`, { kesan });
      setKesanTarget(null);
      await reload();
    } catch (err: unknown) {
      setKesanError(err instanceof Error ? err.message : 'Gagal menyimpan kesan');
    } finally {
      setKesanSaving(false);
    }
  }

  async function handlePrintKesan(item: UsgItem) {
    setPrintingKesanId(item.id);
    try {
      const [logoRes, signatureRes, kopSuratRes] = await Promise.all([
        loadLogoDataUrl().catch(() => ''),
        loadSignatureDataUrl().catch(() => undefined),
        apiGet<{ item: KopSuratData }>('/api/kop-surat').catch(() => null),
      ]);
      const data: UsgKesanReportData = {
        logoSrc: kopSuratRes?.item.logoDataUrl || logoRes,
        signatureSrc: signatureRes,
        namaKlinik: kopSuratRes?.item.namaKlinik || 'KLINIK PRIMA HUSADA',
        alamatKlinik: kopSuratRes?.item.alamat || '',
        teleponKlinik: kopSuratRes?.item.telepon || '',
        namaPasien: item.namaPasien,
        umur: item.umur || '',
        alamat: item.alamat || '',
        regCode: item.regCode || '',
        jenisPemeriksaan: item.jenisPemeriksaan || '',
        tanggalLabel: formatTanggalDisplay(item.tanggal),
        dokterPengirim: item.dokterPengirim || '',
        kesan: item.kesan || '',
        radiologNama: item.radiologNama || '',
        tanggalCetak: new Date().toLocaleDateString('id-ID', {
          day: '2-digit', month: 'long', year: 'numeric',
        }),
      };
      const blob = await pdf(<UsgKesanReportDocument data={data} />).toBlob();
      setPreviewBlob(blob);
      setPreviewBlobKecil(null);
      setPreviewBlobNoSignature(null);
      setPreviewFilename(`Kesan_USG_${item.namaPasien}.pdf`);
    } finally {
      setPrintingKesanId(null);
    }
  }

  const latestTanggal = items[0]?.tanggal ? formatTanggalDisplay(items[0].tanggal) : '—';

  function toCetakALPasien(item: UsgItem): CetakALPasien {
    return {
      id: item.id,
      regCode: item.regCode || '',
      nama: item.namaPasien,
      umur: item.umur ? Number(item.umur) || 0 : 0,
      tanggalLahir: item.tanggal,
      createdAt: item.tanggal,
      alamat: item.alamat,
      pengirim: { nama: item.dokterPengirim || '-' },
      radiolog: item.radiologNama ? { nama: item.radiologNama } : null,
      pemeriksaan: item.jenisPemeriksaan
        ? item.jenisPemeriksaan.split(', ').filter(Boolean).map((nama) => ({ nama }))
        : [],
    };
  }

  return (
    <div className="page-frame page-frame--cyan">
      <div className="usg-hero" id="usg-form-top">
        <div className="usg-hero__icon">🩻</div>
        <div>
          <h2 className="usg-hero__title">USG — Ultrasonografi</h2>
          <p className="usg-hero__subtitle">
            Arsip pemeriksaan USG pasien, lengkap dengan analisa &amp; kesan manual radiolog.
          </p>
        </div>
        <div className="usg-hero__stat">
          <span className="usg-hero__stat-value">{pagination.total}</span>
          <span className="usg-hero__stat-label">Total Pemeriksaan</span>
        </div>
        <div className="usg-hero__stat">
          <span className="usg-hero__stat-value" style={{ fontSize: '1rem' }}>{latestTanggal}</span>
          <span className="usg-hero__stat-label">Data Terbaru</span>
        </div>
      </div>

      {formOpen && (
      <div className="aifoto-frame" style={{ marginBottom: '1.25rem' }}>
        <div className="aifoto-frame__titlebar">
          {editing ? `✏️ Ubah Data USG — ${editing.namaPasien}` : '📝 Tambah Pasien USG'}
        </div>
        <div className="aifoto-frame__body">
          <form onSubmit={(e) => void handleSubmit(e)} className="form-grid" onKeyDown={handleFormFieldNavKeyDown}>
            <div
              className="form-field form-grid--full"
              style={{
                gap: 0,
                width: '210mm',
                maxWidth: '100%',
                minHeight: '297mm',
                boxSizing: 'border-box',
                margin: '0 auto',
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                borderRadius: 'var(--radius-card)',
                boxShadow: 'var(--shadow-card)',
                padding: '15mm',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.6rem',
                  textAlign: 'center',
                  paddingBottom: '0.6rem',
                  marginBottom: '0.9rem',
                  borderBottom: '2px solid #2b4c9b',
                }}
              >
                {(kopSurat?.logoDataUrl || logoFallback) && (
                  <img
                    src={kopSurat?.logoDataUrl || logoFallback}
                    alt="Logo klinik"
                    style={{ width: 40, height: 40, objectFit: 'contain' }}
                  />
                )}
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 700, color: '#2b4c9b', fontSize: '1rem', lineHeight: 1.2 }}>
                    {kopSurat?.namaKlinik || 'KLINIK PRIMA HUSADA'}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#334155' }}>
                    {kopSurat?.alamat}
                    {kopSurat?.telepon ? ` Telp. ${kopSurat.telepon}` : ''}
                  </div>
                  <div style={{ marginTop: '0.25rem', fontWeight: 700, color: '#2b4c9b', fontSize: '0.85rem', textTransform: 'uppercase' }}>
                    Hasil Pemeriksaan USG
                  </div>
                </div>
              </div>

              {/* Identitas Pasien — persis urutan dokumen cetak: kop surat di atas, identitas
                  pasien, lalu isian sampai tanda tangan dokter spesialis radiologi di bawah. */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '0.75rem',
                  padding: '0.75rem',
                  marginBottom: '1rem',
                  background: '#f8fafc',
                  border: '0.5px solid #cbd5e1',
                  borderRadius: 'var(--radius-card)',
                }}
              >
                <div className="form-field form-field--full" style={{ gridColumn: '1 / -1' }}>
                  <label htmlFor="usg-pendaftaran">Ambil dari Pendaftaran (Opsional)</label>
                  <select
                    id="usg-pendaftaran"
                    value=""
                    onChange={(e) => {
                      const selected = pendaftaranOptions.find((p) => p.id === e.target.value);
                      if (selected) {
                        setForm((f) => ({
                          ...f,
                          namaPasien: selected.namaPasien,
                          umur: selected.umur ?? f.umur,
                          alamat: selected.alamat ?? f.alamat,
                          regCode: selected.noRegistrasi,
                          dokterPengirim: selected.dokterPengirim ?? f.dokterPengirim,
                        }));
                      }
                    }}
                  >
                    <option value="">-- Pilih Pasien / Ketik Manual di Bawah --</option>
                    {pendaftaranOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.namaPasien} ({p.noRegistrasi})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor="usg-nama">Nama Pasien *</label>
                  <input
                    id="usg-nama"
                    required
                    value={form.namaPasien}
                    onChange={(e) => setForm((f) => ({ ...f, namaPasien: e.target.value }))}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="usg-umur">Umur</label>
                  <input
                    id="usg-umur"
                    value={form.umur}
                    onChange={(e) => setForm((f) => ({ ...f, umur: e.target.value }))}
                    placeholder="Contoh: 35 tahun"
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="usg-alamat">Alamat</label>
                  <input
                    id="usg-alamat"
                    value={form.alamat}
                    onChange={(e) => setForm((f) => ({ ...f, alamat: e.target.value }))}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="usg-jenis">Jenis Pemeriksaan</label>
                  <input
                    id="usg-jenis"
                    value={form.jenisPemeriksaan}
                    onChange={(e) => setForm((f) => ({ ...f, jenisPemeriksaan: e.target.value }))}
                    placeholder="Contoh: USG Abdomen"
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="usg-regcode">No. Reg</label>
                  <input
                    id="usg-regcode"
                    value={form.regCode}
                    onChange={(e) => setForm((f) => ({ ...f, regCode: e.target.value }))}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="usg-dokter-pengirim">Dokter Pengirim</label>
                  <select
                    id="usg-dokter-pengirim"
                    value={form.dokterPengirim}
                    onChange={(e) => setForm((f) => ({ ...f, dokterPengirim: e.target.value }))}
                  >
                    <option value="">-- Pilih Dokter Pengirim --</option>
                    {form.dokterPengirim && !dokterOptions.some((d) => d.nama === form.dokterPengirim) && (
                      <option value={form.dokterPengirim}>{form.dokterPengirim}</option>
                    )}
                    {dokterOptions.map((d) => (
                      <option key={d.id} value={d.nama}>
                        {d.nama}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor="usg-radiolog">Radiolog</label>
                  <select
                    id="usg-radiolog"
                    value={form.radiologNama}
                    onChange={(e) => setForm((f) => ({ ...f, radiologNama: e.target.value }))}
                  >
                    <option value="">-- Pilih Radiolog --</option>
                    {form.radiologNama && !radiologOptions.some((r) => r.nama === form.radiologNama) && (
                      <option value={form.radiologNama}>{form.radiologNama}</option>
                    )}
                    {radiologOptions.map((r) => (
                      <option key={r.id} value={r.nama}>
                        {r.nama}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor="usg-tanggal">Tanggal *</label>
                  <input
                    id="usg-tanggal"
                    type="date"
                    required
                    value={form.tanggal}
                    onChange={(e) => setForm((f) => ({ ...f, tanggal: e.target.value }))}
                  />
                </div>
              </div>

              <div className="form-field form-field--full">
                <label htmlFor="usg-analisa" style={{ color: '#2b4c9b', fontWeight: 700 }}>
                  Klinis:
                </label>
                <textarea
                  id="usg-analisa"
                  rows={4}
                  value={form.analisa}
                  onChange={(e) => setForm((f) => ({ ...f, analisa: e.target.value }))}
                  placeholder="Diisi manual oleh radiolog"
                  style={{ border: '1px solid #cbd5e1', borderRadius: '4px' }}
                />
              </div>

              <div style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                <div style={{ flex: '1 1 200px', maxWidth: 200 }}>
                  <label htmlFor="usg-foto" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                    Foto USG 1 *
                  </label>
                  {!form.fotoDataUrl ? (
                    <label htmlFor="usg-foto" className="aifoto-upload aifoto-photo-box" style={{ cursor: 'pointer', height: 200, margin: '0.4rem auto 0' }}>
                      <span className="aifoto-upload__icon">📤</span>
                      <p className="aifoto-upload__hint">Klik untuk unggah</p>
                    </label>
                  ) : (
                    <div className="aifoto-photo-box aifoto-photo-box--filled" style={{ height: 200, margin: '0.4rem auto 0' }}>
                      <img src={form.fotoDataUrl} alt="Preview foto USG 1" />
                    </div>
                  )}
                  <input
                    id="usg-foto"
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFotoFileChange('fotoDataUrl', e)}
                    style={form.fotoDataUrl ? { display: 'block', margin: '0.4rem auto 0' } : { display: 'none' }}
                  />
                </div>

                <div style={{ flex: '1 1 200px', maxWidth: 200 }}>
                  <label htmlFor="usg-foto-2" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                    Foto USG 2 (Opsional)
                  </label>
                  {!form.fotoDataUrl2 ? (
                    <label htmlFor="usg-foto-2" className="aifoto-upload aifoto-photo-box" style={{ cursor: 'pointer', height: 200, margin: '0.4rem auto 0' }}>
                      <span className="aifoto-upload__icon">📤</span>
                      <p className="aifoto-upload__hint">Klik untuk unggah</p>
                    </label>
                  ) : (
                    <div className="aifoto-photo-box aifoto-photo-box--filled" style={{ height: 200, margin: '0.4rem auto 0' }}>
                      <img src={form.fotoDataUrl2} alt="Preview foto USG 2" />
                    </div>
                  )}
                  <input
                    id="usg-foto-2"
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFotoFileChange('fotoDataUrl2', e)}
                    style={form.fotoDataUrl2 ? { display: 'block', margin: '0.4rem auto 0' } : { display: 'none' }}
                  />
                </div>

                <div style={{ flex: '1 1 200px', maxWidth: 200 }}>
                  <label htmlFor="usg-foto-3" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                    Foto USG 3 (Opsional)
                  </label>
                  {!form.fotoDataUrl3 ? (
                    <label htmlFor="usg-foto-3" className="aifoto-upload aifoto-photo-box" style={{ cursor: 'pointer', height: 200, margin: '0.4rem auto 0' }}>
                      <span className="aifoto-upload__icon">📤</span>
                      <p className="aifoto-upload__hint">Klik untuk unggah</p>
                    </label>
                  ) : (
                    <div className="aifoto-photo-box aifoto-photo-box--filled" style={{ height: 200, margin: '0.4rem auto 0' }}>
                      <img src={form.fotoDataUrl3} alt="Preview foto USG 3" />
                    </div>
                  )}
                  <input
                    id="usg-foto-3"
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFotoFileChange('fotoDataUrl3', e)}
                    style={form.fotoDataUrl3 ? { display: 'block', margin: '0.4rem auto 0' } : { display: 'none' }}
                  />
                </div>

                <div style={{ flex: '1 1 200px', maxWidth: 200 }}>
                  <label htmlFor="usg-foto-4" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>
                    Foto USG 4 (Opsional)
                  </label>
                  {!form.fotoDataUrl4 ? (
                    <label htmlFor="usg-foto-4" className="aifoto-upload aifoto-photo-box" style={{ cursor: 'pointer', height: 200, margin: '0.4rem auto 0' }}>
                      <span className="aifoto-upload__icon">📤</span>
                      <p className="aifoto-upload__hint">Klik untuk unggah</p>
                    </label>
                  ) : (
                    <div className="aifoto-photo-box aifoto-photo-box--filled" style={{ height: 200, margin: '0.4rem auto 0' }}>
                      <img src={form.fotoDataUrl4} alt="Preview foto USG 4" />
                    </div>
                  )}
                  <input
                    id="usg-foto-4"
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFotoFileChange('fotoDataUrl4', e)}
                    style={form.fotoDataUrl4 ? { display: 'block', margin: '0.4rem auto 0' } : { display: 'none' }}
                  />
                </div>
              </div>

              <div className="form-field form-field--full">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <label htmlFor="usg-kesan" style={{ color: '#2b4c9b', fontWeight: 700 }}>
                    Kesan:
                  </label>
                  <button
                    type="button"
                    className="btn btn--xs btn--secondary"
                    onClick={() => setFormKesanOpen(true)}
                    title="Edit kesan dengan Master Kesan"
                  >
                    ✏️ Edit
                  </button>
                </div>
                <textarea
                  id="usg-kesan"
                  rows={3}
                  value={form.kesan}
                  onChange={(e) => setForm((f) => ({ ...f, kesan: e.target.value }))}
                  placeholder="Diisi manual oleh radiolog"
                  style={{ border: '1px solid #cbd5e1', borderRadius: '4px' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
                <div style={{ width: 220 }}>
                  <p style={{ margin: '0 0 2.5rem', fontSize: '0.8rem', textAlign: 'center' }}>
                    Teman Sejawat
                  </p>
                  <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '0.85rem' }}>
                    {form.radiologNama || '( ................................. )'}
                  </div>
                  <p
                    style={{
                      margin: '0.1rem 0 0',
                      fontSize: '0.8rem',
                      textAlign: 'center',
                      borderTop: '1px solid #1a1a1a',
                      paddingTop: '0.25rem',
                    }}
                  >
                    Radiolog
                  </p>
                </div>
              </div>
            </div>

            <p className="form-grid--full" style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
              Klik Batal untuk menutup form ini tanpa menyimpan.
            </p>

            <div className="form-actions form-actions--end form-grid--full">
              <button type="submit" className="btn btn--primary" disabled={submitting}>
                {submitting ? 'Menyimpan…' : editing ? 'Simpan Perubahan' : 'Simpan'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={resetForm}>
                Batal
              </button>
              <button type="button" className="btn btn--ghost" onClick={resetForm}>
                Tutup
              </button>
            </div>
          </form>
        </div>
      </div>
      )}

      <ListPageShell
        title="Riwayat Pemeriksaan USG"
        subtitle="Klik kartu untuk mengubah, mencetak, atau menghapus data"
        searchPlaceholder="Cari nama pasien..."
        searchValue={search}
        onSearchChange={setSearch}
        onRefresh={() => void reload()}
        error={error}
        loading={loading}
        pagination={pagination}
        onPageChange={setPage}
        action={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn--secondary" onClick={() => setIdentifikasiOpen(true)}>
              🩻 Identifikasi USG
            </button>
            <button type="button" className="btn btn--primary" onClick={openCreate}>
              + Tambah Pasien
            </button>
          </div>
        }
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
              🗓️ Pasien 1 Minggu
            </button>
            <button
              type="button"
              className={`btn btn--sm ${timeFilter === 'month' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => { setTimeFilter(timeFilter === 'month' ? 'all' : 'month'); setPage(1); }}
              style={timeFilter !== 'month' ? { border: '1px solid var(--color-border)' } : {}}
            >
              🗓️ Pasien 1 Bulan
            </button>
            {timeFilter !== 'all' && (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => { setTimeFilter('all'); setPage(1); }}
                style={{ border: '1px solid var(--color-border)' }}
              >
                Lihat Semua
              </button>
            )}
          </div>
        }
      >
        {items.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-text-muted)' }}>
            Belum ada data USG.
          </p>
        ) : (
          <div className="usg-gallery">
            {items.map((item) => (
              <div className="usg-card" key={item.id}>
                <div className="usg-card__photo">
                  <img src={item.fotoDataUrl} alt={`Foto USG ${item.namaPasien}`} />
                  <span className="usg-card__date-badge">{formatTanggalDisplay(item.tanggal)}</span>
                </div>
                <div className="usg-card__body">
                  <h3 className="usg-card__name">{item.namaPasien}</h3>
                  {item.jenisPemeriksaan && (
                    <span className="usg-card__badge">{item.jenisPemeriksaan}</span>
                  )}
                  <p className="usg-card__kesan">{item.kesan || 'Belum ada kesan.'}</p>
                  <div className="usg-card__meta">
                    🩺 {item.radiologNama || 'Radiolog belum ditentukan'}
                  </div>
                </div>
                <div className="usg-card__actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    style={{ border: '1px solid var(--color-border)' }}
                    onClick={() => openEdit(item)}
                  >
                    <IconPencil className="icon-btn__svg" /> Ubah
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    style={{ border: '1px solid var(--color-border)' }}
                    onClick={() => setPrintChoice(item)}
                    disabled={printingId === item.id}
                  >
                    <IconPrint className="icon-btn__svg" /> {printingId === item.id ? '...' : 'Cetak'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    style={{ border: '1px solid var(--color-border)' }}
                    onClick={() => void handlePrintKesan(item)}
                    disabled={printingKesanId === item.id}
                  >
                    <IconPrint className="icon-btn__svg" /> {printingKesanId === item.id ? '...' : 'Kesan'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    style={{ border: '1px solid var(--color-border)' }}
                    onClick={() => setAmplopItem(item)}
                  >
                    <IconPrint className="icon-btn__svg" /> Amplop
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    style={{ border: '1px solid var(--color-border)' }}
                    onClick={() => {
                      setKesanError(null);
                      setKesanTarget(item);
                    }}
                    title="Edit kesan"
                  >
                    ✏️ Edit Kesan
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-danger, #dc2626)' }}
                    onClick={() => setDeleting(item)}
                  >
                    <IconTrash className="icon-btn__svg" /> Hapus
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </ListPageShell>

      <ConfirmModal
        open={deleting !== null}
        title="Hapus Data USG"
        message={`Yakin hapus data USG "${deleting?.namaPasien ?? ''}"?`}
        loading={submitting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void handleDeleteConfirm()}
      />

      {kesanTarget && (
        <KesanEditorModal
          key={kesanTarget.id}
          nama={kesanTarget.namaPasien}
          initialKesan={kesanTarget.kesan ?? ''}
          saving={kesanSaving}
          error={kesanError}
          onClose={() => setKesanTarget(null)}
          onSave={(kesan) => void handleKesanSave(kesan)}
        />
      )}

      {formKesanOpen && (
        <KesanEditorModal
          nama={form.namaPasien || (editing ? editing.namaPasien : 'Pasien USG')}
          initialKesan={form.kesan}
          saving={false}
          error={null}
          submitLabel="Pakai Kesan"
          onClose={() => setFormKesanOpen(false)}
          onSave={(kesan) => {
            setForm((f) => ({ ...f, kesan }));
            setFormKesanOpen(false);
          }}
        />
      )}

      <UsgIdentifikasiModal
        open={identifikasiOpen}
        onClose={() => setIdentifikasiOpen(false)}
        onGunakan={(kesanText) => {
          openCreate();
          setForm((f) => ({ ...f, kesan: kesanText }));
          setIdentifikasiOpen(false);
        }}
      />

      <UsgPdfPreviewModal
        open={previewBlob !== null}
        blob={previewBlob}
        blobKecil={previewBlobKecil}
        blobNoSignature={previewBlobNoSignature}
        filename={previewFilename}
        onClose={() => {
          setPreviewBlob(null);
          setPreviewBlobKecil(null);
          setPreviewBlobNoSignature(null);
        }}
      />

      {printChoice && (
        <UsgPrintChoiceModal
          item={printChoice}
          onClose={() => setPrintChoice(null)}
          onChoose={(count) => void handlePrint(printChoice, count)}
        />
      )}

      <CetakALModal
        open={amplopItem !== null}
        onClose={() => setAmplopItem(null)}
        pasien={amplopItem ? toCetakALPasien(amplopItem) : null}
        initialMode="amplop"
        examLabel="USG"
      />
    </div>
  );
}

interface UsgPrintChoiceModalProps {
  readonly item: UsgItem;
  readonly onClose: () => void;
  readonly onChoose: (count: 1 | 2 | 4) => void;
}

function UsgPrintChoiceModal({ item, onClose, onChoose }: UsgPrintChoiceModalProps) {
  const availableCount = [item.fotoDataUrl, item.fotoDataUrl2, item.fotoDataUrl3, item.fotoDataUrl4].filter(
    Boolean,
  ).length;

  return (
    <Modal open title="Pilih Jumlah Foto untuk Dicetak" onClose={onClose} size="md">
      <p style={{ margin: '0 0 1rem', color: 'var(--color-text-muted)' }}>
        Data ini memiliki {availableCount} foto. Pilih berapa foto yang ingin ditampilkan pada hasil cetak.
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
        {([1, 2, 4] as const).map((count) => (
          <button
            key={count}
            type="button"
            className="btn btn--sm btn--primary"
            disabled={count > 1 && availableCount < 2}
            onClick={() => onChoose(count)}
          >
            {count} Foto
          </button>
        ))}
      </div>
    </Modal>
  );
}

interface UsgPdfPreviewModalProps {
  readonly open: boolean;
  readonly blob: Blob | null;
  readonly blobKecil: Blob | null;
  readonly blobNoSignature: Blob | null;
  readonly filename: string;
  readonly onClose: () => void;
}

function UsgPdfPreviewModal({ open, blob, blobKecil, blobNoSignature, filename, onClose }: UsgPdfPreviewModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  function handlePrint() {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  }

  function printBlobSilently(targetBlob: Blob) {
    const objectUrl = URL.createObjectURL(targetBlob);
    const hiddenFrame = document.createElement('iframe');
    hiddenFrame.style.position = 'fixed';
    hiddenFrame.style.right = '0';
    hiddenFrame.style.bottom = '0';
    hiddenFrame.style.width = '0';
    hiddenFrame.style.height = '0';
    hiddenFrame.style.border = '0';
    hiddenFrame.src = objectUrl;
    hiddenFrame.onload = () => {
      hiddenFrame.contentWindow?.focus();
      hiddenFrame.contentWindow?.print();
    };
    document.body.appendChild(hiddenFrame);
    setTimeout(() => {
      document.body.removeChild(hiddenFrame);
      URL.revokeObjectURL(objectUrl);
    }, 60_000);
  }

  function handlePrintKecil() {
    if (blobKecil) printBlobSilently(blobKecil);
  }

  function handlePrintNoSignature() {
    if (blobNoSignature) printBlobSilently(blobNoSignature);
  }

  function handleDownload() {
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  return (
    <Modal open={open} title="Pratinjau Hasil USG" onClose={onClose} size="xl">
      <div className="pdf-preview__toolbar">
        <button type="button" className="btn btn--primary btn--sm" onClick={handlePrint}>
          Cetak
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={handlePrintKecil} disabled={!blobKecil}>
          Cetak Kertas Kecil
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handlePrintNoSignature}
          disabled={!blobNoSignature}
        >
          Cetak Tanpa TTD
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={handleDownload}>
          Unduh PDF
        </button>
      </div>
      {url ? (
        <iframe ref={iframeRef} title="Pratinjau PDF USG" className="pdf-preview__frame" src={url} />
      ) : (
        <p className="loading-text">Menyiapkan PDF…</p>
      )}
    </Modal>
  );
}
