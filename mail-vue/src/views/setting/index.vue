<template>
  <div class="settings-page">
    <el-scrollbar height="100%">
  <div class="box">
    <div class="container">
      <div class="title">{{$t('profile')}}</div>
      <div class="item setting-row">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item setting-row">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item setting-row">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
    </div>
    <div class="language">
      <div class="title">{{$t('language')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('preferredLanguage')}}</div>
        <el-select
            :model-value="langSelect"
            class="language-select"
            placeholder="Select"
            @change="changeLang"
        >
          <el-option label="中文" value="zh" @pointerdown.prevent.stop="changeLang('zh')"/>
          <el-option label="English" value="en" @pointerdown.prevent.stop="changeLang('en')"/>
        </el-select>
      </div>
    </div>
    <div class="preference-item">
      <div class="title" id="theme-label">{{$t('themeStyle')}}</div>
      <ThemeSelector/>
    </div>
    <div class="preference-item">
      <div class="title">{{$t('noticeTitle')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('noticeInfo')}}</div>
        <div>
          <el-button @click="uiStore.showNotice()">{{$t('viewNotice')}}</el-button>
        </div>
      </div>
    </div>
    <div class="preference-item">
      <div class="title">{{$t('emailSecurityTitle')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('blockImages')}}</div>
        <div>
          <el-switch v-model="blockImages" @change="saveEmailSecurity"/>
        </div>
      </div>
      <div class="security-desc">{{$t('blockImagesDesc')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('disableLinks')}}</div>
        <div>
          <el-switch v-model="disableLinks" @change="saveEmailSecurity"/>
        </div>
      </div>
      <div class="security-desc">{{$t('disableLinksDesc')}}</div>
    </div>
    <div class="preference-item">
      <div class="title">{{$t('totpTitle')}}</div>
      <div class="language-row setting-row">
        <div>{{$t('totpStatus')}}</div>
        <div>
          <el-tag :type="totpEnabled ? 'success' : 'info'">{{ totpEnabled ? $t('totpOn') : $t('totpOff') }}</el-tag>
          <el-button type="primary" style="margin-left: 10px" @click="totpEnabled ? (totpDisableShow = true) : startTotpSetup()">{{ totpEnabled ? $t('totpDisableBtn') : $t('totpEnableBtn') }}</el-button>
        </div>
      </div>
      <div class="security-desc">{{$t('totpDesc')}}</div>
      <div class="language-row setting-row" v-if="totpEnabled">
        <div>{{$t('totpBackupTitle')}}</div>
        <div>
          <el-button @click="totpRegenShow = true">{{$t('totpRegenerateBtn')}}</el-button>
        </div>
      </div>
    </div>
    <div class="del-email" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off" @keyup.enter="submitPwd"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
    <el-dialog v-model="totpSetupShow" :title="$t('totpSetupTitle')" width="340">
      <div class="update-pwd">
        <div class="security-desc">{{$t('totpSetupDesc')}}</div>
        <el-input :model-value="totpSecret" readonly>
          <template #append>
            <el-button @click="copyTotpSecret">{{$t('totpCopySecret')}}</el-button>
          </template>
        </el-input>
        <div>
          <a :href="totpOtpauthUrl" target="_blank" rel="noopener">{{$t('totpOpenAuthApp')}}</a>
        </div>
        <el-input v-model="totpCode" :placeholder="$t('totpCodePlaceholder')" inputmode="numeric" autocomplete="one-time-code" maxlength="6" @keyup.enter="confirmTotpSetup"/>
        <el-button type="primary" :loading="totpLoading" @click="confirmTotpSetup">{{$t('confirm')}}</el-button>
      </div>
    </el-dialog>
    <el-dialog v-model="totpBackupShow" :title="$t('totpBackupTitle')" width="340">
      <div class="update-pwd">
        <div class="security-desc">{{$t('totpBackupDesc')}}</div>
        <div class="totp-backup-codes">
          <div v-for="code in totpBackupCodes" :key="code" class="totp-backup-code">{{ code }}</div>
        </div>
        <el-button type="primary" @click="totpBackupShow = false">{{$t('totpBackupSaved')}}</el-button>
      </div>
    </el-dialog>
    <el-dialog v-model="totpDisableShow" :title="$t('totpDisableTitle')" width="340">
      <div class="update-pwd">
        <div class="security-desc">{{$t('totpDisableDesc')}}</div>
        <el-input type="password" :placeholder="$t('password')" v-model="totpDisableForm.password" autocomplete="off"/>
        <el-input v-model="totpDisableForm.code" :placeholder="$t('totpCodePlaceholder')" inputmode="numeric" autocomplete="one-time-code" maxlength="10" @keyup.enter="confirmTotpDisable"/>
        <el-button type="primary" :loading="totpLoading" @click="confirmTotpDisable">{{$t('confirm')}}</el-button>
      </div>
    </el-dialog>
    <el-dialog v-model="totpRegenShow" :title="$t('totpRegenerateBtn')" width="340">
      <div class="update-pwd">
        <el-input v-model="totpRegenCode" :placeholder="$t('totpCodePlaceholder')" inputmode="numeric" autocomplete="one-time-code" maxlength="6" @keyup.enter="confirmTotpRegen"/>
        <el-button type="primary" :loading="totpLoading" @click="confirmTotpRegen">{{$t('confirm')}}</el-button>
      </div>
    </el-dialog>
  </div>
    </el-scrollbar>
  </div>
</template>
<script setup>
import {reactive, ref, watch, defineOptions} from 'vue'
import {resetPassword, userDelete, setEmailSecurity, totpSetup, totpEnable, totpDisable, totpRegenerateBackupCodes} from "@/request/my.js";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {accountSetName} from "@/request/account.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import {useSettingStore} from "@/store/setting.js";
import {useUiStore} from "@/store/ui.js";
import ThemeSelector from "@/components/theme-selector/index.vue";

const { t } = useI18n()
const accountStore = useAccountStore()
const settingStore = useSettingStore()
const uiStore = useUiStore()
const userStore = useUserStore();
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)
const langSelect = ref(settingStore.lang)

defineOptions({
  name: 'setting'
})

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {

  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameShow.value = false
  let name = accountName.value

  if (name === userStore.user.name) {
    return
  }

  userStore.user.name = accountName.value

  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })

    accountStore.changeUserAccountName = name

  }).catch(() => {
    userStore.user.name = name
  })
}

function changeLang(lang) {
  let setting = {}
  try {
    setting = JSON.parse(localStorage.getItem('setting') || '{}')
  } catch (e) {
    setting = {}
  }
  localStorage.setItem('setting', JSON.stringify({...setting, lang}))
  window.location.reload()
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}


function submitPwd() {

  if (setPwdLoading.value) return

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })

}

// Per-user email security prefs. blockImages defaults to blocked (true)
// when the row predates the migration; disableLinks defaults to off.
const blockImages = ref(userStore.user.blockImages !== 0)
const disableLinks = ref(userStore.user.disableLinks === 1)

watch(() => [userStore.user.blockImages, userStore.user.disableLinks], () => {
  blockImages.value = userStore.user.blockImages !== 0
  disableLinks.value = userStore.user.disableLinks === 1
})

function saveEmailSecurity() {
  setEmailSecurity({
    blockImages: blockImages.value ? 1 : 0,
    disableLinks: disableLinks.value ? 1 : 0,
  }).then(() => {
    userStore.user.blockImages = blockImages.value ? 1 : 0
    userStore.user.disableLinks = disableLinks.value ? 1 : 0
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).catch(() => {
    blockImages.value = userStore.user.blockImages !== 0
    disableLinks.value = userStore.user.disableLinks === 1
  })
}

// Two-factor authentication (TOTP). The enabled flag comes from the
// login user info; the secret is only ever shown during setup, and
// backup codes only once, when they are (re)generated.
const totpEnabled = ref(userStore.user.totpEnabled === 1)
const totpSetupShow = ref(false)
const totpBackupShow = ref(false)
const totpDisableShow = ref(false)
const totpRegenShow = ref(false)
const totpSecret = ref('')
const totpOtpauthUrl = ref('')
const totpCode = ref('')
const totpBackupCodes = ref([])
const totpDisableForm = reactive({ password: '', code: '' })
const totpRegenCode = ref('')
const totpLoading = ref(false)

watch(() => userStore.user.totpEnabled, () => {
  totpEnabled.value = userStore.user.totpEnabled === 1
})

function startTotpSetup() {
  totpLoading.value = true
  totpSetup().then((data) => {
    totpSecret.value = data.secret
    totpOtpauthUrl.value = data.otpauthUrl
    totpCode.value = ''
    totpSetupShow.value = true
    totpLoading.value = false
  }).catch(() => {
    totpLoading.value = false
  })
}

function confirmTotpSetup() {
  if (totpCode.value.length !== 6) return
  totpLoading.value = true
  totpEnable(totpCode.value).then((data) => {
    totpBackupCodes.value = data.backupCodes || []
    totpSetupShow.value = false
    totpBackupShow.value = true
    totpEnabled.value = true
    userStore.user.totpEnabled = 1
    totpLoading.value = false
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).catch(() => {
    totpLoading.value = false
  })
}

function copyTotpSecret() {
  const done = () => {
    ElMessage({
      message: t('totpSecretCopied'),
      type: 'success',
      plain: true,
    })
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(totpSecret.value).then(done).catch(() => {})
  }
}

function confirmTotpDisable() {
  if (!totpDisableForm.password || !totpDisableForm.code) return
  totpLoading.value = true
  totpDisable(totpDisableForm.password, totpDisableForm.code).then(() => {
    totpDisableShow.value = false
    totpEnabled.value = false
    userStore.user.totpEnabled = 0
    totpDisableForm.password = ''
    totpDisableForm.code = ''
    totpLoading.value = false
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).catch(() => {
    totpLoading.value = false
  })
}

function confirmTotpRegen() {
  if (totpRegenCode.value.length !== 6) return
  totpLoading.value = true
  totpRegenerateBackupCodes(totpRegenCode.value).then((data) => {
    totpBackupCodes.value = data.backupCodes || []
    totpRegenShow.value = false
    totpRegenCode.value = ''
    totpBackupShow.value = true
    totpLoading.value = false
  }).catch(() => {
    totpLoading.value = false
  })
}

</script>
<style scoped lang="scss">
.settings-page {
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 30px;
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 40px;

    .item {
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: minmax(0, auto) max-content;
        justify-content: start;
        align-items: center;
        span:first-child {
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        white-space: nowrap;
        cursor: pointer;
      }

    }
  }

  .preference-item,
  .language {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;
    align-items: flex-start;

  }

  .setting-row {
    width: 100%;
    display: grid;
    grid-template-columns: 120px 220px;
    align-items: center;
    column-gap: 110px;
    font-size: 14px;

    > div:first-child {
      font-weight: bold;
      min-width: 0;
      text-align: left;
    }

    > div:last-child {
      min-width: 0;
      overflow: hidden;
      text-align: left;
    }

    @media (max-width: 767px) {
      grid-template-columns: 120px minmax(0, 1fr);
      column-gap: 24px;
    }
  }

  .language-select {
    width: 110px;
    max-width: 100%;
  }

  .security-desc {
    color: var(--regular-text-color);
    font-size: 13px;
    line-height: 1.5;
  }

  .totp-backup-codes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .totp-backup-code {
    font-family: monospace;
    font-size: 14px;
    text-align: center;
    padding: 6px 0;
    border: 1px solid var(--el-border-color);
    border-radius: 6px;
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
}
</style>
