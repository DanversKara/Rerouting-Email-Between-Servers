<template>
  <div class="trash-view">
    <el-alert v-if="syncDeleteOn" :title="$t('syncDeleteTrashNote')" type="warning" :closable="false" class="trash-note" show-icon />
    <emailScroll ref="scroll" type="trash"
                 is-trash
                 :show-star="false"
                 :getEmailList="getEmailList"
                 :emailDelete="emailDeleteForever"
                 :emailRestore="emailRestore"
                 :highlight-text="trashStore.searchParams.text"
                 actionLeft="4px"
                 @jump="jumpContent"
    >
      <template #first>
        <el-button size="small" @click="handleEmptyTrash">{{ $t('emptyTrash') }}</el-button>
      </template>
    </emailScroll>
  </div>
</template>

<script setup>
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useSettingStore} from "@/store/setting.js";
import {useTrashStore} from "@/store/trash.js";
import emailScroll from "@/components/email-scroll/index.vue"
import {emailList, emailDeleteForever, emailRestore, emailEmptyTrash} from "@/request/email.js";
import {computed, defineOptions, onMounted, ref, watch} from "vue";
import {ElMessage, ElMessageBox} from 'element-plus'
import {useI18n} from "vue-i18n";
import router from "@/router/index.js";

defineOptions({
  name: 'trash'
})

const {t} = useI18n()
const emailStore = useEmailStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const trashStore = useTrashStore();
const scroll = ref({})

// Sync delete ON means deletes are permanently removed and never reach
// trash - say so, instead of showing a mysteriously empty folder.
const syncDeleteOn = computed(() => settingStore.settings.syncDelete === 0)

onMounted(() => {
  emailStore.trashScroll = scroll;
})

watch(() => accountStore.currentAccountId, () => {
  scroll.value.refreshList();
})

watch(
  () => trashStore.searchParams,
  () => {
    scroll.value.refreshList()
  },
  {deep: true}
)

function jumpContent(email) {
  emailStore.contentData.email = emailStore.toContentEmail(email)
  emailStore.contentData.delType = 'trash'
  emailStore.contentData.showStar = false
  emailStore.contentData.showReply = false
  emailStore.contentData.showUnread = true
  router.push({name: 'content', params: {mailbox: 'trash'}})
}

function getEmailList(emailId, size) {
  const accountId = accountStore.currentAccountId;
  const allReceive = accountStore.currentAccount.allReceive;
  return emailStore.fetchList(full =>
    emailList(accountId, allReceive, emailId, 0, size, 0, full, trashStore.searchParams, 1)
  ).then(data => {
    data.latestEmail.reqAccountId = accountId;
    data.latestEmail.allReceive = allReceive;
    return data;
  })
}

function handleEmptyTrash() {
  ElMessageBox.confirm(t('emptyTrashConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    emailEmptyTrash().then(() => {
      ElMessage({
        message: t('emptyTrashSuccessMsg'),
        type: 'success',
        plain: true,
      })
      scroll.value.refreshList()
    })
  })
}

</script>

<style scoped>
.trash-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.trash-view > .email-container {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}
.trash-note {
  margin-bottom: 8px;
}
</style>
