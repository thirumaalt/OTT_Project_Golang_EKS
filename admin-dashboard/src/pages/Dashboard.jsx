import React, { useState, useEffect } from 'react'
import { api } from '../api/client'

export default function Dashboard() {
    const [stats, setStats] = useState({
        totalVideos: 0,
        pendingTranscode: 0,
        completedToday: 0,
        failedCount: 0
    })
    const [categoryBreakdown, setCategoryBreakdown] = useState({
        Movies: 0,
        TvShows: 0,
        Anime: 0
    })
    const [recentActivity, setRecentActivity] = useState([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        const fetchAllData = async () => {
            // Fetch transcoding status
            try {
                const data = await api('/transcoding/status')
                setStats(prev => ({
                    ...prev,
                    pendingTranscode: data.pending_count || 0,
                    completedToday: data.completed_count || 0,
                    failedCount: data.failed_count || 0
                }))
                const activities = []
                if (data.processing) {
                    activities.push({ type: 'transcoding', message: `Transcoding: ${data.processing.split('/').pop()}`, time: 'Now' })
                }
                if (data.pending && data.pending.length > 0) {
                    activities.push({ type: 'queue', message: `${data.pending.length} videos in queue`, time: 'Pending' })
                }
                setRecentActivity(prev => [...activities, ...prev].slice(0, 5))
            } catch (err) {
                console.error('Failed to fetch transcoding status:', err)
            }

            // Fetch library stats
            try {
                const data = await api('/media/library')
                setStats(prev => ({ ...prev, totalVideos: data.total || 0 }))
                const breakdown = { Movies: 0, TvShows: 0, Anime: 0 }
                if (data.results) {
                    data.results.forEach(item => {
                        if (breakdown[item.category] !== undefined) breakdown[item.category]++
                    })
                }
                setCategoryBreakdown(breakdown)

                // Count HLS-ready from the same response
                const hlsReady = (data.results || []).filter(item => item.hls_url).length
                if (hlsReady > 0) {
                    setRecentActivity(prev => [
                        { type: 'success', message: `${hlsReady} videos ready to stream`, time: 'Live' },
                        ...prev
                    ].slice(0, 5))
                }
            } catch (err) {
                console.error('Failed to fetch library stats:', err)
            }

            setLoading(false)
        }

        fetchAllData()
        const interval = setInterval(fetchAllData, 10000) // Refresh every 10s
        return () => clearInterval(interval)
    }, [])

    const totalByCategory = categoryBreakdown.Movies + categoryBreakdown.TvShows + categoryBreakdown.Anime

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="text-slate-400">Loading dashboard...</div>
            </div>
        )
    }

    return (
        <div>
            <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <StatCard
                    title="Total Videos"
                    value={stats.totalVideos}
                    icon="🎬"
                    color="bg-indigo-600"
                    trend={stats.totalVideos > 0 ? '+' : ''}
                />
                <StatCard
                    title="Pending Transcode"
                    value={stats.pendingTranscode}
                    icon="⏳"
                    color="bg-amber-600"
                    highlight={stats.pendingTranscode > 0}
                />
                <StatCard
                    title="Completed"
                    value={stats.completedToday}
                    icon="✅"
                    color="bg-emerald-600"
                />
                <StatCard
                    title="Failed"
                    value={stats.failedCount}
                    icon="❌"
                    color="bg-red-600"
                    highlight={stats.failedCount > 0}
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                {/* Category Breakdown */}
                <div className="bg-slate-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-4">📊 Content by Category</h2>
                    <div className="space-y-4">
                        <CategoryBar
                            label="Movies"
                            count={categoryBreakdown.Movies}
                            total={totalByCategory}
                            color="bg-blue-500"
                        />
                        <CategoryBar
                            label="TV Shows"
                            count={categoryBreakdown.TvShows}
                            total={totalByCategory}
                            color="bg-purple-500"
                        />
                        <CategoryBar
                            label="Anime"
                            count={categoryBreakdown.Anime}
                            total={totalByCategory}
                            color="bg-pink-500"
                        />
                    </div>
                </div>

                {/* Transcoding Health */}
                <div className="bg-slate-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-4">🔄 Transcoding Health</h2>
                    <div className="flex items-center justify-center h-32">
                        <div className="text-center">
                            <div className={`text-5xl font-bold ${stats.failedCount > 0 ? 'text-red-400' :
                                    stats.pendingTranscode > 0 ? 'text-amber-400' : 'text-emerald-400'
                                }`}>
                                {stats.failedCount > 0 ? '⚠️' :
                                    stats.pendingTranscode > 0 ? '🔄' : '✅'}
                            </div>
                            <p className="text-slate-400 mt-2">
                                {stats.failedCount > 0 ? `${stats.failedCount} Failed Jobs` :
                                    stats.pendingTranscode > 0 ? `${stats.pendingTranscode} Processing` : 'All Healthy'}
                            </p>
                        </div>
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
                        <div className="bg-slate-700 rounded p-2">
                            <div className="text-emerald-400 font-bold">{stats.completedToday}</div>
                            <div className="text-slate-500">Done</div>
                        </div>
                        <div className="bg-slate-700 rounded p-2">
                            <div className="text-amber-400 font-bold">{stats.pendingTranscode}</div>
                            <div className="text-slate-500">Queue</div>
                        </div>
                        <div className="bg-slate-700 rounded p-2">
                            <div className="text-red-400 font-bold">{stats.failedCount}</div>
                            <div className="text-slate-500">Failed</div>
                        </div>
                    </div>
                </div>

                {/* Recent Activity */}
                <div className="bg-slate-800 rounded-xl p-6">
                    <h2 className="text-xl font-semibold mb-4">📋 Recent Activity</h2>
                    {recentActivity.length > 0 ? (
                        <div className="space-y-3">
                            {recentActivity.map((activity, i) => (
                                <div key={i} className="flex items-center gap-3 text-sm">
                                    <span className={`w-2 h-2 rounded-full ${activity.type === 'success' ? 'bg-emerald-500' :
                                            activity.type === 'transcoding' ? 'bg-amber-500 animate-pulse' :
                                                'bg-blue-500'
                                        }`} />
                                    <span className="flex-1 truncate">{activity.message}</span>
                                    <span className="text-slate-500 text-xs">{activity.time}</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-slate-500 italic">No recent activity</p>
                    )}
                </div>
            </div>

            {/* Quick Actions */}
            <div className="bg-slate-800 rounded-xl p-6">
                <h2 className="text-xl font-semibold mb-4">⚡ Quick Actions</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <a
                        href="/admin/upload"
                        className="flex items-center gap-3 p-4 bg-indigo-600/20 border border-indigo-600/40 rounded-lg hover:bg-indigo-600/30 transition"
                    >
                        <span className="text-2xl">📤</span>
                        <div>
                            <div className="font-medium">Upload Content</div>
                            <div className="text-sm text-slate-400">Add new videos</div>
                        </div>
                    </a>
                    <a
                        href="/admin/transcoding"
                        className="flex items-center gap-3 p-4 bg-amber-600/20 border border-amber-600/40 rounded-lg hover:bg-amber-600/30 transition"
                    >
                        <span className="text-2xl">🔄</span>
                        <div>
                            <div className="font-medium">Transcoding Queue</div>
                            <div className="text-sm text-slate-400">Monitor progress</div>
                        </div>
                    </a>
                    <a
                        href="/admin/library"
                        className="flex items-center gap-3 p-4 bg-emerald-600/20 border border-emerald-600/40 rounded-lg hover:bg-emerald-600/30 transition"
                    >
                        <span className="text-2xl">📚</span>
                        <div>
                            <div className="font-medium">Content Library</div>
                            <div className="text-sm text-slate-400">Manage videos</div>
                        </div>
                    </a>
                </div>
            </div>
        </div>
    )
}

function StatCard({ title, value, icon, color, trend, highlight }) {
    return (
        <div className={`bg-slate-800 rounded-xl p-6 ${highlight ? 'ring-2 ring-amber-500/50' : ''}`}>
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-slate-400 text-sm">{title}</p>
                    <p className="text-3xl font-bold mt-1">
                        {trend && <span className="text-emerald-400 text-lg">{trend}</span>}
                        {value}
                    </p>
                </div>
                <div className={`w-12 h-12 ${color} rounded-lg flex items-center justify-center text-2xl`}>
                    {icon}
                </div>
            </div>
        </div>
    )
}

function CategoryBar({ label, count, total, color }) {
    const percentage = total > 0 ? (count / total) * 100 : 0

    return (
        <div>
            <div className="flex justify-between text-sm mb-1">
                <span>{label}</span>
                <span className="text-slate-400">{count}</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2">
                <div
                    className={`${color} h-2 rounded-full transition-all duration-500`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
        </div>
    )
}
