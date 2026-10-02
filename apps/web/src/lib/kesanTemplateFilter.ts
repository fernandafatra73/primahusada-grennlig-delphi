interface KesanTemplateText {
  readonly judul: string;
  readonly isi: string;
}

/** Saring Master Kesan berdasarkan judul atau isi; kata kunci kosong mengembalikan semua baris. */
export function filterKesanTemplates<T extends KesanTemplateText>(templates: readonly T[], query: string): readonly T[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return templates;
  return templates.filter(
    (t) => t.judul.toLowerCase().includes(keyword) || t.isi.toLowerCase().includes(keyword),
  );
}
