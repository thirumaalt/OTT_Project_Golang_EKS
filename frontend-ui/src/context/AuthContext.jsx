import React, { createContext, useContext, useState, useEffect } from "react";
import { api } from "../api/client";

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [activeProfile, setActiveProfile] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Check for existing token and user details
        const token = localStorage.getItem("token");
        const userId = localStorage.getItem("userId");
        const username = localStorage.getItem("username");
        const savedProfile = localStorage.getItem("activeProfile");

        if (token) {
            setUser({
                token,
                id: userId ? parseInt(userId) : null,
                email: username
            });
            if (savedProfile) {
                setActiveProfile(JSON.parse(savedProfile));
            }
        }
        setLoading(false);
    }, []);

    const login = async (email, password) => {
        try {
            const res = await api("/auth/login", { method: "POST", body: { username: email, password } });
            // res should be { token: "...", userId: 123, username: "..." }
            if (res.token) {
                localStorage.setItem("token", res.token);
                localStorage.setItem("userId", res.userId);
                localStorage.setItem("username", res.username);

                // Store user details in state
                setUser({
                    token: res.token,
                    id: res.userId,
                    email: res.username
                });
                return true;
            }
        } catch (e) {
            console.error("Login failed", e);
            throw e;
        }
        return false;
    };

    const selectProfile = (profile) => {
        setActiveProfile(profile);
        localStorage.setItem("activeProfile", JSON.stringify(profile));
    };

    const logout = () => {
        localStorage.removeItem("token");
        localStorage.removeItem("userId");
        localStorage.removeItem("username");
        localStorage.removeItem("activeProfile");
        setUser(null);
        setActiveProfile(null);
    };

    return (
        <AuthContext.Provider value={{ user, activeProfile, login, logout, selectProfile, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
