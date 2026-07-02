import React, { useState, useEffect } from 'react'
import { api } from '../api/client'

export default function Transcoding() {
    const [status, setStatus] = useState(null)
    const [error, setError] = useState(null)
    const [lastUpdated, setLastUpdated] = useState(new Date())
    const [retranscodePath, setRetranscodePath] = useState('')
    const [retranscodeLoading, setRetranscodeLoading] = useState(false)
    const [retranscodeMsg, setRetranscodeMsg] = useState(null)

    const fetchStatus = async () => {
        try {
            const data = await api('/transcoding/status')
            setStatus(data)
            setError(null)
            setLastUpdated(new Date())
        } catch (err) {
            console.error('Failed to fetch transcoding status', err)
            setError('Failed to fetch status')
            setLastUpdated(new Date())
        }
    }

    const handleRetranscode = async () => {
        if (!retranscodePath.trim()) return
        setRetranscodeLoading(true)
        setRetranscodeMsg(null)
        try {
            const data = await api('/transcoding/transcode', {
                method: 'POST',
                body: { path: retranscodePath.trim(), force: true }
            })
            setRetranscodeMsg({ type: 'success', text: `✅ Queued: ${data.file_id}` })
            setRetranscodePath('')
            fetchStatus()
        } catch (err) {
            setRetranscodeMsg({ type: 'error', text: `❌ ${err.message || 'Request failed'}` })
        }
        setRetranscodeLoading(false)
    }

    useEffect(() => {
        fetchStatus()
        const interval = setInterval(fetchStatus, 5000)
        return () => clearInterval(interval)
    }, [])

    return (
        <div>
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-bold">Transcoding Queue ⚡</h1>
                <div className="text-sm text-slate-400">
                    Last Updated: {lastUpdated.toLocaleTimeString()}
                </div>
            </div>

            {error && (
                <div className="bg-red-900/50 border border-red-700 p-4 rounded-lg mb-8 text-red-200">
                    ⚠️ {error}
                </div>
            )}

            {/* Retranscode Section */}
            <div className="bg-slate-800 rounded-xl p-6 mb-6">
                <h2 className="text-xl font-semibold mb-4">🔄 Re-transcode</h2>
                <div className="flex gap-3">
                    <input
                        type="text"
                        value={retranscodePath}
                        onChange={(e) => setRetranscodePath(e.target.value)}
                        placeholder="Movies/Interstellar_2014.mp4"
                        className="flex-1 px-4 py-2 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-indigo-500"
                    />
                    <button
                        onClick={handleRetranscode}
                        disabled={retranscodeLoading || !retranscodePath.trim()}
                        className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg font-medium transition"
                    >
                        {retranscodeLoading ? '...' : 'Re-transcode'}
                    </button>
                </div>
                {retranscodeMsg && (
                    <div className={`mt-3 text-sm ${retranscodeMsg.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
                        {retranscodeMsg.text}
                    </div>
                )}
                <p className="text-xs text-slate-500 mt-2">
                    Enter S3 path (e.g. Movies/filename.mp4) to force re-transcode
                </p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <StatCard
                    label="Processing"
                    value={status?.processing ? '1' : '0'}
                    color="text-amber-400"
                    icon="🔄"
                />
                <StatCard
                    label="Queued"
                    value={status?.pending_count || 0}
                    color="text-blue-400"
                    icon="⏳"
                />
                <StatCard
                    label="Completed"
                    value={status?.completed_count || 0}
                    color="text-emerald-400"
                    icon="✅"
                />
                <StatCard
                    label="Failed"
                    value={status?.failed_count || 0}
                    color="text-red-400"
                    icon="❌"
                />
            </div>

            {/* Active Job */}
            <div className="bg-slate-800 rounded-xl p-6 mb-6">
                <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                    {status?.processing && (
                        <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                    )}
                    Active Job
                </h2>

                {status?.processing ? (
                    <div>
                        <div className="bg-slate-900 p-4 rounded-lg font-mono text-green-400 break-all border border-green-900/30 mb-4">
                            {status.processing}
                        </div>

                        {/* Quality Progress */}
                        <div className="flex items-center gap-6 mt-4">
                            <span className="text-slate-400 text-sm">Quality Progress:</span>
                            <div className="flex gap-4">
                                {(status.qualities_total || ['1080p', '720p', '480p']).map((quality) => {
                                    const isDone = status.qualities_done?.includes(quality)
                                    return (
                                        <div
                                            key={quality}
                                            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${isDone
                                                    ? 'bg-green-900/50 text-green-400 border border-green-700'
                                                    : 'bg-slate-700 text-slate-400 border border-slate-600'
                                                }`}
                                        >
                                            {isDone ? '✓' : '⏳'} {quality}
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center h-24 text-slate-500">
                        <span className="text-4xl mb-2">💤</span>
                        <p>System Idle</p>
                    </div>
                )}
            </div>

            {/* Queue */}
            <div className="bg-slate-800 rounded-xl p-6">
                <h2 className="text-xl font-semibold mb-4">Pending Queue</h2>
                {status?.pending && status.pending.length > 0 ? (
                    <div className="space-y-2">
                        {status.pending.map((file, i) => (
                            <div
                                key={i}
                                className="bg-slate-900 p-3 rounded-lg flex items-center justify-between border border-slate-700"
                            >
                                <span className="font-mono text-sm truncate max-w-2xl">{file}</span>
                                <span className="text-xs bg-blue-900/50 text-blue-300 px-2 py-1 rounded">
                                    #{i + 1}
                                </span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-slate-500 italic">Queue is empty.</p>
                )}
            </div>
        </div>
    )
}

function StatCard({ label, value, color, icon }) {
    return (
        <div className="bg-slate-800 p-4 rounded-xl text-center">
            <div className="text-2xl mb-1">{icon}</div>
            <div className={`text-3xl font-bold ${color}`}>{value}</div>
            <div className="text-xs text-slate-400 uppercase tracking-wider mt-1">{label}</div>
        </div>
    )
}
