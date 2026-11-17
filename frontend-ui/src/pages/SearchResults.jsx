import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import MediaCard from "../components/MediaCard";
import { loadLibrary, titleKey } from "../components/RecommendedRows";

// Vector search always returns the nearest titles, even for nonsense queries, so drop weak matches.
// Tuned on a small sample (good matches ~0.55-0.70); raise it if unrelated titles show up.
const MIN_SEMANTIC_SCORE = 0.5;

export default function SearchResults({ onPlay, onInfo }) {
    const [searchParams] = useSearchParams();
    const query = searchParams.get("q") || "";

    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [category, setCategory] = useState("");
    const [related, setRelated] = useState([]);
    const [relatedLoading, setRelatedLoading] = useState(false);

    // "Related by meaning": semantic matches, mapped to playable library files
    useEffect(() => {
        setRelated([]);
        if (query.trim().length < 3) { setRelatedLoading(false); return; }
        let cancelled = false;
        setRelatedLoading(true);
        (async () => {
            try {
                const [hits, library] = await Promise.all([
                    api("/search/semantic", { q: query, limit: 20 }),
                    loadLibrary(),
                ]);
                const byKey = new Map();
                for (const f of library) {
                    const k = titleKey(f.title);
                    if (k && !byKey.has(k)) byKey.set(k, f);
                }
                const seen = new Set();
                const matched = [];
                for (const h of hits || []) {
                    if (h.score < MIN_SEMANTIC_SCORE) continue;
                    const f = byKey.get(titleKey(h.title));
                    if (f && !seen.has(f.path)) { seen.add(f.path); matched.push(f); }
                }
                if (!cancelled) setRelated(matched.slice(0, 12));
            } catch (e) {
                console.error("Semantic search failed", e); // keyword results still show
            } finally {
                if (!cancelled) setRelatedLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [query]);

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

    // semantic matches not already in the keyword results, capped at one row
    const closest = related.filter((r) => !items.some((i) => i.path === r.path)).slice(0, 6);

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
                    {total > 0
                        ? `${total} ${total === 1 ? "result" : "results"} found`
                        : closest.length > 0
                            ? "No exact matches — showing the closest titles by meaning"
                            : relatedLoading
                                ? "Looking for related titles..."
                                : "0 results found"}
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
            ) : closest.length === 0 && !relatedLoading ? (
                <div className="text-center py-20">
                    <div className="text-6xl mb-4">🔍</div>
                    <h2 className="text-2xl font-bold text-white mb-2">No results found</h2>
                    <p className="text-gray-400">
                        Try searching with different keywords
                    </p>
                </div>
            ) : null}

            {/* Closest matches by meaning (semantic search) */}
            {closest.length > 0 && (
                <div className={items.length > 0 ? "mt-16" : "mt-2"}>
                    <h2 className="text-xl font-bold text-white mb-1">Closest matches</h2>
                    <p className="text-gray-400 text-sm mb-6">Titles that match what you described, even without the exact words</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
                        {closest.map((item) => (
                            <MediaCard key={item.id} item={item} onInfo={onInfo} onPlay={onPlay} />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
