import http from '@/axios/index.js';

export function login(email, password, token) {
    return http.post('/login', {email, password, token})
}

export function verifyTotpLogin(challenge, code) {
    return http.post('/login/totp', {challenge, code})
}

export function logout() {
    return http.delete('/logout')
}

export function register(form) {
    return http.post('/register', form)
}

export function requestPasswordReset(email) {
    return http.post('/forget-password', {email})
}

export function confirmPasswordReset(token, password) {
    return http.post('/reset-password', {token, password})
}
