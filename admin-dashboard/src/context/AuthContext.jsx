import React, { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        // Check for existing token from main app
        const token = localStorage.getItem('token')
        const userId = localStorage.getItem('userId')
        const username = localStorage.getItem('username')

        if (token) {
            setUser({
                token,
                id: userId ? parseInt(userId) : null,
                email: username,
                isAdmin: true // Admin dashboard assumes admin role
            })
        }
        setLoading(false)
    }, [])

    const logout = () => {
        localStorage.removeItem('token')
        localStorage.removeItem('userId')
        localStorage.removeItem('username')
        localStorage.removeItem('activeProfile')
        setUser(null)
        // Redirect to main app login
        window.location.href = '/login'
    }

    const value = {
        user,
        loading,
        logout,
        isAuthenticated: !!user
    }

    return (
        <AuthContext.Provider value={value}>
            {!loading && children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const context = useContext(AuthContext)
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider')
    }
    return context
}
