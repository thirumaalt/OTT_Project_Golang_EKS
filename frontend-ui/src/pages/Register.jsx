import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";

export default function Register() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError("");
        try {
            // Integrate with actual Auth Service
            await api("/auth/register", { method: "POST", body: { email, username: email, password, name } });

            // Redirect to login on success
            navigate("/login");
        } catch (err) {
            let msg = err.message || "Failed to register";
            if (msg.includes("User already exists")) {
                msg = "It looks like you already have an account. Sign in below to start watching";
            }
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
            {/* Background with Overlay */}
            <div className="absolute inset-0 z-0">
                <img
                    src="https://assets.nflxext.com/ffe/siteui/vlv3/f841d4c7-10e1-40af-bcae-07a3f8dc141a/f6d7434e-d6de-4185-a6d4-c77a2d08737b/US-en-20220502-popsignuptwoweeks-perspective_alpha_website_medium.jpg"
                    alt="Background"
                    className="w-full h-full object-cover opacity-50"
                />
                <div className="absolute inset-0 bg-black/60" />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black/40" />
            </div>

            {/* Register Card */}
            <div className="relative z-10 w-full max-w-md p-8 sm:p-12 bg-black/75 backdrop-blur-md rounded-xl border border-white/10 shadow-2xl animate-fade-in">
                <h1 className="text-3xl font-bold text-white mb-8">Sign Up</h1>

                {error && (
                    <div className="mb-6 p-3 rounded bg-orange-500/20 border border-orange-500/50 text-orange-200 text-sm">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="space-y-1">
                        <input
                            type="text"
                            placeholder="Full Name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full px-4 py-3.5 rounded bg-[#333] text-white placeholder-gray-400 border-none focus:ring-2 focus:ring-white/20 focus:bg-[#454545] transition outline-none"
                            required
                        />
                    </div>

                    <div className="space-y-1">
                        <input
                            type="email"
                            placeholder="Email address"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-3.5 rounded bg-[#333] text-white placeholder-gray-400 border-none focus:ring-2 focus:ring-white/20 focus:bg-[#454545] transition outline-none"
                            required
                        />
                    </div>

                    <div className="space-y-1">
                        <input
                            type="password"
                            placeholder="Password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-4 py-3.5 rounded bg-[#333] text-white placeholder-gray-400 border-none focus:ring-2 focus:ring-white/20 focus:bg-[#454545] transition outline-none"
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-3.5 rounded bg-[#e50914] text-white font-bold hover:bg-[#f6121d] transition disabled:opacity-50 disabled:cursor-not-allowed mt-4"
                    >
                        {loading ? "Creating Account..." : "Sign Up"}
                    </button>
                </form>

                <div className="mt-16 text-[#737373]">
                    <p>
                        Already have an account?{" "}
                        <Link to="/login" className="text-white hover:underline">
                            Sign in now
                        </Link>
                        .
                    </p>
                </div>
            </div>
        </div>
    );
}
