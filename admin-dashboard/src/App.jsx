import React from 'react'
import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import Transcoding from './pages/Transcoding'
import Library from './pages/Library'

function ProtectedRoute({ children }) {
    const { isAuthenticated, loading } = useAuth()

    if (loading) {
        return (
            <div className="min-h-screen bg-slate-900 flex items-center justify-center">
                <div className="text-white">Loading...</div>
            </div>
        )
    }

    if (!isAuthenticated) {
        // Redirect to main app login
        window.location.href = '/login?redirect=/admin'
        return null
    }

    return children
}

function Sidebar() {
    const { logout, user } = useAuth()

    const linkClass = ({ isActive }) =>
        `flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${isActive
            ? 'bg-indigo-600 text-white'
            : 'text-slate-400 hover:bg-slate-800 hover:text-white'
        }`

    return (
        <aside className="w-64 bg-slate-900 border-r border-slate-800 p-4 flex flex-col min-h-screen">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-white">🎬 Admin</h1>
                <p className="text-slate-500 text-sm">OTT Platform</p>
            </div>

            <nav className="space-y-2 flex-1">
                <NavLink to="/" className={linkClass}>
                    <span>📊</span> Dashboard
                </NavLink>
                <NavLink to="/upload" className={linkClass}>
                    <span>📤</span> Upload Content
                </NavLink>
                <NavLink to="/transcoding" className={linkClass}>
                    <span>🔄</span> Transcoding
                </NavLink>
                <NavLink to="/library" className={linkClass}>
                    <span>📚</span> Content Library
                </NavLink>
            </nav>

            <div className="border-t border-slate-800 pt-4 mt-4">
                {user && (
                    <div className="text-sm text-slate-400 mb-3 px-2">
                        👤 {user.email || 'Admin'}
                    </div>
                )}
                <a
                    href="/"
                    className="block text-center py-2 text-slate-500 hover:text-white transition mb-2"
                >
                    ← Back to App
                </a>
                <button
                    onClick={logout}
                    className="w-full py-2 text-red-400 hover:bg-red-900/30 rounded transition"
                >
                    Logout
                </button>
            </div>
        </aside>
    )
}

function AdminLayout() {
    return (
        <div className="flex min-h-screen bg-slate-900">
            <Sidebar />
            <main className="flex-1 p-8 overflow-auto">
                <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/upload" element={<Upload />} />
                    <Route path="/transcoding" element={<Transcoding />} />
                    <Route path="/library" element={<Library />} />
                </Routes>
            </main>
        </div>
    )
}

export default function App() {
    return (
        <AuthProvider>
            <ProtectedRoute>
                <AdminLayout />
            </ProtectedRoute>
        </AuthProvider>
    )
}
