import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";

export default function ProfileSelection() {
    const { user, selectProfile } = useAuth();
    const navigate = useNavigate();
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [newProfileName, setNewProfileName] = useState("");

    useEffect(() => {
        if (!user) return;
        fetchProfiles();
    }, [user]);

    const fetchProfiles = async () => {
        try {
            const data = await api(`/user/profiles?userId=${user.id}`);
            setProfiles(data);
        } catch (e) {
            console.error("Failed to fetch profiles", e);
        } finally {
            setLoading(false);
        }
    };

    const handleSelect = (profile) => {
        selectProfile(profile);
        navigate("/");
    };

    const handleAddProfile = async (e) => {
        e.preventDefault();
        if (!newProfileName.trim()) return;

        try {
            // Random avatar color/image for now
            const avatarUrl = `https://ui-avatars.com/api/?name=${newProfileName}&background=random`;
            await api("/user/profiles", {
                method: "POST",
                body: { userId: user.id, name: newProfileName, avatarUrl }
            });
            setNewProfileName("");
            setIsAdding(false);
            fetchProfiles();
        } catch (e) {
            console.error("Failed to create profile", e);
        }
    };

    if (loading) return <div className="min-h-screen bg-black text-white flex items-center justify-center">Loading...</div>;

    return (
        <div className="min-h-screen bg-[#141414] text-white flex flex-col items-center justify-center">
            <h1 className="text-3xl md:text-5xl font-medium mb-8">Who's watching?</h1>

            <div className="flex flex-wrap justify-center gap-4 md:gap-8 mb-12">
                {profiles.map((profile) => (
                    <div key={profile.id} className="group flex flex-col items-center gap-4 cursor-pointer" onClick={() => handleSelect(profile)}>
                        <div className="w-24 h-24 md:w-32 md:h-32 rounded overflow-hidden border-2 border-transparent group-hover:border-white transition">
                            <img src={profile.avatarUrl} alt={profile.name} className="w-full h-full object-cover" />
                        </div>
                        <span className="text-gray-400 group-hover:text-white text-lg md:text-xl transition">{profile.name}</span>
                    </div>
                ))}

                {/* Add Profile Button */}
                <div className="group flex flex-col items-center gap-4 cursor-pointer" onClick={() => setIsAdding(true)}>
                    <div className="w-24 h-24 md:w-32 md:h-32 rounded flex items-center justify-center bg-transparent border-2 border-gray-400 group-hover:border-white transition hover:bg-gray-800">
                        <svg className="w-12 h-12 text-gray-400 group-hover:text-white" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                        </svg>
                    </div>
                    <span className="text-gray-400 group-hover:text-white text-lg md:text-xl transition">Add Profile</span>
                </div>
            </div>

            {/* Add Profile Modal */}
            {isAdding && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
                    <div className="bg-[#141414] p-8 rounded max-w-md w-full border border-gray-700">
                        <h2 className="text-2xl font-bold mb-4">Add Profile</h2>
                        <form onSubmit={handleAddProfile}>
                            <input
                                type="text"
                                placeholder="Name"
                                className="w-full bg-[#333] text-white px-4 py-2 rounded mb-6 focus:outline-none focus:ring-2 focus:ring-white"
                                value={newProfileName}
                                onChange={(e) => setNewProfileName(e.target.value)}
                                autoFocus
                            />
                            <div className="flex gap-4">
                                <button type="submit" className="bg-white text-black px-6 py-2 font-bold hover:bg-red-600 hover:text-white transition">Save</button>
                                <button type="button" onClick={() => setIsAdding(false)} className="border border-gray-500 text-gray-500 px-6 py-2 font-bold hover:border-white hover:text-white transition">Cancel</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
