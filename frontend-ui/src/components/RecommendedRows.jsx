import React, { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import MediaCard from "./MediaCard";
import ScrollRow from "./ScrollRow";

// Library is fetched once per page load and shared (one S3 listing, not one per recommendation).
let libraryPromise = null;
export function loadLibrary() {
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
    let timer = null;

    const resolve = (home, byKey) =>
      (home?.rows || [])
        // "recent" and "trending" already exist on the page (Continue Watching / Trending Now)
        .filter((r) => r.key !== "recent" && r.key !== "trending")
        .map((r) => ({
          key: r.key,
          title: r.title,
          items: (r.items || [])
            .map((it) => {
              const file = byKey.get(titleKey(it.title));
              return file ? { file, reason: it.reason } : null;
            })
            .filter(Boolean),
        }))
        .filter((r) => r.items.length > 0);

    (async () => {
      try {
        const library = await loadLibrary();
        const byKey = new Map();
        for (const f of library) {
          const k = titleKey(f.title);
          if (k && !byKey.has(k)) byKey.set(k, f);
        }

        const [home, ai] = await Promise.all([
          api("/recommendation/home", { userId: user.id }),
          api("/recommendation/ai/home", { userId: user.id }).catch(() => null),
        ]);
        if (cancelled) return;

        const show = (aiRes) => {
          const aiRows = resolve(aiRes, byKey);
          const hasAi = aiRows.some((r) => r.key === "ai");
          // the AI shelf replaces the rule-based "Because you watched" shelf; fall back to it when AI isn't ready
          const base = resolve(home, byKey).filter((r) => !(hasAi && r.key === "because"));
          setRows([...aiRows.filter((r) => r.key === "ai"), ...base]);
        };
        show(ai);

        // The model can take a while on the first request; poll a few times for the cached result.
        let tries = 0;
        const poll = async () => {
          if (cancelled || tries++ >= 6) return;
          const next = await api("/recommendation/ai/home", { userId: user.id }).catch(() => null);
          if (cancelled) return;
          if (next?.pending) {
            timer = setTimeout(poll, 10000);
          } else {
            show(next);
          }
        };
        if (ai?.pending) timer = setTimeout(poll, 10000);
      } catch (e) {
        console.error("Failed to load recommendations", e); // shelf simply doesn't show
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user?.id]);

  return rows.map((row) => (
    <div key={row.key} className="mb-12 w-full text-left">
      <h3 className="text-lg font-bold text-gray-400 mb-4 uppercase tracking-wider text-left">
        {row.title}
        {row.key === "ai" && (
          <span className="ml-3 align-middle rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold tracking-widest text-gray-300">AI</span>
        )}
      </h3>
      <ScrollRow>
        {row.items.map(({ file, reason }) => (
          <div key={file.id ?? file.path ?? file.title} className={`${reason ? "w-[150px] md:w-[180px]" : "w-[130px] md:w-[160px]"} flex-none`}>
            <MediaCard item={file} onInfo={onInfo} onPlay={onPlay} />
            {reason && <p className="mt-2 text-xs leading-snug text-gray-400 normal-case line-clamp-3">{reason}</p>}
          </div>
        ))}
      </ScrollRow>
    </div>
  ));
}
