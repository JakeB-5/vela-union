// Thin HTTP helpers using native fetch (Node >= 22).

export interface HttpResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export async function getJson<T>(url: string, timeoutMs = 5000): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      // Non-JSON response — surface as error but keep status.
      return { ok: false, status: res.status, data: null, error: `non-JSON body: ${text.slice(0, 200)}` };
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs = 30_000,
): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      return { ok: false, status: res.status, data: null, error: `non-JSON body: ${text.slice(0, 200)}` };
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : text };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll a URL until it returns 2xx or the deadline passes. Raw status only, no body parsing. */
export async function waitForHttpOk(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      clearTimeout(timer);
      // network error / connection refused / abort — keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
