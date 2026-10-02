import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CetakALModal, type CetakALPasien } from '../components/CetakALModal.tsx';
import { KesanEditorModal } from '../components/KesanEditorModal.tsx';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import { ListPageShell } from '../components/ui/ListPageShell.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { ModalFormFooter } from '../components/ui/ModalFormFooter.tsx';
import { TableRowActions } from '../components/ui/TableRowActions.tsx';
import { useListQueryParams, useListSearch } from '../hooks/useListQueryParams.ts';
import { useMutationReload } from '../hooks/useMutationReload.ts';
import { usePaginatedList } from '../hooks/usePaginatedList.ts';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.ts';
import { formatDateShort, formatRupiah } from '../lib/format.ts';
import type { PaginatedResponse } from '../lib/pagination.ts';
import { formatRadiologName } from '../lib/pasienPrint.ts';
import { rad2FieldsFromPendaftaran, type Rad2PendaftaranSource } from '../lib/rad2Pendaftaran.ts';
import { computeRad2Sharing, type Rad2SharingResult } from '../lib/rad2Sharing.ts';
import { printRadiologyReport } from '../pdf/printRadiologyReport.tsx';
import '../components/ui/ui.css';

interface Rad2Item {
  readonly id: string;
  readonly nama: string;
  readonly umur: number;
  readonly alamat: string | null;
  readonly tanggal: string;
  readonly pemeriksaan: string;
  readonly pengirim: string;
  readonly klinis: string | null;
  readonly kesan: string | null;
  readonly radiologi: string | null;
  readonly harga: string;
  readonly sharing: string;
}

interface Rad2ListResponse extends PaginatedResponse<Rad2Item> {
  readonly totalHarga: string;
  readonly totalSharing: string;
}

interface NamaOption {
  readonly id: string;
  readonly nama: string;
}

interface JenisPemeriksaanOption extends NamaOption {
  readonly harga: string | null;
}

interface PilihanSharingOption {
  readonly id: string;
  readonly nominal: number;
}

interface PendaftaranOption extends Rad2PendaftaranSource {
  readonly id: string;
  readonly noRegistrasi: string;
}

interface Rad2Form {
  readonly nama: string;
  readonly umur: string;
  readonly alamat: string;
  readonly tanggal: string;
  readonly pemeriksaan: string;
  readonly pengirim: string;
  readonly klinis: string;
  readonly kesan: string;
  readonly radiologi: string;
  readonly harga: string;
  readonly sharing: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): Rad2Form {
  return {
    nama: '',
    umur: '',
    alamat: '',
    tanggal: todayIso(),
    pemeriksaan: '',
    pengirim: '',
    klinis: '',
    kesan: '',
    radiologi: '',
    harga: '',
    sharing: '',
  };
}

/** Field yang memengaruhi aturan sharing; mengubahnya menghitung ulang sharing. */
const SHARING_SOURCE_FIELDS: ReadonlySet<keyof Rad2Form> = new Set(['pengirim', 'pemeriksaan', 'umur', 'harga']);

function autoSharingFor(form: Rad2Form): Rad2SharingResult | null {
  if (!form.pengirim.trim() || !form.pemeriksaan.trim() || form.umur.trim() === '') return null;
  return computeRad2Sharing({
    pengirim: form.pengirim,
    pemeriksaan: form.pemeriksaan,
    umur: Number(form.umur),
    harga: Number(form.harga || 0),
  });
}

/** Isi sharing otomatis; nilainya tetap bisa diubah manual sesudahnya. */
function withAutoSharing(form: Rad2Form): Rad2Form {
  const result = autoSharingFor(form);
  return result ? { ...form, sharing: String(result.nominal) } : form;
}

/** Bentuk data yang dipakai modal Cetak A+L; Rad2 tidak punya No. Foto, jadi
 * nomor urut baris dipakai sebagai gantinya (masih bisa diubah di modal). */
function toCetakALPasien(item: Rad2Item, rowNo: number): CetakALPasien {
  return {
    id: item.id,
    regCode: String(rowNo),
    nama: item.nama,
    umur: item.umur,
    tanggalLahir: '',
    createdAt: item.tanggal,
    alamat: item.alamat,
    pengirim: { nama: item.pengirim },
    radiolog: item.radiologi ? { nama: item.radiologi } : null,
    pemeriksaan: [{ nama: item.pemeriksaan }],
  };
}

export function Rad2Page() {
  const { search, setSearch } = useListSearch();
  const queryParams = useListQueryParams({}, search);
  const [totals, setTotals] = useState({ harga: '0', sharing: '0' });
  const onLoaded = useCallback((res: Rad2ListResponse) => {
    setTotals({ harga: res.totalHarga, sharing: res.totalSharing });
  }, []);
  const { items, pagination, setPage, loading, error, setError, reload: reloadList } =
    usePaginatedList<Rad2Item, Rad2ListResponse>('/api/rad2', queryParams, onLoaded);
  const reload = useMutationReload(reloadList);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Rad2Item | null>(null);
  const [deleting, setDeleting] = useState<Rad2Item | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<Rad2Form>(emptyForm);

  const [kesanTarget, setKesanTarget] = useState<Rad2Item | null>(null);
  const [kesanSaving, setKesanSaving] = useState(false);
  const [kesanError, setKesanError] = useState<string | null>(null);

  const [cetakPasien, setCetakPasien] = useState<CetakALPasien | null>(null);
  const [cetakMode, setCetakMode] = useState<'amplop' | 'label'>('amplop');

  const [dokterOptions, setDokterOptions] = useState<readonly NamaOption[]>([]);
  const [radiologOptions, setRadiologOptions] = useState<readonly NamaOption[]>([]);
  const [jenisOptions, setJenisOptions] = useState<readonly JenisPemeriksaanOption[]>([]);
  const [sharingOptions, setSharingOptions] = useState<readonly PilihanSharingOption[]>([]);
  const [pendaftaranOptions, setPendaftaranOptions] = useState<readonly PendaftaranOption[]>([]);

  const loadOptions = useCallback(async () => {
    // Pilihan hanya membantu pengisian; kalau gagal dimuat, form tetap bisa diketik manual.
    const [dokter, radiolog, jenis, sharing, pendaftaran] = await Promise.allSettled([
      apiGet<{ items: NamaOption[] }>('/api/dokter?limit=100'),
      apiGet<{ items: NamaOption[] }>('/api/radiolog?limit=100'),
      apiGet<{ items: JenisPemeriksaanOption[] }>('/api/jenis-pemeriksaan?limit=100'),
      apiGet<{ items: PilihanSharingOption[] }>('/api/pilihan-sharing'),
      apiGet<{ items: PendaftaranOption[] }>('/api/pendaftaran-umum?limit=200'),
    ]);
    setDokterOptions(dokter.status === 'fulfilled' ? dokter.value.items : []);
    setRadiologOptions(radiolog.status === 'fulfilled' ? radiolog.value.items : []);
    setJenisOptions(jenis.status === 'fulfilled' ? jenis.value.items : []);
    setSharingOptions(sharing.status === 'fulfilled' ? sharing.value.items : []);
    setPendaftaranOptions(pendaftaran.status === 'fulfilled' ? pendaftaran.value.items : []);
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  function updateForm(field: keyof Rad2Form, value: string) {
    setForm((f) => {
      const next = { ...f, [field]: value };
      return SHARING_SOURCE_FIELDS.has(field) ? withAutoSharing(next) : next;
    });
  }

  function handlePemeriksaanChange(value: string) {
    const match = jenisOptions.find((j) => j.nama === value);
    setForm((f) =>
      withAutoSharing({
        ...f,
        pemeriksaan: value,
        harga: match?.harga ? String(Math.round(Number(match.harga))) : f.harga,
      }),
    );
  }

  function handlePendaftaranSelect(id: string) {
    const selected = pendaftaranOptions.find((p) => p.id === id);
    if (!selected) return;
    const fields = rad2FieldsFromPendaftaran(selected);
    // Kolom pendaftaran yang kosong tidak menimpa isian yang sudah diketik.
    setForm((f) =>
      withAutoSharing({
        ...f,
        nama: fields.nama,
        umur: fields.umur || f.umur,
        alamat: fields.alamat || f.alamat,
        pengirim: fields.pengirim || f.pengirim,
        klinis: fields.klinis || f.klinis,
      }),
    );
  }

  const sharingRule = autoSharingFor(form);

  function openCreate() {
    setForm(emptyForm());
    setError(null);
    setCreateOpen(true);
  }

  function openEdit(item: Rad2Item) {
    setForm({
      nama: item.nama,
      umur: String(item.umur),
      alamat: item.alamat ?? '',
      tanggal: item.tanggal.slice(0, 10),
      pemeriksaan: item.pemeriksaan,
      pengirim: item.pengirim,
      klinis: item.klinis ?? '',
      kesan: item.kesan ?? '',
      radiologi: item.radiologi ?? '',
      harga: String(Math.round(Number(item.harga))),
      sharing: String(Math.round(Number(item.sharing))),
    });
    setError(null);
    setEditing(item);
  }

  function closeModal() {
    setCreateOpen(false);
    setEditing(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        ...form,
        umur: Number(form.umur),
        harga: Number(form.harga || 0),
        sharing: Number(form.sharing || 0),
      };
      if (editing) {
        await apiPatch(`/api/rad2/${editing.id}`, body);
      } else {
        await apiPost('/api/rad2', body);
      }
      closeModal();
      await reload({ resetPage: !editing });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan data Rad2');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiDelete(`/api/rad2/${deleting.id}`);
      setDeleting(null);
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus data Rad2');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleKesanSave(kesan: string) {
    if (!kesanTarget) return;
    setKesanSaving(true);
    setKesanError(null);
    try {
      // API update memvalidasi seluruh field, jadi field lain dikirim apa adanya.
      await apiPatch(`/api/rad2/${kesanTarget.id}`, {
        nama: kesanTarget.nama,
        umur: kesanTarget.umur,
        alamat: kesanTarget.alamat,
        tanggal: kesanTarget.tanggal.slice(0, 10),
        pemeriksaan: kesanTarget.pemeriksaan,
        pengirim: kesanTarget.pengirim,
        klinis: kesanTarget.klinis,
        kesan,
        radiologi: kesanTarget.radiologi,
        harga: Math.round(Number(kesanTarget.harga)),
        sharing: Math.round(Number(kesanTarget.sharing)),
      });
      setKesanTarget(null);
      await reload();
    } catch (err: unknown) {
      setKesanError(err instanceof Error ? err.message : 'Gagal menyimpan kesan');
    } finally {
      setKesanSaving(false);
    }
  }

  async function handlePrint(item: Rad2Item, rowNo: number) {
    setError(null);
    try {
      await printRadiologyReport({
        regCode: String(rowNo),
        nama: item.nama,
        umurLabel: `${item.umur} tahun`,
        tanggal: formatDateShort(item.tanggal),
        alamat: item.alamat?.trim() || '—',
        pemeriksaan: item.pemeriksaan,
        dokterPengirim: item.pengirim,
        klinis: item.klinis?.trim() || '—',
        kesan: item.kesan?.trim() || '—',
        radiologNama: formatRadiologName(item.radiologi),
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal mencetak hasil');
    }
  }

  function openCetak(item: Rad2Item, rowNo: number, mode: 'amplop' | 'label') {
    setCetakMode(mode);
    setCetakPasien(toCetakALPasien(item, rowNo));
  }

  return (
    <div className="page-frame page-frame--blue">
      <ListPageShell
        title="Rad2"
        subtitle="Register pemeriksaan radiologi beserta harga dan sharing"
        metrics={[
          { label: 'Total data', value: String(pagination.total), tone: 'blue', iconKind: 'clipboard' },
          { label: 'Total Harga', value: formatRupiah(totals.harga), tone: 'green', iconKind: 'currency' },
          { label: 'Total Sharing', value: formatRupiah(totals.sharing), tone: 'amber', iconKind: 'percent' },
        ]}
        searchPlaceholder="Cari nama, pemeriksaan, pengirim, radiologi..."
        searchValue={search}
        onSearchChange={setSearch}
        onRefresh={() => void reload()}
        error={error}
        loading={loading}
        pagination={pagination}
        onPageChange={setPage}
        action={
          <button type="button" className="btn btn--primary" onClick={openCreate}>
            + Tambah Data
          </button>
        }
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>No</th>
              <th>Nama</th>
              <th>Umur</th>
              <th>Alamat</th>
              <th>Tanggal</th>
              <th>Pemeriksaan</th>
              <th>Pengirim</th>
              <th>Klinis</th>
              <th>Kesan</th>
              <th>Radiologi</th>
              <th style={{ textAlign: 'right' }}>Harga</th>
              <th style={{ textAlign: 'right' }}>Sharing</th>
              <th>Aksi</th>
              <th style={{ textAlign: 'center' }}>Cetak</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={14} style={{ textAlign: 'center', padding: '1.5rem' }}>
                  Belum ada data Rad2.
                </td>
              </tr>
            ) : (
              items.map((item, idx) => {
                const rowNo = (pagination.page - 1) * pagination.limit + idx + 1;
                return (
                  <tr key={item.id}>
                    <td>{rowNo}</td>
                    <td style={{ fontWeight: 600 }}>{item.nama}</td>
                    <td>{item.umur} th</td>
                    <td>{item.alamat || '—'}</td>
                    <td>{formatDateShort(item.tanggal)}</td>
                    <td>{item.pemeriksaan}</td>
                    <td>{item.pengirim}</td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>{item.klinis || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                        <span style={{ whiteSpace: 'pre-wrap', flex: 1 }}>{item.kesan || '—'}</span>
                        <button
                          type="button"
                          className="btn btn--xs btn--secondary"
                          onClick={() => {
                            setKesanError(null);
                            setKesanTarget(item);
                          }}
                          title="Edit kesan"
                        >
                          ✏️ Edit
                        </button>
                      </div>
                    </td>
                    <td>{item.radiologi || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatRupiah(item.harga)}</td>
                    <td style={{ textAlign: 'right' }}>{formatRupiah(item.sharing)}</td>
                    <td>
                      <TableRowActions
                        onEdit={() => openEdit(item)}
                        onDelete={() => setDeleting(item)}
                        onPrint={() => void handlePrint(item, rowNo)}
                        editLabel="Ubah data Rad2"
                        deleteLabel="Hapus data Rad2"
                        printLabel="Print hasil"
                      />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                        <button
                          type="button"
                          className="btn btn--xs btn--secondary"
                          onClick={() => openCetak(item, rowNo, 'amplop')}
                          title="Cetak Amplop"
                        >
                          ✉️ Amplop
                        </button>
                        <button
                          type="button"
                          className="btn btn--xs btn--secondary"
                          onClick={() => openCetak(item, rowNo, 'label')}
                          title="Cetak Label"
                        >
                          🏷️ Label
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={10} style={{ textAlign: 'right' }}>
                  Total ({pagination.total} data)
                </td>
                <td style={{ textAlign: 'right' }}>{formatRupiah(totals.harga)}</td>
                <td style={{ textAlign: 'right' }}>{formatRupiah(totals.sharing)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </ListPageShell>

      {(createOpen || editing) && (
        <Modal open={true} title={editing ? 'Ubah Data Rad2' : 'Tambah Data Rad2'} onClose={closeModal}>
          <form onSubmit={(e) => void handleSubmit(e)} className="form-grid">
            {!editing && (
              <div className="form-field form-field--full">
                <label htmlFor="rad2-pendaftaran">Ambil dari Pendaftaran (Opsional)</label>
                <select id="rad2-pendaftaran" value="" onChange={(e) => handlePendaftaranSelect(e.target.value)}>
                  <option value="">-- Pilih Pasien / Ketik Manual di Bawah --</option>
                  {pendaftaranOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.namaPasien} ({p.noRegistrasi})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-field form-field--full">
              <label htmlFor="rad2-nama">Nama *</label>
              <input id="rad2-nama" required value={form.nama} onChange={(e) => updateForm('nama', e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="rad2-umur">Umur (tahun) *</label>
              <input
                id="rad2-umur"
                type="number"
                min="0"
                max="150"
                step="1"
                required
                value={form.umur}
                onChange={(e) => updateForm('umur', e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="rad2-tanggal">Tanggal *</label>
              <input
                id="rad2-tanggal"
                type="date"
                required
                value={form.tanggal}
                onChange={(e) => updateForm('tanggal', e.target.value)}
              />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="rad2-alamat">Alamat</label>
              <input id="rad2-alamat" value={form.alamat} onChange={(e) => updateForm('alamat', e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="rad2-pemeriksaan">Pemeriksaan *</label>
              <input
                id="rad2-pemeriksaan"
                required
                list="rad2-pemeriksaan-list"
                value={form.pemeriksaan}
                onChange={(e) => handlePemeriksaanChange(e.target.value)}
              />
              <datalist id="rad2-pemeriksaan-list">
                {jenisOptions.map((j) => (
                  <option key={j.id} value={j.nama} />
                ))}
              </datalist>
            </div>
            <div className="form-field">
              <label htmlFor="rad2-pengirim">Pengirim *</label>
              <input
                id="rad2-pengirim"
                required
                list="rad2-pengirim-list"
                value={form.pengirim}
                onChange={(e) => updateForm('pengirim', e.target.value)}
              />
              <datalist id="rad2-pengirim-list">
                {dokterOptions.map((d) => (
                  <option key={d.id} value={d.nama} />
                ))}
              </datalist>
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="rad2-klinis">Klinis</label>
              <textarea
                id="rad2-klinis"
                rows={2}
                value={form.klinis}
                onChange={(e) => updateForm('klinis', e.target.value)}
              />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="rad2-kesan">Kesan</label>
              <textarea id="rad2-kesan" rows={4} value={form.kesan} onChange={(e) => updateForm('kesan', e.target.value)} />
            </div>
            <div className="form-field form-field--full">
              <label htmlFor="rad2-radiologi">Radiologi</label>
              <input
                id="rad2-radiologi"
                list="rad2-radiologi-list"
                value={form.radiologi}
                onChange={(e) => updateForm('radiologi', e.target.value)}
              />
              <datalist id="rad2-radiologi-list">
                {radiologOptions.map((r) => (
                  <option key={r.id} value={r.nama} />
                ))}
              </datalist>
            </div>
            <div className="form-field">
              <label htmlFor="rad2-harga">Harga (Rp)</label>
              <input
                id="rad2-harga"
                type="number"
                min="0"
                step="1"
                value={form.harga}
                onChange={(e) => updateForm('harga', e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="rad2-sharing">Sharing (Rp)</label>
              <input
                id="rad2-sharing"
                type="number"
                min="0"
                step="1"
                list="rad2-sharing-list"
                value={form.sharing}
                onChange={(e) => updateForm('sharing', e.target.value)}
              />
              <datalist id="rad2-sharing-list">
                {sharingOptions.map((s) => (
                  <option key={s.id} value={s.nominal} />
                ))}
              </datalist>
              {sharingRule && (
                <small className="form-hint">
                  Otomatis: {formatRupiah(sharingRule.nominal)} ({sharingRule.keterangan})
                  {form.sharing !== String(sharingRule.nominal) && ' — diubah manual'}
                </small>
              )}
            </div>
            <ModalFormFooter
              onCancel={closeModal}
              submitLabel={editing ? 'Simpan Perubahan' : 'Simpan'}
              loading={submitting}
            />
          </form>
        </Modal>
      )}

      <ConfirmModal
        open={deleting !== null}
        title="Hapus Data Rad2"
        message={`Yakin hapus data "${deleting?.nama ?? ''}"? Tindakan ini tidak bisa dibatalkan.`}
        loading={submitting}
        onClose={() => setDeleting(null)}
        onConfirm={() => void handleDeleteConfirm()}
      />

      {kesanTarget && (
        <KesanEditorModal
          key={kesanTarget.id}
          nama={kesanTarget.nama}
          initialKesan={kesanTarget.kesan ?? ''}
          saving={kesanSaving}
          error={kesanError}
          onClose={() => setKesanTarget(null)}
          onSave={(kesan) => void handleKesanSave(kesan)}
        />
      )}

      {/* Dipasang ulang tiap dibuka: CetakALModal hanya membaca initialMode saat mount. */}
      {cetakPasien && (
        <CetakALModal
          key={`${cetakPasien.id}-${cetakMode}`}
          open={true}
          onClose={() => setCetakPasien(null)}
          pasien={cetakPasien}
          initialMode={cetakMode}
        />
      )}
    </div>
  );
}
