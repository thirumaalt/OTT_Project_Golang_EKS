import React, { useState, useEffect } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function MediaCard({ item, onInfo, onPlay, onRemove, inWatchlist: initialInWatchlist }) {
  const [metadata, setMetadata] = useState(item.metadata || null);
  const [inWatchlist, setInWatchlist] = useState(initialInWatchlist || false);
  const [loading, setLoading] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (item.metadata) {
      setMetadata(item.metadata);
      return;
    }
    let cancelled = false;
    async function fetchMeta() {
      try {
        const rawTitle = item.title || item.filename;
        const title = rawTitle.replace(/\.[^/.]+$/, "").replace(/\s*[\(\[]?\d{4}[\)\]]?\s*$/, "").trim();
        const data = await api(`/metadata/title/${encodeURIComponent(title)}`);
        if (!cancelled && data && data.data) {
          try {
            const tmdb = JSON.parse(data.data);
            if (tmdb.results && tmdb.results.length > 0) {
              setMetadata(tmdb.results[0]);
            } else if (tmdb.id) {
              setMetadata(tmdb);
            }
          } catch (e) {
            // ignore parse error
          }
        }
      } catch (e) {
        // ignore fetch error
      }
    }
    fetchMeta();
    return () => { cancelled = true; };
  }, [item]);

  // Check if in watchlist
  useEffect(() => {
    if (initialInWatchlist !== undefined) return;
    if (!user) return;

    const checkWatchlist = async () => {
      try {
        const watchlist = await api(`/user/watchlist?userId=${user.id}`);
        const isInList = watchlist.some(w => w.mediaPath === item.path);
        setInWatchlist(isInList);
      } catch (e) {
        console.error("Failed to check watchlist", e);
      }
    };

    checkWatchlist();
  }, [user, item.path, initialInWatchlist]);

  const toggleWatchlist = async (e) => {
    e.stopPropagation();
    if (!user || loading) return;

    setLoading(true);
    try {
      if (inWatchlist) {
        // Remove from watchlist
        await api(`/user/watchlist?userId=${user.id}&mediaPath=${encodeURIComponent(item.path)}`, {
          method: "DELETE"
        });
        setInWatchlist(false);
        if (onRemove) onRemove(item);
      } else {
        // Add to watchlist
        await api("/user/watchlist", {
          method: "POST",
          body: {
            userId: user.id,
            mediaPath: item.path
          }
        });
        setInWatchlist(true);
      }
    } catch (e) {
      console.error("Failed to toggle watchlist", e);
    } finally {
      setLoading(false);
    }
  };

  const posterPath = metadata?.poster_path;
  const fallbackPoster = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><rect width="400" height="600" fill="#1a1a2e"/><rect x="0" y="0" width="400" height="4" fill="#e50914"/><text x="200" y="290" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">${(item.title || item.filename || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').substring(0,28)}</text><text x="200" y="330" font-family="Arial,sans-serif" font-size="14" fill="#888" text-anchor="middle">No poster available</text></svg>`).replace(/#/g,'%23')}`;
  const poster = posterPath
    ? `https://image.tmdb.org/t/p/w500${posterPath}`
    : (item.poster || fallbackPoster);

  return (
    <div
      className="relative group cursor-pointer transition-transform duration-300 hover:scale-105 hover:z-10"
      onClick={() => onInfo({ ...item, metadata })}
    >
      {/* Heart Icon */}
      <button
        onClick={toggleWatchlist}
        disabled={loading}
        className="absolute top-2 right-2 z-20 w-8 h-8 flex items-center justify-center bg-black/60 rounded-full hover:bg-black/80 transition"
      >
        {inWatchlist ? (
          <svg className="w-5 h-5 text-red-500 fill-current" viewBox="0 0 24 24">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        ) : (
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        )}
      </button>

      {/* Card Image */}
      <div className="aspect-[2/3] rounded-md overflow-hidden bg-gray-800">
        <img src={poster} alt={item.title} className="w-full h-full object-cover" loading="lazy" />

        {/* Progress Bar */}
        {item.progress && item.total && item.progress > 0 && item.total > 0 && (
          <div className="absolute bottom-0 left-0 w-full h-1 bg-gray-700">
            <div
              className="h-full bg-[#e50914]"
              style={{ width: `${(item.progress / item.total) * 100}%` }}
            />
          </div>
        )}

        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
          <h3 className="text-white font-bold text-sm md:text-base mb-2 line-clamp-2">
            {item.title || item.filename}
          </h3>
          <div className="flex items-center gap-2 text-xs text-gray-300">
            {metadata?.release_date && (
              <span>{metadata.release_date.substring(0, 4)}</span>
            )}
            {metadata?.vote_average && (
              <span className="text-green-400">
                ⭐ {metadata.vote_average.toFixed(1)}
              </span>
            )}
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={(e) => { e.stopPropagation(); onPlay({ ...item, metadata }); }}
              className="flex-1 px-3 py-1.5 bg-white text-black rounded text-xs font-bold hover:bg-gray-200 transition flex items-center justify-center gap-1"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              Play
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onInfo({ ...item, metadata }); }}
              className="px-3 py-1.5 bg-white/20 text-white rounded text-xs hover:bg-white/30 transition backdrop-blur-sm"
            >
              Info
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
