import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";

export default function SearchBar({ mobile = false }) {
    const [query, setQuery] = useState("");
    const [suggestions, setSuggestions] = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [loading, setLoading] = useState(false);
    const inputRef = useRef(null);
    const suggestionsRef = useRef(null);
    const navigate = useNavigate();

    // Debounced search
    useEffect(() => {
        if (query.length < 2) {
            setSuggestions([]);
            setShowSuggestions(false);
            return;
        }

        const timer = setTimeout(async () => {
            setLoading(true);
            try {
                const results = await api("/media/search", { q: query, limit: 5 });
                setSuggestions(results.results || []);
                setShowSuggestions(true);
            } catch (e) {
                console.error("Search failed:", e);
                setSuggestions([]);
            } finally {
                setLoading(false);
            }
        }, 300); // 300ms debounce

        return () => clearTimeout(timer);
    }, [query]);

    // Click outside to close
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (
                suggestionsRef.current &&
                !suggestionsRef.current.contains(e.target) &&
                !inputRef.current.contains(e.target)
            ) {
                setShowSuggestions(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleKeyDown = (e) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex((prev) => Math.max(prev - 1, -1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (selectedIndex >= 0 && suggestions[selectedIndex]) {
                handleSelect(suggestions[selectedIndex]);
            } else if (query.trim()) {
                handleSearch();
            }
        } else if (e.key === "Escape") {
            setShowSuggestions(false);
            inputRef.current?.blur();
        }
    };

    const handleSearch = () => {
        if (query.trim()) {
            navigate(`/search?q=${encodeURIComponent(query.trim())}`);
            setShowSuggestions(false);
            inputRef.current?.blur();
        }
    };

    const handleSelect = (item) => {
        setQuery(item.title);
        navigate(`/search?q=${encodeURIComponent(item.title)}`);
        setShowSuggestions(false);
        inputRef.current?.blur();
    };

    return (
        <div className={`relative ${mobile ? "w-full" : "w-full max-w-md"}`}>
            {/* Search Input */}
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => query.length >= 2 && setShowSuggestions(true)}
                    placeholder="Search titles..."
                    className="w-full px-4 py-2 pl-10 pr-4 bg-black/60 border border-white/20 rounded text-white placeholder-gray-400 focus:outline-none focus:border-white/40 transition"
                />
                {/* Search Icon */}
                <svg
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                </svg>
                {/* Loading Spinner */}
                {loading && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    </div>
                )}
            </div>

            {/* Suggestions Dropdown */}
            {showSuggestions && suggestions.length > 0 && (
                <div
                    ref={suggestionsRef}
                    className="absolute z-50 w-full mt-2 bg-black/95 border border-white/20 rounded shadow-2xl overflow-hidden"
                >
                    {suggestions.map((item, index) => (
                        <button
                            key={item.id}
                            onClick={() => handleSelect(item)}
                            className={`w-full px-4 py-3 text-left hover:bg-white/10 transition ${index === selectedIndex ? "bg-white/10" : ""
                                }`}
                        >
                            <div className="font-medium text-white">{item.title}</div>
                            <div className="text-xs text-gray-400 mt-1">
                                {item.category}
                                {item.size && (
                                    <span className="ml-2">
                                        · {(item.size / (1024 * 1024 * 1024)).toFixed(1)} GB
                                    </span>
                                )}
                            </div>
                        </button>
                    ))}
                    <button
                        onClick={handleSearch}
                        className="w-full px-4 py-2 text-sm text-center text-gray-400 hover:bg-white/5 border-t border-white/10"
                    >
                        See all results for "{query}"
                    </button>
                </div>
            )}
        </div>
    );
}
