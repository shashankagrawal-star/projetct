export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const ACTOR_KEY = 'workbench.actor';
export const getActor = (): string => {
  try {
    return localStorage.getItem(ACTOR_KEY) || 'reviewer';
  } catch {
    return 'reviewer';
  }
};
export const setActor = (name: string): void => {
  try {
    localStorage.setItem(ACTOR_KEY, name);
  } catch {
    /* storage unavailable: attribution falls back to the default */
  }
};

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-actor': getActor(), ...extraHeaders },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON error page from a proxy */
    }
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', path, body ?? {}, headers);

export const errorMessage = (err: unknown): string => (err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong');

export function blockerList(err: unknown): string[] {
  if (err instanceof ApiError && Array.isArray(err.details)) {
    return err.details.map((d: any) => (typeof d === 'object' && d && 'message' in d ? String(d.message) : JSON.stringify(d)));
  }
  return [];
}
