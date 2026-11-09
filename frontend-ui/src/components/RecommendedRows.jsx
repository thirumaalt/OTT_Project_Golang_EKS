import React, { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import MediaCard from "./MediaCard";

// Library is fetched once per page load and shared (one S3 listing, not one per recommendation).
let libraryPromise = null;
function loadLibrary() {
  if (!libraryPromise) {
    libraryPromise = (async () => {
      const all = [];
      const limit = 500;
      for (let offset = 0; ; offset += limit) {
        const res = await api("/media/library", { limit, offset });
        const batch = res?.results || [];
        all.push(...batch);
        if (all.length >= (res?.total || 0) || batch.length === 0) break;
      }
      return all;
    })().catch((e) => {
      libraryPromise = null; // allow retry on next mount
      throw e;
    });
  }
  return libraryPromise;
}

// "Casablanca (1943)" / "casablanca.1943" / "Casablanca" -> "casablanca"
// A trailing year is dropped only when something remains ("1917" stays "1917").
export function titleKey(raw) {
  let s = (raw || "").toLowerCase().replace(/\.[^/.]+$/, "");
  s = s.replace(/[\(\[]\s*(19|20)\d{2}\s*[\)\]]/g, " ");
  const noYear = s.replace(/[\s._-]+(19|20)\d{2}\s*$/, "");
  if (/[a-z0-9]/.test(noYear)) s = noYear;
  return s.replace(/[^a-z0-9]+/g, "");
}

export default function RecommendedRows({ onInfo, onPlay }) {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const [home, library] = await Promise.all([
          api("/recommendation/home", { userId: user.id }),
          loadLibrary(),
        ]);
        const byKey = new Map();
        for (const f of library) {
          const k = titleKey(f.title);
          if (k && !byKey.has(k)) byKey.set(k, f);
        }
        // "recent" and "trending" already exist on the page (Continue Watching / Trending Now)
        const resolved = (home?.rows || [])
          .filter((r) => r.key !== "recent" && r.key !== "trending")
          .map((r) => ({
            key: r.key,
            title: r.title,
            items: (r.items || [])
              .map((it) => byKey.get(titleKey(it.title)))
              .filter(Boolean),
          }))
          .filter((r) => r.items.length > 0);
        if (!cancelled) setRows(resolved);
      } catch (e) {
        console.error("Failed to load recommendations", e); // shelf simply doesn't show
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  return rows.map((row) => (
    <div key={row.key} className="mb-12 w-full text-left">
      <h3 className="text-lg font-bold text-gray-400 mb-4 uppercase tracking-wider text-left">{row.title}</h3>
      <div className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide">
        {row.items.map((item) => (
          <div key={item.id} className="w-[130px] md:w-[160px] flex-none">
            <MediaCard item={item} onInfo={onInfo} onPlay={onPlay} />
          </div>
        ))}
      </div>
    </div>
  ));
}
