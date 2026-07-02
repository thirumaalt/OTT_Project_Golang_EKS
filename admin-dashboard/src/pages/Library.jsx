import React, { useState, useEffect } from 'react'
import { api } from '../api/client'

export default function Library() {
    const [content, setContent] = useState([])
    const [filteredContent, setFilteredContent] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [filterCategory, setFilterCategory] = useState('All')
    const [searchQuery, setSearchQuery] = useState('')

    useEffect(() => {
        const fetchContent = async () => {
            try {
                const data = await api('/cms/content')
                // API returns { results: [...], total: N }
                const items = data.results || data.content || []
                setContent(items)
                setFilteredContent(items)
            } catch (err) {
                setError('Failed to fetch content')
            } finally {
                setLoading(false)
            }
        }

        fetchContent()
    }, [])

    useEffect(() => {
        let result = content

        // Filter by Category
        if (filterCategory !== 'All') {
            result = result.filter(item => item.key.startsWith(filterCategory))
        }

        // Filter by Search
        if (searchQuery) {
            const lowerQuery = searchQuery.toLowerCase()
            result = result.filter(item => item.key.toLowerCase().includes(lowerQuery))
        }

        setFilteredContent(result)
    }, [content, filterCategory, searchQuery])

    const handleDelete = async (key) => {
        if (!confirm(`Are you sure you want to PERMANENTLY delete "${key}"? This cannot be undone.`)) return

        try {
            await api(`/cms/content/${encodeURIComponent(key)}`, { method: 'DELETE' })
            setContent(prev => prev.filter(item => item.key !== key))
            alert('Content deleted successfully')
        } catch (err) {
            alert('Delete error: ' + err.message)
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64 text-slate-400">
                <svg className="animate-spin h-8 w-8 text-indigo-500 mr-3" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading library...
            </div>
        )
    }

    return (
        <div>
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div>
                    <h1 className="text-3xl font-bold">Content Library</h1>
                    <p className="text-slate-400 text-sm mt-1">Manage your OTT platform content</p>
                </div>
                <div className="flex gap-3">
                    <span className="bg-slate-800 px-4 py-2 rounded-lg text-slate-300 border border-slate-700">
                        Total: <span className="text-white font-bold">{content.length}</span>
                    </span>
                </div>
            </div>

            {error && (
                <div className="bg-red-900/50 border border-red-700 p-4 rounded-lg mb-6 text-red-200 flex items-center justify-between">
                    <span>{error}</span>
                    <button onClick={() => window.location.reload()} className="underline hover:text-white">Retry</button>
                </div>
            )}

            {/* Controls */}
            <div className="bg-slate-800 p-4 rounded-xl mb-6 flex flex-col md:flex-row gap-4 border border-slate-700">
                {/* Tabs */}
                <div className="flex bg-slate-900 rounded-lg p-1 overflow-x-auto">
                    {['All', 'Movies', 'TvShows', 'Anime'].map(cat => (
                        <button
                            key={cat}
                            onClick={() => setFilterCategory(cat)}
                            className={`px-4 py-2 rounded-md text-sm font-medium transition whitespace-nowrap ${filterCategory === cat
                                    ? 'bg-indigo-600 text-white shadow-lg'
                                    : 'text-slate-400 hover:text-white'
                                }`}
                        >
                            {cat}
                        </button>
                    ))}
                </div>

                {/* Search */}
                <div className="relative flex-1">
                    <input
                        type="text"
                        placeholder="Search by title..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-2.5 text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                    <svg className="w-5 h-5 text-slate-500 absolute left-3 top-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                </div>
            </div>

            {filteredContent.length === 0 ? (
                <div className="bg-slate-800 rounded-xl p-16 text-center border border-slate-700 border-dashed">
                    <span className="text-6xl mb-4 block opacity-50">🔍</span>
                    <p className="text-xl text-slate-300 font-medium mb-2">No content found</p>
                    <p className="text-slate-500">
                        {content.length === 0
                            ? "Get started by uploading your first video."
                            : "Try adjusting your filters or search query."}
                    </p>
                    {content.length === 0 && (
                        <a
                            href="/admin/upload"
                            className="inline-block mt-6 px-6 py-3 bg-indigo-600 rounded-lg hover:bg-indigo-700 transition font-semibold"
                        >
                            Go to Upload
                        </a>
                    )}
                </div>
            ) : (
                <div className="bg-slate-800 rounded-xl overflow-hidden shadow-xl border border-slate-700">
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-slate-900/50">
                                <tr>
                                    <th className="text-left p-4 text-slate-400 font-medium whitespace-nowrap">Title / Key</th>
                                    <th className="text-left p-4 text-slate-400 font-medium whitespace-nowrap">Type</th>
                                    <th className="text-left p-4 text-slate-400 font-medium whitespace-nowrap">Size</th>
                                    <th className="text-left p-4 text-slate-400 font-medium whitespace-nowrap">Last Modified</th>
                                    <th className="text-right p-4 text-slate-400 font-medium whitespace-nowrap">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-700">
                                {filteredContent.map((item, i) => {
                                    const [cat, ...rest] = item.key.split('/')
                                    const title = rest.join('/')
                                    return (
                                        <tr key={i} className="hover:bg-slate-700/30 transition group">
                                            <td className="p-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-10 h-10 rounded bg-slate-700 flex items-center justify-center text-xl">
                                                        🎬
                                                    </div>
                                                    <div>
                                                        <div className="font-medium text-white">{title}</div>
                                                        <div className="text-xs text-slate-500 font-mono">{item.key}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="p-4">
                                                <span className={`px-2 py-1 rounded text-xs font-semibold
                                                    ${cat === 'Movies' ? 'bg-blue-900/50 text-blue-300' :
                                                        cat === 'TvShows' ? 'bg-purple-900/50 text-purple-300' :
                                                            'bg-pink-900/50 text-pink-300'}`}>
                                                    {cat}
                                                </span>
                                            </td>
                                            <td className="p-4 text-slate-400 text-sm">
                                                {item.size ? (item.size / 1024 / 1024).toFixed(2) + ' MB' : 'N/A'}
                                            </td>
                                            <td className="p-4 text-slate-400 text-sm">
                                                {item.last_modified !== 'N/A'
                                                    ? new Date(item.last_modified).toLocaleDateString() + ' ' + new Date(item.last_modified).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                                    : 'N/A'}
                                            </td>
                                            <td className="p-4 text-right">
                                                <button
                                                    onClick={() => handleDelete(item.key)}
                                                    className="px-4 py-2 bg-red-600/10 text-red-400 hover:bg-red-600 hover:text-white rounded-lg transition text-sm font-medium border border-transparent hover:border-red-500"
                                                >
                                                    Delete
                                                </button>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    )
}

