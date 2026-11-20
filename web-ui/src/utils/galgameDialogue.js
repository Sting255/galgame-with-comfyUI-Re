const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null

export function dialogueWaitStatus({ streaming, messages = [] }) {
  if (!streaming) return ''
  const pending = messages.filter(message => message.type === 'image_gen' && ['pending', 'generating', 'retrying'].includes(message.genStatus))
  if (pending.some(message => message.genStatus === 'retrying')) return '照片还需要一点时间…'
  if (pending.length) return '正在准备一张照片…'
  return ''
}

export function dialogueCharacters(text) {
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text)
}

/** Preserve every character; pagination only controls presentation. */
export function paginateDialogue(text, { width, lines, measure }) {
  const pages = []
  let page = '', lineWidth = 0, line = 1
  for (const char of dialogueCharacters(text)) {
    const size = char === '\n' ? 0 : measure(char)
    const wraps = char === '\n' || (lineWidth > 0 && lineWidth + size > width)
    if (wraps && line >= Math.max(1, lines)) {
      // Keep the newline on the preceding page, without a blank first line.
      if (char === '\n') { pages.push(page + char); page = ''; line = 1; lineWidth = 0; continue }
      pages.push(page); page = ''; line = 1; lineWidth = 0
    } else if (wraps) { line++; lineWidth = 0 }
    page += char
    lineWidth += size
  }
  if (page) pages.push(page)
  return pages.length ? pages : ['']
}

export function dialogueCharacterDelay(character) {
  if (/[。！？!?…]/u.test(character)) return 230
  if (/[，、；：,;:\n]/u.test(character)) return 115
  return 32
}

/** New replies start hidden; resizing preserves the number of revealed characters. */
export function repaginateDialogue(text, layout, previous, reset = false) {
  const pages = paginateDialogue(text, layout)
  if (reset) return { pages, pageIndex: 0, revealed: 0 }
  let offset = previous.pages.slice(0, previous.pageIndex).reduce((sum, page) => sum + dialogueCharacters(page).length, 0) + previous.revealed
  let pageIndex = 0
  // At the start of an unread page, the exact boundary belongs to that next page.
  // A completed page still stays completed until the player explicitly advances.
  const atUnreadPageStart = previous.pageIndex > 0 && previous.revealed === 0
  while (pageIndex < pages.length - 1 && (offset > dialogueCharacters(pages[pageIndex]).length ||
    (atUnreadPageStart && offset === dialogueCharacters(pages[pageIndex]).length))) {
    offset -= dialogueCharacters(pages[pageIndex]).length
    pageIndex++
  }
  return { pages, pageIndex, revealed: Math.min(offset, dialogueCharacters(pages[pageIndex]).length) }
}

export function mergeDialogueMessages(current, incoming) {
  const rows = new Map(current.map(row => [row.id, row]))
  for (const row of incoming) rows.set(row.id, row)
  return [...rows.values()].sort((a, b) => a.id - b.id)
}
