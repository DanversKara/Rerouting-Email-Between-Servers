import http from '@/axios/index.js';

export function emailList(accountId, allReceive, emailId, timeSort, size, type, full, searchParams = {}, deleted = 0) {
    const {type: searchType, text, startDate, endDate} = searchParams
    return http.get('/email/list', {params: {accountId, allReceive, emailId, timeSort, size, type, full, searchType, text, startDate, endDate, deleted}})
}

export function emailUnreadCounts() {
    return http.get('/email/unreadCounts', {noMsg: true})
}

export function emailDelete(emailIds) {
    return http.delete('/email/delete?emailIds=' + emailIds)
}

export function emailRestore(emailIds) {
    return http.post('/email/restore', {emailIds: emailIds.join(',')})
}

export function emailDeleteForever(emailIds) {
    return http.delete('/email/deleteForever?emailIds=' + emailIds)
}

export function emailEmptyTrash() {
    return http.delete('/email/emptyTrash')
}

export function emailReportSpam(emailId) {
    return http.post('/email/reportSpam', {emailId})
}

export function emailLatest(emailId, accountId, allReceive) {
    return http.get('/email/latest', {params: {emailId, accountId, allReceive}, noMsg: true, timeout: 35 * 1000})
}

export function emailRead(emailIds) {
    return http.put('/email/read', {emailIds})
}

export function emailSend(form,progress) {
    return http.post('/email/send', form,{
        onUploadProgress: (e) => {
            progress(e)
        },
        noMsg: true
    })
}
