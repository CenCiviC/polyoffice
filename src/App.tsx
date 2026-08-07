import { useCallback, useEffect, useRef, useState } from 'react'
import { convertHWP, convertModel, wrapStandalone, type ConvertResult } from './lib/narro'
import { html2hwpx } from './lib/html2hwpx'
import { html2docx } from './lib/html2docx'
import { html2odt } from './lib/html2odt'
import { detectFonts, FONT_CANDIDATES, isSafeForExport } from './lib/fonts'
import { normalizeIR } from './lib/ir'
import { paginateKeepingCaret, unpaginate } from './lib/paginate'
import { initHwpWasm, parseHwpWasm } from './lib/parser-wasm'
import wasmUrl from '../rust/hwp-core/pkg/hwp_core_bg.wasm?url'

type Tab = 'preview' | 'source'
type ViewMode = 'single' | 'two'

const FONT_SIZES = ['8', '9', '10', '11', '12', '14', '16', '20', '24', '32']

const Icon = {
  undo: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 7h6.5a3.25 3.25 0 1 1 0 6.5H7" />
      <path d="M6.5 4 3.5 7l3 3" />
    </svg>
  ),
  redo: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 7H6a3.25 3.25 0 1 0 0 6.5h3" />
      <path d="M9.5 4l3 3-3 3" />
    </svg>
  ),
  alignLeft: (
    <svg viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="2.5" y1="8" x2="9.5" y2="8" />
      <line x1="2.5" y1="12" x2="11.5" y2="12" />
    </svg>
  ),
  alignCenter: (
    <svg viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="4.5" y1="8" x2="11.5" y2="8" />
      <line x1="3.5" y1="12" x2="12.5" y2="12" />
    </svg>
  ),
  alignRight: (
    <svg viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="6.5" y1="8" x2="13.5" y2="8" />
      <line x1="4.5" y1="12" x2="13.5" y2="12" />
    </svg>
  ),
  alignJustify: (
    <svg viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="13.5" y2="13.5" />
    </svg>
  ),
  table: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" />
      <line x1="8" y1="3" x2="8" y2="13" />
    </svg>
  ),
  print: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M4.5 6V2.5h7V6" />
      <rect x="2.5" y="6" width="11" height="5.5" rx="1" />
      <rect x="4.5" y="9.5" width="7" height="4" />
    </svg>
  ),
  open: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M1.5 4.5v8h11l2-5.5H4l-1.5 5" />
      <path d="M1.5 4.5v-1.5h4l1.5 1.5h5v2" />
    </svg>
  ),
  code: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5.5 5-3 3 3 3" />
      <path d="m10.5 5 3 3-3 3" />
    </svg>
  ),
  copy: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 8.5 3.5 3.5L13 5" />
    </svg>
  ),
  downloadHtml: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v7" />
      <path d="M5 7l3 3 3-3" />
      <path d="M2.5 13.5h11" />
    </svg>
  ),
  pageSingle: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="4.5" y="2.5" width="7" height="11" rx="1" />
    </svg>
  ),
  pageTwo: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="3.5" width="6" height="9" rx="1" />
      <rect x="8.5" y="3.5" width="6" height="9" rx="1" />
    </svg>
  ),
}

const clampZoom = (z: number) => Math.min(200, Math.max(50, z))

// 두 페이지 보기 배율 계산용 — 편집기 body.two-up의 gap/padding과 값을 맞춘다
const TWO_UP_GAP = 20
const TWO_UP_PAD = 12
const SCROLLBAR = 16

/** 선택 지점이 없을 때 블록을 떨굴 곳 — 첫 장이 아니라 마지막 장 끝 */
const lastPage = (doc: Document): Element | null => {
  const pages = doc.querySelectorAll('doc-section')
  return pages.length ? pages[pages.length - 1] : null
}

/** 외부 붙여넣기 HTML → IR 인라인 어휘로 세탁 (블록 경계는 <br>로 평탄화) */
function sanitizePastedHtml(html: string): string {
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const out: string[] = []
  const escText = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const inlineStyle = (el: Element): string => {
    const cs = (el as HTMLElement).style
    const parts: string[] = []
    const tag = el.tagName
    if (tag === 'B' || tag === 'STRONG' || cs.fontWeight === 'bold' || Number(cs.fontWeight) >= 600)
      parts.push('font-weight:bold')
    if (tag === 'I' || tag === 'EM' || cs.fontStyle === 'italic') parts.push('font-style:italic')
    if (tag === 'U' || cs.textDecoration.includes('underline')) parts.push('text-decoration:underline')
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || cs.textDecoration.includes('line-through'))
      parts.push('text-decoration:line-through')
    if (cs.color) parts.push(`color:${cs.color}`)
    const size = cs.fontSize
    if (size?.endsWith('px')) parts.push(`font-size:${(parseFloat(size) * 0.75).toFixed(1)}pt`)
    else if (size?.endsWith('pt')) parts.push(`font-size:${parseFloat(size).toFixed(1)}pt`)
    return parts.join(';')
  }

  const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'BR', 'UL', 'OL', 'TABLE'])
  const walk = (node: Node, inherited: string) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const t = child.textContent ?? ''
        if (t.trim() || t === ' ')
          out.push(inherited ? `<span style="${escText(inherited)}">${escText(t)}</span>` : escText(t))
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT' || el.tagName === 'META') continue
      const style = [inherited, inlineStyle(el)].filter(Boolean).join(';')
      const blockBoundary = BLOCK.has(el.tagName)
      walk(el, style)
      if (blockBoundary && out.length && out[out.length - 1] !== '<br>') out.push('<br>')
    }
  }
  walk(dom.body, '')
  while (out.length && out[out.length - 1] === '<br>') out.pop()
  return out.join('')
}

export default function App() {
  const [result, setResult] = useState<ConvertResult | null>(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('preview')
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const [edited, setEdited] = useState(false)
  const [previewKey, setPreviewKey] = useState(0)
  const [fmt, setFmt] = useState({ bold: false, italic: false, underline: false, strike: false })
  const [zoom, setZoom] = useState(100)
  const [viewMode, setViewMode] = useState<ViewMode>('single')
  const [counts, setCounts] = useState({ pages: 0, chars: 0, charsNoSpace: 0 })
  const [page, setPage] = useState(1) // 지금 보고 있는 페이지 (1-based)
  const [pageHint, setPageHint] = useState(false) // 스크롤 중 잠깐 뜨는 페이지 표시
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  const [findTotal, setFindTotal] = useState(0)
  const [findIndex, setFindIndex] = useState(0) // 0-based, 표시할 땐 +1
  // 이 기기에 실제로 설치된 글꼴만 고를 수 있게 한다 — 없는 글꼴을 고르면 화면에선 대체되고
  // docx·hwpx로 저장했을 때 받는 쪽에서 또 다른 글꼴로 대체돼 조판이 어긋난다.
  const [fonts, setFonts] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLIFrameElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef<Range[]>([])
  const hintTimerRef = useRef<number | undefined>(undefined)
  const paginateTimerRef = useRef<number | undefined>(undefined)
  const afterPaginateRef = useRef<() => void>(() => {})
  const zoomBeforeTwoUpRef = useRef<{ from: number; to: number } | null>(null)

  const editorDoc = () => previewRef.current?.contentDocument ?? null
  const editorWin = () => previewRef.current?.contentWindow as (Window & typeof globalThis) | null

  useEffect(() => {
    setFonts(detectFonts(FONT_CANDIDATES))
  }, [])

  // ── 파일 열기 ──────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    setError('')
    setCopied(false)
    setEdited(false)
    setFindOpen(false)
    setFindQuery('')
    if (!/\.(hwpx?|docx?|odt)$/i.test(file.name)) {
      setError(`.hwp · .hwpx · .doc · .docx · .odt만 지원합니다: ${file.name}`)
      return
    }
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      // hwp.js 폴백은 .hwp(CFB) 전용 — zip 계열(hwpx/docx/odt)은 WASM 실패가 곧 실패
      const isZip = data[0] === 0x50 && data[1] === 0x4b
      let converted: ConvertResult
      try {
        await initHwpWasm({ url: wasmUrl })
        converted = convertModel(parseHwpWasm(data), 'wasm')
      } catch (wasmErr) {
        if (isZip) throw wasmErr
        console.warn('WASM 파서 실패, hwp.js로 폴백:', wasmErr)
        converted = convertHWP(data)
      }
      setResult(converted)
      setFileName(file.name)
      setTab('preview')
      setPreviewKey((k) => k + 1)
    } catch (e) {
      setResult(null)
      setError(`변환 실패: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) void handleFile(file)
    },
    [handleFile],
  )

  // ?doc=<url> — 링크 하나로 편집기에 문서를 띄운다 (드래그&드롭 없이).
  // 다른 오리진의 URL이면 그쪽 서버가 CORS를 허용해야 한다.
  useEffect(() => {
    const src = new URLSearchParams(window.location.search).get('doc')
    if (!src) return
    void (async () => {
      try {
        const res = await fetch(src)
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        const name = decodeURIComponent(src.split('?')[0].split('/').pop() || 'document.hwpx')
        await handleFile(new File([await res.blob()], name))
      } catch (e) {
        setError(`문서를 불러오지 못했습니다 (${src}): ${e instanceof Error ? e.message : String(e)}`)
      }
    })()
  }, [handleFile])

  // ── 보기(확대/축소·페이지 모드) ────────────────────────────
  const applyView = useCallback(() => {
    const doc = editorDoc()
    if (!doc?.body) return
    ;(doc.body.style as CSSStyleDeclaration & { zoom: string }).zoom = `${zoom}%`
    doc.body.classList.toggle('two-up', viewMode === 'two')
  }, [zoom, viewMode])

  useEffect(() => {
    applyView()
  }, [applyView, previewKey])

  // 두 페이지 나란히: A4 두 장은 100%에서 창보다 넓다 — 창 폭에 맞는 배율을 계산해서
  // 실제로 나란히 보이게 한다. 맞출 수 없으면 null(배율 유지).
  const fitTwoUpZoom = useCallback(() => {
    const doc = editorDoc()
    const frame = previewRef.current
    const page = doc?.querySelector('doc-section')
    if (!frame || !page) return null
    const w = page.getBoundingClientRect().width // 현재 배율에서 보이는 폭
    if (!w) return null
    const avail = frame.clientWidth - TWO_UP_GAP - TWO_UP_PAD * 2 - SCROLLBAR
    const fit = (zoom * (avail / 2)) / w
    return clampZoom(Math.floor(fit / 5) * 5) // 5% 단위로 내림
  }, [zoom])

  const showTwoUp = useCallback(() => {
    const fit = fitTwoUpZoom()
    setViewMode('two')
    if (fit !== null && fit < zoom) {
      zoomBeforeTwoUpRef.current = { from: zoom, to: fit }
      setZoom(fit)
    }
  }, [fitTwoUpZoom, zoom])

  const showSingle = useCallback(() => {
    setViewMode('single')
    // 두 장 맞추려고 우리가 줄인 배율이면 되돌린다 (사용자가 직접 바꿨으면 그대로 둔다)
    const prev = zoomBeforeTwoUpRef.current
    if (prev && prev.to === zoom) setZoom(prev.from)
    zoomBeforeTwoUpRef.current = null
  }, [zoom])

  const applyCounts = useCallback(() => {
    const doc = editorDoc()
    if (!doc?.body) return
    const text = doc.body.textContent ?? ''
    setCounts({
      pages: doc.querySelectorAll('doc-section').length,
      chars: text.replace(/\n/g, '').length,
      charsNoSpace: text.replace(/\s/g, '').length,
    })
  }, [])

  /** 용지 높이에 맞춰 페이지를 다시 나눈다 (페이지 수는 그 결과에서 나온다) */
  const repaginate = useCallback(() => {
    const doc = editorDoc()
    if (!doc?.body) return
    paginateKeepingCaret(doc)
    applyCounts()
    afterPaginateRef.current() // 페이지가 갈리며 노드가 옮겨졌으니 찾기 하이라이트는 다시 잡는다
  }, [applyCounts])

  // 타자 칠 때마다 다시 나누면 무거우니 입력이 멎은 뒤에 한 번
  const schedulePaginate = useCallback(() => {
    window.clearTimeout(paginateTimerRef.current)
    paginateTimerRef.current = window.setTimeout(repaginate, 400)
  }, [repaginate])

  const recount = useCallback(() => {
    applyCounts()
    schedulePaginate()
  }, [applyCounts, schedulePaginate])

  // 스크롤 위치 → 지금 보고 있는 페이지. 뷰포트 위쪽 30% 선에 걸친 페이지를 "현재"로 본다.
  const trackPage = useCallback(() => {
    const doc = editorDoc()
    const win = editorWin()
    if (!doc || !win) return
    const sections = doc.querySelectorAll('doc-section')
    if (!sections.length) return
    const mark = win.innerHeight * 0.3
    let cur = 1
    sections.forEach((s, i) => {
      if (s.getBoundingClientRect().top <= mark) cur = i + 1
    })
    setPage(cur)
    setPageHint(true)
    window.clearTimeout(hintTimerRef.current)
    hintTimerRef.current = window.setTimeout(() => setPageHint(false), 900)
  }, [])

  // ── 찾기/바꾸기 ────────────────────────────────────────────
  const clearFind = useCallback(() => {
    const win = editorWin() as (Window & { CSS?: { highlights?: Map<string, unknown> } }) | null
    win?.CSS?.highlights?.delete?.('hwp-find')
    win?.CSS?.highlights?.delete?.('hwp-find-current')
    matchesRef.current = []
    setFindTotal(0)
    setFindIndex(0)
  }, [])

  const highlightCurrent = useCallback((ranges: Range[], idx: number, scroll = true) => {
    const win = editorWin() as (Window & {
      CSS?: { highlights?: Map<string, unknown> }
      Highlight?: new (...r: Range[]) => unknown
    }) | null
    if (!win?.CSS?.highlights || !win.Highlight) return
    win.CSS.highlights.set('hwp-find', new win.Highlight(...ranges))
    const cur = ranges[idx]
    if (cur) {
      win.CSS.highlights.set('hwp-find-current', new win.Highlight(cur))
      if (scroll) cur.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [])

  const runFind = useCallback(
    (query: string, keepIndex = false, scroll = true) => {
      const doc = editorDoc()
      if (!doc || !query) {
        clearFind()
        return
      }
      const ranges: Range[] = []
      const lower = query.toLowerCase()
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const hay = (node.textContent ?? '').toLowerCase()
        let i = 0
        while ((i = hay.indexOf(lower, i)) !== -1) {
          const r = doc.createRange()
          r.setStart(node, i)
          r.setEnd(node, i + query.length)
          ranges.push(r)
          i += query.length
        }
      }
      matchesRef.current = ranges
      setFindTotal(ranges.length)
      const idx = keepIndex ? Math.min(findIndex, Math.max(0, ranges.length - 1)) : 0
      setFindIndex(idx)
      highlightCurrent(ranges, idx, scroll)
    },
    [clearFind, findIndex, highlightCurrent],
  )

  // 페이지를 다시 나눈 뒤 찾기 결과 되살리기 — 화면은 그대로 두고 하이라이트만 다시 잡는다
  useEffect(() => {
    afterPaginateRef.current = () => {
      if (findQuery) runFind(findQuery, true, false)
    }
  }, [findQuery, runFind])

  const stepFind = useCallback(
    (delta: number) => {
      const total = matchesRef.current.length
      if (!total) return
      const next = (findIndex + delta + total) % total
      setFindIndex(next)
      highlightCurrent(matchesRef.current, next)
    },
    [findIndex, highlightCurrent],
  )

  const replaceOne = useCallback(() => {
    const doc = editorDoc()
    const r = matchesRef.current[findIndex]
    if (!doc || !r) return
    r.deleteContents()
    r.insertNode(doc.createTextNode(replaceQuery))
    setEdited(true)
    recount()
    runFind(findQuery, true)
  }, [findIndex, replaceQuery, findQuery, runFind, recount])

  const replaceAll = useCallback(() => {
    const doc = editorDoc()
    if (!doc || !matchesRef.current.length) return
    for (const r of [...matchesRef.current].reverse()) {
      r.deleteContents()
      r.insertNode(doc.createTextNode(replaceQuery))
    }
    setEdited(true)
    recount()
    runFind(findQuery)
  }, [replaceQuery, findQuery, runFind, recount])

  const openFind = useCallback(() => {
    setFindOpen(true)
    setTimeout(() => findInputRef.current?.focus(), 0)
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    clearFind()
  }, [clearFind])

  // ── 편집 활성화 ────────────────────────────────────────────
  const makeEditable = useCallback((doc: Document) => {
    for (const p of Array.from(doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li'))) {
      p.setAttribute('contenteditable', 'true')
      p.setAttribute('spellcheck', 'false')
    }
  }, [])

  const enableEditing = useCallback(() => {
    const doc = editorDoc()
    if (!doc) return
    makeEditable(doc)
    doc.execCommand('styleWithCSS', false, 'true')
    const style = doc.createElement('style')
    style.textContent = `
      [contenteditable]:hover { outline: 1px dashed rgba(94, 106, 210, .4); outline-offset: 1px; }
      [contenteditable]:focus { outline: 2px solid rgba(94, 106, 210, .65); outline-offset: 1px; }
      /* 정확히 2열 — flex-wrap이면 폭이 모자랄 때 조용히 1열로 되돌아간다 (배율은 fitTwoUpZoom이 맞춘다) */
      body.two-up { display: grid; grid-template-columns: repeat(2, max-content);
        justify-content: center; align-items: start; gap: 20px; padding: 20px 12px; }
      body.two-up doc-section.hwp-page { margin: 0 !important; }
      ::highlight(hwp-find) { background: #ffe58a; color: #1a1a1a; }
      ::highlight(hwp-find-current) { background: #f0a020; color: #101010; }
    `
    doc.head.appendChild(style)
    setPage(1)
    doc.defaultView?.addEventListener('scroll', trackPage, { passive: true })
    doc.body.addEventListener('input', () => {
      setEdited(true)
      recount()
    })
    // 붙여넣기 정제: 외부 HTML을 IR 인라인 어휘(span 스타일 + br)로 세탁해서 삽입
    doc.body.addEventListener('paste', (e) => {
      e.preventDefault()
      const clip = (e as ClipboardEvent).clipboardData
      const html = clip?.getData('text/html')
      if (html) {
        const safe = sanitizePastedHtml(html)
        if (safe) {
          doc.execCommand('insertHTML', false, safe)
          return
        }
      }
      const text = clip?.getData('text/plain') ?? ''
      if (text) doc.execCommand('insertText', false, text)
    })
    doc.addEventListener('selectionchange', () => {
      setFmt({
        bold: doc.queryCommandState('bold'),
        italic: doc.queryCommandState('italic'),
        underline: doc.queryCommandState('underline'),
        strike: doc.queryCommandState('strikeThrough'),
      })
    })
    doc.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setZoom((z) => clampZoom(z + 10))
      } else if (e.key === '-') {
        e.preventDefault()
        setZoom((z) => clampZoom(z - 10))
      } else if (e.key === '0') {
        e.preventDefault()
        setZoom(100)
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFind()
      }
    })
    repaginate() // 문서를 열자마자 용지 높이대로 나눈다
    applyView()
  }, [makeEditable, applyView, repaginate, recount, openFind, trackPage])

  // ── 서식 명령 ──────────────────────────────────────────────
  const exec = useCallback(
    (cmd: string, value?: string) => {
      const doc = editorDoc()
      if (!doc) return
      doc.execCommand('styleWithCSS', false, 'true')
      doc.execCommand(cmd, false, value)
      makeEditable(doc) // formatBlock 등이 만든 새 블록도 편집 가능해야 함
      setEdited(true)
    },
    [makeEditable],
  )

  /** 선택 지점의 블록(p·h1-h6·li) */
  const selectionBlock = (): HTMLElement | null => {
    const doc = editorDoc()
    const n = doc?.getSelection()?.anchorNode
    if (!n) return null
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement
    return (el?.closest('p, h1, h2, h3, h4, h5, h6, li') as HTMLElement) ?? null
  }

  /** 문단 스타일: 본문/제목1-3 */
  const applyBlockStyle = useCallback(
    (tag: string) => {
      if (!tag) return
      exec('formatBlock', `<${tag}>`)
      recount()
    },
    [exec, recount],
  )

  /** 목록 토글: 현재 블록을 ul/ol의 li로 감싸거나 해제 */
  const listOp = useCallback(
    (kind: 'ul' | 'ol') => {
      const doc = editorDoc()
      const block = selectionBlock()
      if (!doc || !block) return
      if (block.tagName === 'LI') {
        // 해제: li → p, 목록이 비면 목록 제거
        const list = block.parentElement
        const p = doc.createElement('p')
        while (block.firstChild) p.appendChild(block.firstChild)
        list?.after(p)
        block.remove()
        if (list && !list.querySelector('li')) list.remove()
      } else {
        const list = doc.createElement(kind)
        const li = doc.createElement('li')
        while (block.firstChild) li.appendChild(block.firstChild)
        list.appendChild(li)
        block.replaceWith(list)
      }
      makeEditable(doc)
      setEdited(true)
    },
    [makeEditable],
  )

  /** 줄간격: 선택 블록에 line-height 적용 */
  const applyLineHeight = useCallback((value: string) => {
    const block = selectionBlock()
    if (!block || !value) return
    block.style.lineHeight = value
    setEdited(true)
  }, [])

  /** 이미지 삽입: 파일 → data URI, 원본 픽셀 크기(px→pt, 최대 420pt)로 */
  const insertImage = useCallback(
    async (file: File) => {
      const doc = editorDoc()
      if (!doc) return
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(new Error('파일 읽기 실패'))
        reader.readAsDataURL(file)
      })
      const probe = new Image()
      await new Promise((resolve) => {
        probe.onload = resolve
        probe.onerror = resolve
        probe.src = dataUri
      })
      let wPt = (probe.naturalWidth || 300) * 0.75
      let hPt = (probe.naturalHeight || 200) * 0.75
      if (wPt > 420) {
        hPt = (hPt * 420) / wPt
        wPt = 420
      }
      const imgHtml = `<img src="${dataUri}" alt="" style="width:${wPt.toFixed(1)}pt;height:${hPt.toFixed(1)}pt">`
      const block = selectionBlock()
      if (block && block.tagName === 'P' && doc.getSelection()?.rangeCount) {
        doc.execCommand('insertHTML', false, imgHtml)
      } else {
        const p = doc.createElement('p')
        p.innerHTML = imgHtml
        lastPage(doc)?.appendChild(p)
        makeEditable(doc)
      }
      setEdited(true)
      recount()
    },
    [makeEditable, recount],
  )

  /** 페이지 나눔 삽입 */
  const insertPageBreak = useCallback(() => {
    const doc = editorDoc()
    const block = selectionBlock()
    if (!doc) return
    const brk = doc.createElement('doc-pagebreak')
    if (block && block.closest('doc-section') && block.tagName !== 'LI') block.after(brk)
    else lastPage(doc)?.appendChild(brk)
    setEdited(true)
  }, [])

  const applyFontSize = useCallback((pt: string) => {
    const doc = editorDoc()
    if (!doc || !pt) return
    doc.execCommand('styleWithCSS', false, 'false')
    doc.execCommand('fontSize', false, '7')
    for (const f of Array.from(doc.querySelectorAll('font[size="7"]'))) {
      const span = doc.createElement('span')
      span.setAttribute('style', `font-size:${pt}.0pt`)
      while (f.firstChild) span.appendChild(f.firstChild)
      f.replaceWith(span)
    }
    doc.execCommand('styleWithCSS', false, 'true')
    setEdited(true)
  }, [])

  // ── 표 편집 ────────────────────────────────────────────────
  const selectionCell = (): HTMLTableCellElement | null => {
    const doc = editorDoc()
    const n = doc?.getSelection()?.anchorNode
    if (!n) return null
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement
    return (el?.closest('td') as HTMLTableCellElement) ?? null
  }

  const emptyCellLike = (src: HTMLTableCellElement): HTMLTableCellElement => {
    const td = src.cloneNode(false) as HTMLTableCellElement
    td.removeAttribute('colspan')
    td.removeAttribute('rowspan')
    td.innerHTML = '<p></p>'
    return td
  }

  /** 표 그리드 점유 계산: grid[r][c] = 셀, colStart = 셀의 시작 열 */
  const buildGrid = (table: HTMLTableElement) => {
    const rows = Array.from(table.querySelectorAll('tr')).filter(
      (r) => r.closest('table') === table,
    ) as HTMLTableRowElement[]
    const grid: (HTMLTableCellElement | undefined)[][] = rows.map(() => [])
    const colStart = new Map<HTMLTableCellElement, [number, number]>() // cell → [row, col]
    rows.forEach((tr, r) => {
      let c = 0
      for (const td of Array.from(tr.cells)) {
        while (grid[r][c]) c++
        const cs = Number(td.getAttribute('colspan') ?? 1)
        const rs = Number(td.getAttribute('rowspan') ?? 1)
        colStart.set(td, [r, c])
        for (let rr = r; rr < r + rs && rr < rows.length; rr++)
          for (let cc = c; cc < c + cs; cc++) grid[rr][cc] = td
        c += cs
      }
    })
    return { rows, grid, colStart }
  }

  const tableOp = useCallback(
    (op: 'row-add' | 'row-del' | 'col-add' | 'col-del' | 'merge-right' | 'merge-down' | 'unmerge') => {
      const doc = editorDoc()
      const td = selectionCell()
      const tr = td?.parentElement as HTMLTableRowElement | null
      const table = td?.closest('table')
      if (!doc || !td || !tr || !table) return
      const rows = Array.from(table.querySelectorAll('tr')).filter((r) => r.closest('table') === table)

      if (op === 'merge-right' || op === 'merge-down' || op === 'unmerge') {
        const { rows: gridRows, grid, colStart } = buildGrid(table as HTMLTableElement)
        const pos = colStart.get(td)
        if (!pos) return
        const [r0, c0] = pos
        const cs = Number(td.getAttribute('colspan') ?? 1)
        const rs = Number(td.getAttribute('rowspan') ?? 1)

        const absorb = (victim: HTMLTableCellElement) => {
          for (const child of Array.from(victim.children)) td.appendChild(child)
          victim.remove()
        }

        if (op === 'merge-right') {
          const neighbor = grid[r0][c0 + cs]
          if (!neighbor || neighbor === td) return
          const nPos = colStart.get(neighbor)
          const nRs = Number(neighbor.getAttribute('rowspan') ?? 1)
          if (!nPos || nPos[0] !== r0 || nRs !== rs) return // 모양이 안 맞으면 병합 불가
          td.setAttribute('colspan', String(cs + Number(neighbor.getAttribute('colspan') ?? 1)))
          absorb(neighbor)
        } else if (op === 'merge-down') {
          const neighbor = grid[r0 + rs]?.[c0]
          if (!neighbor || neighbor === td) return
          const nPos = colStart.get(neighbor)
          const nCs = Number(neighbor.getAttribute('colspan') ?? 1)
          if (!nPos || nPos[1] !== c0 || nCs !== cs) return
          td.setAttribute('rowspan', String(rs + Number(neighbor.getAttribute('rowspan') ?? 1)))
          absorb(neighbor)
        } else {
          // 병합 해제: 1×1로 되돌리고 덮었던 칸을 빈 셀로 채움
          if (cs === 1 && rs === 1) return
          td.removeAttribute('colspan')
          td.removeAttribute('rowspan')
          const fillRow = (row: HTMLTableRowElement, col: number, count: number) => {
            let ref: HTMLTableCellElement | null = null
            for (const cell of Array.from(row.cells)) {
              const p = colStart.get(cell)
              if (p && p[1] > col) {
                ref = cell
                break
              }
            }
            for (let i = 0; i < count; i++) {
              const empty = emptyCellLike(td)
              if (ref) ref.before(empty)
              else row.appendChild(empty)
            }
          }
          if (cs > 1) fillRow(gridRows[r0], c0, cs - 1)
          for (let rr = r0 + 1; rr < r0 + rs && rr < gridRows.length; rr++) fillRow(gridRows[rr], c0 - 1, cs)
        }
        makeEditable(doc)
        setEdited(true)
        recount()
        return
      }

      if (op === 'row-add') {
        const clone = doc.createElement('tr')
        for (const cell of Array.from(tr.cells)) clone.appendChild(emptyCellLike(cell))
        tr.after(clone)
      } else if (op === 'row-del') {
        if (rows.length > 1) tr.remove()
      } else if (op === 'col-add') {
        const idx = td.cellIndex
        for (const row of rows) {
          const ref = row.cells[Math.min(idx, row.cells.length - 1)]
          ref.after(emptyCellLike(ref))
        }
      } else if (op === 'col-del') {
        if (tr.cells.length > 1) {
          const idx = td.cellIndex
          for (const row of rows) row.cells[Math.min(idx, row.cells.length - 1)]?.remove()
        }
      }
      makeEditable(doc)
      setEdited(true)
      recount()
    },
    [makeEditable, recount],
  )

  const insertTable = useCallback(() => {
    const doc = editorDoc()
    if (!doc) return
    const input = window.prompt('표 크기 (행x열)', '3x3')
    const m = input?.match(/^\s*(\d{1,2})\s*[x×,]\s*(\d{1,2})\s*$/)
    if (!m) return
    const rows = Number(m[1])
    const cols = Number(m[2])
    const wPt = Math.round(4000 / cols) / 10
    const rowHtml = `<tr>${Array.from({ length: cols })
      .map(() => `<td style="width:${wPt}pt;height:20.0pt;padding:5.1pt 5.1pt 2.0pt 2.0pt"><p></p></td>`)
      .join('')}</tr>`
    const table = doc.createElement('table')
    table.className = 'hwp-table'
    table.innerHTML = Array.from({ length: rows })
      .map(() => rowHtml)
      .join('')

    // 커서 위치의 문단 뒤에, 없으면 첫 섹션 끝에
    const n = doc.getSelection()?.anchorNode
    const anchor = (n && (n.nodeType === 1 ? (n as Element) : n.parentElement))?.closest('p')
    if (anchor && anchor.closest('doc-section')) anchor.after(table)
    else lastPage(doc)?.appendChild(table)

    makeEditable(doc)
    setEdited(true)
    recount()
  }, [makeEditable, recount])

  // ── 커밋/내보내기 ──────────────────────────────────────────
  const currentBody = useCallback((): string => {
    const doc = editorDoc()
    if (!doc || !result) return result?.body ?? ''
    const clone = doc.body.cloneNode(true) as HTMLElement
    clone.classList.remove('two-up')
    clone.style.removeProperty('zoom')
    unpaginate(clone) // 미리보기용으로 나눈 페이지는 원래 섹션으로 되돌린 뒤 내보낸다
    normalizeIR(clone)
    return clone.innerHTML
  }, [result])

  const commitEdits = useCallback((): ConvertResult | null => {
    if (!result) return null
    if (!edited) return result
    const body = currentBody()
    const next = { ...result, body, standalone: wrapStandalone(body) }
    setResult(next)
    return next
  }, [result, edited, currentBody])

  const switchTab = useCallback(
    (next: Tab) => {
      if (next === 'source') commitEdits()
      setTab(next)
    },
    [commitEdits],
  )

  const resetEdits = useCallback(() => {
    setEdited(false)
    setPreviewKey((k) => k + 1)
  }, [])

  const copySource = useCallback(() => {
    const current = commitEdits()
    if (!current) return
    void navigator.clipboard.writeText(current.standalone).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [commitEdits])

  const downloadBlob = (blob: Blob, name: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const download = useCallback(() => {
    const current = commitEdits()
    if (!current) return
    downloadBlob(
      new Blob([current.standalone], { type: 'text/html;charset=utf-8' }),
      fileName.replace(/\.(hwpx?|docx?|odt)$/i, '.html'),
    )
  }, [commitEdits, fileName])

  const downloadHwpx = useCallback(async () => {
    const current = commitEdits()
    if (!current) return
    try {
      const template = new Uint8Array(await (await fetch('/blank.hwpx')).arrayBuffer())
      const dom = new DOMParser().parseFromString(current.body, 'text/html')
      const { data } = html2hwpx(dom.body, template)
      downloadBlob(
        new Blob([data as BlobPart], { type: 'application/hwp+zip' }),
        fileName.replace(/\.(hwpx?|docx?|odt)$/i, '.hwpx'),
      )
    } catch (e) {
      setError(`hwpx 변환 실패: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [commitEdits, fileName])

  /** 편집 결과 IR을 다른 포맷으로 저장 — 백엔드만 갈아끼운다 */
  const downloadAs = useCallback(
    (ext: 'docx' | 'odt') => {
      const current = commitEdits()
      if (!current) return
      try {
        const dom = new DOMParser().parseFromString(current.body, 'text/html')
        const { data } = ext === 'docx' ? html2docx(dom.body) : html2odt(dom.body)
        const mime =
          ext === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/vnd.oasis.opendocument.text'
        downloadBlob(
          new Blob([data as BlobPart], { type: mime }),
          fileName.replace(/\.(hwpx?|docx?|odt)$/i, `.${ext}`),
        )
      } catch (e) {
        setError(`${ext} 변환 실패: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [commitEdits, fileName],
  )

  const printDoc = useCallback(() => {
    editorWin()?.print()
  }, [])

  const keepSelection = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div className="shell">
      <header className="appbar">
        <span className="brand">
          <img src="/icons/narro-logo-48.png" alt="" />
          Narro
        </span>
        <span className="docname">
          {fileName || '문서를 열어주세요'}
          {edited && <span className="edited-chip">편집됨</span>}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".hwp,.hwpx,.doc,.docx,.odt"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
            e.target.value = ''
          }}
        />
        <div className="appbar-actions">
          <button
            className="icon-btn"
            title="열기 (.hwp · .hwpx · .doc · .docx · .odt)"
            onClick={() => inputRef.current?.click()}
          >
            {Icon.open}
          </button>
          {result && (
            <>
              <button
                className={`icon-btn${tab === 'source' ? ' on' : ''}`}
                title={tab === 'source' ? '편집으로 돌아가기' : 'HTML 소스 보기'}
                onClick={() => switchTab(tab === 'source' ? 'preview' : 'source')}
              >
                {Icon.code}
              </button>
              <button
                className={`icon-btn${copied ? ' ok' : ''}`}
                title="HTML 복사"
                onClick={copySource}
              >
                {copied ? Icon.check : Icon.copy}
              </button>
              <button className="icon-btn" title="인쇄 · PDF 저장" onClick={printDoc}>
                {Icon.print}
              </button>
              <button className="icon-btn" title=".html로 저장" onClick={download}>
                {Icon.downloadHtml}
              </button>
              <span className="appbar-sep" />
              <button className="save-alt" title="Word 문서로 저장" onClick={() => downloadAs('docx')}>
                docx
              </button>
              <button className="save-alt" title="오픈오피스 문서로 저장" onClick={() => downloadAs('odt')}>
                odt
              </button>
              <button className="primary" onClick={() => void downloadHwpx()}>
                .hwpx 저장
              </button>
            </>
          )}
        </div>
      </header>

      {result && tab === 'preview' && (
        <div className="fmtbar" role="toolbar" aria-label="서식">
          <div className="group">
            <button title="실행 취소 (⌘Z)" onMouseDown={keepSelection} onClick={() => exec('undo')}>
              {Icon.undo}
            </button>
            <button title="다시 실행 (⇧⌘Z)" onMouseDown={keepSelection} onClick={() => exec('redo')}>
              {Icon.redo}
            </button>
          </div>
          <div className="group">
            <select
              title="문단 스타일"
              defaultValue=""
              onChange={(e) => {
                applyBlockStyle(e.target.value)
                e.target.value = ''
              }}
            >
              <option value="" disabled>
                스타일
              </option>
              <option value="p">본문</option>
              <option value="h1">제목 1</option>
              <option value="h2">제목 2</option>
              <option value="h3">제목 3</option>
            </select>
            <select
              title="서체"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) exec('fontName', e.target.value)
                e.target.value = ''
              }}
            >
              <option value="" disabled>
                서체
              </option>
              {fonts.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {isSafeForExport(f) ? f : `${f} (이 기기에만)`}
                </option>
              ))}
              {fonts.length === 0 && (
                <option value="" disabled>
                  사용 가능한 글꼴 없음
                </option>
              )}
            </select>
            <select
              title="글자 크기"
              defaultValue=""
              onChange={(e) => {
                applyFontSize(e.target.value)
                e.target.value = ''
              }}
            >
              <option value="" disabled>
                크기
              </option>
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}pt
                </option>
              ))}
            </select>
          </div>
          <div className="group">
            <button title="굵게 (⌘B)" className={fmt.bold ? 'on' : ''} onMouseDown={keepSelection} onClick={() => exec('bold')}>
              <b>가</b>
            </button>
            <button
              title="기울임 (⌘I)"
              className={fmt.italic ? 'on' : ''}
              onMouseDown={keepSelection}
              onClick={() => exec('italic')}
            >
              <i>가</i>
            </button>
            <button
              title="밑줄 (⌘U)"
              className={fmt.underline ? 'on' : ''}
              onMouseDown={keepSelection}
              onClick={() => exec('underline')}
            >
              <u>가</u>
            </button>
            <button
              title="취소선"
              className={fmt.strike ? 'on' : ''}
              onMouseDown={keepSelection}
              onClick={() => exec('strikeThrough')}
            >
              <s>가</s>
            </button>
            <label className="colorwell" title="글자 색">
              <span>A</span>
              <input type="color" onMouseDown={keepSelection} onChange={(e) => exec('foreColor', e.target.value)} />
            </label>
            <label className="colorwell hilite" title="형광펜">
              <span>가</span>
              <input
                type="color"
                defaultValue="#fff59d"
                onMouseDown={keepSelection}
                onChange={(e) => exec('hiliteColor', e.target.value)}
              />
            </label>
          </div>
          <div className="group">
            <button title="왼쪽 정렬" onMouseDown={keepSelection} onClick={() => exec('justifyLeft')}>
              {Icon.alignLeft}
            </button>
            <button title="가운데 정렬" onMouseDown={keepSelection} onClick={() => exec('justifyCenter')}>
              {Icon.alignCenter}
            </button>
            <button title="오른쪽 정렬" onMouseDown={keepSelection} onClick={() => exec('justifyRight')}>
              {Icon.alignRight}
            </button>
            <button title="양쪽 정렬" onMouseDown={keepSelection} onClick={() => exec('justifyFull')}>
              {Icon.alignJustify}
            </button>
          </div>
          <div className="group">
            <button title="글머리 목록" onMouseDown={keepSelection} onClick={() => listOp('ul')}>
              •≡
            </button>
            <button title="번호 목록" onMouseDown={keepSelection} onClick={() => listOp('ol')}>
              1≡
            </button>
            <select
              title="줄간격"
              defaultValue=""
              onChange={(e) => {
                applyLineHeight(e.target.value)
                e.target.value = ''
              }}
            >
              <option value="" disabled>
                줄간격
              </option>
              <option value="1.0">1.0</option>
              <option value="1.15">1.15</option>
              <option value="1.5">1.5</option>
              <option value="2.0">2.0</option>
            </select>
            <button title="이미지 삽입" onMouseDown={keepSelection} onClick={() => imageInputRef.current?.click()}>
              🖼
            </button>
            <button title="페이지 나눔 삽입" onMouseDown={keepSelection} onClick={insertPageBreak}>
              ⤓⤒
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void insertImage(file)
                e.target.value = ''
              }}
            />
          </div>
          <div className="group">
            <button title="표 삽입" onMouseDown={keepSelection} onClick={insertTable}>
              {Icon.table}
            </button>
            <button title="아래에 행 추가" onMouseDown={keepSelection} onClick={() => tableOp('row-add')}>
              행+
            </button>
            <button title="행 삭제" onMouseDown={keepSelection} onClick={() => tableOp('row-del')}>
              행−
            </button>
            <button title="오른쪽에 열 추가" onMouseDown={keepSelection} onClick={() => tableOp('col-add')}>
              열+
            </button>
            <button title="열 삭제" onMouseDown={keepSelection} onClick={() => tableOp('col-del')}>
              열−
            </button>
            <button title="오른쪽 셀과 병합" onMouseDown={keepSelection} onClick={() => tableOp('merge-right')}>
              병합→
            </button>
            <button title="아래 셀과 병합" onMouseDown={keepSelection} onClick={() => tableOp('merge-down')}>
              병합↓
            </button>
            <button title="병합 해제" onMouseDown={keepSelection} onClick={() => tableOp('unmerge')}>
              해제
            </button>
          </div>
          <div className="group">
            <button title="찾기/바꾸기 (⌘F)" className={findOpen ? 'on' : ''} onClick={() => (findOpen ? closeFind() : openFind())}>
              {Icon.search}
            </button>
          </div>
          <div className="fmt-meta">
            {edited && (
              <button className="link" onClick={resetEdits}>
                원본으로 되돌리기
              </button>
            )}
          </div>
        </div>
      )}

      {result && tab === 'preview' && findOpen && (
        <div className="findbar">
          <input
            ref={findInputRef}
            placeholder="찾기"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value)
              runFind(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') stepFind(e.shiftKey ? -1 : 1)
              if (e.key === 'Escape') closeFind()
            }}
          />
          <span className="find-count">{findTotal ? `${findIndex + 1}/${findTotal}` : findQuery ? '0건' : ''}</span>
          <button onClick={() => stepFind(-1)} title="이전 (⇧Enter)">
            ↑
          </button>
          <button onClick={() => stepFind(1)} title="다음 (Enter)">
            ↓
          </button>
          <span className="find-sep" />
          <input
            placeholder="바꾸기"
            value={replaceQuery}
            onChange={(e) => setReplaceQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') replaceOne()
              if (e.key === 'Escape') closeFind()
            }}
          />
          <button onClick={replaceOne} disabled={!findTotal}>
            바꾸기
          </button>
          <button onClick={replaceAll} disabled={!findTotal}>
            모두 바꾸기
          </button>
          <button className="find-close" onClick={closeFind} title="닫기 (Esc)">
            ✕
          </button>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <main
        className={`canvas${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {!result ? (
          <div className="empty" onClick={() => inputRef.current?.click()} role="button" tabIndex={0}>
            <img src="/icons/narro-logo-180.png" alt="" />
            <b>한글 문서를 브라우저에서</b>
            <span>한글·워드·오픈오피스 문서를 끌어다 놓거나 클릭해서 열기 — 열고, 고치고, .hwpx로 저장</span>
            <span className="hint">
              서버 업로드 없음 · 전부 로컬 처리 · <kbd>⌘B</kbd> <kbd>⌘I</kbd> <kbd>⌘U</kbd> <kbd>⌘F</kbd> <kbd>⌘Z</kbd>
            </span>
          </div>
        ) : tab === 'preview' ? (
          <iframe
            key={previewKey}
            ref={previewRef}
            className="page"
            title="문서 편집기"
            srcDoc={result.standalone}
            onLoad={enableEditing}
          />
        ) : (
          <pre className="source">
            <code>{result.standalone}</code>
          </pre>
        )}

        {/* 스크롤 중에만 뜨는 페이지 표시 */}
        {result && tab === 'preview' && counts.pages > 1 && (
          <div className={`page-hint${pageHint ? ' on' : ''}`} aria-hidden="true">
            {page} / {counts.pages}
          </div>
        )}
      </main>

      {result && tab === 'preview' && (
        <footer className="statusbar">
          <span>
            페이지 {page} <em>/ {counts.pages}</em>
          </span>
          <span>
            글자 {counts.chars.toLocaleString()} <em>(공백 제외 {counts.charsNoSpace.toLocaleString()})</em>
          </span>
          <div className="status-right">
            <button className={viewMode === 'single' ? 'on' : ''} title="한 페이지 보기" onClick={showSingle}>
              {Icon.pageSingle}
            </button>
            <button className={viewMode === 'two' ? 'on' : ''} title="두 페이지 나란히" onClick={showTwoUp}>
              {Icon.pageTwo}
            </button>
            <span className="status-sep" />
            <button title="축소 (⌘−)" onClick={() => setZoom((z) => clampZoom(z - 10))}>
              −
            </button>
            <button className="zoom-value" title="100%로 (⌘0)" onClick={() => setZoom(100)}>
              {zoom}%
            </button>
            <button title="확대 (⌘+)" onClick={() => setZoom((z) => clampZoom(z + 10))}>
              +
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}
