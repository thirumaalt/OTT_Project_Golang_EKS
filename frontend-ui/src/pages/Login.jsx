import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function Login() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError("");
        try {
            await login(email, password);
            navigate("/");
        } catch (err) {
            let msg = err.message || "Failed to login";
            if (msg.includes("User not found")) {
                msg = "Sorry, we can't find an account with this email address. Please try again or create a new account.";
            } else if (msg.includes("Invalid credentials")) {
                msg = "Incorrect password. Please try again.";
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

            {/* Login Card */}
            <div className="relative z-10 w-full max-w-md p-8 sm:p-12 bg-black/75 backdrop-blur-md rounded-xl border border-white/10 shadow-2xl animate-fade-in">
                <h1 className="text-3xl font-bold text-white mb-8">Sign In</h1>

                {error && (
                    <div className="mb-6 p-3 rounded bg-orange-500/20 border border-orange-500/50 text-orange-200 text-sm">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="space-y-1">
                        <input
                            type="email"
                            placeholder="Email or phone number"
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
                        {loading ? "Signing In..." : "Sign In"}
                    </button>

                    <div className="flex justify-between items-center text-xs text-[#b3b3b3]">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" className="rounded bg-[#333] border-none focus:ring-0" />
                            Remember me
                        </label>
                        <a href="#" className="hover:underline">Need help?</a>
                    </div>
                </form>

                <div className="mt-16 text-[#737373]">
                    <p>
                        New to OTT Platform?{" "}
                        <Link to="/register" className="text-white hover:underline">
                            Sign up now
                        </Link>
                        .
                    </p>
                    <p className="text-xs mt-4">
                        This page is protected by Google reCAPTCHA to ensure you're not a bot.
                    </p>
                </div>
            </div>
        </div>
    );
}
