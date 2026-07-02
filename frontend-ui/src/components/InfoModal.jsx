import React from "react";

export default function InfoModal({ item, onClose, onPlay }) {
  if (!item) return null;

  const metadata = item.metadata;
  const fallbackPoster = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><rect width="400" height="600" fill="#1a1a2e"/><rect x="0" y="0" width="400" height="4" fill="#e50914"/><text x="200" y="290" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">${(item?.title || item?.filename || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').substring(0,28)}</text><text x="200" y="330" font-family="Arial,sans-serif" font-size="14" fill="#888" text-anchor="middle">No poster available</text></svg>`).replace(/#/g,'%23')}`;
  const poster = metadata?.poster_path
    ? `https://image.tmdb.org/t/p/w500${metadata.poster_path}`
    : (item?.poster || fallbackPoster);

  const backdrop = metadata?.backdrop_path
    ? `https://image.tmdb.org/t/p/original${metadata.backdrop_path}`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 max-w-4xl w-full bg-[#181818]/90 backdrop-blur-xl border border-white/10 rounded-xl overflow-hidden shadow-2xl animate-scale-up">

        {/* Backdrop Header */}
        <div className="relative h-64 sm:h-80 w-full">
          {backdrop ? (
            <img src={backdrop} alt="" className="w-full h-full object-cover opacity-60" />
          ) : (
            <div className="w-full h-full bg-gradient-to-r from-gray-900 to-gray-800" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#181818] via-transparent to-transparent" />

          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-black/40 backdrop-blur-md border border-white/10 text-white flex items-center justify-center hover:bg-white hover:text-black transition"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-6 p-6 sm:px-8 -mt-20 relative z-20">
          {/* Poster */}
          <div className="w-32 sm:w-48 aspect-[2/3] rounded-lg shadow-lg overflow-hidden flex-shrink-0 border border-white/10">
            <img src={poster} alt="" className="w-full h-full object-cover" />
          </div>

          {/* Content */}
          <div className="flex-1 pt-2">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-2">{metadata?.title || item.title || item.filename}</h2>

            <div className="flex items-center flex-wrap gap-3 text-sm text-gray-300 mb-4">
              {metadata?.vote_average && (
                <span className="text-green-400 font-bold">{Math.round(metadata.vote_average * 10)}% Match</span>
              )}
              <span>{metadata?.release_date ? new Date(metadata.release_date).getFullYear() : (item.year || "2023")}</span>
              <span className="border border-gray-500 px-1.5 rounded text-xs">
                {metadata?.release_dates?.results?.find(r => r.iso_3166_1 === "US")?.release_dates?.find(d => d.certification)?.certification || "HD"}
              </span>
              {metadata?.runtime && <span>{Math.floor(metadata.runtime / 60)}h {metadata.runtime % 60}m</span>}
              {metadata?.genres && <span>{metadata.genres.slice(0, 3).map(g => g.name).join(", ")}</span>}
            </div>

            <p className="text-gray-300 leading-relaxed text-sm sm:text-base mb-6 line-clamp-3">
              {metadata?.overview || "No description available."}
            </p>

            {/* Cast & Crew */}
            {metadata?.credits && (
              <div className="mb-6 text-sm text-gray-400">
                <p><span className="text-gray-200">Starring:</span> {metadata.credits.cast?.slice(0, 5).map(c => c.name).join(", ")}</p>
                <p><span className="text-gray-200">Director:</span> {metadata.credits.crew?.find(c => c.job === "Director")?.name}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => onPlay(item)}
                className="px-6 py-2.5 rounded bg-white text-black font-bold hover:bg-gray-200 transition flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                Play
              </button>
              <button onClick={onClose} className="px-6 py-2.5 rounded border border-gray-500 text-white hover:bg-white/10 transition">
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
