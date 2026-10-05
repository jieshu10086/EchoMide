const DEFAULT_BACKENDS = {
  python: {
    id: 'python',
    label: 'Python',
    baseUrl: import.meta.env.VITE_PYTHON_API_URL || '/api/python',
    port: '8000',
    streaming: true
  },
  java: {
    id: 'java',
    label: 'Java',
    baseUrl: import.meta.env.VITE_JAVA_API_URL || '/api/java',
    port: '8080',
    streaming: false
  }
}

const DEFAULT_IDLE_MINUTES = 30

export function createInitialSettings() {
  const saved = readSettings()
  return {
    // 界面已固定为 Python 版（支持 SSE 流式），保留 backend 字段是为了复用同一套 API 适配层。
    // 这里强制覆盖历史 localStorage 里的 'java'，否则老用户会指向未启动的 8080。
    backend: 'python',
    userId: saved.userId || 'u1001',
    conversationId: saved.conversationId || '',
    // 会话边界：记录上一条消息时间，用于空闲自动切会话（设计文档 §4.2）
    lastMessageAt: Number(saved.lastMessageAt || 0),
    idleMinutes: Number(saved.idleMinutes || DEFAULT_IDLE_MINUTES),
    // L7：流式输出开关，Python 后端默认开启；Java 后端无 /chat/stream 会自动回退
    streamEnabled: saved.streamEnabled !== false,
    endpoints: {
      python: saved.endpoints?.python || DEFAULT_BACKENDS.python.baseUrl,
      java: saved.endpoints?.java || DEFAULT_BACKENDS.java.baseUrl
    }
  }
}

export function saveSettings(settings) {
  localStorage.setItem('echomind.frontend.settings', JSON.stringify(settings))
}

export function backendMeta(type, settings) {
  const meta = DEFAULT_BACKENDS[type] || DEFAULT_BACKENDS.java
  return {
    ...meta,
    baseUrl: normalizeBaseUrl(settings.endpoints[type] || meta.baseUrl)
  }
}

/**
 * 前端是否对该后端启用流式。
 * 后端 /chat/stream 未开启（409）或上游不支持 SSE 时会自动降级到非流式。
 */
export function supportsStreaming(type, settings) {
  const meta = backendMeta(type, settings)
  return Boolean(meta.streaming) && settings.streamEnabled !== false
}

/** 空闲切会话阈值（毫秒）。 */
export function idleTimeoutMs(settings) {
  const minutes = Number(settings.idleMinutes || DEFAULT_IDLE_MINUTES)
  return Math.max(1, minutes) * 60 * 1000
}

/**
 * 发送前判断是否需要开新会话（空闲超时）。
 * 只清 conversationId 让后端重新生成，交给后端维护会话边界，前端不单方面切换状态。
 */
export function shouldRotateSession(settings, now = Date.now()) {
  if (!settings.conversationId || !settings.lastMessageAt) return false
  return now - Number(settings.lastMessageAt) > idleTimeoutMs(settings)
}

/** 开始新会话：清空会话标识与空闲计时（可选清空消息列表由调用方决定）。 */
export function resetSession(settings) {
  settings.conversationId = ''
  settings.lastMessageAt = 0
}

export async function requestHealth(type, settings) {
  return requestJson(backendMeta(type, settings).baseUrl, '/health')
}

export async function requestMonitor(type, settings) {
  return requestJson(backendMeta(type, settings).baseUrl, '/monitor')
}

export async function requestSkills(type, settings) {
  return requestJson(backendMeta(type, settings).baseUrl, '/skills')
}

export async function reloadSkills(type, settings) {
  return requestJson(backendMeta(type, settings).baseUrl, '/skills/reload', { method: 'POST' })
}

export async function requestKnowledgeStats(type, settings) {
  return requestJson(backendMeta(type, settings).baseUrl, '/knowledge/stats')
}

export async function runEvaluation(type, settings, body = null) {
  return requestJson(backendMeta(type, settings).baseUrl, '/eval/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
}

export async function requestSearch(type, settings, query, topK = 5) {
  const params = new URLSearchParams({ query, top_k: String(topK) })
  return requestJson(backendMeta(type, settings).baseUrl, `/search?${params}`, { method: 'POST' })
}

export async function requestChat(type, settings, message) {
  const meta = backendMeta(type, settings)
  const payload = buildChatPayload(type, settings, message)
  const raw = await requestJson(meta.baseUrl, '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return normalizeChatResponse(type, raw)
}

/**
 * L7：流式对话（SSE）。
 *
 * 事件约定与后端 /chat/stream 一致：
 *   meta  —— conv_id / intent / knowledge_used / 记忆统计
 *   route —— 路由决策（primary_agent / supporting_agents / multi_agent）
 *   delta —— {"text": "..."} 回答增量
 *   done  —— 最终可观测字段（latency_ms / llm_calls / session_closed ...）
 *   error —— {"message": "..."}
 *
 * 返回归一化后的结果对象；HTTP 失败会直接抛错，由调用方回退到 requestChat。
 */
export async function requestChatStream(type, settings, message, handlers = {}) {
  const meta = backendMeta(type, settings)
  const payload = buildChatPayload(type, settings, message)
  const response = await fetch(`${meta.baseUrl}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload)
  })

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let text = ''
  let final = null
  let streamError = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = parseSseFrame(frame)
      if (event) {
        const name = event.event
        const data = event.data
        if (name === 'meta') handlers.onMeta?.(data)
        else if (name === 'route') handlers.onRoute?.(data)
        else if (name === 'delta') {
          const piece = typeof data?.text === 'string' ? data.text : ''
          if (piece) {
            text += piece
            handlers.onDelta?.(piece)
          }
        } else if (name === 'done') {
          final = normalizeStreamResult(data, text)
        } else if (name === 'error') {
          streamError = new Error(data?.message || '流式响应返回错误')
          handlers.onError?.(streamError)
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }

  const result = final || normalizeStreamResult({}, text)
  if (streamError && !result.response) throw streamError
  if (streamError) result.error = streamError.message
  return result
}

export async function addKnowledge(type, settings, documents) {
  return requestJson(backendMeta(type, settings).baseUrl, '/knowledge/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents })
  })
}

export async function uploadKnowledge(type, settings, file) {
  const form = new FormData()
  form.append('file', file)
  return requestJson(backendMeta(type, settings).baseUrl, '/knowledge/upload', {
    method: 'POST',
    body: form
  })
}

function buildChatPayload(type, settings, message) {
  return {
    message,
    user_id: settings.userId || 'anonymous',
    conv_id: settings.conversationId || undefined
  }
}

function normalizeChatResponse(type, raw) {
  return {
    backend: type,
    conversationId: raw.conversation_id || raw.conversationId || raw.conv_id || '',
    requestId: raw.request_id || raw.requestId || '',
    response: raw.response || '',
    intent: raw.intent || 'other',
    intentGroup: raw.intent_group || raw.intentGroup || 'other',
    agentType: raw.agent_type || raw.agentType || '',
    primaryAgent: raw.primary_agent || '',
    supportingAgents: raw.supporting_agents || [],
    escalated: Boolean(raw.escalated),
    latencyMs: Number(raw.latency_ms ?? raw.latencyMs ?? 0),
    knowledgeUsed: Boolean(raw.knowledge_used ?? raw.knowledgeUsed),
    verified: raw.verified,
    grounded: raw.grounded,
    // ── 优化后可观测字段（设计文档 §5.3）───────────────────────────────────
    sessionClosed: Boolean(raw.session_closed ?? raw.sessionClosed),
    historyKept: Number(raw.history_kept ?? 0),
    historyDroppedByThreshold: Number(raw.history_dropped_by_threshold ?? 0),
    llmCalls: Number(raw.llm_calls ?? 0),
    llmCallsByPurpose: raw.llm_calls_by_purpose || {},
    usedSummary: Boolean(raw.used_summary ?? raw.usedSummary),
    intentLlmSkipped: Boolean(raw.intent_llm_skipped ?? raw.intentLlmSkipped),
    streamed: Boolean(raw.streamed),
    raw
  }
}

function normalizeStreamResult(data, text) {
  return normalizeChatResponse('python', { ...(data || {}), response: text })
}

function parseSseFrame(frame) {
  const lines = String(frame || '').split('\n')
  let event = 'message'
  const dataLines = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  const raw = dataLines.join('\n')
  let data = raw
  try {
    data = JSON.parse(raw)
  } catch {
    data = { text: raw }
  }
  return { event, data }
}

async function requestJson(baseUrl, path, options = {}) {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data)
    throw new Error(`${response.status} ${response.statusText}: ${detail}`)
  }
  return data
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '')
}

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem('echomind.frontend.settings') || '{}')
  } catch {
    return {}
  }
}

function runtimeConfig() {
  if (typeof window === 'undefined') return {}
  return window.__ECHOMIND_CONFIG__ || {}
}
