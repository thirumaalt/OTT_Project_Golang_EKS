import { useEffect, useState, useCallback } from 'react'
import { fetchChecklist, fetchServices, deployService } from './api/client'

const REFRESH_INTERVAL_MS = 15000

// Checks that are expected to fail right now for known, already-understood
// reasons (payment-service has no Razorpay credentials yet — not a bug).
// Keeping this as one small list rather than baking the exception into
// the backend keeps the API honest ("this actually failed") while letting
// the UI present it calmly instead of as a fresh alarm every 15 seconds.
const KNOWN_ISSUES = {
  'payment-service': 'Waiting on real Razorpay credentials — not a bug',
  'myflix-razorpay-secret': 'Waiting on real Razorpay credentials — not a bug',
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

function StatusBadge({ status, known }) {
  if (known) return <span className="badge badge-known">KNOWN</span>
  const label = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'UNKNOWN'
  return <span className={`badge badge-${status}`}>{label}</span>
}

function HealthRing({ pass, total }) {
  const pct = total === 0 ? 0 : Math.round((pass / total) * 100)
  const radius = 42
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (pct / 100) * circumference
  const color = pct === 100 ? '#4ade80' : pct >= 90 ? '#facc15' : '#f87171'

  return (
    <div className="health-ring">
      <svg width="110" height="110" viewBox="0 0 110 110">
        <circle cx="55" cy="55" r={radius} fill="none" stroke="#2a2d37" strokeWidth="10" />
        <circle
          cx="55" cy="55" r={radius} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 55 55)"
          style={{ transition: 'stroke-dashoffset 0.4s ease' }}
        />
      </svg>
      <div className="health-ring-label">
        <div className="health-ring-pct">{pct}%</div>
        <div className="health-ring-sub">{pass}/{total}</div>
      </div>
    </div>
  )
}

function HPABar({ current, target }) {
  const over = current > target
  const widthPct = Math.min(100, (current / Math.max(target, 1)) * 100)
  return (
    <div className="hpa-bar-wrap" title={`${current}% of ${target}% target`}>
      <div className="hpa-bar-track">
        <div
          className="hpa-bar-fill"
          style={{ width: `${widthPct}%`, background: over ? '#f87171' : '#4ade80' }}
        />
      </div>
      <span className="hpa-bar-label">{current}% / {target}%</span>
    </div>
  )
}

function ChecklistView() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastChecked, setLastChecked] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [, forceTick] = useState(0) // re-renders just to update the "Xs ago" label

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    fetchChecklist()
      .then((d) => {
        setData(d)
        setLastChecked(new Date())
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Auto-refresh loop
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => load(true), REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [autoRefresh, load])

  // Ticks the "Xs ago" label every few seconds without re-fetching
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 3000)
    return () => clearInterval(id)
  }, [])

  if (loading && !data) return <p className="muted">Running checks…</p>
  if (error) return <p className="error">Error: {error}</p>
  if (!data) return null

  const isKnown = (r) => KNOWN_ISSUES[r.name] !== undefined
  const effectivelyPassing = (r) => r.status === 'pass' || isKnown(r)

  const realPassCount = data.results.filter(effectivelyPassing).length
  const realFailCount = data.results.length - realPassCount

  const categories = []
  const byCategory = {}
  for (const r of data.results) {
    if (failuresOnly && effectivelyPassing(r)) continue
    if (!byCategory[r.category]) {
      byCategory[r.category] = []
      categories.push(r.category)
    }
    byCategory[r.category].push(r)
  }

  return (
    <div>
      <div className="health-header">
        <HealthRing pass={realPassCount} total={data.summary.total} />
        <div className="health-header-text">
          <div className="summary-pass">{realPassCount} healthy</div>
          <div className="summary-fail">{realFailCount} need attention</div>
          {data.summary.fail !== realFailCount && (
            <div className="muted small">
              ({data.summary.fail - realFailCount} of those are known/expected)
            </div>
          )}
        </div>
      </div>

      <div className="summary-bar">
        <label className="toggle">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh (15s)
        </label>
        <label className="toggle">
          <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} />
          Failures only
        </label>
        {lastChecked && <span className="muted">Checked {timeAgo(lastChecked)}</span>}
        <button onClick={() => load()} className="refresh-btn">Refresh now</button>
      </div>

      {categories.length === 0 && (
        <p className="muted">Nothing to show{failuresOnly ? ' — no failures right now.' : '.'}</p>
      )}

      {categories.map((cat) => (
        <div className="category-block" key={cat}>
          <h3>{cat}</h3>
          <table className="check-table">
            <tbody>
              {byCategory[cat].map((r, i) => {
                const known = isKnown(r) && r.status === 'fail'
                return (
                  <tr key={i} className={r.status === 'fail' ? (known ? 'row-known' : 'row-fail') : ''}>
                    <td className="check-name">{r.name}</td>
                    <td><StatusBadge status={r.status} known={known} /></td>
                    <td className="check-detail">
                      {known ? KNOWN_ISSUES[r.name] : r.detail}
                      {r.current != null && r.target != null && (
                        <HPABar current={r.current} target={r.target} />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function ConfirmDialog({ service, tag, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Confirm deploy</h3>
        <p>
          This commits a real change to <code>main</code>, bumping <strong>{service}</strong> to
          tag <code>{tag}</code>. ArgoCD will pick it up on its next sync — it won't apply to the
          cluster instantly, but the commit itself happens right now.
        </p>
        <div className="modal-actions">
          <button onClick={onCancel} className="btn-secondary">Cancel</button>
          <button onClick={onConfirm} className="btn-danger">Commit the change</button>
        </div>
      </div>
    </div>
  )
}

function DeployView() {
  const [services, setServices] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tagInputs, setTagInputs] = useState({})
  const [deployMsg, setDeployMsg] = useState({})
  const [confirming, setConfirming] = useState(null) // { name, tag } | null

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchServices()
      .then((d) => setServices(d.services))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const requestDeploy = (name) => {
    const tag = tagInputs[name]
    if (!tag) {
      setDeployMsg((m) => ({ ...m, [name]: { type: 'error', text: 'Enter a tag first' } }))
      return
    }
    setConfirming({ name, tag })
  }

  const runDeploy = async () => {
    const { name, tag } = confirming
    setConfirming(null)
    setDeployMsg((m) => ({ ...m, [name]: { type: 'pending', text: 'Committing…' } }))
    try {
      const result = await deployService(name, tag)
      setDeployMsg((m) => ({ ...m, [name]: { type: 'ok', text: result.note } }))
    } catch (e) {
      setDeployMsg((m) => ({ ...m, [name]: { type: 'error', text: e.message } }))
    }
  }

  if (loading && services.length === 0) return <p className="muted">Loading services…</p>
  if (error) return <p className="error">Error: {error}</p>

  const behindCount = services.filter((s) => s.behind).length

  return (
    <div>
      <div className="summary-bar">
        <span className="muted">{services.length} services</span>
        {behindCount > 0 ? (
          <span className="summary-fail">{behindCount} behind</span>
        ) : (
          <span className="summary-pass">all up to date</span>
        )}
        <button onClick={load} className="refresh-btn">Refresh</button>
      </div>

      <table className="check-table deploy-table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Deployed</th>
            <th>Latest in ECR</th>
            <th>Status</th>
            <th>Deploy tag</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.name} className={s.behind ? 'row-fail' : ''}>
              <td className="check-name">{s.name}</td>
              <td><code>{s.deployed}</code></td>
              <td><code>{s.latest}</code></td>
              <td>{s.behind ? <span className="badge badge-fail">BEHIND</span> : <span className="badge badge-pass">UP TO DATE</span>}</td>
              <td>
                {s.deployable ? (
                  <div className="deploy-cell">
                    <input
                      type="text"
                      placeholder={s.latest}
                      value={tagInputs[s.name] || ''}
                      onChange={(e) => setTagInputs((t) => ({ ...t, [s.name]: e.target.value }))}
                    />
                    <button onClick={() => requestDeploy(s.name)}>Deploy</button>
                    {deployMsg[s.name] && (
                      <div className={`deploy-msg deploy-msg-${deployMsg[s.name].type}`}>
                        {deployMsg[s.name].text}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="muted">manifest path unknown</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted note">
        Deploying here commits a tag change to git — it does not touch the cluster directly.
        Sync via ArgoCD to actually roll it out.
      </p>

      {confirming && (
        <ConfirmDialog
          service={confirming.name}
          tag={confirming.tag}
          onConfirm={runDeploy}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState('checklist')

  return (
    <div className="app">
      <header>
        <h1>MyFlix Platform Status</h1>
        <nav>
          <button className={tab === 'checklist' ? 'active' : ''} onClick={() => setTab('checklist')}>
            Checklist
          </button>
          <button className={tab === 'deploy' ? 'active' : ''} onClick={() => setTab('deploy')}>
            Deploy
          </button>
        </nav>
      </header>
      <main>
        {tab === 'checklist' ? <ChecklistView /> : <DeployView />}
      </main>
    </div>
  )
}
