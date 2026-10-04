export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    body: string,
  ) {
    super(body || `HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export interface JsonRequestOptions {
  method?: string;
  headers?: HeadersInit;
  params?: Record<string, string | number>;
  body?: unknown;
}

export async function httpRequest(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const response = await fetch(url, {
    redirect: 'error',
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new HttpError(response.status, response.headers, await response.text());
  }
  return response;
}

export async function jsonRequest<T>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const target = new URL(url);
  for (const [name, value] of Object.entries(options.params ?? {})) {
    target.searchParams.set(name, String(value));
  }
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await httpRequest(target, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  try {
    return (await response.json()) as T;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new HttpError(
        response.status,
        response.headers,
        `Invalid JSON response: ${err.message}`,
      );
    }
    throw err;
  }
}
