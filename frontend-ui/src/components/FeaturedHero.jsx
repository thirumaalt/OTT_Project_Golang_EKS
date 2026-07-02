import React, { useState, useEffect } from "react";
import { api } from "../api/client";

export default function FeaturedHero({ onPlay, onInfo }) {
    const [featuredItem, setFeaturedItem] = useState(null);
    const [metadata, setMetadata] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchFeatured() {
            try {
                // Fetch a few items to pick one randomly
                // We'll fetch from "Movies" to ensure we get a movie for the hero usually
                const data = await api("/media/library", { category: "Movies", limit: 20 });
                if (data && data.results && data.results.length > 0) {
                    const randomItem = data.results[Math.floor(Math.random() * data.results.length)];
                    setFeaturedItem(randomItem);

                    // Fetch metadata for backdrop
                    const title = randomItem.title || randomItem.filename;
                    const metaRes = await api(`/metadata/title/${encodeURIComponent(title)}`);
                    if (metaRes && metaRes.data) {
                        const tmdb = JSON.parse(metaRes.data);
                        if (tmdb.results && tmdb.results.length > 0) {
                            setMetadata(tmdb.results[0]);
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to fetch featured item", e);
            } finally {
                setLoading(false);
            }
        }
        fetchFeatured();
    }, []);

    if (loading) return <div className="h-[70vh] bg-black/50 animate-pulse" />;
    if (!featuredItem) return null;

    const backdropUrl = metadata?.backdrop_path
        ? `https://image.tmdb.org/t/p/original${metadata.backdrop_path}`
        : null;

    return (
        <div className="relative h-[85vh] w-full -mt-24 mb-8">
            {/* Background Image */}
            <div className="absolute inset-0">
                {backdropUrl ? (
                    <img
                        src={backdropUrl}
                        alt={featuredItem.title}
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="w-full h-full bg-gradient-to-br from-gray-900 to-black" />
                )}
                {/* Gradient Overlay */}
                <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#141414] via-transparent to-transparent" />
            </div>

            {/* Content */}
            <div className="absolute inset-0 flex items-end px-4 md:px-12 pb-20">
                <div className="max-w-2xl space-y-6 text-left">
                    <h1 className="text-5xl md:text-7xl font-bold text-white drop-shadow-lg">
                        {featuredItem.title}
                    </h1>

                    {metadata?.overview && (
                        <p className="text-lg md:text-xl text-gray-200 line-clamp-3 drop-shadow-md max-w-xl">
                            {metadata.overview}
                        </p>
                    )}

                    <div className="flex items-center gap-4 pt-4">
                        <button
                            onClick={() => onPlay({ ...featuredItem, metadata })}
                            className="px-8 py-3 bg-white text-black font-bold rounded hover:bg-white/90 transition flex items-center gap-2 text-xl"
                        >
                            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                            Play
                        </button>
                        <button
                            onClick={() => onInfo({ ...featuredItem, metadata })}
                            className="px-8 py-3 bg-gray-500/70 text-white font-bold rounded hover:bg-gray-500/50 transition flex items-center gap-2 text-xl backdrop-blur-sm"
                        >
                            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            More Info
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
