import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api.ts';
import { insertTextAt } from '../lib/insertText.ts';
import { filterKesanTemplates } from '../lib/kesanTemplateFilter.ts';
import { Modal } from './ui/Modal.tsx';
import './ui/ui.css';

interface KesanTemplateRow {
  readonly id: string;
  readonly judul: string;
  readonly isi: string;
}

interface KesanEditorModalProps {
  readonly nama: string;
  readonly initialKesan: string;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSave: (kesan: string) => void;
  /** Label tombol simpan, mis. "Pakai Kesan" bila hasilnya hanya mengisi form. */
  readonly submitLabel?: string;
}

/** Editor kesan (dipakai Rad2 dan USG): klik baris Master Kesan di tabel bawah untuk
 * menyisipkan isinya ke posisi kursor pada kotak teks. */
export function KesanEditorModal({
  nama,
  initialKesan,
  saving,
  error,
  onClose,
  onSave,
  submitLabel = 'Simpan Kesan',
}: KesanEditorModalProps) {
  const [kesan, setKesan] = useState(initialKesan);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursorRef = useRef<number | null>(null);

  const [templates, setTemplates] = useState<readonly KesanTemplateRow[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSearch, setTemplateSearch] = useState('');
  const visibleTemplates = filterKesanTemplates(templates, templateSearch);

  const [addOpen, setAddOpen] = useState(false);
  /** Template yang sedang diubah; null berarti form dipakai untuk menambah. */
  const [editingTemplate, setEditingTemplate] = useState<KesanTemplateRow | null>(null);
  const [newJudul, setNewJudul] = useState('');
  const [newIsi, setNewIsi] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    setTemplateError(null);
    try {
      const res = await apiGet<{ items: KesanTemplateRow[] }>('/api/kesan-template?limit=100');
      setTemplates(res.items);
    } catch (err: unknown) {
      setTemplateError(err instanceof Error ? err.message : 'Gagal memuat Master Kesan');
    } finally {
      setLoadingTemplates(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    const cursor = pendingCursorRef.current;
    const el = textareaRef.current;
    if (cursor === null || !el) return;
    pendingCursorRef.current = null;
    el.focus();
    el.setSelectionRange(cursor, cursor);
  }, [kesan]);

  function handlePick(isi: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? kesan.length;
    const end = el?.selectionEnd ?? kesan.length;
    const result = insertTextAt(kesan, isi, start, end);
    pendingCursorRef.current = result.cursor;
    setKesan(result.text);
  }

  function handleClear() {
    pendingCursorRef.current = 0;
    setKesan('');
    // Kalau teks sudah kosong, state tidak berubah sehingga fokus dipindah langsung.
    textareaRef.current?.focus();
  }

  function openAdd() {
    setNewJudul('');
    // Isi awal diambil dari kotak teks supaya kesan yang baru diketik bisa langsung dijadikan template.
    setNewIsi(kesan);
    setEditingTemplate(null);
    setAddError(null);
    setAddOpen(true);
  }

  function openEditTemplate(template: KesanTemplateRow) {
    setNewJudul(template.judul);
    setNewIsi(template.isi);
    setEditingTemplate(template);
    setAddError(null);
    setAddOpen(true);
  }

  function closeTemplateForm() {
    setAddOpen(false);
    setEditingTemplate(null);
  }

  async function handleAdd() {
    if (!newJudul.trim() || !newIsi.trim()) {
      setAddError('Judul dan isi kesan wajib diisi');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const body = { judul: newJudul.trim(), isi: newIsi.trim() };
      if (editingTemplate) {
        await apiPatch(`/api/kesan-template/${editingTemplate.id}`, body);
      } else {
        await apiPost('/api/kesan-template', body);
      }
      closeTemplateForm();
      await loadTemplates();
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : editingTemplate ? 'Gagal mengubah kesan' : 'Gagal menambah kesan');
    } finally {
      setAdding(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave(kesan);
  }

  return (
    <Modal open={true} title={`Edit Kesan — ${nama}`} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="form-grid">
        {error && <div className="alert alert--error form-grid--full">{error}</div>}
        <div className="form-field form-grid--full">
          <label htmlFor="rad2-kesan-editor">Kesan</label>
          <textarea
            id="rad2-kesan-editor"
            ref={textareaRef}
            rows={8}
            value={kesan}
            onChange={(e) => setKesan(e.target.value)}
            placeholder="Ketik kesan, atau klik baris tabel di bawah untuk menyisipkan teks"
          />
        </div>
        <div className="form-actions form-actions--end form-grid--full">
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Menyimpan…' : submitLabel}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Batal
          </button>
          <button type="button" className="btn btn--secondary" onClick={openAdd} disabled={addOpen}>
            + Tambah Kesan
          </button>
          <button type="button" className="btn btn--danger" onClick={handleClear} disabled={kesan === ''}>
            Kosongkan Teks
          </button>
        </div>

        {addOpen && (
          <div
            className="form-grid--full"
            style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0.75rem' }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
              {editingTemplate ? 'Ubah Kesan' : 'Tambah Kesan'}
            </div>
            {addError && (
              <p className="alert alert--error" style={{ marginTop: 0 }}>
                {addError}
              </p>
            )}
            <div className="form-field">
              <label htmlFor="rad2-kesan-baru-judul">Judul *</label>
              <input id="rad2-kesan-baru-judul" value={newJudul} onChange={(e) => setNewJudul(e.target.value)} />
            </div>
            <div className="form-field" style={{ marginTop: '0.5rem' }}>
              <label htmlFor="rad2-kesan-baru-isi">Isi Kesan *</label>
              <textarea id="rad2-kesan-baru-isi" rows={4} value={newIsi} onChange={(e) => setNewIsi(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button type="button" className="btn btn--sm btn--ghost" onClick={closeTemplateForm} disabled={adding}>
                Batal
              </button>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => void handleAdd()} disabled={adding}>
                {adding ? 'Menyimpan...' : editingTemplate ? 'Simpan Perubahan' : 'Simpan Kesan Baru'}
              </button>
            </div>
          </div>
        )}

        <div className="form-field form-grid--full">
          <label htmlFor="rad2-kesan-cari">Pencarian Data</label>
          <input
            id="rad2-kesan-cari"
            type="search"
            value={templateSearch}
            onChange={(e) => setTemplateSearch(e.target.value)}
            placeholder="Cari judul atau isi kesan..."
          />
        </div>

        <div className="form-grid--full" style={{ maxHeight: '320px', overflowY: 'auto' }}>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '48px' }}>No</th>
                <th style={{ width: '30%' }}>Judul</th>
                <th>Isi</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {templateError ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: '1rem', color: '#b91c1c' }}>
                    {templateError}
                  </td>
                </tr>
              ) : loadingTemplates && templates.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: '1rem' }}>
                    Memuat...
                  </td>
                </tr>
              ) : templates.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: '1rem' }}>
                    Belum ada kesan.
                  </td>
                </tr>
              ) : visibleTemplates.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: '1rem' }}>
                    Tidak ada kesan yang cocok dengan pencarian.
                  </td>
                </tr>
              ) : (
                visibleTemplates.map((t, idx) => (
                  <tr
                    key={t.id}
                    onClick={() => handlePick(t.isi)}
                    title="Klik untuk memasukkan ke kotak teks"
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{idx + 1}</td>
                    <td style={{ fontWeight: 600 }}>{t.judul}</td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>{t.isi}</td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn btn--xs btn--secondary"
                        title="Ubah kesan ini"
                        onClick={(e) => {
                          // Jangan ikut menyisipkan teks seperti klik baris.
                          e.stopPropagation();
                          openEditTemplate(t);
                        }}
                      >
                        ✏️ Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </form>
    </Modal>
  );
}
