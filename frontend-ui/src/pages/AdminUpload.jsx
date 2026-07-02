import React, { useState, useEffect, useRef } from "react";
import { API_BASE } from "../api/client";

export default function AdminUpload() {
    const [file, setFile] = useState(null);
    const [title, setTitle] = useState("");
    const [category, setCategory] = useState("Movies");
    const [uploading, setUploading] = useState(false);
    const [message, setMessage] = useState(null);
    const [transcodeStatus, setTranscodeStatus] = useState(null);
    const pollRef = useRef(null);

    // Poll /api/media/queue/status every 4s after a successful upload
    const startPolling = () => {
        stopPolling();
        pollRef.current = setInterval(async () => {
            try {
                const token = localStorage.getItem("token");
                const res = await fetch(`${API_BASE}/api/media/queue/status`, {
                    headers: { "Authorization": `Bearer ${token}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    setTranscodeStatus(data);
                    // Stop polling once queue drains
                    if (data.queue?.pending_count === 0 && !data.queue?.processing) {
                        stopPolling();
                    }
                }
            } catch (_) {}
        }, 4000);
    };

    const stopPolling = () => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    };

    useEffect(() => () => stopPolling(), []);

    const handleUpload = async (e) => {
        e.preventDefault();
        if (!file || !title) return alert("Please select a file and enter a title");

        const formData = new FormData();
        formData.append("file", file);
        formData.append("title", title);
        formData.append("category", category);

        setUploading(true);
        setMessage(null);
        setTranscodeStatus(null);
        try {
            const token = localStorage.getItem("token");
            const res = await fetch(`${API_BASE}/api/media/upload`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${token}` },
                body: formData
            });

            if (res.ok) {
                const data = await res.json();
                const queued = data.transcoding_queued;
                setMessage({
                    type: "success",
                    text: queued
                        ? "Upload successful! Transcoding queued — status below."
                        : "Upload successful! Kafka not available — transcoding will start when the service picks it up."
                });
                setTitle("");
                setFile(null);
                if (queued) startPolling();
            } else {
                const errText = await res.text();
                setMessage({ type: "error", text: `Upload Failed: ${errText}` });
            }
        } catch (err) {
            console.error(err);
            setMessage({ type: "error", text: "Upload Error: Network issue or server down." });
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#141414] text-white p-8 pt-24 flex justify-center">
            <div className="w-full max-w-2xl">
                <h1 className="text-3xl font-bold mb-8">Upload New Content</h1>

                <div className="bg-gray-900 p-8 rounded-lg border border-gray-800">
                    {message && (
                        <div className={`p-4 mb-6 rounded ${message.type === 'success' ? 'bg-green-900/50 text-green-200' : 'bg-red-900/50 text-red-200'}`}>
                            {message.text}
                        </div>
                    )}

                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm text-gray-400 mb-2">Title</label>
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                className="w-full bg-black border border-gray-700 rounded p-3 text-white focus:border-red-600 outline-none transition-colors"
                                placeholder="e.g. Inception"
                            />
                        </div>

                        <div>
                            <label className="block text-sm text-gray-400 mb-2">Category</label>
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                className="w-full bg-black border border-gray-700 rounded p-3 text-white focus:border-red-600 outline-none transition-colors"
                            >
                                <option value="Movies">Movies</option>
                                <option value="TvShows">TV Shows</option>
                                <option value="Anime">Anime</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm text-gray-400 mb-2">Video File</label>
                            <div className="border-2 border-dashed border-gray-700 rounded-lg p-8 text-center hover:border-red-600 transition-colors cursor-pointer relative">
                                <input
                                    type="file"
                                    accept="video/*"
                                    onChange={(e) => setFile(e.target.files[0])}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                />
                                <div className="text-gray-400">
                                    {file ? (
                                        <span className="text-white font-medium">{file.name}</span>
                                    ) : (
                                        <>
                                            <p className="text-lg mb-2">Drag and drop or click to select</p>
                                            <p className="text-sm text-gray-500">MP4, MKV, AVI (Max 2GB)</p>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>

                        <button
                            onClick={handleUpload}
                            disabled={uploading}
                            className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-4 rounded transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                        >
                            {uploading ? (
                                <>
                                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Uploading...
                                </>
                            ) : "Upload Video"}
                        </button>
                    </div>
                </div>

                {/* Transcoding Status Panel */}
                {transcodeStatus && (
                    <div className="mt-6 bg-gray-900 p-6 rounded-lg border border-gray-800">
                        <h2 className="text-lg font-semibold mb-4 text-gray-200">Transcoding Queue</h2>
                        <div className="grid grid-cols-3 gap-4 mb-4">
                            <div className="bg-black rounded p-3 text-center">
                                <div className="text-2xl font-bold text-yellow-400">{transcodeStatus.queue?.pending_count ?? 0}</div>
                                <div className="text-xs text-gray-400 mt-1">Pending</div>
                            </div>
                            <div className="bg-black rounded p-3 text-center">
                                <div className="text-2xl font-bold text-blue-400">{transcodeStatus.queue?.processing ? 1 : 0}</div>
                                <div className="text-xs text-gray-400 mt-1">Processing</div>
                            </div>
                            <div className="bg-black rounded p-3 text-center">
                                <div className="text-2xl font-bold text-green-400">{transcodeStatus.queue?.completed_count ?? 0}</div>
                                <div className="text-xs text-gray-400 mt-1">Completed</div>
                            </div>
                        </div>
                        {transcodeStatus.queue?.processing && (
                            <div className="text-sm text-gray-400 truncate">
                                <span className="text-blue-400 mr-2">⚙ Processing:</span>
                                {typeof transcodeStatus.queue.processing === "string"
                                    ? transcodeStatus.queue.processing.split("/").pop()
                                    : transcodeStatus.queue.processing?.storage_key?.split("/").pop() ?? "..."}
                            </div>
                        )}
                        {transcodeStatus.queue?.failed_count > 0 && (
                            <div className="mt-3 text-sm text-red-400">
                                ⚠ {transcodeStatus.queue.failed_count} job(s) failed — check transcoding service logs.
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
