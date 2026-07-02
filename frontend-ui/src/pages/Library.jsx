import React, { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import MediaCard from "../components/MediaCard";

export default function Library({ categoryProp, onPlay, onInfo }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState(categoryProp || "Movies");
  const [sort, setSort] = useState("date_desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(36);
  const [loading, setLoading] = useState(false);

  const { user, activeProfile } = useAuth();
  const [historyItems, setHistoryItems] = useState([]);
  const [trendingItems, setTrendingItems] = useState([]);

  useEffect(() => setCategory(categoryProp), [categoryProp]);

  // Fetch History & Trending
  useEffect(() => {
    if (!user || !activeProfile) return;

    // History
    api(`/user/history?profileId=${activeProfile.id}`).then(async (history) => {
      const items = await Promise.all(history.map(async (h) => {
        const filename = h.mediaPath.split(/[/\\]/).pop();
        const title = filename.replace(/\.[^/.]+$/, "").replace(/\s*[\(\[]?\d{4}[\)\]]?\s*$/, "").trim();
        // Try to fetch metadata
        let meta = null;
        try {
          const metaRes = await api(`/metadata/title/${encodeURIComponent(title)}`);
          if (metaRes && metaRes.data) {
            const tmdb = JSON.parse(metaRes.data);
            if (tmdb.results && tmdb.results.length > 0) {
              meta = tmdb.results[0];
            } else if (tmdb.id) {
              meta = tmdb;
            }
          }
        } catch (e) { }
        return {
          id: h.id, // history id
          path: h.mediaPath,
          title: title,
          filename: filename,
          metadata: meta,
          progress: h.progressSeconds,
          total: h.totalDuration
        };
      }));
      setHistoryItems(items);
    }).catch(console.error);

    // Trending
    api("/user/trending").then(async (paths) => {
      const items = await Promise.all(paths.map(async (path) => {
        const filename = path.split(/[/\\]/).pop();
        const title = filename.replace(/\.[^/.]+$/, "").replace(/\s*[\(\[]?\d{4}[\)\]]?\s*$/, "").trim();
        let meta = null;
        try {
          const metaRes = await api(`/metadata/title/${encodeURIComponent(title)}`);
          if (metaRes && metaRes.data) {
            const tmdb = JSON.parse(metaRes.data);
            if (tmdb.results && tmdb.results.length > 0) {
              meta = tmdb.results[0];
            } else if (tmdb.id) {
              meta = tmdb;
            }
          }
        } catch (e) { }
        return {
          path: path,
          title: title,
          filename: filename,
          metadata: meta
        };
      }));
      setTrendingItems(items);
    }).catch(console.error);

  }, [user, activeProfile]);

  useEffect(() => {
    let cancelled = false;
    async function loadData() {
      setLoading(true);
      try {
        const offset = (page - 1) * limit;
        const data = await api("/media/library", { category, sort, limit, offset });
        if (!cancelled) {
          setItems(data.results || []);
          setTotal(data.total || 0);
        }
      } catch (e) {
        console.error("Failed to load library", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadData();
    return () => { cancelled = true; };
  }, [category, sort, page, limit]);

  const pages = Math.ceil(total / limit);

  return (
    <div className="pb-20 -mt-32 relative z-20 px-4 md:px-12">

      {/* Filter Bar */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4 pt-12">
        <h2 className="text-2xl md:text-3xl font-bold text-white">
          {category === "Series" ? "TV Shows" : category}
        </h2>

        <div className="flex items-center gap-4">
          {/* Category Pills (Only show if not locked by prop) */}
          {!categoryProp && (
            <div className="flex bg-black/40 rounded-full p-1 border border-white/10">
              {["Movies", "Series", "Anime"].map((cat) => (
                <button
                  key={cat}
                  onClick={() => { setCategory(cat); setPage(1); }}
                  className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${category === cat ? "bg-white text-black" : "text-gray-400 hover:text-white"
                    }`}
                >
                  {cat === "Series" ? "TV" : cat}
                </button>
              ))}
            </div>
          )}

          {/* Sort Dropdown */}
          <div className="relative group">
            <button className="flex items-center gap-2 bg-black/40 border border-white/10 px-4 py-2 rounded text-sm font-medium hover:bg-white/10 transition">
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" /></svg>
              <span>Sort: {sort === "date_desc" ? "Newest" : sort === "date_asc" ? "Oldest" : sort === "title_asc" ? "A-Z" : "Z-A"}</span>
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>

            <div className="absolute right-0 mt-2 w-48 bg-black/90 border border-white/10 rounded shadow-xl opacity-0 group-hover:opacity-100 invisible group-hover:visible transition-all duration-200 z-50">
              {[
                { label: "Newest Added", value: "date_desc" },
                { label: "Oldest Added", value: "date_asc" },
                { label: "Title (A-Z)", value: "title_asc" },
                { label: "Title (Z-A)", value: "title_desc" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSort(opt.value)}
                  className={`block w-full text-left px-4 py-3 text-sm hover:bg-white/10 transition ${sort === opt.value ? "text-red-500 font-bold" : "text-gray-300"
                    }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Continue Watching Row */}
      {historyItems.length > 0 && (
        <div className="mb-12 w-full text-left">
          <h3 className="text-lg font-bold text-gray-400 mb-4 uppercase tracking-wider text-left">Continue Watching</h3>
          <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
            {historyItems.map((item) => (
              <div key={item.id} className="w-[130px] md:w-[160px] flex-none">
                <MediaCard item={item} onInfo={onInfo} onPlay={onPlay} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trending Now Row */}
      {trendingItems.length > 0 && (
        <div className="mb-12 w-full text-left">
          <h3 className="text-lg font-bold text-gray-400 mb-4 uppercase tracking-wider text-left">Trending Now</h3>
          <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
            {trendingItems.map((item) => (
              <div key={item.path} className="w-[130px] md:w-[160px] flex-none">
                <MediaCard item={item} onInfo={onInfo} onPlay={onPlay} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Grid */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-[2/3] bg-white/5 animate-pulse rounded-md" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-x-4 gap-y-8">
          {items.map((item) => (
            <MediaCard key={item.id} item={item} onInfo={onInfo} onPlay={onPlay} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="mt-12 flex justify-center gap-2">
          <button
            className="px-4 py-2 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition text-white"
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
          >
            Previous
          </button>
          <div className="flex items-center px-4 text-sm text-gray-400">
            Page {page} of {pages}
          </div>
          <button
            className="px-4 py-2 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition text-white"
            disabled={page >= pages}
            onClick={() => setPage(p => Math.min(pages, p + 1))}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
