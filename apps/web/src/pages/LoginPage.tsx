import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import logoPrimahusada from '@src/image/logo-primahusada.png';
import { LoginTakeoffScene } from '../components/LoginTakeoffScene.tsx';
import { apiPost } from '../lib/api.ts';
import type { AuthUser } from '../lib/auth.ts';
import './login.css';

interface LoginPageProps {
  readonly onLogin: (user: AuthUser) => void;
}

interface LoginResponse {
  readonly user: AuthUser;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [email, setEmail] = useState('admin@primahusada.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  function onEmailKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      passwordRef.current?.focus();
    }
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await apiPost<LoginResponse>('/api/auth/login', { email, password });
      onLogin(result.user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login gagal');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-panel__brand">
          <img src={logoPrimahusada} alt="Klinik Prima Husada" className="login-panel__logo" />
          <p className="login-panel__eyebrow">Klinik Prima Husada</p>
        </div>

        <div className="login-panel__divider" aria-hidden />

        <LoginTakeoffScene />

        <h1 id="login-title" className="login-panel__title">Masuk ke sistem</h1>

        <form className="login-form" onSubmit={(event) => void onSubmit(event)}>
          <div className="form-field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={onEmailKeyDown}
            />
          </div>

          <div className="form-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {error ? <p className="login-form__error">{error}</p> : null}

          <button type="submit" className="btn btn--primary login-form__submit" disabled={loading}>
            {loading ? 'Masuk...' : 'Masuk'}
          </button>
        </form>
      </section>
    </main>
  );
}
