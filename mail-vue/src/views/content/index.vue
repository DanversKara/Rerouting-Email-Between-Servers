<template>
  <div class="box">
    <div class="header-actions">
      <Icon class="icon" icon="material-symbols-light:arrow-back-ios-new" width="20" height="20" @click="handleBack"/>
      <Icon v-perm="'email:delete'" class="icon" icon="uiw:delete" width="16" height="16" @click="handleDelete"/>
      <Icon v-if="email && email.type === 0" class="icon" icon="material-symbols-light:report" width="19" height="19" :title="$t('reportSpam')" @click="handleReportSpam"/>
      <span class="star" v-if="emailStore.contentData.showStar">
        <Icon class="icon" @click="changeStar" v-if="email.isStar" icon="fluent-color:star-16" width="20" height="20"/>
        <Icon class="icon" @click="changeStar" v-else icon="solar:star-line-duotone" width="18.5" height="18.5"/>
      </span>
      <Icon class="icon" v-if="emailStore.contentData.showReply" v-perm="'email:send'"  @click="openReply" icon="fluent-mdl2:reply" width="19" height="19" />
      <Icon class="icon" v-if="emailStore.contentData.showReply" v-perm="'email:send'"  @click="openForward" icon="iconoir:arrow-up-right" width="20" height="20" />
    </div>
    <div></div>
    <el-scrollbar class="scrollbar">
      <div class="container">
        <div class="email-title">
          {{ email.subject }}
        </div>
        <div class="content">
          <div class="email-info">
            <div class="address-meta">
              <div class="send"><span class="send-source">{{$t('from')}}</span>
                <div class="send-name" ref="sendNameRef" :class="{ 'is-wrapped': senderWrapped }">
                  <span class="send-name-title">{{ email.name }}</span>
                  <span class="send-email"><{{ email.sendEmail }}></span>
                  <span class="sent-via" v-if="sentViaEmail">
                    <el-tooltip effect="dark" :content="$t('sentVia', { email: sentViaEmail })">
                      <span>
                        <el-tag size="small" disable-transitions>{{ $t('sentViaTag') }}</el-tag>
                      </span>
                    </el-tooltip>
                  </span>
                </div>
              </div>
              <div class="receive"><span class="source">{{$t('recipient')}}</span><span class="receive-email">{{  formateReceive(email.recipient) }}</span></div>
              <div class="receive" v-if="ccText"><span class="source">{{$t('cc')}}</span><span class="receive-email">{{ ccText }}</span></div>
              <div class="date">
                <div>{{ formatDetailDate(email.createTime) }}</div>
              </div>
            </div>
            <el-alert v-if="email.status === 3" :closable="false" :title="toMessage(email.message)" class="email-msg" type="error" show-icon />
            <el-alert v-if="email.status === 4" :closable="false" :title="$t('complained')" class="email-msg" type="warning" show-icon />
            <el-alert v-if="email.status === 5" :closable="false" :title="$t('delayed')" class="email-msg" type="warning" show-icon />
          </div>
          <el-scrollbar class="htm-scrollbar" :class="!email.attList?.length ? 'bottom-distance' : ''">
            <div v-if="showImageBanner" class="image-banner">
              <span class="image-banner-text">{{ $t('imagesBlockedMsg', { count: processedContent.blocked }) }}</span>
              <el-button size="small" @click="showImagesOnce = true">{{ $t('showImagesOnce') }}</el-button>
              <el-button size="small" type="primary" @click="alwaysShowImages">{{ $t('alwaysShowImages') }}</el-button>
            </div>
            <ShadowHtml class="shadow-html" :html="processedContent.html" v-if="email.content" />
            <pre v-else class="email-text" >{{email.text}}</pre>
          </el-scrollbar>
          <div class="att" v-if="email.attList?.length > 0">
            <div class="att-title">
              <span>{{$t('attachments')}}</span>
              <span>{{$t('attCount',{total: email.attList.length})}}</span>
            </div>
            <div class="att-box">

              <div class="att-item" v-for="att in email.attList" :key="att.attId">
                <div class="att-icon" @click="showImage(att)">
                  <Icon v-bind="getIconByName(att.filename)" />
                </div>
                <div class="att-name" @click="showImage(att)">
                  {{ att.filename }}
                </div>
                <div class="att-size">{{ formatBytes(att.size) }}</div>
                <div class="opt-icon att-icon">
                  <Icon v-if="isImage(att.filename)" icon="hugeicons:view" width="22" height="22" @click="showImage(att)"/>
                  <a :href="att.url || cvtR2Url(att.key)" download>
                    <Icon icon="system-uicons:push-down" width="22" height="22"/>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-scrollbar>
    <el-image-viewer
        v-if="showPreview"
        :url-list="srcList"
        show-progress
        @close="showPreview = false"
    />
  </div>
</template>
<script setup>
import ShadowHtml from '@/components/shadow-html/index.vue'
import {computed, reactive, ref, watch, onMounted, onUnmounted, nextTick} from "vue";
import {useRouter} from 'vue-router'
import {ElMessage, ElMessageBox} from 'element-plus'
import {emailDelete, emailRead, emailReportSpam} from "@/request/email.js";
import {setEmailSecurity} from "@/request/my.js";
import {Icon} from "@iconify/vue";
import {useEmailStore} from "@/store/email.js";
import {useUserStore} from "@/store/user.js";
import {useAccountStore} from "@/store/account.js";
import {formatDetailDate} from "@/utils/day.js";
import {starAdd, starCancel} from "@/request/star.js";
import {getExtName, formatBytes} from "@/utils/file-utils.js";
import {cvtR2Url,toOssDomain} from "@/utils/convert.js";
import {getIconByName} from "@/utils/icon-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {allEmailDelete} from "@/request/all-email.js";
import {useUiStore} from "@/store/ui.js";
import {useI18n} from "vue-i18n";
import {EmailUnreadEnum} from "@/enums/email-enum.js";
const { t } = useI18n()

const uiStore = useUiStore();
const settingStore = useSettingStore();
const userStore = useUserStore();
const accountStore = useAccountStore();
const emailStore = useEmailStore();
const router = useRouter()
const sendNameRef = ref(null)
const senderWrapped = ref(false)
let senderResizeObserver = null

const showPreview = ref(false)
const srcList = reactive([])


const email = computed(() => emailStore.contentData.email || {
  emailId: 0,
  attList: [],
  content: '',
  text: '',
  recipient: '[]',
})

const ccText = computed(() => formateReceive(email.value.cc))

const sentViaEmail = computed(() => {
  const raw = String(email.value.senderEmail || '').trim()
  if (!raw) return ''
  const matched = raw.match(/<([^>]+)>/)
  const address = (matched ? matched[1] : raw).trim()
  if (!address || address.toLowerCase() === String(email.value.sendEmail || '').trim().toLowerCase()) return ''
  return address
})

watch(() => accountStore.currentAccountId, () => {
  handleBack()
})

let readRequesting = false

function contentWidth(el) {
  const range = document.createRange()
  range.selectNodeContents(el)
  const width = range.getBoundingClientRect().width
  range.detach()
  return width
}

function updateSenderWrap() {
  const root = sendNameRef.value
  if (!root) return
  const name = root.querySelector('.send-name-title')
  const mail = root.querySelector('.send-email')
  const tag = root.querySelector('.sent-via')
  if (!name || !mail) {
    senderWrapped.value = false
    return
  }
  const gap = 6
  let need = contentWidth(name) + gap + contentWidth(mail)
  if (tag) need += gap + contentWidth(tag)
  senderWrapped.value = need > root.clientWidth + 0.5
}


function tryMarkRead() {
  if (!emailStore.contentData.showUnread || readRequesting) return
  const current = email.value
  if (!current?.emailId || current.unread !== EmailUnreadEnum.UNREAD) return

  // 等详情数据就绪（detailMap 已写入，或正文已有内容）再标已读
  const full = emailStore.detailMap[current.emailId]
  const detailReady = !!full || !!(current.content || current.text)
  if (!detailReady) return

  readRequesting = true
  const emailId = current.emailId
  current.unread = EmailUnreadEnum.READ
  if (emailStore.detailMap[emailId]) {
    emailStore.detailMap[emailId].unread = EmailUnreadEnum.READ
  }
  emailStore.markListRead(emailId)
  emailRead([emailId]).finally(() => {
    readRequesting = false
  })
}

watch(
  () => [
    email.value?.emailId,
    email.value?.content,
    email.value?.text,
    emailStore.detailMap[email.value?.emailId]
  ],
  () => tryMarkRead(),
  { flush: 'post' }
)

watch(
  () => [email.value?.name, email.value?.sendEmail, sentViaEmail.value],
  () => nextTick(updateSenderWrap)
)

onMounted(() => {
  tryMarkRead()
  window.addEventListener('keydown', handleKeyDown);
  senderResizeObserver = new ResizeObserver(() => updateSenderWrap())
  if (sendNameRef.value) senderResizeObserver.observe(sendNameRef.value)
  nextTick(updateSenderWrap)
})

onUnmounted(() => {
  emailStore.contentData.showUnread = false;
  readRequesting = false
  window.removeEventListener('keydown', handleKeyDown);
  senderResizeObserver?.disconnect()
})

function handleKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (showPreview.value) return;
  if (document.querySelector('.el-message-box')) return;
  const writeBox = document.querySelector('.write-box');
  if (writeBox && writeBox.offsetParent !== null) return;
  handleBack();
}

function openReply() {
  uiStore.writerRef.openReply(email.value)
}

function openForward() {
  uiStore.writerRef.openForward(email.value)
}

function toMessage(message) {
  return  message ? JSON.parse(message).message : '';
}

// --- Per-user email security (blockImages / disableLinks) ---
// Whether the current user blocks remote images in emails (default on).
// blockImages is 1 when blocked; undefined (pre-migration rows) means blocked.
const blockImages = computed(() => userStore.user.blockImages !== 0)
// Whether the current user disables links in emails (default off).
const disableLinks = computed(() => userStore.user.disableLinks === 1)
// One-time image show for this email only; reset when another email opens.
const showImagesOnce = ref(false)
watch(() => email.value?.emailId, () => { showImagesOnce.value = false })

// Remote-resource attributes the server rewriter touches
// (proxy-service.js ATTRS) plus srcset/poster. A URL is "remote" unless it
// is inline data, a CID reference, or one of our own signed attachment
// links on the R2 origin - everything else must never load while images
// are blocked.
const REMOTE_ATTRS = ['src', 'poster', 'background', 'data-src', 'data-original', 'data-lazy-src']
const BLOCKED_PLACEHOLDER_STYLE = 'display:inline-block;background:#f0f0f0;color:#888;border:1px dashed #ccc;padding:4px 8px;border-radius:4px;font-size:12px;'
function isRemoteResource(value, r2Origin) {
  if (!value) return false
  const v = String(value).trim()
  if (!v || v.startsWith('#')) return false
  if (/^(data|blob|cid):/i.test(v)) return false
  if (v.startsWith('{{domain}}')) return false
  if (v.startsWith('/attachments/')) return false
  if (r2Origin && v.startsWith(r2Origin + '/attachments/')) return false
  return true
}
function stripRemoteCssUrls(css, r2Origin) {
  if (!css) return css
  return String(css).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
    return isRemoteResource(url, r2Origin) ? 'none' : match
  })
}
function blockedPlaceholder(doc, label) {
  const span = doc.createElement('span')
  span.setAttribute('class', 'cm-blocked-media')
  span.setAttribute('style', BLOCKED_PLACEHOLDER_STYLE)
  span.textContent = label
  return span
}
function processEmailHtml(rawHtml) {
  let blocked = 0
  const r2Origin = toOssDomain(settingStore.settings.r2Domain)
  // {{domain}} placeholders are expanded first so local attachments can be
  // told apart from remote URLs (same expansion formatImage did before).
  let html = (rawHtml || '').replace(/{{domain}}/g, toOssDomain(settingStore.settings.r2Domain) + '/')
  if (!html) return { html, blocked }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (blockImages.value && !showImagesOnce.value) {
    // Remote images / media: replace the element with a placeholder so the
    // browser never requests the URL - no tracking pixel, font, stylesheet,
    // video, iframe or background may load while images are blocked.
    doc.querySelectorAll('img,video,audio,iframe,input').forEach(el => {
      const tag = el.tagName
      const isImageInput = tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'image'
      if (tag === 'INPUT' && !isImageInput) return
      const remote = REMOTE_ATTRS.some(attr => isRemoteResource(el.getAttribute(attr), r2Origin)) ||
        (el.getAttribute('srcset') || '').split(',').some(part => isRemoteResource(part.trim().split(/\s+/, 1)[0], r2Origin))
      if (!remote) return
      blocked++
      const label = tag === 'IMG' || isImageInput ? t('blockedImage') : t('blockedMedia')
      el.replaceWith(blockedPlaceholder(doc, label))
    })
    doc.querySelectorAll('source,track').forEach(el => {
      const remote = REMOTE_ATTRS.some(attr => isRemoteResource(el.getAttribute(attr), r2Origin)) ||
        (el.getAttribute('srcset') || '').split(',').some(part => isRemoteResource(part.trim().split(/\s+/, 1)[0], r2Origin))
      if (!remote) return
      blocked++
      el.remove()
    })
    doc.querySelectorAll('link[href]').forEach(el => {
      if (isRemoteResource(el.getAttribute('href'), r2Origin)) {
        blocked++
        el.remove()
      }
    })
    doc.querySelectorAll('[background]').forEach(el => {
      if (isRemoteResource(el.getAttribute('background'), r2Origin)) {
        blocked++
        el.removeAttribute('background')
      }
    })
    doc.querySelectorAll('[style]').forEach(el => {
      const before = el.getAttribute('style') || ''
      const after = stripRemoteCssUrls(before, r2Origin)
      if (after !== before) {
        blocked++
        el.setAttribute('style', after)
      }
    })
    doc.querySelectorAll('style').forEach(el => {
      const before = el.textContent || ''
      const after = stripRemoteCssUrls(before, r2Origin)
      if (after !== before) {
        blocked++
        el.textContent = after
      }
    })
  }
  if (disableLinks.value) {
    // Links become plain text showing the REAL destination, never the
    // display text - a link reading "sofi.com" that points at
    // "fake-sofi.com" shows as "https://fake-sofi.com".
    doc.querySelectorAll('a[href]').forEach(el => {
      const href = el.getAttribute('href') || ''
      const span = doc.createElement('span')
      span.setAttribute('class', 'cm-link-text')
      span.setAttribute('style', 'overflow-wrap:anywhere;word-break:break-all;')
      span.textContent = href
      el.replaceWith(span)
    })
  }
  // Serialize the whole document so <style> blocks in <head> survive;
  // ShadowHtml parses it again and imports head styles as before.
  return { html: new XMLSerializer().serializeToString(doc), blocked }
}
// Rendered email HTML for this view, with the user's security prefs applied.
// Recomputed when the email, the prefs, or the one-time show flag change.
const processedContent = computed(() => processEmailHtml(email.value?.content || ''))
const showImageBanner = computed(() => blockImages.value && !showImagesOnce.value && processedContent.value.blocked > 0 && !!email.value?.content)

function alwaysShowImages() {
  setEmailSecurity({ blockImages: 0 }).then(() => {
    userStore.user.blockImages = 0
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
  })
}

function showImage(att) {
  if (!isImage(att.filename)) return;
  const url = att.url || cvtR2Url(att.key)
  srcList.length = 0
  srcList.push(url)
  showPreview.value = true
}

function isImage(filename) {
  return ['png', 'jpg', 'jpeg', 'bmp', 'gif','jfif'].includes(getExtName(filename))
}

function formateReceive(recipient) {
  if (!recipient) return ''
  recipient = JSON.parse(recipient)
  return recipient.map(item => item.address).join(', ')
}

function changeStar() {
  if (email.value.isStar) {
    email.value.isStar = 0;
    starCancel(email.value.emailId).then(() => {
      email.value.isStar = 0;
      emailStore.cancelStarEmailId = email.value.emailId
      setTimeout(() => emailStore.cancelStarEmailId = 0)
      emailStore.starScroll?.deleteEmail([email.value.emailId])
    }).catch((e) => {
      console.error(e)
      email.value.isStar = 1;
    })
  } else {
    email.value.isStar = 1;
    starAdd(email.value.emailId).then(() => {
      email.value.isStar = 1;
      emailStore.addStarEmailId = email.value.emailId
      setTimeout(() => emailStore.addStarEmailId = 0)
      emailStore.starScroll?.addItem(email.value)
    }).catch((e) => {
      console.error(e)
      email.value.isStar = 0;
    })
  }
}

const handleBack = () => {
  router.back()
}

const handleDelete = () => {
  ElMessageBox.confirm(t('delEmailConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    if (emailStore.contentData.delType === 'logic') {
      emailDelete(email.value.emailId).then(() => {
        ElMessage({
          message: t('delSuccessMsg'),
          type: 'success',
          plain: true,
        })
        emailStore.deleteIds = [email.value.emailId]
      })
    } else  {

      allEmailDelete(email.value.emailId).then(() => {
        ElMessage({
          message: t('delSuccessMsg'),
          type: 'success',
          plain: true,
        })
        emailStore.deleteIds = [email.value.emailId]
      })
    }

    router.back()
  })
}

const handleReportSpam = () => {
  ElMessageBox.confirm(t('reportSpamConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    emailReportSpam(email.value.emailId).then(() => {
      ElMessage({
        message: t('reportSpamSuccessMsg'),
        type: 'success',
        plain: true,
      })
      emailStore.deleteIds = [email.value.emailId]
      router.back()
    })
  })
}
</script>
<style scoped lang="scss">
.box {
  height: 100%;
  overflow: hidden;
}

.header-actions {
  padding: 9px 15px 9px;
  display: flex;
  align-items: center;
  gap: 20px;
  box-shadow: var(--header-actions-border);
  font-size: 18px;
  .star {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 21px;
  }
  .icon {
    cursor: pointer;
  }
}


.scrollbar {
  height: calc(100% - 38px);
  width: 100%;
}

.container {
  font-size: 14px;
  padding-left: 20px;
  padding-right: 20px;
  padding-top: 10px;
  @media (max-width: 1023px) {
    padding-left: 15px;
    padding-right: 15px;
  }

  .email-title {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 10px;
  }

  .htm-scrollbar {
  }

  .image-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 0 12px;
    padding: 10px 12px;
    background: var(--el-color-warning-light-9);
    border: 1px solid var(--el-color-warning-light-5);
    border-radius: 6px;
    color: var(--el-text-color-regular);
    font-size: 13px;
  }

  .image-banner-text {
    flex: 1;
    min-width: 200px;
  }

  .content {
    display: flex;
    flex-direction: column;

    .att {
      margin-top: 30px;
      margin-bottom: 30px;
      border: 1px solid var(--light-border-color);
      padding: 14px;
      border-radius: 6px;
      width: fit-content;
      .att-box {
        min-width: min(410px,calc(100vw - 60px));
        max-width: 600px;
        display: grid;
        gap: 12px;
        grid-template-rows: 1fr;
      }

      .att-title {
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        span:first-child {
          font-weight: bold;
        }
      }

      .att-item {
        cursor: pointer;
        div {
          align-self: center;
        }
        background: var(--light-ill);
        padding: 5px 7px;
        border-radius: 4px;
        align-self: start;
        display: grid;
        grid-template-columns: auto 1fr auto auto;
        .att-icon {
          display: grid;
        }

        .att-size {
          color: var(--secondary-text-color);
        }

        .att-name {
          margin-left: 8px;
          margin-right: 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          word-break: break-all;
        }

        .att-image {
          width: 60px;
          height: 60px;
          object-fit: contain;
        }

        .opt-icon {
          padding-left: 10px;
          color: var(--secondary-text-color);
          align-items: center;
          display: flex;
          gap: 8px;
          cursor: pointer;
          a {
            color: var(--secondary-text-color);
            align-items: center;
            display: flex;
          }
        }
      }
    }

    .email-info {

      border-bottom: 1px solid var(--light-border-color);
      margin-bottom: 20px;
      padding-bottom: 8px;
      @media (max-width: 1024px) {
        margin-bottom: 15px;
      }
      .date {
        color: var(--regular-text-color);
        margin-bottom: 6px;
      }

      .email-msg {
        max-width: 400px;
        width: fit-content;
        margin-bottom: 15px;
      }

      .address-meta {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        column-gap: 10px;
        row-gap: 6px;
        align-items: baseline;
      }

      .send,
      .receive {
        display: contents;
      }

      .send {
        .send-name {
          color: var(--regular-text-color);
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          column-gap: 6px;

          .send-email {
            max-width: 100%;
            overflow-wrap: anywhere;
          }

          &.is-wrapped {
            .send-name-title {
              order: 1;
            }

            .sent-via {
              order: 2;
            }

            .send-email {
              order: 3;
              flex-basis: 100%;
            }
          }
        }
      }

      .receive {
        .receive-email {
          max-width: 700px;
          word-break: break-word;
        }
        span:nth-child(2) {
          color: var(--regular-text-color);
        }
      }

      .date {
        grid-column: 1 / -1;
      }

      .send-source,
      .source {
        white-space: nowrap;
        font-weight: bold;
        text-align: left;
      }
    }
  }
}

.shadow-html::after  {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--message-block-color); /* 半透明黑色蒙层 */
  pointer-events: none; /* 不影响点击 */
}

.email-text {
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.bottom-distance {
  margin-bottom: 30px;
}


</style>
