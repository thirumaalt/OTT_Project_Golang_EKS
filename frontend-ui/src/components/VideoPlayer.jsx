import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import Hls from "hls.js";

export default function VideoPlayer({ src, title, onClose, itemPath }) {
  const vidRef = useRef(null);
  const containerRef = useRef(null);
  const { user, activeProfile } = useAuth();

  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [initialSeekDone, setInitialSeekDone] = useState(false);

  // Quality selector state
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [qualityLevels, setQualityLevels] = useState([]);
  const [currentQuality, setCurrentQuality] = useState(-1); // -1 = auto
  const hlsRef = useRef(null);

  // Auto-hide controls timer
  const controlsTimeoutRef = useRef(null);

  // Fetch history on mount
  useEffect(() => {
    if (!user || !itemPath || !activeProfile) return;
    api(`/user/history?profileId=${activeProfile.id}`)
      .then(history => {
        const match = history.find(h => h.mediaPath === itemPath);
        if (match && match.progressSeconds > 10) {
          if (vidRef.current) {
            vidRef.current.currentTime = match.progressSeconds;
            setInitialSeekDone(true);
          }
        }
      })
      .catch(console.error);
  }, [user, itemPath, activeProfile]);

  // Save progress periodically
  useEffect(() => {
    if (!user || !itemPath || !activeProfile) return;
    const interval = setInterval(() => {
      if (vidRef.current && !vidRef.current.paused) {
        saveProgress();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [user, itemPath, activeProfile]);

  const saveProgress = () => {
    if (!vidRef.current || !user || !itemPath || !activeProfile) return;
    const current = vidRef.current.currentTime;
    const total = vidRef.current.duration;
    if (current > 5) {
      api("/user/history", {
        method: "POST",
        body: {
          profileId: activeProfile.id,
          mediaPath: itemPath,
          progressSeconds: current,
          totalDuration: total
        }
      }).catch(console.error);
    }
  };

  useEffect(() => {
    const v = vidRef.current;
    if (!v || !src) return;

    let hls = null;

    if (src.endsWith(".m3u8")) {
      if (Hls.isSupported()) {
        hls = new Hls();
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(v);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // Detect quality levels
          if (hls.levels.length > 1) {
            setQualityLevels(hls.levels);
            setCurrentQuality(-1); // Auto by default
          }
          v.play().catch(console.error);
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
          setCurrentQuality(data.level);
        });
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = src;
        v.addEventListener("loadedmetadata", () => {
          v.play().catch(console.error);
        });
      }
    } else {
      v.src = src;
      v.play().catch(() => {
        setMuted(true);
        v.muted = true;
        v.play().catch(console.error);
      });
    }

    const onTimeUpdate = () => setProgress(v.currentTime);
    const onDurationChange = () => setDuration(v.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      saveProgress(); // Save on pause
    };
    const onWaiting = () => setBuffering(true);
    const onPlaying = () => setBuffering(false);

    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("durationchange", onDurationChange);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);

    return () => {
      if (hls) hls.destroy();
      saveProgress(); // Save on unmount
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("durationchange", onDurationChange);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
    };
  }, [src]);

  // Sync fullscreen state when user exits via Escape or browser controls
  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!vidRef.current) return;

      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          toggleMute();
          break;
        case "arrowright":
          seekRelative(10);
          break;
        case "arrowleft":
          seekRelative(-10);
          break;
        case "escape":
          if (!document.fullscreenElement) onClose();
          break;
      }
      showControlsTemporarily();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const togglePlay = () => {
    if (vidRef.current) {
      if (vidRef.current.paused) vidRef.current.play();
      else vidRef.current.pause();
    }
  };

  const changeQuality = (levelIndex) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex; // -1 for auto
      setCurrentQuality(levelIndex);
      setShowQualityMenu(false);
    }
  };

  const toggleMute = () => {
    if (vidRef.current) {
      vidRef.current.muted = !vidRef.current.muted;
      setMuted(vidRef.current.muted);
    }
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (vidRef.current) {
      vidRef.current.volume = val;
      vidRef.current.muted = val === 0;
      setMuted(val === 0);
    }
  };

  const seek = (time) => {
    if (vidRef.current) {
      vidRef.current.currentTime = time;
      setProgress(time);
    }
  };

  const seekRelative = (seconds) => {
    if (vidRef.current) {
      const newTime = Math.max(0, Math.min(vidRef.current.duration, vidRef.current.currentTime + seconds));
      vidRef.current.currentTime = newTime;
      setProgress(newTime);
    }
  };

  const handleSeek = (e) => {
    const time = parseFloat(e.target.value);
    seek(time);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  };

  const changeSpeed = () => {
    const speeds = [0.5, 0.75, 1, 1.25, 1.5];
    const nextIdx = (speeds.indexOf(playbackRate) + 1) % speeds.length;
    const newSpeed = speeds[nextIdx];
    setPlaybackRate(newSpeed);
    if (vidRef.current) vidRef.current.playbackRate = newSpeed;
  };

  const showControlsTemporarily = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (playing) setShowControls(false);
    }, 3000);
  };

  const handleMouseMove = () => {
    showControlsTemporarily();
  };

  const formatTime = (seconds) => {
    if (!seconds) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m < 10 ? "0" + m : m}:${s < 10 ? "0" + s : s}`;
    return `${m}:${s < 10 ? "0" + s : s}`;
  };

  if (!src) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[60] bg-black flex items-center justify-center group overflow-hidden font-sans"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => playing && setShowControls(false)}
    >
      <video
        ref={vidRef}
        className="w-full h-full object-contain"
        src={src}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      />

      {/* Buffering Spinner */}
      {buffering && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-16 h-16 border-4 border-white/20 border-t-[#e50914] rounded-full animate-spin" />
        </div>
      )}

      {/* Controls Overlay */}
      <div
        className={`absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/80 transition-opacity duration-300 flex flex-col justify-between ${showControls ? "opacity-100" : "opacity-0 cursor-none"}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) togglePlay();
        }}
      >
        {/* Top Bar */}
        <div className="p-8 flex items-center justify-between">
          <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="text-white hover:scale-110 transition">
            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
          </button>
          <button className="text-white hover:scale-110 transition" title="Report">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-8a2 2 0 012-2h14a2 2 0 012 2v8M3 21h18M5 11V7a2 2 0 012-2h14a2 2 0 012 2v4M5 11l14-4" /></svg>
          </button>
        </div>

        {/* Bottom Bar Container */}
        <div className="px-8 pb-8 pt-4 space-y-2" onClick={(e) => e.stopPropagation()}>

          {/* Progress Bar (Full Width, Red) */}
          <div className="relative group/progress h-4 flex items-center cursor-pointer">
            {/* Background Track */}
            <div className="absolute w-full h-1 bg-gray-600 rounded-full group-hover/progress:h-2 transition-all" />

            {/* Played Track */}
            <div
              className="absolute h-1 bg-[#e50914] rounded-l-full group-hover/progress:h-2 transition-all"
              style={{ width: `${(progress / (duration || 1)) * 100}%` }}
            />

            {/* Scrubber Knob */}
            <div
              className="absolute w-4 h-4 bg-[#e50914] rounded-full scale-0 group-hover/progress:scale-100 transition-transform shadow-lg"
              style={{ left: `calc(${(progress / (duration || 1)) * 100}% - 8px)` }}
            />

            {/* Input Range (Invisible but functional) */}
            <input
              type="range"
              min="0"
              max={duration || 100}
              value={progress}
              onChange={handleSeek}
              className="absolute w-full h-full opacity-0 cursor-pointer z-10"
            />

            {/* Time Tooltip */}
            <div className="absolute right-0 -top-6 text-xs text-gray-300 font-medium">
              {formatTime(duration - progress)}
            </div>
          </div>

          {/* Controls Row - Added relative for absolute positioning of title */}
          <div className="flex items-center justify-between mt-2 relative">

            {/* Left Controls */}
            <div className="flex items-center gap-6 z-10">
              {/* Play/Pause */}
              <button onClick={togglePlay} className="text-white hover:text-gray-300 transition">
                {playing ? (
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                ) : (
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                )}
              </button>

              {/* Rewind 10s */}
              <button onClick={() => seekRelative(-10)} className="text-white hover:text-gray-300 transition">
                <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" /></svg>
              </button>

              {/* Forward 10s */}
              <button onClick={() => seekRelative(10)} className="text-white hover:text-gray-300 transition">
                <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 group/volume">
                <button onClick={toggleMute} className="text-white hover:text-gray-300 transition">
                  {muted || volume === 0 ? (
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" /></svg>
                  ) : (
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
                  )}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={muted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-0 group-hover/volume:w-24 opacity-0 group-hover/volume:opacity-100 transition-all duration-300 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
                />
              </div>
            </div>

            {/* Center Title - Absolutely positioned within the relative container */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <h3 className="text-white font-medium text-lg drop-shadow-md">{title}</h3>
            </div>

            {/* Right Controls */}
            <div className="flex items-center gap-6 z-10">
              {/* Next Episode */}
              <button className="text-white hover:text-gray-300 transition" title="Next Episode">
                <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4v16l12-8zM19 4v16h2V4z" /></svg>
              </button>

              {/* Episodes List */}
              <button className="text-white hover:text-gray-300 transition" title="Episodes">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
              </button>

              {/* Audio & Subtitles */}
              <button className="text-white hover:text-gray-300 transition" title="Audio & Subtitles">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
              </button>

              {/* Quality Selector */}
              {qualityLevels.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => setShowQualityMenu(!showQualityMenu)}
                    className="text-white hover:text-gray-300 transition"
                    title="Quality"
                  >
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                  </button>

                  {showQualityMenu && (
                    <div className="absolute bottom-full right-0 mb-2 bg-black/95 border border-white/20 rounded shadow-xl py-2 min-w-[150px]">
                      <button
                        onClick={() => changeQuality(-1)}
                        className={`w-full text-left px-4 py-2 hover:bg-white/10 transition ${currentQuality === -1 ? 'text-red-500 font-bold' : 'text-white'}`}
                      >
                        Auto
                      </button>
                      {qualityLevels.map((level, index) => (
                        <button
                          key={index}
                          onClick={() => changeQuality(index)}
                          className={`w-full text-left px-4 py-2 hover:bg-white/10 transition ${currentQuality === index ? 'text-red-500 font-bold' : 'text-white'}`}
                        >
                          {level.height}p
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Speed */}
              <button onClick={changeSpeed} className="text-white hover:text-gray-300 transition font-bold text-sm min-w-[30px]" title="Speed">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </button>

              {/* Fullscreen */}
              <button onClick={toggleFullscreen} className="text-white hover:text-gray-300 transition" title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}>
                {fullscreen ? (
                  // Compress / exit-fullscreen icon
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4m0 5H4m11-5v5m0 0h5M9 15v5m0-5H4m11 5v-5m0 0h5" />
                  </svg>
                ) : (
                  // Expand / enter-fullscreen icon
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
