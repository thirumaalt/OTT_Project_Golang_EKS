// Relative paths only — no hardcoded host. Works whether this is reached
// via the ALB, CloudFront, or a local port-forward, with no per-environment
// config needed. (This is the exact fix applied to frontend-ui's Faro
// integration after it shipped with a hardcoded `http://localhost/...` —
// worth not repeating here.)

export async function fetchChecklist() {
  const res = await fetch('/api/checklist')
  if (!res.ok) throw new Error(`Checklist request failed: ${res.status}`)
  return res.json()
}

export async function fetchServices() {
  const res = await fetch('/api/services')
  if (!res.ok) throw new Error(`Services request failed: ${res.status}`)
  return res.json()
}

export async function deployService(serviceName, tag) {
  const res = await fetch(`/api/deploy/${serviceName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `Deploy request failed: ${res.status}`)
  return body
}
