/**
 * 极简 Markdown → HTML 渲染器（零依赖）。
 *
 * 为什么需要它：Python 后端的回答是 Markdown（`# 标题`、`**加粗**`、`- 列表`），
 * 旧界面用 white-space: pre-wrap 直接输出，导致用户看到裸露的 `**`、`#`、`-` 符号。
 *
 * 安全模型：先整体 HTML 转义，再在转义后的文本上套用受控的标签模板。
 * 因此模型输出里的 `<script>`、`onerror=`、`javascript:` 全部失去作用，
 * 只有本文件显式生成的白名单标签会进入 DOM，可直接安全地交给 v-html。
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])
}

/** 行内语法：代码片段 → 加粗 → 斜体 → 删除线 → 链接。输入必须已转义。 */
function renderInline(escaped) {
  const codes = []

  // 行内代码先抽成占位符，避免其中的 ** 或 _ 被后续规则误伤
  let text = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    // href 允许一层括号（如 javascript:alert(3)），这样不安全的协议能被整体识别并降级为纯文本
    .replace(/\[([^\]\n]+)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/g, (match, label, href) => {
      // 只放行安全协议，其余退化为纯文本
      const safe = /^(https?:\/\/|mailto:)/i.test(href) ? href : ''
      return safe
        ? `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : label
    })

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`)
}

function inlineBlock(lines) {
  return renderInline(lines.join('\n')).replace(/\n/g, '<br>')
}

/* ── 表格（GFM）────────────────────────────────────────────────────────────
   后端回答里的「到账时间线」等内容是 Markdown 表格，必须专门解析，
   否则表格会以 `| 环节 | 预计时间 |` 的原始竖线形态直接暴露给用户。 */

function isDelimiterRow(line) {
  return /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(line)
}

function splitRow(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

function parseAlignments(delimiter) {
  return splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

function buildTable(header, alignments, rows) {
  const cell = (tag, text, column) => {
    const align = alignments[column]
    const cls = align === 'center' ? ' class="ta-c"' : align === 'right' ? ' class="ta-r"' : ''
    return `<${tag}${cls}>${renderInline(text || '')}</${tag}>`
  }
  const head = `<thead><tr>${header.map((text, i) => cell('th', text, i)).join('')}</tr></thead>`
  const body = rows.length
    ? `<tbody>${rows
        .map((row) => `<tr>${header.map((_, i) => cell('td', row[i], i)).join('')}</tr>`)
        .join('')}</tbody>`
    : ''
  // 外包一层可横向滚动的容器，避免窄屏撑破对话区
  return `<div class="table-wrap"><table>${head}${body}</table></div>`
}

/**
 * 块级语法：围栏代码、标题、水平线、引用、有序/无序列表、段落。
 * 支持扁平列表（后端回答的列表都是单层），不做嵌套缩进解析。
 */
export function renderMarkdown(source) {
  const lines = escapeHtml(source).split('\n')
  const html = []

  let paragraph = []
  let quote = []
  let list = null // 'ul' | 'ol'

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inlineBlock(paragraph)}</p>`)
      paragraph = []
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      html.push(`<blockquote>${inlineBlock(quote)}</blockquote>`)
      quote = []
    }
  }
  const closeList = () => {
    if (list) {
      html.push(`</${list}>`)
      list = null
    }
  }
  const flushAll = () => {
    flushParagraph()
    flushQuote()
    closeList()
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()

    // 围栏代码块
    const fence = line.match(/^(`{3,}|~{3,})\s*([\w+#-]*)\s*$/)
    if (fence) {
      flushAll()
      const marker = fence[1][0]
      const lang = fence[2]
      const closer = new RegExp(`^\\s*\\${marker}{3,}\\s*$`)
      const buffer = []
      index += 1
      while (index < lines.length && !closer.test(lines[index])) {
        buffer.push(lines[index])
        index += 1
      }
      index += 1 // 跳过收尾围栏（若缺失则顺带结束循环）
      const langAttr = lang ? ` data-lang="${lang}"` : ''
      html.push(`<pre${langAttr}><code>${buffer.join('\n')}</code></pre>`)
      continue
    }

    if (!line) {
      flushAll()
      index += 1
      continue
    }

    // 水平线：--- / *** / ___
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushAll()
      html.push('<hr>')
      index += 1
      continue
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushAll()
      const level = Math.min(heading[1].length + 1, 6) // 正文里 # 降一级，避免抢走页面标题层级
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    // 表格：当前行是表头，且下一行是分隔行
    if (line.includes('|') && index + 1 < lines.length && isDelimiterRow(lines[index + 1].trim())) {
      flushAll()
      const header = splitRow(line)
      const alignments = parseAlignments(lines[index + 1].trim())
      index += 2
      const rows = []
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitRow(lines[index].trim()))
        index += 1
      }
      html.push(buildTable(header, alignments, rows))
      continue
    }

    // 引用（> 已被转义成 &gt;）
    if (/^&gt;\s?/.test(line)) {
      flushParagraph()
      closeList()
      quote.push(line.replace(/^&gt;\s?/, ''))
      index += 1
      continue
    }

    flushQuote()

    // 无序列表
    const bullet = line.match(/^[-*+]\s+(.+)$/)
    if (bullet) {
      flushParagraph()
      if (list !== 'ul') {
        closeList()
        html.push('<ul>')
        list = 'ul'
      }
      html.push(`<li>${renderInline(bullet[1])}</li>`)
      index += 1
      continue
    }

    // 有序列表
    const ordered = line.match(/^\d+[.)]\s+(.+)$/)
    if (ordered) {
      flushParagraph()
      if (list !== 'ol') {
        closeList()
        html.push('<ol>')
        list = 'ol'
      }
      html.push(`<li>${renderInline(ordered[1])}</li>`)
      index += 1
      continue
    }

    closeList()
    paragraph.push(line)
    index += 1
  }

  flushAll()
  return html.join('\n')
}
