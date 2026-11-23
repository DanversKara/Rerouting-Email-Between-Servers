import { defineStore } from 'pinia'

export const useTrashStore = defineStore('trash', {
    state: () => ({
        searchParams: {
            text: '',
            type: 'subject',
            startDate: '',
            endDate: '',
        },
    }),
    actions: {
        setSearchParams(params) {
            this.searchParams = {
                ...this.searchParams,
                ...params,
            }
        },
    },
})
