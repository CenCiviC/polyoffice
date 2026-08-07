/**
 * 미리보기 페이지네이션 — HWPX의 <doc-section>은 "인쇄 페이지"가 아니라 "구역"이라
 * 문서 전체가 한 장짜리 긴 상자로 렌더된다. 여기서 실제 용지 높이(min-height)에 맞춰
 * 블록을 잘라 이어지는 페이지 요소로 나눈다.
 *
 * 원칙 — 원본 충실도가 먼저다:
 * · 블록을 **옮기기만** 한다. 쪼개거나 새로 만들지 않는다(문단 중간 분할 없음).
 * · 만들어진 페이지는 data-pg로 표시하고, 저장/내보내기 직전 unpaginate로 원상복구한다.
 * · 한 페이지보다 큰 블록(긴 표·큰 이미지)은 그 페이지가 세로로 늘어난다 — 잘리지 않는다.
 */

/** 페이지네이션이 만들어낸 이어지는 페이지 표시 */
const PAGE_FLAG = 'data-pg'

/** 본문 흐름에서 빼고 마지막 페이지에 붙이는 꼬리 블록 */
const TAIL = new Set(['DOC-FOOTNOTE'])

/** 만들어진 페이지의 블록을 원래 섹션으로 되돌린다 (라이브 문서·클론 모두에서 동작) */
export function unpaginate(root: ParentNode): void {
  let origin: Element | null = null
  for (const sec of Array.from(root.querySelectorAll('doc-section'))) {
    if (!sec.hasAttribute(PAGE_FLAG)) {
      origin = sec
      continue
    }
    if (!origin) continue
    while (sec.firstChild) origin.appendChild(sec.firstChild)
    sec.remove()
  }
}

/** 문서 전체를 용지 높이에 맞춰 다시 나눈다 */
export function paginate(doc: Document): void {
  const body = doc.body
  if (!body) return
  // 측정은 항상 배율 100%에서 — getComputedStyle(px)과 getBoundingClientRect(배율 반영)이
  // 같은 좌표계여야 한다. 동기 실행이라 중간 페인트는 없다.
  const zoom = body.style.zoom
  body.style.zoom = ''
  try {
    unpaginate(doc)
    for (const sec of Array.from(doc.querySelectorAll('doc-section'))) splitSection(sec as HTMLElement)
  } finally {
    body.style.zoom = zoom
  }
}

function splitSection(sec: HTMLElement): void {
  const cs = getComputedStyle(sec)
  const padTop = parseFloat(cs.paddingTop) || 0
  const contentH = (parseFloat(cs.minHeight) || 0) - padTop - (parseFloat(cs.paddingBottom) || 0)
  if (!(contentH > 0)) return

  const kids = Array.from(sec.children) as HTMLElement[]
  const flow = kids.filter((k) => !TAIL.has(k.tagName))
  const tail = kids.filter((k) => TAIL.has(k.tagName))
  if (flow.length < 2) return

  // 1열 상태에서 위치를 한 번에 잰다 — 페이지가 갈려도 폭이 같으니 블록 높이는 그대로다.
  const base = sec.getBoundingClientRect().top + padTop + (parseFloat(cs.borderTopWidth) || 0)
  const rects = flow.map((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top - base, bottom: r.bottom - base }
  })

  const starts = new Set<HTMLElement>() // 새 페이지를 여는 블록
  let pageTop = 0
  let pageFirst = 0 // 현재 페이지의 첫 블록 인덱스
  let forced = false // 직전 블록이 명시적 페이지 나눔이었나
  flow.forEach((el, i) => {
    // 한 페이지보다 큰 블록은 혼자서 페이지를 넘기게 두고(잘림 방지), 그다음 블록부터 새 페이지로
    const overflows = i !== pageFirst && rects[i].bottom - pageTop > contentH
    if (i > 0 && (forced || overflows)) {
      starts.add(el)
      pageTop = rects[i].top
      pageFirst = i
    }
    forced = el.tagName === 'DOC-PAGEBREAK'
  })
  if (!starts.size) return

  let cur = sec
  for (const el of flow) {
    if (starts.has(el)) {
      const page = sec.cloneNode(false) as HTMLElement // 폭·용지높이·여백을 그대로 물려받는다
      page.setAttribute(PAGE_FLAG, '')
      cur.after(page)
      cur = page
    }
    if (cur !== sec) cur.appendChild(el)
  }
  for (const t of tail) cur.appendChild(t) // 각주는 마지막 페이지 끝에
}

/**
 * 커서와 스크롤 위치를 지키면서 다시 나눈다.
 * 블록을 DOM에서 뺐다 넣으면 Selection은 풀리지만 텍스트 노드 자체는 그대로라,
 * 같은 (노드, offset)으로 다시 세우면 커서가 제자리에 남는다.
 */
export function paginateKeepingCaret(doc: Document): void {
  const win = doc.defaultView
  const sel = doc.getSelection()
  const caret = sel?.focusNode ? { node: sel.focusNode, offset: sel.focusOffset } : null

  // 화면 위쪽에 보이던 블록을 기준점으로 잡아둔다 (페이지 간격이 생기며 내용이 밀려나므로)
  const blocks = Array.from(doc.querySelectorAll('doc-section > *')) as HTMLElement[]
  const anchor = blocks.find((el) => el.getBoundingClientRect().bottom > 0)
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0

  paginate(doc)

  if (anchor && win && doc.contains(anchor)) {
    win.scrollBy(0, anchor.getBoundingClientRect().top - anchorTop)
  }
  if (caret && sel && doc.contains(caret.node)) {
    const max = caret.node.nodeType === 3 ? (caret.node.textContent ?? '').length : caret.node.childNodes.length
    const range = doc.createRange()
    range.setStart(caret.node, Math.min(caret.offset, max))
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}
