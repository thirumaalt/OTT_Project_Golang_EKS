// Relative paths only — no hardcoded host (same lesson as the earlier
// Faro localhost mistake). But since this app is nested behind
// frontend-ui's proxy at /platform-status, bare "/api/..." would collide
// with the MAIN app's own /api/ route (which points at api-gateway, a
// completely different backend). import.meta.env.BASE_URL — set from
// vite.config.js's `base` — makes these resolve to
// /platform-status/api/... instead, routing back through the correct
// proxy path. When run standalone (e.g. local dev, no base set), BASE_URL
// defaults to "/", so this still works unchanged in that case too.

const API_BASE = import.meta.env.BASE_URL

export async function fetchChecklist() {
  const res = await fetch(`${API_BASE}api/checklist`)
  if (!res.ok) throw new Error(`Checklist request failed: ${res.status}`)
  return res.json()
}

export async function fetchServices() {
  const res = await fetch(`${API_BASE}api/services`)
  if (!res.ok) throw new Error(`Services request failed: ${res.status}`)
  return res.json()
}

export async function deployService(serviceName, tag) {
  const res = await fetch(`${API_BASE}api/deploy/${serviceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `Deploy request failed: ${res.status}`)
  return body
}

export async function fetchLogs(serviceName) {
  const res = await fetch(`${API_BASE}api/logs/${serviceName}`)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `Logs request failed: ${res.status}`)
  return body
}
