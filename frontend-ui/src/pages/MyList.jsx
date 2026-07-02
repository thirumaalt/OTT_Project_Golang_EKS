import React, { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import MediaCard from "../components/MediaCard";

export default function MyList({ onPlay, onInfo }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const { user, activeProfile } = useAuth();

    useEffect(() => {
        if (!user || !activeProfile) return;

        const loadWatchlist = async () => {
            setLoading(true);
            try {
                const watchlist = await api(`/user/watchlist?profileId=${activeProfile.id}`);

                // Fetch metadata for each item
                const itemsWithDetails = await Promise.all(watchlist.map(async (w) => {
                    // Use mediaPath as the identifier
                    try {
                        const libraryData = await api("/media/library", { limit: 500 });
                        const found = libraryData.results.find(item => item.path === w.mediaPath);
                        return found || { path: w.mediaPath, title: w.mediaPath.split('/').pop(), id: w.mediaPath };
                    } catch (e) {
                        return { path: w.mediaPath, title: w.mediaPath.split('/').pop(), id: w.mediaPath };
                    }
                }));

                setItems(itemsWithDetails);
            } catch (e) {
                console.error("Failed to load watchlist", e);
            } finally {
                setLoading(false);
            }
        };

        loadWatchlist();
    }, [user, activeProfile]);

    const handleRemove = async (item) => {
        if (!user || !activeProfile) return;
        try {
            await api(`/user/watchlist?profileId=${activeProfile.id}&mediaPath=${encodeURIComponent(item.path)}`, {
                method: "DELETE"
            });
            setItems(items.filter(i => i.path !== item.path));
        } catch (e) {
            console.error("Failed to remove from watchlist", e);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen pt-20 px-4 md:px-12">
                <div className="text-white text-xl">Loading...</div>
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
                <h1 className="text-3xl font-bold text-white mb-2">My List</h1>
                <p className="text-gray-400">
                    {items.length} {items.length === 1 ? "title" : "titles"}
                </p>
            </div>

            {/* Results Grid */}
            {items.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
                    {items.map((item) => (
                        <MediaCard
                            key={item.id}
                            item={item}
                            onInfo={onInfo}
                            onPlay={onPlay}
                            onRemove={handleRemove}
                            inWatchlist={true}
                        />
                    ))}
                </div>
            ) : (
                <div className="text-center py-20">
                    <div className="text-6xl mb-4">❤️</div>
                    <h2 className="text-2xl font-bold text-white mb-2">Your list is empty</h2>
                    <p className="text-gray-400">
                        Click the heart icon on any title to add it to your list
                    </p>
                </div>
            )}
        </div>
    );
}
