export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get forbidden(): boolean {
    return this.status === 403;
  }
}

function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname.startsWith('/login')) return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.assign(`/login?next=${next}`);
}

/**
 * Same-origin JSON fetch through the Next.js rewrite. The browser attaches the session cookie and the Origin
 * header that the server's CSRF check requires. 401 sends the user to /login.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; redirectOn401?: boolean } = {}): Promise<T> {
  const { method = 'GET', body, signal, redirectOn401 = true } = init;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
      cache: 'no-store',
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'The orchestrator API is unreachable. Is the server running?');
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const payload = (data ?? {}) as { error?: string; issues?: Array<{ path: string; message: string }> };
    if (response.status === 401 && redirectOn401) redirectToLogin();
    let message = payload.error ?? `Request failed (${response.status})`;
    if (response.status === 403) message = `Insufficient role: ${payload.error ?? 'you are not allowed to do this'}`;
    if (response.status >= 500 && !payload.error) message = 'The orchestrator API returned an error. Is the server running?';
    if (payload.issues?.length) message = `${message}: ${payload.issues.map((i) => `${i.path || 'body'} ${i.message}`).join('; ')}`;
    throw new ApiError(response.status, message, payload.issues ?? []);
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function qs(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
