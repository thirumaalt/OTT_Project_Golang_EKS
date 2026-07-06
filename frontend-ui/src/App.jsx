import React, { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import Header from "./components/Header";

import Library from "./pages/Library";
import Login from "./pages/Login";
import Register from "./pages/Register";
import SearchResults from "./pages/SearchResults";
import MyList from "./pages/MyList";
import { api } from "./api/client";
import FeaturedHero from "./components/FeaturedHero";
import VideoPlayer from "./components/VideoPlayer";
import InfoModal from "./components/InfoModal";

import ProfileSelection from "./pages/ProfileSelection";
import PlansPage from "./pages/PlansPage";

function ProtectedRoute({ children, requireProfile = false }) {
  const { user, activeProfile, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requireProfile && !activeProfile) {
    return <Navigate to="/profiles" replace />;
  }

  return children;
}

function MainApp() {
  const [tab, setTab] = useState("Movies"); // Movies | Series | Anime
  const [scrolled, setScrolled] = useState(false);
  const [isWatching, setIsWatching] = useState(false);

  // Global Player & Modal State
  const [playerSrc, setPlayerSrc] = useState(null);
  const [playerTitle, setPlayerTitle] = useState("");
  const [infoItem, setInfoItem] = useState(null);
  const [playerItemPath, setPlayerItemPath] = useState(null);

  const { user, activeProfile } = useAuth();
  const location = useLocation();

  const onPlay = (item) => {
    const token = localStorage.getItem("token") || "";
    const base = import.meta.env.VITE_API_BASE ?? "http://localhost:8094";
    let streamUrl = item.hls_url
      ? `${base}${item.hls_url}?token=${encodeURIComponent(token)}`
      : `${base}/api/media/stream?path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(token)}`;

    setPlayerSrc(streamUrl);
    setPlayerTitle(item.title || item.filename);
    setPlayerItemPath(item.path);
    setIsWatching(true);
  };

  const onInfo = (item) => {
    setInfoItem(item);
  };

  const closePlayer = () => {
    setPlayerSrc(null);
    setPlayerTitle("");
    setPlayerItemPath(null);
    setIsWatching(false);
  };

  // Don't show hero on search page
  const isSearchPage = location.pathname === "/search";

  // Sync URL with Tab State
  useEffect(() => {
    const path = location.pathname;
    if (path === "/series" || path === "/tvshows") {
      setTab("Series");
    } else if (path === "/anime") {
      setTab("Anime");
    } else {
      setTab("Movies");
    }
  }, [location.pathname]);

  // Handle scroll for transparent navbar effect
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Fetch featured content
  useEffect(() => {
    if (!user || !activeProfile || isSearchPage) return;

    // ... fetch hero logic ...
  }, [user, activeProfile, isSearchPage]);

  return (
    <div className="min-h-screen bg-[#141414] text-white font-sans">
      {!isWatching && <Header />}

      {/* Hero Section */}
      {!isWatching && !isSearchPage && (
        <FeaturedHero onPlay={onPlay} onInfo={onInfo} />
      )}

      {/* Main Content */}
      <main className="relative z-20 pb-20 space-y-8 bg-gradient-to-b from-transparent to-[#141414]">
        <Routes>
          <Route path="/" element={<Library categoryProp={tab} onPlay={onPlay} onInfo={onInfo} />} />
          <Route path="/series" element={<Library categoryProp="Series" onPlay={onPlay} onInfo={onInfo} />} />
          <Route path="/movies" element={<Library categoryProp="Movies" onPlay={onPlay} onInfo={onInfo} />} />
          <Route path="/search" element={<SearchResults onPlay={onPlay} onInfo={onInfo} />} />
          <Route path="/mylist" element={<MyList onPlay={onPlay} onInfo={onInfo} />} />
          <Route path="/plans" element={<ProtectedRoute><PlansPage /></ProtectedRoute>} />
        </Routes>
      </main>

      {/* Global Modals */}
      <InfoModal item={infoItem} onClose={() => setInfoItem(null)} onPlay={(it) => { onPlay(it); setInfoItem(null); }} />
      {playerSrc && (
        <VideoPlayer
          src={playerSrc}
          title={playerTitle}
          itemPath={playerItemPath}
          onClose={closePlayer}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/profiles" element={
            <ProtectedRoute>
              <ProfileSelection />
            </ProtectedRoute>
          } />
          <Route
            path="/*"
            element={
              <ProtectedRoute requireProfile={true}>
                <MainApp />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
