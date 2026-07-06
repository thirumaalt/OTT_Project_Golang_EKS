export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8094";

export async function api(path, options = {}) {
  // All gateway routes are mounted under /api — prepend it so callers
  // can use short paths like "/auth/login" instead of "/api/auth/login"
  const normalizedPath = path.startsWith("/api/") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
  const url = new URL(API_BASE + normalizedPath, window.location.origin);

  // Handle query params if passed in options or as a separate arg (backward compat)
  // If options is NOT an object with 'method' or 'body', treat it as params (legacy)
  let config = { headers: { "Accept": "application/json", "Content-Type": "application/json" } };

  if (options.method || options.body || options.headers) {
    // New style: api(path, { method: 'POST', body: {...} })
    const { body, ...rest } = options;
    config = { ...config, ...rest };
    if (body) {
      config.body = JSON.stringify(body);
    }
    // If params exist in options
    if (options.params) {
      Object.entries(options.params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
      });
    }
  } else {
    // Old style: api(path, { param: 'value' })
    Object.entries(options).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });
  }

  const token = localStorage.getItem("token");
  if (token) {
    config.headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, config);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  // Handle empty response for 204 or void
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    // If response is not JSON (e.g. raw token string), return as text
    return text;
  }
}