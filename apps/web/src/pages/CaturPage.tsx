import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PROMOTION_CHOICES,
  applyMove,
  gameStatus,
  generateMoves,
  initialPosition,
  isGameOver,
  moveToSan,
  opposite,
  type Color,
  type GameStatus,
  type Move,
  type PieceType,
  type Position,
  type Square,
} from '../lib/chess.ts';
import { ChessBoard, PIECE_GLYPH } from '../components/ChessBoard.tsx';
import { CaturTonton } from '../components/CaturTonton.tsx';
import { DIFFICULTY_LABELS, chooseMove, type Difficulty } from '../lib/chessAi.ts';
import {
  DEFAULT_TIME_CONTROL_ID,
  TIME_CONTROLS,
  findTimeControl,
  formatClock,
  isLowTime,
} from '../lib/chessClock.ts';
import {
  applyEloResult,
  eloDelta,
  initialEloState,
  parseEloState,
  type EloDelta,
  type EloState,
  type HasilCatur,
} from '../lib/chessElo.ts';
import { ConfirmModal } from '../components/ui/ConfirmModal.tsx';
import '../components/ui/ui.css';


/** Pemain dunia yang bisa dipilih sebagai lawan. */
const WORLD_PLAYERS: readonly string[] = [
  'Magnus Carlsen',
  'Garry Kasparov',
  'Bobby Fischer',
  'Anatoly Karpov',
  'Viswanathan Anand',
  'Vladimir Kramnik',
  'Mikhail Tal',
  'José Raúl Capablanca',
  'Emanuel Lasker',
  'Alexander Alekhine',
  'Judit Polgár',
  'Ding Liren',
  'Hikaru Nakamura',
  'Hou Yifan',
];

const COLOR_LABEL: Record<Color, string> = { w: 'Putih', b: 'Hitam' };

const STATUS_TEXT: Record<GameStatus, string> = {
  playing: 'Permainan berjalan',
  check: 'Skak!',
  checkmate: 'Skakmat',
  stalemate: 'Remis — raja buntu (stalemate)',
  'insufficient-material': 'Remis — bidak tidak cukup untuk menang',
  'fifty-move': 'Remis — 50 langkah tanpa makan atau jalan pion',
};

const TICK_MS = 200;

const ELO_STORAGE_KEY = 'labprima.caturElo';

function loadEloState(): EloState {
  try {
    return parseEloState(window.localStorage.getItem(ELO_STORAGE_KEY));
  } catch {
    // Penyimpanan browser bisa diblokir (mode privat); rating tetap jalan tanpa disimpan.
    return initialEloState();
  }
}

function saveEloState(state: EloState): void {
  try {
    window.localStorage.setItem(ELO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Lihat loadEloState: gagal menyimpan tidak boleh mengganggu permainan.
  }
}

function formatDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

interface GameSnapshot {
  readonly position: Position;
  /** Langkah yang menghasilkan posisi ini, untuk menyorot langkah terakhir. */
  readonly lastMove: Move | null;
  readonly san: string | null;
}

interface Clocks {
  readonly w: number;
  readonly b: number;
}

function initialSnapshot(): GameSnapshot {
  return { position: initialPosition(), lastMove: null, san: null };
}

/** Pasangan langkah putih–hitam per nomor giliran, untuk tabel riwayat. */
function toMovePairs(sans: readonly string[]): readonly (readonly [number, string, string])[] {
  const pairs: [number, string, string][] = [];
  for (let i = 0; i < sans.length; i += 2) {
    pairs.push([i / 2 + 1, sans[i] ?? '', sans[i + 1] ?? '']);
  }
  return pairs;
}

export function CaturPage() {
  const [mode, setMode] = useState<'main' | 'tonton'>('main');
  const [history, setHistory] = useState<readonly GameSnapshot[]>([initialSnapshot()]);
  const [playerColor, setPlayerColor] = useState<Color>('w');
  const [difficulty, setDifficulty] = useState<Difficulty>('sedang');
  const [selected, setSelected] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [thinking, setThinking] = useState(false);

  const [namaPemain, setNamaPemain] = useState('Anda');
  const [namaLawan, setNamaLawan] = useState<string>(WORLD_PLAYERS[0] as string);

  const [timeControlId, setTimeControlId] = useState(DEFAULT_TIME_CONTROL_ID);
  const timeControl = findTimeControl(timeControlId);
  const [clocks, setClocks] = useState<Clocks | null>(null);
  const [flagged, setFlagged] = useState<Color | null>(null);

  const [elo, setElo] = useState<EloState>(loadEloState);
  /** Perubahan rating dari partai yang baru selesai; null selama partai berjalan. */
  const [eloChange, setEloChange] = useState<EloDelta | null>(null);
  const [resetEloOpen, setResetEloOpen] = useState(false);
  const eloRecordedRef = useRef(false);

  const current = history[history.length - 1] ?? initialSnapshot();
  const position = current.position;
  const status = useMemo(() => gameStatus(position), [position]);
  const over = isGameOver(status) || flagged !== null;
  const legalMoves = useMemo(() => generateMoves(position), [position]);

  const sans = useMemo(
    () => history.map((h) => h.san).filter((s): s is string => s !== null),
    [history],
  );

  const playerTurn = position.turn === playerColor;
  const started = history.length > 1;

  const resetClocks = useCallback((ms: number | null) => {
    setClocks(ms === null ? null : { w: ms, b: ms });
    setFlagged(null);
  }, []);

  const startNewGame = useCallback(
    (color: Color, controlId: string) => {
      setHistory([initialSnapshot()]);
      setSelected(null);
      setPendingPromotion(null);
      setPlayerColor(color);
      setTimeControlId(controlId);
      resetClocks(findTimeControl(controlId).ms);
      eloRecordedRef.current = false;
      setEloChange(null);
    },
    [resetClocks],
  );

  const pushMove = useCallback((move: Move) => {
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      return [
        ...prev,
        {
          position: applyMove(last.position, move),
          lastMove: move,
          san: moveToSan(last.position, move),
        },
      ];
    });
    setSelected(null);
  }, []);

  // Jam hanya berjalan setelah langkah pertama, supaya waktu tidak habis
  // selagi papan masih dibaca.
  useEffect(() => {
    if (!clocks || over || !started) return;
    const turn = position.turn;
    const timer = setInterval(() => {
      setClocks((prev) => (prev ? { ...prev, [turn]: Math.max(0, prev[turn] - TICK_MS) } : prev));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [clocks !== null, over, started, position.turn]);

  useEffect(() => {
    if (!clocks || flagged) return;
    if (clocks.w === 0) setFlagged('w');
    else if (clocks.b === 0) setFlagged('b');
  }, [clocks, flagged]);

  // Giliran komputer dijalankan lewat timer supaya papan sempat tergambar
  // ulang dulu; pencarian langkah memblokir thread selama beberapa ratus ms.
  const thinkingRef = useRef(false);
  useEffect(() => {
    if (over || playerTurn || thinkingRef.current) return;
    thinkingRef.current = true;
    setThinking(true);

    const timer = setTimeout(() => {
      const move = chooseMove(position, difficulty);
      if (move) pushMove(move);
      thinkingRef.current = false;
      setThinking(false);
    }, 120);

    return () => {
      clearTimeout(timer);
      thinkingRef.current = false;
      setThinking(false);
    };
  }, [position, playerTurn, over, difficulty, pushMove]);

  const movesForSelected = useMemo(
    () => (selected === null ? [] : legalMoves.filter((m) => m.from === selected)),
    [legalMoves, selected],
  );

  function handleSquareClick(sq: Square) {
    if (over || thinking || !playerTurn) return;

    const target = movesForSelected.filter((m) => m.to === sq);
    if (target.length > 0) {
      if (target.some((m) => m.promotion)) {
        setPendingPromotion({ from: selected as Square, to: sq });
        return;
      }
      pushMove(target[0] as Move);
      return;
    }

    const piece = position.board[sq];
    setSelected(piece && piece.color === position.turn ? sq : null);
  }

  function completePromotion(type: PieceType) {
    if (!pendingPromotion) return;
    const move = legalMoves.find(
      (m) =>
        m.from === pendingPromotion.from && m.to === pendingPromotion.to && m.promotion === type,
    );
    setPendingPromotion(null);
    if (move) pushMove(move);
  }

  /** Mundur dua langkah (langkah komputer dan langkah sendiri) supaya giliran
   * kembali ke pemain. */
  function undo() {
    setHistory((prev) => {
      if (prev.length <= 1) return prev;
      const back = prev.length > 2 && prev[prev.length - 1]?.position.turn === playerColor ? 2 : 1;
      return prev.slice(0, Math.max(1, prev.length - back));
    });
    setSelected(null);
  }

  const flipped = playerColor === 'b';
  const targetSquares = new Set(movesForSelected.map((m) => m.to));
  const advantage = useMemo(() => materialAdvantage(position), [position]);

  const opponentColor = opposite(playerColor);
  const winner = status === 'checkmate' ? opposite(position.turn) : flagged ? opposite(flagged) : null;
  const nameOf = (color: Color) => (color === playerColor ? namaPemain || 'Anda' : namaLawan);

  // Rating dihitung sekali per partai, saat partai selesai. Ref dipakai supaya
  // efek yang terpicu ulang (mis. ganti tingkat kesulitan) tidak menghitung dua kali.
  useEffect(() => {
    if (!over || eloRecordedRef.current) return;
    eloRecordedRef.current = true;
    const hasil: HasilCatur = winner === null ? 'seri' : winner === playerColor ? 'menang' : 'kalah';
    const next = applyEloResult(elo, difficulty, hasil);
    setEloChange(eloDelta(elo.rating, elo.lawan[difficulty], hasil));
    setElo(next);
    saveEloState(next);
  }, [over, winner, playerColor, difficulty, elo]);

  function resetElo() {
    const next = initialEloState();
    setElo(next);
    setEloChange(null);
    saveEloState(next);
    setResetEloOpen(false);
  }

  const ratingLawan = elo.lawan[difficulty];
  const jikaMenang = eloDelta(elo.rating, ratingLawan, 'menang').saya;
  const jikaSeri = eloDelta(elo.rating, ratingLawan, 'seri').saya;
  const jikaKalah = eloDelta(elo.rating, ratingLawan, 'kalah').saya;

  const statusLine = flagged
    ? `Waktu ${COLOR_LABEL[flagged]} habis — ${nameOf(opposite(flagged))} menang`
    : over
      ? winner
        ? `Skakmat — ${nameOf(winner)} menang`
        : STATUS_TEXT[status]
      : thinking
        ? `${namaLawan} sedang berpikir…`
        : `Giliran ${nameOf(position.turn)}${status === 'check' ? ' — Skak!' : ''}`;

  const modeTabs = (
    <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem' }}>
      {([
        ['main', '♟️ Main Catur'],
        ['tonton', '📺 Tonton Pertandingan'],
      ] as const).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={`btn btn--sm ${mode === id ? 'btn--primary' : 'btn--ghost'}`}
          onClick={() => setMode(id)}
          style={mode !== id ? { border: '1px solid var(--color-border)' } : undefined}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (mode === 'tonton') {
    return (
      <>
        {modeTabs}
        <CaturTonton />
      </>
    );
  }

  return (
    <>
      {modeTabs}
    <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div>
        <PlayerBar
          name={namaLawan}
          rating={ratingLawan}
          color={opponentColor}
          clockMs={clocks ? clocks[opponentColor] : null}
          active={!over && position.turn === opponentColor}
        />

        <ChessBoard
          position={position}
          flipped={flipped}
          selected={selected}
          targets={targetSquares}
          lastMove={current.lastMove}
          onSquareClick={handleSquareClick}
        />

        <PlayerBar
          name={namaPemain || 'Anda'}
          rating={elo.rating}
          color={playerColor}
          clockMs={clocks ? clocks[playerColor] : null}
          active={!over && position.turn === playerColor}
        />

        <p
          style={{ margin: '0.5rem 0 0', fontWeight: 700, color: over ? '#b91c1c' : 'inherit' }}
          aria-live="polite"
        >
          {statusLine}
        </p>
        <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: '#64748b' }}>
          Anda bermain {COLOR_LABEL[playerColor]} · Lawan {DIFFICULTY_LABELS[difficulty]} ·{' '}
          {timeControl.label}
          {advantage !== 0 && ` · Selisih materi ${advantage > 0 ? '+' : ''}${advantage}`}
        </p>
      </div>

      <div style={{ minWidth: '16rem', flex: '1 1 16rem' }}>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => startNewGame(playerColor, timeControlId)}
          >
            ♟️ Permainan Baru
          </button>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            onClick={undo}
            disabled={history.length <= 1 || thinking || over}
          >
            ↩️ Batalkan Langkah
          </button>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            onClick={() => startNewGame(opposite(playerColor), timeControlId)}
          >
            🔄 Main sebagai {COLOR_LABEL[opposite(playerColor)]}
          </button>
        </div>

        <fieldset className="legacy-groupbox" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
          <legend>Elo Rating</legend>
          <table className="table table--compact" style={{ width: '100%' }}>
            <tbody>
              <tr>
                <td>Elo {namaPemain || 'Anda'}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>
                  {elo.rating}
                  {eloChange && ` (${formatDelta(eloChange.saya)})`}
                </td>
              </tr>
              <tr>
                <td>
                  Elo {namaLawan} ({DIFFICULTY_LABELS[difficulty]})
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>
                  {ratingLawan}
                  {eloChange && ` (${formatDelta(eloChange.lawan)})`}
                </td>
              </tr>
              <tr>
                <td>Menang / Kalah / Seri</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>
                  {elo.menang} / {elo.kalah} / {elo.seri}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="form-hint" style={{ margin: '0.4rem 0' }}>
            Partai berikutnya: menang {formatDelta(jikaMenang)}, seri {formatDelta(jikaSeri)}, kalah{' '}
            {formatDelta(jikaKalah)}. Rating dihitung saat partai selesai; partai yang ditinggalkan tidak
            dihitung.
          </p>
          <button type="button" className="btn btn--xs btn--danger" onClick={() => setResetEloOpen(true)}>
            Reset Rating
          </button>
        </fieldset>

        <div className="form-field" style={{ marginBottom: '0.6rem' }}>
          <label htmlFor="catur-nama">Nama Anda</label>
          <input
            id="catur-nama"
            value={namaPemain}
            onChange={(e) => setNamaPemain(e.target.value)}
            placeholder="Anda"
          />
        </div>

        <div className="form-field" style={{ marginBottom: '0.6rem' }}>
          <label htmlFor="catur-lawan">Lawan</label>
          <select id="catur-lawan" value={namaLawan} onChange={(e) => setNamaLawan(e.target.value)}>
            {WORLD_PLAYERS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p className="form-hint">
            Nama pemain dunia hanya dipakai sebagai label lawan; kekuatan mainnya diatur lewat
            tingkat kesulitan di bawah.
          </p>
        </div>

        <div className="form-field" style={{ marginBottom: '0.6rem' }}>
          <label htmlFor="catur-waktu">Waktu Permainan</label>
          <select
            id="catur-waktu"
            value={timeControlId}
            onChange={(e) => startNewGame(playerColor, e.target.value)}
          >
            {TIME_CONTROLS.map((tc) => (
              <option key={tc.id} value={tc.id}>
                {tc.label}
              </option>
            ))}
          </select>
          <p className="form-hint">
            Jam mulai berjalan setelah langkah pertama. Mengubah pilihan ini memulai permainan baru.
          </p>
        </div>

        <div className="form-field" style={{ marginBottom: '0.75rem' }}>
          <label htmlFor="catur-level">Tingkat Kesulitan</label>
          <select
            id="catur-level"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
          >
            {(Object.keys(DIFFICULTY_LABELS) as Difficulty[]).map((level) => (
              <option key={level} value={level}>
                {DIFFICULTY_LABELS[level]}
              </option>
            ))}
          </select>
          <p className="form-hint">
            Makin tinggi tingkatnya, makin dalam komputer menghitung dan makin lama berpikir.
          </p>
        </div>

        <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.95rem' }}>Riwayat Langkah</h3>
        {sans.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>
            Belum ada langkah. Klik bidak Anda untuk melihat langkah yang boleh dijalankan.
          </p>
        ) : (
          <div style={{ maxHeight: '16rem', overflowY: 'auto' }}>
            <table className="table table--compact">
              <thead>
                <tr>
                  <th style={{ width: '3rem' }}>#</th>
                  <th>Putih</th>
                  <th>Hitam</th>
                </tr>
              </thead>
              <tbody>
                {toMovePairs(sans).map(([no, white, black]) => (
                  <tr key={no}>
                    <td>{no}</td>
                    <td>{white}</td>
                    <td>{black}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={resetEloOpen}
        title="Reset Elo Rating"
        message="Rating Anda, rating lawan, dan rekap menang/kalah/seri akan kembali ke awal. Lanjutkan?"
        confirmLabel="Reset"
        onClose={() => setResetEloOpen(false)}
        onConfirm={resetElo}
      />

      {pendingPromotion && (
        <div
          role="dialog"
          aria-label="Pilih bidak promosi"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div style={{ background: '#fff', padding: '1rem 1.25rem', borderRadius: '10px' }}>
            <p style={{ marginTop: 0, fontWeight: 700 }}>Pion promosi menjadi:</p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {PROMOTION_CHOICES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => completePromotion(type)}
                  style={{ fontSize: '1.8rem', lineHeight: 1, padding: '0.3rem 0.6rem' }}
                >
                  {PIECE_GLYPH[type]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

interface PlayerBarProps {
  readonly name: string;
  readonly rating: number;
  readonly color: Color;
  readonly clockMs: number | null;
  readonly active: boolean;
}

function PlayerBar({ name, rating, color, clockMs, active }: PlayerBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        padding: '0.35rem 0.6rem',
        margin: '0.35rem 0',
        borderRadius: '6px',
        background: active ? '#fef3c7' : '#f1f5f9',
        border: `1px solid ${active ? '#f2c14e' : 'var(--color-border)'}`,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
        <span
          style={{
            width: '0.85rem',
            height: '0.85rem',
            borderRadius: '50%',
            background: color === 'w' ? '#fffdf7' : '#1b1b1b',
            border: '1px solid #64748b',
            display: 'inline-block',
          }}
          aria-hidden="true"
        />
        {name}
        <span style={{ fontWeight: 400, color: '#475569' }}>({rating})</span>
      </span>
      {clockMs !== null && (
        <span
          style={{
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 700,
            fontSize: '1.05rem',
            color: isLowTime(clockMs) ? '#b91c1c' : '#0f172a',
          }}
        >
          {formatClock(clockMs)}
        </span>
      )}
    </div>
  );
}

const MATERIAL_VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Selisih materi putih dikurangi hitam, dihitung dari bidak yang masih ada. */
function materialAdvantage(pos: Position): number {
  let advantage = 0;
  for (const piece of pos.board) {
    if (!piece) continue;
    advantage += piece.color === 'w' ? MATERIAL_VALUE[piece.type] : -MATERIAL_VALUE[piece.type];
  }
  return advantage;
}
