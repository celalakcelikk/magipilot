export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      <FILL>throw new HttpError(response.status, response.statusText, url);</FILL>
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
