<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <div class="brand-mark">EM</div>
          <div class="brand-text">
            <h1>EchoMind</h1>
            <p>智能客服对话台</p>
          </div>
        </div>

        <div class="topbar-actions">
          <button
            class="conn"
            :class="healthOk ? 'is-online' : 'is-offline'"
            :title="`点击重新检测 · ${healthLabel}`"
            @click="checkHealth"
          >
            <span class="conn-dot" aria-hidden="true"></span>
            <span class="conn-text">{{ healthOk ? '服务已连接' : '服务未连接' }}</span>
          </button>

          <button class="ghost-btn" :class="{ active: settingsOpen }" @click="settingsOpen = !settingsOpen">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7h9M17 7h3M4 17h4M12 17h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <circle cx="15" cy="7" r="2.2" stroke="currentColor" stroke-width="1.8" />
              <circle cx="10" cy="17" r="2.2" stroke="currentColor" stroke-width="1.8" />
            </svg>
            设置
          </button>
        </div>
      </div>

      <transition name="drop">
        <section v-if="settingsOpen" class="settings">
          <div class="settings-inner">
            <header class="settings-head">
              <div>
                <h2>连接设置</h2>
                <p>
                  当前后端固定为 Python 版（支持 SSE 流式输出）· 实际请求地址
                  <code>{{ currentBackend.baseUrl }}</code>
                </p>
              </div>
              <button class="ghost-btn small" :disabled="testingConnection" @click="checkHealth">
                {{ testingConnection ? '检测中…' : '测试连接' }}
              </button>
            </header>

            <div class="settings-grid">
              <label class="field">
                <span>Python API 地址</span>
                <input v-model="settings.endpoints.python" @change="onEndpointChange" placeholder="/api/python" />
              </label>
              <label class="field">
                <span>用户 ID</span>
                <input v-model="settings.userId" @change="persist" placeholder="u1001" />
              </label>
              <label class="field">
                <span>会话 ID</span>
                <input v-model="settings.conversationId" placeholder="留空则由后端自动生成" />
              </label>
              <label class="field">
                <span>空闲切会话阈值</span>
                <span class="input-affix">
                  <input v-model.number="settings.idleMinutes" type="number" min="1" max="240" @change="persist" />
                  <em>分钟</em>
                </span>
              </label>
            </div>

            <label class="toggle">
              <input type="checkbox" v-model="settings.streamEnabled" @change="persist" />
              <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
              <span class="toggle-text">
                <strong>流式输出（SSE）</strong>
                <small>逐字返回回答；上游不支持时自动降级为一次性返回</small>
              </span>
            </label>
          </div>
        </section>
      </transition>
    </header>

    <main class="chat">
      <div class="stream" ref="messageList">
        <div class="stream-inner">
          <section v-if="messages.length === 0" class="welcome">
            <div class="welcome-mark">EM</div>
            <h2>你好，我是 EchoMind 智能客服</h2>
            <p>基于意图识别、RAG 知识检索与多 Agent 路由，为你处理退款、技术与账户类问题。</p>
            <div class="suggestions">
              <button v-for="item in suggestions" :key="item" class="suggestion" @click="useSuggestion(item)">
                {{ item }}
              </button>
            </div>
          </section>

          <template v-else>
            <article
              v-for="item in messages"
              :key="item.id"
              :class="['msg', item.role, { streaming: item.streaming }]"
            >
              <template v-if="item.role === 'system'">
                <span class="divider-note">{{ item.content }}</span>
              </template>

              <template v-else>
                <div class="avatar" :class="item.role" aria-hidden="true">
                  {{ item.role === 'user' ? '我' : 'EM' }}
                </div>
                <div class="msg-body">
                  <div class="msg-head">
                    <span class="who">{{ roleLabel(item) }}</span>
                    <div v-if="item.meta" class="chips">
                      <span v-for="chip in metaChips(item.meta)" :key="chip" class="chip">{{ chip }}</span>
                    </div>
                  </div>

                  <div v-if="item.content" class="md" v-html="renderMarkdown(item.content)"></div>
                  <div v-else-if="item.streaming" class="waiting">
                    <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
                    {{ item.phase || '正在生成…' }}
                  </div>
                </div>
              </template>
            </article>
          </template>
        </div>
      </div>

      <div class="composer-bar">
        <div class="composer-inner">
          <form class="composer" @submit.prevent="sendMessage">
            <textarea
              ref="composerInput"
              v-model="draft"
              rows="1"
              placeholder="输入你的问题…"
              @input="autoGrow"
              @compositionstart="onCompositionStart"
              @compositionend="onCompositionEnd"
              @keydown.enter.exact="onComposerKeydown"
              @keydown.meta.enter="onComposerKeydown"
              @keydown.ctrl.enter="onComposerKeydown"
            ></textarea>

            <div class="composer-side">
              <button class="ghost-btn small" type="button" :disabled="busy" @click="startNewSession">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" />
                </svg>
                新会话
              </button>
              <button class="send-btn" :disabled="busy || !draft.trim()" :title="sendLabel">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.4 20.4 21 12 3.4 3.6l2.5 7.1L14 12l-8.1 1.3z" fill="currentColor" />
                </svg>
              </button>
            </div>
          </form>

          <p class="composer-hint">
            <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行<span v-if="streamActive"> · 正在流式接收…</span>
          </p>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  backendMeta,
  createInitialSettings,
  idleTimeoutMs,
  requestChat,
  requestChatStream,
  requestHealth,
  resetSession,
  saveSettings,
  shouldRotateSession,
  supportsStreaming
} from './lib/backends'
import { renderMarkdown } from './lib/markdown'

const suggestions = [
  '退款多久能到账？',
  '订单 #12345 我想申请退款',
  '账号登录不上，提示 401 错误',
  '你们的技术支持电话是多少？'
]

const settings = reactive(createInitialSettings())
const activeView = ref('chat')
const messages = ref([])
const draft = ref('')
const busy = ref(false)
const streamActive = ref(false)
const settingsOpen = ref(false)
const testingConnection = ref(false)
const healthOk = ref(false)
const healthLabel = ref('未检查')
const messageList = ref(null)
const composerInput = ref(null)
// 输入法组词状态：组词中的回车是"确认候选词"，绝不能当成发送
const isComposing = ref(false)

const currentBackend = computed(() => backendMeta(settings.backend, settings))
const sendLabel = computed(() => (busy.value ? (streamActive.value ? '生成中' : '发送中') : '发送'))

watch(() => settings.conversationId, () => persist())

onMounted(() => {
  checkHealth()
  autoFocus()
})

function persist() {
  saveSettings(settings)
}

function autoFocus() {
  nextTick(() => composerInput.value?.focus())
}

function onEndpointChange() {
  persist()
  checkHealth()
}

function useSuggestion(text) {
  draft.value = text
  sendMessage()
}

function onCompositionStart() {
  isComposing.value = true
}

function onCompositionEnd() {
  isComposing.value = false
}

/**
 * 回车发送。
 *
 * 中文/日文输入法组词时按回车是用来"确认候选词"的，早期实现直接把它当成了发送，
 * 会出现「已写好的内容被发出去、正在组词的字母却留在输入框」的问题。三种情况必须放过：
 *   1. compositionstart 到 compositionend 之间（isComposing 标记）
 *   2. 事件自身带 isComposing
 *   3. keyCode 229（部分浏览器/输入法不设置 isComposing）
 *
 * 注意这些分支里不能 preventDefault，否则会打断输入法对候选词的确认。
 */
function onComposerKeydown(event) {
  if (isComposing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  sendMessage()
}

/** 输入框随内容增高，最多 200px 后内部滚动。 */
function autoGrow(event) {
  const el = event.target
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

function resetComposerHeight() {
  const el = composerInput.value
  if (el) el.style.height = 'auto'
}

function roleLabel(item) {
  if (item.role === 'user') return '你'
  if (item.role === 'system') return '系统'
  return 'EchoMind 客服'
}

/**
 * 回答下方的标签文案。
 *
 * 目前只展示耗时：意图 / 路由 Agent / 流式 / RAG / 转人工 / LLM 调用次数属于调试字段，
 * 需要时把 SHOW_DEBUG_META 改成 true 即可整组恢复，不必改动其它逻辑。
 * 失败信息不受开关影响——用户没拿到正常回答时必须能看见原因。
 */
const SHOW_DEBUG_META = false

function metaText(result) {
  const parts = [
    result.latencyMs ? `${Math.round(result.latencyMs)} ms` : '',
    result.error ? `流式中断：${result.error}` : ''
  ]
  if (SHOW_DEBUG_META) {
    parts.unshift(
      result.primaryAgent || result.agentType || '',
      result.intent || '',
      result.streamed ? '流式' : '',
      result.knowledgeUsed ? 'RAG' : '',
      result.escalated ? '转人工' : '',
      result.llmCalls ? `LLM ${result.llmCalls} 次` : '',
      result.historyDroppedByThreshold ? `丢弃历史 ${result.historyDroppedByThreshold} 条` : ''
    )
  }
  return parts.filter(Boolean).join(' · ')
}

function metaChips(meta) {
  return String(meta).split(' · ').filter(Boolean)
}

function pushSystemMessage(content) {
  messages.value.push({ id: crypto.randomUUID(), role: 'system', content })
}

/** 手动新建会话：清空会话标识与消息列表（设计文档 §4.2 方式一）。 */
function startNewSession() {
  resetSession(settings)
  messages.value = []
  persist()
  pushSystemMessage('已开启新会话，不再携带上一话题的摘要与历史')
  scrollToBottom()
  autoFocus()
}

/** 空闲超时自动切会话（设计文档 §4.2 方式二）。 */
function rotateSessionIfIdle() {
  if (!shouldRotateSession(settings)) return false
  const idleMinutes = Math.round(idleTimeoutMs(settings) / 60000)
  resetSession(settings)
  persist()
  pushSystemMessage(`距上条消息已超过 ${idleMinutes} 分钟，本轮提问自动开启新会话（不携带旧话题记忆）。`)
  return true
}

function scrollToBottom(smooth = true) {
  nextTick(() => {
    const el = messageList.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  })
}

/** 会话收尾标记：只清会话标识，由下次发送时重新生成 conv_id。 */
function applySessionClosed(result) {
  if (!result.sessionClosed) return
  resetSession(settings)
  persist()
  pushSystemMessage('后端识别到本轮会话已收尾，下次提问将开启新会话')
}

async function sendMessage() {
  // 组词中一律不发送：回车之外的入口（表单提交等）也走同一道闸
  if (isComposing.value) return
  const content = draft.value.trim()
  if (!content || busy.value) return

  rotateSessionIfIdle()
  messages.value.push({ id: crypto.randomUUID(), role: 'user', content })
  draft.value = ''
  resetComposerHeight()
  busy.value = true
  scrollToBottom()

  settings.lastMessageAt = Date.now()
  persist()

  const useStream = settings.backend === 'python' && supportsStreaming(settings.backend, settings)

  try {
    const result = useStream
      ? await sendStreaming(content)
      : await requestChat(settings.backend, settings, content)
    // 非流式路径的会话标识只在响应里下发：首轮必须回填，否则多轮记忆每轮都会被重置
    if (result.conversationId && !settings.conversationId) {
      settings.conversationId = result.conversationId
      persist()
    }
    applySessionClosed(result)
  } catch (error) {
    messages.value.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: error.message,
      meta: '请求失败'
    })
  } finally {
    busy.value = false
    streamActive.value = false
    scrollToBottom()
    autoFocus()
  }
}

/**
 * L7 流式发送：先占位一条 assistant 消息，delta 到达时增量渲染。
 * 流式完全失败（没有拿到任何内容）时自动降级为非流式请求，保证用户不会看到空回答。
 */
async function sendStreaming(content) {
  const placeholder = reactive({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    // 首字到达前不显示任何标签，只有阶段文案（下面是计时），避免一上来就冒调试字段
    meta: '',
    streaming: true,
    phase: '正在连接…'
  })
  messages.value.push(placeholder)
  streamActive.value = true
  let deltaCount = 0
  // 是否已收到 meta / route：只用来决定等待期文案，不再当作标签内容
  let recognized = false
  const startedAt = Date.now()

  // 等待期可见化：模型"思考"或上游排队时，前端一直在走计时与阶段文案，
  // 不让用户面对一个静止的省略号（实测上游首字可能波动到数秒）。
  let firstDeltaAt = 0
  const ticker = setInterval(() => {
    if (!placeholder.streaming) return
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (!firstDeltaAt) {
      placeholder.phase = recognized
        ? `已识别问题，等待模型响应… ${elapsed}s`
        : `正在理解你的问题… ${elapsed}s`
    }
  }, 100)

  try {
    const result = await requestChatStream(settings.backend, settings, content, {
      onMeta: (data) => {
        if (data?.conv_id && !settings.conversationId) {
          settings.conversationId = data.conv_id
          persist()
        }
        recognized = true
        placeholder.phase = '已识别问题，正在组织回答…'
      },
      onRoute: (data) => {
        recognized = true
        placeholder.phase = `已路由到 ${data?.primary_agent || '客服'}，正在组织回答…`
      },
      onDelta: (piece) => {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now()
          // 流式过程中唯一展示的指标：首字耗时
          placeholder.meta = `${((firstDeltaAt - startedAt) / 1000).toFixed(1)}s 首字`
        }
        deltaCount += 1
        placeholder.content += piece
        if (deltaCount % 8 === 0) scrollToBottom(false)
      }
    })

    placeholder.streaming = false
    clearInterval(ticker)
    if (!placeholder.content) placeholder.content = result.response
    placeholder.meta = metaText(result)
    return result
  } catch (error) {
    clearInterval(ticker)
    placeholder.streaming = false
    if (!placeholder.content) {
      // 一个 delta 都没拿到：整条降级为非流式
      messages.value = messages.value.filter((item) => item.id !== placeholder.id)
      streamActive.value = false
      const fallback = await requestChat(settings.backend, settings, content)
      messages.value.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: fallback.response,
        meta: metaText(fallback)
      })
      return fallback
    }
    // 已经流出一部分：保留内容，只标注中断原因
    placeholder.meta = `流式中断：${error.message}`
    throw error
  }
}

async function checkHealth() {
  testingConnection.value = true
  try {
    const data = await requestHealth(settings.backend, settings)
    healthOk.value = data.status === 'ok'
    healthLabel.value = data.status || 'ok'
  } catch (error) {
    healthOk.value = false
    healthLabel.value = '不可用'
  } finally {
    testingConnection.value = false
  }
}
</script>
