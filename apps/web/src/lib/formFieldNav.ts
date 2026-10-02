import type { KeyboardEvent } from 'react';

/**
 * Navigasi field pakai Enter / panah atas-bawah, meniru form aplikasi klinik
 * lama (mis. Clipper/FoxPro) yang biasa dipakai staf pendaftaran & registrasi.
 * Textarea sengaja dikecualikan supaya Enter/panah tetap bisa dipakai untuk
 * baris baru dan menggerakkan kursor pada catatan klinis yang panjang.
 */
export function handleFormFieldNavKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const target = e.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
  e.preventDefault();
  const focusable = Array.from(
    e.currentTarget.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'),
  ).filter((el) => !el.disabled);
  const index = focusable.indexOf(target);
  if (index === -1) return;
  const nextIndex = e.key === 'ArrowUp' ? index - 1 : index + 1;
  const nextField = focusable[nextIndex];
  if (!nextField) return;
  nextField.focus();
  if (nextField instanceof HTMLInputElement) nextField.select();
}
