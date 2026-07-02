import React, { useState } from 'react'

const API_BASE = '/api'

export default function Upload() {
    const [queue, setQueue] = useState([]) // { id, file, title, category, status: 'pending'|'uploading'|'success'|'error', progress: 0, message: '' }
    const [uploading, setUploading] = useState(false)
    const [globalCategory, setGlobalCategory] = useState('Movies')

    // Handle file selection
    const handleFileSelect = (e) => {
        const files = Array.from(e.target.files)
        const newItems = files.map(file => ({
            id: Math.random().toString(36).substr(2, 9),
            file,
            title: file.name.replace(/\.[^/.]+$/, "").replace(/[._-]/g, " "), // Auto-generate title
            category: globalCategory,
            status: 'pending',
            progress: 0,
            message: ''
        }))
        setQueue(prev => [...prev, ...newItems])
    }

    const removeQueueItem = (id) => {
        if (uploading) return // Prevent removing while uploading (simplification)
        setQueue(prev => prev.filter(item => item.id !== id))
    }

    const updateItem = (id, updates) => {
        setQueue(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item))
    }

    const processQueue = async () => {
        setUploading(true)

        // Process sequentially
        for (let i = 0; i < queue.length; i++) {
            const item = queue[i]
            if (item.status === 'success') continue // Skip already done

            updateItem(item.id, { status: 'uploading', progress: 0 })

            const formData = new FormData()
            formData.append('file', item.file)
            formData.append('title', item.title)
            formData.append('category', item.category)

            try {
                // Simulate progress (since fetch doesn't support generic progress events easily without XMLHttpRequest or streams)
                // We'll just set it to 50% immediately, then 100% on completion.
                updateItem(item.id, { progress: 20 })

                const token = localStorage.getItem('token')
                const res = await fetch(`${API_BASE}/cms/upload`, {
                    method: 'POST',
                    headers: {
                        ...(token && { 'Authorization': `Bearer ${token}` })
                    },
                    body: formData
                })

                updateItem(item.id, { progress: 80 })

                if (res.ok) {
                    const data = await res.json()
                    updateItem(item.id, {
                        status: 'success',
                        progress: 100,
                        message: 'Uploaded & Transcoding Started'
                    })
                } else {
                    const errText = await res.text()
                    updateItem(item.id, {
                        status: 'error',
                        progress: 0,
                        message: errText
                    })
                }
            } catch (err) {
                console.error(err)
                updateItem(item.id, {
                    status: 'error',
                    message: 'Network Error'
                })
            }
        }
        setUploading(false)
    }

    const pendingCount = queue.filter(i => i.status === 'pending').length

    return (
        <div>
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-bold">Upload Content</h1>
                <div className="flex gap-4">
                    <select
                        value={globalCategory}
                        onChange={(e) => setGlobalCategory(e.target.value)}
                        className="bg-slate-800 border border-slate-700 rounded-lg p-2 text-white outline-none"
                    >
                        <option value="Movies">Default: Movies</option>
                        <option value="TvShows">Default: TV Shows</option>
                        <option value="Anime">Default: Anime</option>
                    </select>
                </div>
            </div>

            {/* Drop Zone */}
            <div className="border-2 border-dashed border-slate-700 rounded-xl p-8 text-center hover:border-indigo-500 transition cursor-pointer relative bg-slate-800/50 mb-8">
                <input
                    type="file"
                    accept="video/*"
                    multiple // Allow multiple files
                    onChange={handleFileSelect}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <div className="text-slate-400">
                    <p className="text-2xl mb-2">📤</p>
                    <p className="text-lg font-medium text-white">Drag & Drop files here</p>
                    <p className="text-sm text-slate-500 mt-1">or click to select multiple videos</p>
                </div>
            </div>

            {/* Queue List */}
            {queue.length > 0 && (
                <div className="space-y-4">
                    <div className="flex justify-between items-center">
                        <h2 className="text-xl font-semibold">Upload Queue ({queue.length})</h2>
                        {pendingCount > 0 && !uploading && (
                            <button
                                onClick={processQueue}
                                className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg transition flex items-center gap-2"
                            >
                                Start Upload ({pendingCount})
                            </button>
                        )}
                        {uploading && (
                            <button disabled className="px-6 py-2 bg-gray-600 text-white font-bold rounded-lg cursor-not-allowed flex items-center gap-2">
                                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                Uploading...
                            </button>
                        )}
                    </div>

                    <div className="bg-slate-800 rounded-xl overflow-hidden divide-y divide-slate-700">
                        {queue.map((item) => (
                            <div key={item.id} className="p-4 flex items-center gap-4">
                                {/* Icon based on status */}
                                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-slate-700">
                                    {item.status === 'pending' && <span className="text-slate-400">⏳</span>}
                                    {item.status === 'uploading' && <span className="text-indigo-400 animate-pulse">⬆️</span>}
                                    {item.status === 'success' && <span className="text-green-400">✅</span>}
                                    {item.status === 'error' && <span className="text-red-400">❌</span>}
                                </div>

                                {/* Info Inputs */}
                                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <input
                                            type="text"
                                            value={item.title}
                                            disabled={item.status !== 'pending'}
                                            onChange={(e) => updateItem(item.id, { title: e.target.value })}
                                            className="w-full bg-transparent border-b border-slate-600 focus:border-indigo-500 outline-none py-1 text-white font-medium"
                                            placeholder="Title"
                                        />
                                        <div className="text-xs text-slate-500 mt-1">{item.file.name} ({(item.file.size / 1024 / 1024).toFixed(1)} MB)</div>
                                    </div>
                                    <div>
                                        <select
                                            value={item.category}
                                            disabled={item.status !== 'pending'}
                                            onChange={(e) => updateItem(item.id, { category: e.target.value })}
                                            className="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-300 outline-none"
                                        >
                                            <option value="Movies">Movies</option>
                                            <option value="TvShows">TV Shows</option>
                                            <option value="Anime">Anime</option>
                                        </select>
                                    </div>
                                </div>

                                {/* Status / Progress */}
                                <div className="w-32 flex-shrink-0">
                                    {item.status === 'uploading' && (
                                        <div className="w-full bg-slate-700 rounded-full h-1.5 mt-2">
                                            <div className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${item.progress}%` }} />
                                        </div>
                                    )}
                                    {item.message && (
                                        <div className={`text-xs mt-1 truncate ${item.status === 'error' ? 'text-red-400' : 'text-green-400'}`}>
                                            {item.message}
                                        </div>
                                    )}
                                </div>

                                {/* Actions */}
                                <div className="w-10 text-right">
                                    {item.status === 'pending' && (
                                        <button
                                            onClick={() => removeQueueItem(item.id)}
                                            className="text-slate-500 hover:text-red-400 transition"
                                        >
                                            ✕
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

