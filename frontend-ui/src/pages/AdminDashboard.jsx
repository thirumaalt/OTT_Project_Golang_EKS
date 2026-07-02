import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

export default function AdminDashboard() {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        api("/analytics/stats")
            .then(setStats)
            .catch(console.error)
            .finally(() => setLoading(false));
    }, []);

    if (loading) return <div className="p-12 text-white">Loading stats...</div>;

    return (
        <div className="min-h-screen bg-[#141414] text-white p-8 pt-24">
            <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                <StatCard title="Total Actions" value={stats?.total_actions || 0} color="bg-blue-600" />
                <StatCard title="Video Plays" value={stats?.plays || 0} color="bg-red-600" />
                <StatCard title="Logins" value={stats?.logins || 0} color="bg-green-600" />
            </div>

            <div className="bg-gray-900 p-8 rounded-lg border border-gray-800 max-w-2xl">
                <h2 className="text-2xl font-bold mb-6">Upload New Content</h2>
                <p className="text-gray-400 mb-6">Upload movies, TV shows, and anime to the platform.</p>
                <Link to="/admin/upload" className="inline-block bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-8 rounded transition">
                    Go to Upload Page
                </Link>
            </div>
        </div>
    );
}

function StatCard({ title, value, color }) {
    return (
        <div className={`p-6 rounded-lg shadow-lg ${color}`}>
            <h3 className="text-lg font-medium opacity-80">{title}</h3>
            <p className="text-4xl font-bold mt-2">{value}</p>
        </div>
    );
}


