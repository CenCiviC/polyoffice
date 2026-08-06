/**
 * IR(HTML) → 중립 문서 트리.
 *
 * 쓰기 백엔드가 늘어나면서 백엔드마다 DOM을 훑는 코드를 복사하게 됐다.
 * DOM 해석은 여기서 한 번만 하고, 백엔드는 이 트리를 각자의 XML로 옮기기만 한다.
 * (hwpx 백엔드는 이 모듈보다 먼저 만들어져 자체 순회를 쓴다 — 계약은 같다.)
 */

export interface IrStyle {
  sizePt: number
  /** #RRGGBB */
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  family: string | null
}

export interface IrRun extends IrStyle {
  /** '\n' = 줄바꿈, '\t' = 탭 */
  text: string
}

export interface IrImage {
  ext: string
  base64: string
  widthPt: number
  heightPt: number
}

export type IrAlign = 'left' | 'center' | 'right' | 'justify'

export interface IrPara {
  align: IrAlign
  runs: IrRun[]
  images: IrImage[]
}

export interface IrCell {
  colSpan: number
  rowSpan: number
  widthPt: number
  heightPt: number
  /** #RRGGBB */
  background: string | null
  blocks: IrBlock[]
}

export interface IrTable {
  rows: IrCell[][]
  /** 열 폭(pt) — 1행 기준, 병합은 펼쳐서 계산 */
  colWidthsPt: number[]
}

export type IrBlock = { kind: 'p'; para: IrPara } | { kind: 'table'; table: IrTable }

export interface IrSection {
  widthPt: number
  heightPt: number
  padLeftPt: number
  padRightPt: number
  padTopPt: number
  padBottomPt: number
  blocks: IrBlock[]
}

export interface IrDoc {
  sections: IrSection[]
}

/**
 * XML 1.0이 허용하지 않는 문자를 걷어낸다 (탭·개행·복귀만 예외).
 *
 * 리더가 제어문자를 하나라도 흘리면 결과 파일이 통째로 안 열린다 — 실제로
 * .hwp의 "묶음 빈칸"(0x1F)이 새어 나와 docx가 열리지 않은 적이 있다.
 * 리더는 리더대로 고치되, 쓰기 쪽도 마지막 방어선을 둔다.
 */
export function xmlSafe(s: string): string {
  // oxlint-disable-next-line no-control-regex -- XML이 금지한 문자를 걸러내는 게 목적
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
}

const DEFAULT_STYLE: IrStyle = {
  sizePt: 10,
  color: '#000000',
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  family: null,
}

function styleProp(el: Element | null, prop: string): string | null {
  const style = el?.getAttribute('style') ?? ''
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))
  return m ? m[1].trim() : null
}

/** `rgb(r, g, b)` · `#rgb` · `#rrggbb` → `#RRGGBB` */
export function toHex(value: string | null): string | null {
  if (!value) return null
  const rgb = value.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgb) {
    return (
      '#' + [rgb[1], rgb[2], rgb[3]].map((v) => Number(v).toString(16).padStart(2, '0').toUpperCase()).join('')
    )
  }
  const hex = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return ('#' + hex.slice(1).split('').map((c) => c + c).join('')).toUpperCase()
  }
  return null
}

/** CSS 길이 → pt (기본 단위는 pt) */
export function toPt(value: string | null): number | null {
  if (!value) return null
  const m = value.match(/(-?[\d.]+)\s*(pt|in|mm|cm|px)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  switch (m[2]) {
    case 'in':
      return n * 72
    case 'mm':
      return n * 72 / 25.4
    case 'cm':
      return n * 72 / 2.54
    case 'px':
      return n * 0.75
    default:
      return n
  }
}

function readStyle(el: Element | null, inherited: IrStyle): IrStyle {
  if (!el) return inherited
  const deco = styleProp(el, 'text-decoration') ?? ''
  const weight = styleProp(el, 'font-weight')
  const tag = el.tagName
  return {
    sizePt: toPt(styleProp(el, 'font-size')) ?? inherited.sizePt,
    color: toHex(styleProp(el, 'color')) ?? inherited.color,
    bold: tag === 'B' || tag === 'STRONG' || weight === 'bold' || Number(weight) >= 600 || inherited.bold,
    italic: tag === 'I' || tag === 'EM' || styleProp(el, 'font-style') === 'italic' || inherited.italic,
    underline: tag === 'U' || deco.includes('underline') || inherited.underline,
    strike: tag === 'S' || deco.includes('line-through') || inherited.strike,
    family: styleProp(el, 'font-family')?.replace(/['"]/g, '') ?? inherited.family,
  }
}

function alignOf(el: Element): IrAlign {
  const a = styleProp(el, 'text-align')
  return a === 'center' || a === 'right' || a === 'justify' ? a : 'left'
}

/** data URI → (확장자, base64) */
function readImage(img: Element): IrImage | null {
  const src = img.getAttribute('src') ?? ''
  const m = src.match(/^data:image\/([a-z0-9+.-]+);base64,(.+)$/i)
  if (!m) return null
  const subtype = m[1].toLowerCase()
  const ext = subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype
  return {
    ext,
    base64: m[2],
    widthPt: toPt(styleProp(img, 'width')) ?? 0,
    heightPt: toPt(styleProp(img, 'height')) ?? 0,
  }
}

function readPara(p: Element): IrPara {
  const para: IrPara = { align: alignOf(p), runs: [], images: [] }
  const base = readStyle(p, DEFAULT_STYLE)

  const push = (text: string, style: IrStyle) => {
    if (!text) return
    const last = para.runs[para.runs.length - 1]
    if (last && sameStyle(last, style)) last.text += text
    else para.runs.push({ ...style, text })
  }

  const walk = (node: Node, style: IrStyle) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        push(child.textContent ?? '', style)
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      switch (el.tagName) {
        case 'BR':
          push('\n', style)
          break
        case 'IMG': {
          const img = readImage(el)
          if (img) para.images.push(img)
          break
        }
        default:
          walk(el, readStyle(el, style))
      }
    }
  }
  walk(p, base)
  return para
}

function sameStyle(a: IrStyle, b: IrStyle): boolean {
  return (
    a.sizePt === b.sizePt &&
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.family === b.family
  )
}

function readTable(table: Element): IrTable {
  const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table)
  const rows: IrCell[][] = []
  for (const tr of trs) {
    const cells: IrCell[] = []
    for (const td of Array.from(tr.children)) {
      if (td.tagName !== 'TD' && td.tagName !== 'TH') continue
      cells.push({
        colSpan: Number(td.getAttribute('colspan') ?? 1) || 1,
        rowSpan: Number(td.getAttribute('rowspan') ?? 1) || 1,
        widthPt: toPt(styleProp(td, 'width')) ?? 0,
        heightPt: toPt(styleProp(td, 'height')) ?? 0,
        background: toHex(styleProp(td, 'background') ?? styleProp(td, 'background-color')),
        blocks: readBlocks(td),
      })
    }
    rows.push(cells)
  }

  // 열 폭: 병합을 펼쳐 열마다 하나씩 채운다 (첫 등장 값 우선)
  const colWidthsPt: number[] = []
  const occupied = new Set<string>()
  rows.forEach((row, r) => {
    let c = 0
    for (const cell of row) {
      while (occupied.has(`${r},${c}`)) c++
      for (let rr = r; rr < r + cell.rowSpan; rr++) {
        for (let cc = c; cc < c + cell.colSpan; cc++) occupied.add(`${rr},${cc}`)
      }
      const per = cell.widthPt / cell.colSpan
      for (let k = 0; k < cell.colSpan; k++) {
        if (colWidthsPt[c + k] === undefined || colWidthsPt[c + k] === 0) colWidthsPt[c + k] = per
      }
      c += cell.colSpan
    }
  })
  return { rows, colWidthsPt: colWidthsPt.map((w) => w || 60) }
}

function readBlocks(container: Element): IrBlock[] {
  const out: IrBlock[] = []
  for (const child of Array.from(container.children)) {
    if (child.tagName === 'P' || /^H[1-6]$/.test(child.tagName) || child.tagName === 'LI') {
      out.push({ kind: 'p', para: readPara(child) })
    } else if (child.tagName === 'TABLE') {
      out.push({ kind: 'table', table: readTable(child) })
    } else if (child.tagName === 'UL' || child.tagName === 'OL' || child.tagName === 'DIV') {
      out.push(...readBlocks(child))
    }
  }
  return out
}

/** IR HTML의 body(또는 doc-section들을 담은 요소) → 중립 문서 트리 */
export function readIr(root: Element): IrDoc {
  const sections = Array.from(root.querySelectorAll('doc-section'))
  const targets = sections.length ? sections : [root]
  return {
    sections: targets.map((sec) => {
      // doc-section의 style에서 페이지 크기·여백을 되읽는다 (없으면 A4 세로)
      const pad = (styleProp(sec, 'padding') ?? '').split(/\s+/)
      const padPt = (i: number, fallback: number) => toPt(pad[i] ?? null) ?? fallback
      return {
        widthPt: toPt(styleProp(sec, 'width')) ?? 595,
        heightPt: toPt(styleProp(sec, 'min-height') ?? styleProp(sec, 'height')) ?? 842,
        padTopPt: padPt(0, 72),
        padRightPt: padPt(1, 72),
        padBottomPt: padPt(2, padPt(0, 72)),
        padLeftPt: padPt(3, padPt(1, 72)),
        blocks: readBlocks(sec),
      }
    }),
  }
}
