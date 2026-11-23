import http from '@/axios/index.js';

export function loginUserInfo() {
    return http.get('/my/loginUserInfo')
}

export function resetPassword(password) {
    return http.put('/my/resetPassword', {password})
}

export function setEmailSecurity(settings) {
    return http.put('/my/emailSecurity', settings)
}

export function totpSetup() {
    return http.post('/my/totp/setup')
}

export function totpEnable(code) {
    return http.post('/my/totp/enable', {code})
}

export function totpDisable(password, code) {
    return http.post('/my/totp/disable', {password, code})
}

export function totpRegenerateBackupCodes(code) {
    return http.post('/my/totp/regenerateBackupCodes', {code})
}

export function userDelete() {
    return http.delete('/my/delete')
}

