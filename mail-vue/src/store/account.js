    import { defineStore } from 'pinia'

import { emailUnreadCounts } from '@/request/email.js'

export const useAccountStore = defineStore('account', {
    state: () => ({
        currentAccountId: 0,
        currentAccount: {},
        changeUserAccountName: '',
        // Unread counts per accountId, plus the total across all of the
        // caller's accounts. Shown as badges in the address list.
        unreadCounts: {},
        totalUnread: 0
    }),
    actions: {
        async refreshUnreadCounts() {
            try {
                const data = await emailUnreadCounts()
                this.unreadCounts = data?.counts || {}
                this.totalUnread = data?.total || 0
            } catch (e) {
                console.error(e)
            }
        }
    }
})