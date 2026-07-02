import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import MediaCard from "../components/MediaCard";

export default function SearchResults({ onPlay, onInfo }) {
    const [searchParams] = useSearchParams();
    const query = searchParams.get("q") || "";

    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [category, setCategory] = useState("");

    useEffect(() => {
        if (!query) return;

        const loadResults = async () => {
            setLoading(true);
            try {
                const data = await api("/media/search", {
                    q: query,
                    category: category || undefined,
                    limit: 50
                });
                setItems(data.results || []);
                setTotal(data.total || 0);
            } catch (e) {
                console.error("Search failed:", e);
                setItems([]);
                setTotal(0);
            } finally {
                setLoading(false);
            }
        };

        loadResults();
    }, [query, category]);

    if (loading) {
        return (
            <div className="min-h-screen pt-20 px-4 md:px-12">
                <div className="text-white text-xl">Searching...</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 mt-8">
                    {Array.from({ length: 12 }).map((_, i) => (
                        <div key={i} className="aspect-[2/3] bg-white/5 animate-pulse rounded-md" />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen pt-20 px-4 md:px-12 pb-20">
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white mb-2">
                    Search Results for "{query}"
                </h1>
                <p className="text-gray-400">
                    {total} {total === 1 ? "result" : "results"} found
                </p>
            </div>

            {/* Category Filter */}
            <div className="flex gap-4 mb-8">
                <button
                    onClick={() => setCategory("")}
                    className={`px-4 py-2 rounded transition ${category === ""
                        ? "bg-white text-black"
                        : "bg-white/10 text-white hover:bg-white/20"
                        }`}
                >
                    All
                </button>
                <button
                    onClick={() => setCategory("movies")}
                    className={`px-4 py-2 rounded transition ${category === "movies"
                        ? "bg-white text-black"
                        : "bg-white/10 text-white hover:bg-white/20"
                        }`}
                >
                    Movies
                </button>
                <button
                    onClick={() => setCategory("series")}
                    className={`px-4 py-2 rounded transition ${category === "series"
                        ? "bg-white text-black"
                        : "bg-white/10 text-white hover:bg-white/20"
                        }`}
                >
                    TV Shows
                </button>
            </div>

            {/* Results Grid */}
            {items.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
                    {items.map((item) => (
                        <MediaCard key={item.id} item={item} onInfo={onInfo} onPlay={onPlay} />
                    ))}
                </div>
            ) : (
                <div className="text-center py-20">
                    <div className="text-6xl mb-4">🔍</div>
                    <h2 className="text-2xl font-bold text-white mb-2">No results found</h2>
                    <p className="text-gray-400">
                        Try searching with different keywords
                    </p>
                </div>
            )}
        </div>
    );
}
