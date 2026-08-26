'use client';

import { useState, useTransition } from 'react';
import { login } from '@/app/auth-actions';
import { KeyRound, Lock, ShieldCheck } from 'lucide-react';

export default function LoginForm({ needsSetup }: { needsSetup: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'setup'>(needsSetup ? 'setup' : 'login');

  const submit = (fd: FormData) => {
    setError(null);
    start(async () => {
      try {
        const res = mode === 'setup'
          ? await (await import('@/app/auth-actions')).setupOwnerPassword(fd)
          : await login(fd);
        if (res && !res.ok) setError(res.message);
      } catch {
        // Server actions redirect on success; anything else is a failure.
      }
    });
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" action={submit}>
        <div className="auth-brand">
          <div className="auth-mark">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3 L15.5 9 L12 15 L8.5 9 Z" fill="#fff" opacity="0.95" />
              <path d="M4 18.5 H20" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
              <circle cx="12" cy="20.5" r="1" fill="#fff" opacity="0.6" />
            </svg>
          </div>
          <div>
            <div className="auth-name">
              ClientForge<span className="ai">AI</span>
            </div>
            <div className="auth-tag">Discover. Personalize. Convert. Deliver.</div>
          </div>
        </div>

        <h1 className="auth-title">{mode === 'setup' ? 'Set your password' : 'Sign in'}</h1>
        <p className="auth-sub">
          {mode === 'setup'
            ? 'This workspace has no password yet. Choose one to secure it — you will be signed in automatically.'
            : 'Enter your credentials to open your workspace.'}
        </p>

        {error && (
          <div className="banner critical" role="alert">
            <span className="banner-icon">
              <Lock size={15} />
            </span>
            <div>{error}</div>
          </div>
        )}

        <div className="field mt-2">
          <label className="label" htmlFor="email">
            Email
          </label>
          <input className="input" id="email" name="email" type="email" autoComplete="username" required />
        </div>

        <div className="field">
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            className="input"
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            minLength={mode === 'setup' ? 10 : undefined}
            required
          />
          {mode === 'setup' && <span className="hint">At least 10 characters. Add a number or symbol.</span>}
        </div>

        {mode === 'setup' && (
          <div className="field">
            <label className="label" htmlFor="confirm">
              Confirm password
            </label>
            <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
          </div>
        )}

        <button className="btn btn-primary btn-lg btn-block mt-2" type="submit" disabled={pending}>
          {pending ? 'Working…' : mode === 'setup' ? 'Set password & continue' : 'Sign in'}
        </button>

        {needsSetup && mode === 'login' && (
          <button type="button" className="btn btn-block mt-1" onClick={() => setMode('setup')}>
            This workspace needs a password
          </button>
        )}

        <div className="auth-foot">
          <ShieldCheck size={13} />
          <span>
            Passwords are hashed with scrypt. Sessions are opaque tokens stored hashed. Login attempts are rate-limited and logged.
          </span>
        </div>
      </form>
    </div>
  );
}

export { KeyRound };
