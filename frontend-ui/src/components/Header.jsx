import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import SearchBar from "./SearchBar";

export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const { user, logout, activeProfile } = useAuth();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header className={`fixed top-0 w-full z-50 transition-all duration-500 ${scrolled ? "bg-black/60 backdrop-blur-lg" : "bg-gradient-to-b from-black/80 to-transparent"}`}>
      <div className="px-4 md:px-12 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-8">
          <Link to="/">
            <h1 className="text-2xl md:text-3xl font-bold text-[#e50914] cursor-pointer">MyFlix</h1>
          </Link>
          <nav className="hidden md:flex gap-5 text-sm text-gray-300">
            <Link to="/" className="text-white font-medium hover:text-gray-300 transition">Home</Link>
            <Link to="/series" className="hover:text-gray-300 transition">TV Shows</Link>
            <Link to="/movies" className="hover:text-gray-300 transition">Movies</Link>
            <Link to="/new" className="hover:text-gray-300 transition">New & Popular</Link>
            <Link to="/mylist" className="hover:text-gray-300 transition">My List</Link>
            <Link to="/plans" className="text-[#e50914] font-bold hover:text-red-400 transition">Plans</Link>
          </nav>
        </div>

        {/* Right Side: Search + Profile */}
        <div className="flex items-center gap-6">
          {/* Search Bar */}
          <div className="hidden md:block w-64">
            <SearchBar />
          </div>

          <div className="flex items-center gap-5 text-white text-sm">
            <div className="hidden md:block">Children</div>
            <svg className="w-6 h-6 cursor-pointer" fill="currentColor" viewBox="0 0 24 24"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" /></svg>

            <div className="flex items-center gap-2 cursor-pointer group relative">
              <img src={activeProfile?.avatarUrl || "https://upload.wikimedia.org/wikipedia/commons/0/0b/Netflix-avatar.png"} alt="Profile" className="w-8 h-8 rounded object-cover" />
              <svg className="w-4 h-4 transition-transform group-hover:rotate-180" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" /></svg>

              <div className="absolute top-full right-0 pt-2 w-40 opacity-0 group-hover:opacity-100 transition pointer-events-none group-hover:pointer-events-auto">
                <div className="bg-black/95 border border-white/20 rounded shadow-xl">
                  <Link to="/profiles" className="block px-4 py-3 hover:bg-white/10 text-sm transition text-gray-300 hover:text-white">
                    Manage Profiles
                  </Link>
                  <a href="/admin" className="block px-4 py-3 hover:bg-white/10 text-sm transition text-gray-300 hover:text-white">
                    Admin Dashboard
                  </a>
                  <div className="border-t border-white/10 my-1"></div>
                  <button onClick={logout} className="w-full text-left px-4 py-3 hover:bg-white/10 text-sm transition text-gray-300 hover:text-white">
                    Sign Out
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
