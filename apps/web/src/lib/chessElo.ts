import type { Difficulty } from './chessAi.ts';

export type HasilCatur = 'menang' | 'kalah' | 'seri';

/** Rating pemain dan lawan (per tingkat kesulitan) beserta rekap hasil. */
export interface EloState {
  readonly rating: number;
  readonly menang: number;
  readonly kalah: number;
  readonly seri: number;
  readonly lawan: Readonly<Record<Difficulty, number>>;
}

export interface EloDelta {
  readonly saya: number;
  readonly lawan: number;
}

export const ELO_AWAL_PEMAIN = 1200;

/** Rating awal komputer; nama pemain dunia hanya label, kekuatannya ikut tingkat kesulitan. */
export const ELO_AWAL_LAWAN: Readonly<Record<Difficulty, number>> = {
  mudah: 800,
  sedang: 1200,
  sulit: 1600,
  master: 2000,
};

/** Faktor K standar untuk pemain non-master: satu partai menggeser rating paling banyak 32 poin. */
export const ELO_K = 32;

const SKOR: Readonly<Record<HasilCatur, number>> = { menang: 1, seri: 0.5, kalah: 0 };
const DIFFICULTIES: readonly Difficulty[] = ['mudah', 'sedang', 'sulit', 'master'];

export function initialEloState(): EloState {
  return { rating: ELO_AWAL_PEMAIN, menang: 0, kalah: 0, seri: 0, lawan: ELO_AWAL_LAWAN };
}

/** Peluang menang menurut rumus Elo (0..1). */
export function expectedScore(rating: number, ratingLawan: number): number {
  return 1 / (1 + 10 ** ((ratingLawan - rating) / 400));
}

/** Perubahan rating kedua pihak untuk satu hasil; jumlahnya selalu nol. */
export function eloDelta(rating: number, ratingLawan: number, hasil: HasilCatur): EloDelta {
  const saya = Math.round(ELO_K * (SKOR[hasil] - expectedScore(rating, ratingLawan)));
  // `0 - saya` (bukan `-saya`) supaya hasil nol tidak menjadi -0.
  return { saya, lawan: 0 - saya };
}

export function applyEloResult(state: EloState, difficulty: Difficulty, hasil: HasilCatur): EloState {
  const delta = eloDelta(state.rating, state.lawan[difficulty], hasil);
  return {
    rating: state.rating + delta.saya,
    menang: state.menang + (hasil === 'menang' ? 1 : 0),
    kalah: state.kalah + (hasil === 'kalah' ? 1 : 0),
    seri: state.seri + (hasil === 'seri' ? 1 : 0),
    lawan: { ...state.lawan, [difficulty]: state.lawan[difficulty] + delta.lawan },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Baca rating tersimpan; data kosong atau rusak kembali ke rating awal. */
export function parseEloState(raw: string | null): EloState {
  if (!raw) return initialEloState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return initialEloState();
  }
  if (!isRecord(parsed)) return initialEloState();
  const { rating, menang, kalah, seri, lawan } = parsed;
  if (!isRating(rating) || !isCount(menang) || !isCount(kalah) || !isCount(seri) || !isRecord(lawan)) {
    return initialEloState();
  }
  const ratings: Record<Difficulty, number> = { ...ELO_AWAL_LAWAN };
  for (const level of DIFFICULTIES) {
    const value = lawan[level];
    if (!isRating(value)) return initialEloState();
    ratings[level] = value;
  }
  return { rating, menang, kalah, seri, lawan: ratings };
}
