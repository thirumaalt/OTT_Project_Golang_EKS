const API_BASE = '/api'

export async function api(endpoint, options = {}) {
    const token = localStorage.getItem('token')

    const headers = {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...options.headers
    }

    const res = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    })

    if (res.status === 401) {
        // Token expired or invalid - redirect to main app login
        localStorage.removeItem('token')
        window.location.href = '/login'
        return
    }

    if (!res.ok) {
        const error = await res.text()
        throw new Error(error || 'API Error')
    }

    return res.json()
}

export { API_BASE }
