import { describe, expect, test } from 'vitest';
import { filterKesanTemplates } from '../../apps/web/src/lib/kesanTemplateFilter.ts';

const templates = [
  { id: '1', judul: 'Thorax Normal', isi: 'Cor dan pulmo dalam batas normal' },
  { id: '2', judul: 'Bronkitis', isi: 'Corakan bronkovaskuler meningkat' },
  { id: '3', judul: 'TB Paru', isi: 'Infiltrat di apex paru kanan' },
];

describe('filterKesanTemplates', () => {
  test('returns every row when the query is empty or only spaces', () => {
    expect(filterKesanTemplates(templates, '')).toEqual(templates);
    expect(filterKesanTemplates(templates, '   ')).toEqual(templates);
  });

  test('matches the title case-insensitively', () => {
    expect(filterKesanTemplates(templates, 'thorax').map((t) => t.id)).toEqual(['1']);
  });

  test('matches the body text as well', () => {
    expect(filterKesanTemplates(templates, 'PARU').map((t) => t.id)).toEqual(['3']);
    expect(filterKesanTemplates(templates, 'cor').map((t) => t.id)).toEqual(['1', '2']);
  });

  test('returns an empty list when nothing matches', () => {
    expect(filterKesanTemplates(templates, 'fraktur')).toEqual([]);
  });
});
