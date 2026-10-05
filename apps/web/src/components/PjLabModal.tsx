import { pdf } from '@react-pdf/renderer';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.ts';
import { formatDateShort, formatRupiah } from '../lib/format.ts';
import type { PaginatedResponse } from '../lib/pagination.ts';
import { formatBulanId } from '../lib/pjLab.ts';
import { loadLogoDataUrl } from '../pdf/loadLogoDataUrl.ts';
import { PjLabReportDocument } from '../pdf/PjLabReportDocument.tsx';
import { ConfirmModal } from './ui/ConfirmModal.tsx';
import { Modal } from './ui/Modal.tsx';
import { SharingPdfPreviewModal } from './ui/SharingPdfPreviewModal.tsx';
import { TableRowActions } from './ui/TableRowActions.tsx';

interface PjLabItem {
  readonly id: string;
  readonly bulan: string;
  readonly dokterNama: string;
  readonly jumlah: string;
}

interface DokterItem {
  readonly id: string;
  readonly nama: string;
}

interface PjLabModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const PDF_FILENAME = 'Penanggung_Jawab_Laboratorium.pdf';

function currentBulan(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function emptyForm() {
  return { bulan: currentBulan(), dokterNama: '', jumlah: '' };
}

export function PjLabModal({ open, onClose }: PjLabModalProps) {
  const [items, setItems] = useState<PjLabItem[]>([]);
  const [dokterList, setDokterList] = useState<DokterItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PjLabItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ items: PjLabItem[] }>('/api/pj-lab');
      setItems(res.items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data PJ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEditingId(null);
    setForm(emptyForm());
    void load();
    apiGet<PaginatedResponse<DokterItem>>('/api/dokter?page=1&limit=200')
      .then((res) => setDokterList(res.items))
      .catch(() => setDokterList([]));
  }, [open, load]);

  const total = useMemo(() => items.reduce((sum, p) => sum + (Number(p.jumlah) || 0), 0), [items]);

  function startEdit(item: PjLabItem) {
    setEditingId(item.id);
    setForm({
      bulan: item.bulan,
      dokterNama: item.dokterNama,
      jumlah: item.jumlah,
    });
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      bulan: form.bulan,
      dokterNama: form.dokterNama,
      jumlah: Number(form.jumlah),
    };
    try {
      if (editingId) {
        await apiPatch(`/api/pj-lab/${editingId}`, body);
      } else {
        await apiPost('/api/pj-lab', body);
      }
      setEditingId(null);
      setForm(emptyForm());
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan data PJ');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await apiDelete(`/api/pj-lab/${deleteTarget.id}`);
      if (editingId === deleteTarget.id) cancelEdit();
      setDeleteTarget(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus data PJ');
    } finally {
      setDeleting(false);
    }
  }

  async function buildPdfBlob(): Promise<Blob> {
    const logoSrc = await loadLogoDataUrl();
    return pdf(
      <PjLabReportDocument
        data={{
          logoSrc,
          tanggalCetak: formatDateShort(new Date().toISOString()),
          items: items.map((p, idx) => ({
            no: idx + 1,
            bulan: formatBulanId(p.bulan),
            dokterNama: p.dokterNama,
            jumlahFormatted: formatRupiah(p.jumlah),
          })),
          totalFormatted: formatRupiah(total),
        }}
      />,
    ).toBlob();
  }

  async function handlePreview() {
    setPdfBusy(true);
    try {
      setPreviewBlob(await buildPdfBlob());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal membuat PDF');
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <>
      <Modal open={open} title="PJ Laboratorium" onClose={onClose} size="xl">
        <form onSubmit={(e) => void handleSubmit(e)} className="form-grid">
          <div className="form-field">
            <label htmlFor="pj-bulan">Bulan *</label>
            <input
              id="pj-bulan"
              type="month"
              required
              value={form.bulan}
              onChange={(e) => setForm((f) => ({ ...f, bulan: e.target.value }))}
            />
          </div>
          <div className="form-field">
            <label htmlFor="pj-dokter">Nama Dokter *</label>
            <input
              id="pj-dokter"
              required
              list="pj-dokter-list"
              value={form.dokterNama}
              onChange={(e) => setForm((f) => ({ ...f, dokterNama: e.target.value }))}
            />
            <datalist id="pj-dokter-list">
              {dokterList.map((d) => (
                <option key={d.id} value={d.nama} />
              ))}
            </datalist>
          </div>
          <div className="form-field">
            <label htmlFor="pj-jumlah">Jumlah (Rp) *</label>
            <input
              id="pj-jumlah"
              type="number"
              min="0"
              step="1"
              required
              value={form.jumlah}
              onChange={(e) => setForm((f) => ({ ...f, jumlah: e.target.value }))}
            />
          </div>
          <div className="form-actions form-actions--end form-grid--full">
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Menyimpan…' : editingId ? 'Simpan Perubahan' : '+ Tambah'}
            </button>
            {editingId && (
              <button type="button" className="btn btn--ghost" onClick={cancelEdit}>
                Batal Ubah
              </button>
            )}
          </div>
        </form>

        {error && (
          <p className="form-error" role="alert" style={{ color: '#b91c1c', margin: '0.5rem 0' }}>
            {error}
          </p>
        )}

        <table className="data-table" style={{ marginTop: '1rem' }}>
          <thead>
            <tr>
              <th style={{ width: '50px' }}>No</th>
              <th>Bulan</th>
              <th>Nama Dokter</th>
              <th style={{ textAlign: 'right' }}>Jumlah</th>
              <th style={{ width: '70px' }}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '1.5rem', color: '#64748b' }}>
                  {loading ? 'Memuat…' : 'Belum ada data PJ.'}
                </td>
              </tr>
            ) : (
              items.map((p, idx) => (
                <tr key={p.id} style={p.id === editingId ? { background: '#fef9c3' } : undefined}>
                  <td>{idx + 1}</td>
                  <td>{formatBulanId(p.bulan)}</td>
                  <td>{p.dokterNama}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatRupiah(p.jumlah)}</td>
                  <td>
                    <TableRowActions
                      onEdit={() => startEdit(p)}
                      editLabel="Ubah data PJ"
                      onDelete={() => setDeleteTarget(p)}
                      deleteLabel="Hapus data PJ"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={3} style={{ textAlign: 'right', fontWeight: 700 }}>
                  Total
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatRupiah(total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>

        <div className="form-actions form-actions--end" style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handlePreview()}
            disabled={pdfBusy}
          >
            {pdfBusy ? 'Membuat PDF…' : '🖨️ Cetak PDF (Kop Surat)'}
          </button>
        </div>
      </Modal>

      <ConfirmModal
        open={deleteTarget !== null}
        title="Hapus Data PJ"
        message={`Yakin hapus data PJ ${deleteTarget ? formatBulanId(deleteTarget.bulan) : ''} — ${deleteTarget?.dokterNama ?? ''}?`}
        loading={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeleteConfirm()}
      />

      <SharingPdfPreviewModal
        open={previewBlob !== null}
        blob={previewBlob}
        filename={PDF_FILENAME}
        onClose={() => setPreviewBlob(null)}
        title="Pratinjau Penanggung Jawab Laboratorium"
      />
    </>
  );
}
