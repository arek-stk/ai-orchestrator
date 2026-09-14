'use client';

import { LogIn } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '@/components/providers';
import { Button, ErrorBanner, Field, GitHubMark, inputClass, Loading, OrchestratorMark } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

function safeNext(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

export default function LoginPage() {
  const { user, methods, loading, error, refresh } = useSession();
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (user) router.replace(safeNext());
  }, [user, router]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await api('/api/auth/dev-login', { method: 'POST', body: { login: login.trim() }, redirectOn401: false });
      window.location.assign(safeNext());
    } catch (err) {
      setFormError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-page px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <OrchestratorMark size={32} />
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">Orchestrator</h1>
            <p className="text-xs text-ink-2">Sign in to the control dashboard</p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-6">
          {loading ? (
            <Loading label="Checking session" />
          ) : error ? (
            <ErrorBanner error={error} onRetry={() => void refresh()} />
          ) : (
            <div className="flex flex-col gap-5">
              {methods.github ? (
                <a
                  href="/api/auth/github/login"
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-medium text-page transition-opacity hover:opacity-90"
                >
                  <GitHubMark size={16} />
                  Sign in with GitHub
                </a>
              ) : null}

              {methods.github && methods.dev ? (
                <div className="flex items-center gap-3 text-xs text-ink-2">
                  <span className="h-px flex-1 bg-line" />
                  or
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : null}

              {methods.dev ? (
                <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
                  <Field label="Development login" htmlFor="dev-login" hint="Local development only. The first user becomes owner, later users start as operators.">
                    <input
                      id="dev-login"
                      name="login"
                      required
                      autoComplete="username"
                      pattern="[a-zA-Z0-9\-]{2,39}"
                      title="2 to 39 letters, digits or dashes"
                      value={login}
                      onChange={(e) => setLogin(e.target.value)}
                      className={inputClass}
                      placeholder="e.g. demo"
                    />
                  </Field>
                  {formError ? <ErrorBanner error={formError} /> : null}
                  <Button type="submit" variant={methods.github ? 'secondary' : 'primary'} icon={LogIn} busy={submitting}>
                    Sign in
                  </Button>
                </form>
              ) : null}

              {!methods.github && !methods.dev ? (
                <div className="text-sm text-ink-2">
                  <p className="font-medium text-ink">No sign-in method is configured.</p>
                  <p className="mt-2">Configure one on the API server and restart it:</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    <li>
                      GitHub OAuth: set <code className="font-mono text-xs text-ink">GITHUB_CLIENT_ID</code> and <code className="font-mono text-xs text-ink">GITHUB_CLIENT_SECRET</code>.
                    </li>
                    <li>
                      Local development: set <code className="font-mono text-xs text-ink">ALLOW_DEV_LOGIN=true</code> (ignored in production).
                    </li>
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
