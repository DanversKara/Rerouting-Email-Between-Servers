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

export function userDelete() {
    return http.delete('/my/delete')
}

