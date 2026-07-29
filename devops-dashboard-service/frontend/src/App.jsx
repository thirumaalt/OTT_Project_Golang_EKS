import { useEffect, useState, useCallback } from 'react'
import { fetchChecklist, fetchServices, deployService } from './api/client'

function StatusBadge({ status }) {
  const label = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'UNKNOWN'
  return <span className={`badge badge-${status}`}>{label}</span>
}

function ChecklistView() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchChecklist()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading && !data) return <p className="muted">Running checks…</p>
  if (error) return <p className="error">Error: {error}</p>
  if (!data) return null

  // Group flat results into categories, preserving the order they arrived in
  // (matches the order checks actually run in the backend).
  const categories = []
  const byCategory = {}
  for (const r of data.results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = []
      categories.push(r.category)
    }
    byCategory[r.category].push(r)
  }

  return (
    <div>
      <div className="summary-bar">
        <span className="summary-pass">{data.summary.pass} passing</span>
        <span className="summary-fail">{data.summary.fail} failing</span>
        <span className="muted">{data.summary.total} total checks</span>
        <button onClick={load} className="refresh-btn">Refresh</button>
      </div>

      {categories.map((cat) => (
        <div className="category-block" key={cat}>
          <h3>{cat}</h3>
          <table className="check-table">
            <tbody>
              {byCategory[cat].map((r, i) => (
                <tr key={i} className={r.status === 'fail' ? 'row-fail' : ''}>
                  <td className="check-name">{r.name}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="check-detail">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function DeployView() {
  const [services, setServices] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tagInputs, setTagInputs] = useState({})
  const [deployMsg, setDeployMsg] = useState({})

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

  const handleDeploy = async (name) => {
    const tag = tagInputs[name]
    if (!tag) {
      setDeployMsg((m) => ({ ...m, [name]: { type: 'error', text: 'Enter a tag first' } }))
      return
    }
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

  return (
    <div>
      <div className="summary-bar">
        <span className="muted">{services.length} services</span>
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
                    <button onClick={() => handleDeploy(s.name)}>Deploy</button>
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
