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
  /** 위/아래첨자 — `<sup>`/`<sub>` */
  vertAlign: 'super' | 'sub' | null
  /**
   * 하이퍼링크 대상. 스타일이 아니라 관계지만 여기 두는 이유:
   * `<a>` 안의 `<span>`처럼 중첩됐을 때 **상속과 런 병합이 다른 서식과 똑같이 동작해야** 한다.
   * 따로 두면 링크 경계마다 런을 쪼개는 코드를 백엔드 세 곳이 각자 갖게 된다.
   */
  link: string | null
}

export interface IrRun extends IrStyle {
  /** '\n' = 줄바꿈, '\t' = 탭 */
  text: string
  /**
   * 각주 참조면 가리키는 `doc-footnote`의 id. 글자가 없는 런이다 —
   * **번호는 여기 없다.** 화면은 뷰어 CSS counter가, 파일은 각 포맷의 각주 기능이 센다.
   */
  footnote?: string
  /** 쪽번호 등 계산 필드면 그 종류. 글자가 없는 런이다 */
  field?: IrFieldKind
}

export interface IrImage {
  ext: string
  base64: string
  widthPt: number
  heightPt: number
}

export type IrAlign = 'left' | 'center' | 'right' | 'justify'

/**
 * 목록 표시 방식. 뷰어가 브라우저 기본 마커로 그리므로 종류도 그것만 있으면 된다
 * — `ul` → 글머리표, `ol` → 십진수.
 */
export type IrListMarker = 'bullet' | 'decimal'

/** 개요 번호 한 수준의 서식 — `prefix + 번호 + suffix` */
export interface OutlineLevel {
  style: 'decimal' | 'hangul'
  prefix: string
  suffix: string
}

/**
 * 개요 번호 스킴 — 한글 공문서 관행 `1. → 가. → 1) → 가) → (1) → (가)`.
 *
 * **진실원은 여기 하나다.** 뷰어 CSS counter도, 백엔드 셋의 numbering 정의도 이 배열에서 나온다
 * — 갈라지면 화면에 보이는 번호와 저장된 번호가 달라진다(제목 여백·링크 색과 같은 원리).
 * 번호 자체는 IR에 저장하지 않는다(IR-SPEC 규칙 2: 진실원은 스킴 참조, 렌더는 파생).
 */
export const OUTLINE_SCHEME: OutlineLevel[] = [
  { style: 'decimal', prefix: '', suffix: '.' },
  { style: 'hangul', prefix: '', suffix: '.' },
  { style: 'decimal', prefix: '', suffix: ')' },
  { style: 'hangul', prefix: '', suffix: ')' },
  { style: 'decimal', prefix: '(', suffix: ')' },
  { style: 'hangul', prefix: '(', suffix: ')' },
]

/** 가·나·다… — 뷰어 `@counter-style`이 쓰는 기호 집합 (system: alphabetic) */
export const HANGUL_ORDINALS = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하']

/**
 * `doc-field`에 쓸 수 있는 종류. 쪽번호는 **글자가 아니라 렌더 시점에 계산되는 값**이라
 * IR에는 종류만 담는다(규칙 2). 화면은 조판이, 파일은 각 포맷의 필드가 센다.
 */
export const FIELD_KINDS = ['page', 'pages'] as const
export type IrFieldKind = (typeof FIELD_KINDS)[number]

/**
 * 페이지 가장자리에서 머리말·꼬리말까지의 거리(pt).
 * 뷰어의 배치와 docx `w:pgMar`의 header/footer가 **같은 값**이어야 화면과 저장물이 맞는다.
 */
export const HF_INSET_PT = 36

/** `data-num`에 쓸 수 있는 값 — 지금은 기본 개요 스킴 하나뿐 */
export const OUTLINE_SCHEMES = ['outline'] as const

/** 문단이 어느 목록의 몇 번째 수준인가 */
export interface IrListRef {
  /** 목록 인스턴스 id. 같은 id끼리 번호가 이어지고, 다른 id면 1부터 다시 센다 */
  id: number
  /** 중첩 수준 — 0부터 */
  level: number
}

/** 문서 전역 목록 정의 — 세 포맷 모두 본문 밖에 이 테이블을 요구한다 */
export interface IrListDef {
  id: number
  /** 수준별 표시. 배열 길이 = 그 목록이 실제로 쓴 최대 수준 + 1 */
  levels: IrListMarker[]
}

export interface IrPara {
  align: IrAlign
  runs: IrRun[]
  images: IrImage[]
  /** 문단 왼쪽 들여쓰기(pt) */
  indentPt: number
  /** 첫 줄 들여쓰기(pt) — **음수면 내어쓰기** */
  firstLinePt: number
  /** 문단 앞 여백(pt) */
  spaceBeforePt: number
  /** 문단 뒤 여백(pt) */
  spaceAfterPt: number
  /** h1~h6이면 1~6, 아니면 0. 뷰어 CSS의 제목 여백·줄간격을 백엔드가 그대로 재현하는 데 쓴다 */
  heading: number
  /** 목록 항목(`li`)이면 소속 목록과 수준, 아니면 null */
  list: IrListRef | null
  /** 개요 번호에 참여하는 제목이면 그 수준(1~6), 아니면 null */
  outline: number | null
}

/**
 * 목록 한 수준의 들여쓰기(pt) — 뷰어 BASE_CSS의 `.hwp-page ul, ol { padding-left: 24pt }`와
 * **같은 값이어야 한다**. 번호·글머리표는 이 칸 안에 내어쓰기로 놓인다.
 * 제목 여백(HEADING_SPACE)·링크 색(LINK_COLOR)과 같은 원리 — 화면과 저장물의 진실원은 하나다.
 */
export const LIST_INDENT_PT = 24

/**
 * 수준별 글머리표 — 브라우저 기본(disc → circle → square)과 같게.
 * 더 깊은 수준은 브라우저처럼 마지막 것을 반복한다.
 */
export const BULLET_CHARS = ['\u2022', '\u25E6', '\u25AA']

/** 수준에 해당하는 글머리표 문자 */
export function bulletChar(level: number): string {
  return BULLET_CHARS[Math.min(level, BULLET_CHARS.length - 1)]
}

/**
 * 텍스트 노드가 **화면에 실제로 보이는** 글자.
 *
 * 소스를 예쁘게 쓴 IR은 `<li>` 안이나 중첩 목록 앞뒤에 개행+들여쓰기를 남긴다.
 * 브라우저는 그걸 안 보여주는데 그대로 옮기면 저장물에만 없던 줄바꿈·공백이 생겨
 * 화면과 파일이 어긋난다. 두 가지만 손본다 —
 *
 * 1. **개행과 그 둘레의 들여쓰기**를 공백 하나로 줄인다. HTML 소스의 개행은 어떤 경우에도
 *    줄바꿈이 아니다(줄바꿈은 `<br>`이다). 탭과 연속 공백은 그대로 둔다 — 리더가 탭 컨트롤을
 *    `\t`로 실어 오기 때문에 여기서 뭉개면 왕복에서 사라진다.
 * 2. 문단의 **처음·끝**이거나 블록 자식(`ul`·`ol`·`table`)과 맞닿은 쪽의 공백은 버린다.
 *    브라우저가 안 보여주는 자리다.
 *
 * 결과가 빈 문자열이면 그 텍스트는 없는 것이다.
 */
export function displayText(node: Node): string {
  let text = (node.textContent ?? '').replace(/[ \t]*\r?\n[ \t]*/g, ' ')
  const isEdge = (n: Node | null) =>
    n === null || (n.nodeType === 1 && (n as Element).tagName in { UL: 1, OL: 1, TABLE: 1 })
  if (isEdge(node.previousSibling)) text = text.replace(/^ +/, '')
  if (isEdge(node.nextSibling)) text = text.replace(/ +$/, '')
  return text
}

/** 뷰어 BASE_CSS의 제목 규칙 — margin: 4pt 0 2pt · line-height: 1.4 */
export const HEADING_SPACE = { beforePt: 4, afterPt: 2, lineHeight: 1.4 }

/**
 * 금칙처리 강도 — 닫는 괄호·마침표를 줄 첫머리에 두지 않는 등의 규칙.
 * 'strict'가 한글 조판 관행에 가깝다. 엔진마다 적용 문자 집합이 달라서 켜고 끄는 것과
 * 강도까지만 맞출 수 있고, 어떤 문자를 금칙으로 볼지는 docx(settings.xml)에서만 지정 가능하다.
 * hwpx는 OWPML에 노출된 스위치가 없어 한글 엔진 기본값을 따른다.
 */
export const LINE_BREAK: 'normal' | 'strict' = 'strict'

/**
 * 글꼴이 지정되지 않은 런의 기본 글꼴.
 * 지정한 글꼴이 그 기기에 없으면 뷰어와 워드프로세서가 **서로 다른 글꼴로 대체**해서
 * 글자 폭이 달라지고 첫 줄부터 줄바꿈 위치가 어긋난다. 두 곳 모두에 실재하는 글꼴을 쓸 것.
 */
export const DOC_FONT = 'Noto Sans KR'

/**
 * 하이퍼링크 글자색 — 뷰어 BASE_CSS의 `a[href]` 규칙과 **같은 값이어야 한다**.
 * 링크는 IR에 색을 들고 있지 않고(관계만 있다) 화면에서는 뷰어 CSS가 칠하므로,
 * 백엔드도 같은 값으로 칠해야 화면과 저장물이 같아진다. 제목 여백과 같은 원리.
 */
export const LINK_COLOR = '#1A4FD6'

/** 테두리 한 변 — `border` 축약 속성이 싣는 값 */
export interface IrBorder {
  widthPt: number
  style: 'solid' | 'dashed' | 'dotted' | 'double'
  /** #RRGGBB */
  color: string
}

export type IrVAlign = 'top' | 'middle' | 'bottom'

/**
 * 표 셀 기본 테두리·세로 정렬 — 뷰어 BASE_CSS의 `table.hwp-table td`와 **같은 값**이어야 한다.
 * 0.75pt ≈ 1px. IR에 `border`·`vertical-align`이 없으면 이 값이 쓰이고, 뷰어 CSS도
 * 여기서 생성된다(제목 여백·링크 색·개요 스킴과 같은 원리).
 */
export const CELL_BORDER: IrBorder = { widthPt: 0.75, style: 'solid', color: '#555555' }
export const CELL_VALIGN: IrVAlign = 'middle'

/**
 * `border` 축약 속성 파싱 — `<width> <style> <color>` (순서 무관, 빠진 값은 기본값).
 * `none`/`0`이면 null(테두리 없음). 속성 자체가 없으면 호출한 쪽이 `CELL_BORDER`를 쓴다.
 */
export function parseBorder(value: string): IrBorder | null {
  const v = value.trim().toLowerCase()
  if (!v || v === 'none' || v === '0' || v.includes('hidden')) return null
  const style = (['solid', 'dashed', 'dotted', 'double'] as const).find((k) => v.includes(k))
  const color = toHex(/(#[0-9a-f]{3,8}|rgb\([^)]*\))/i.exec(value)?.[1] ?? null)
  // 색을 먼저 걷어내고 굵기를 찾는다 — 안 그러면 `#c2352b`의 숫자를 굵기로 읽는다
  const width = /(-?[\d.]+)\s*(pt|px|in|mm)?/.exec(v.replace(/#[0-9a-f]{3,8}|rgb\([^)]*\)/gi, ' '))
  const widthPt = width ? (toPt(`${width[1]}${width[2] ?? 'pt'}`) ?? CELL_BORDER.widthPt) : CELL_BORDER.widthPt
  if (widthPt <= 0) return null
  return { widthPt, style: style ?? CELL_BORDER.style, color: color ?? CELL_BORDER.color }
}

export interface IrCell {
  colSpan: number
  rowSpan: number
  widthPt: number
  heightPt: number
  /** 셀 안쪽 여백(pt) — [상, 우, 하, 좌] */
  paddingPt: [number, number, number, number]
  /** #RRGGBB */
  background: string | null
  /** 셀 테두리 (null = 없음). IR에 없으면 CELL_BORDER */
  border: IrBorder | null
  vAlign: IrVAlign
  blocks: IrBlock[]
}

export interface IrTable {
  rows: IrCell[][]
  /** 열 폭(pt) — 1행 기준, 병합은 펼쳐서 계산 */
  colWidthsPt: number[]
}

export type IrBlock = { kind: 'p'; para: IrPara } | { kind: 'table'; table: IrTable }

export interface IrSection {
  /** 머리말 블록 (없으면 null) — 본문 흐름 밖이고 페이지마다 그려진다 */
  header: IrBlock[] | null
  footer: IrBlock[] | null
  widthPt: number
  heightPt: number
  padLeftPt: number
  padRightPt: number
  padTopPt: number
  padBottomPt: number
  blocks: IrBlock[]
}

/** 각주 하나 — 내용은 블록들이다 (문단·표를 담을 수 있다) */
export interface IrFootnote {
  id: string
  blocks: IrBlock[]
}

export interface IrDoc {
  sections: IrSection[]
  /** `doc-footnote` 블록들. 본문 흐름에서 빠지고 참조 지점에서 불린다 */
  footnotes: IrFootnote[]
  /** 문서 안의 모든 목록 인스턴스. 백엔드는 이걸로 numbering 정의 테이블을 만든다 */
  lists: IrListDef[]
  /**
   * 개요 번호를 쓰는 제목이 하나라도 있으면 그 정의에 붙일 id.
   * 목록과 **같은 번호 공간**에서 뽑는다 — docx numId·hwpx numbering id가 겹치면 안 된다.
   */
  outlineId: number | null
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

/**
 * 문단 기본 줄간격 — 뷰어 BASE_CSS의 line-height와 같은 값.
 * 이걸 안 정하면 백엔드가 각자 기본값(hwpx 템플릿 180%, ODF 100%, Word 1.08+뒤여백 8pt)을
 * 써서 같은 IR인데 포맷마다 페이지 수가 달라진다. 기본값의 진실원은 여기 하나다.
 */
export const DEFAULT_LINE_HEIGHT = 1.6

const DEFAULT_STYLE: IrStyle = {
  sizePt: 10,
  color: '#000000',
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  family: null,
  vertAlign: null,
  link: null,
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

/**
 * CSS padding 단축 표기 → [상, 우, 하, 좌] (pt).
 * 백엔드마다 셀 여백 기본값이 달라서(hwpx 5.1pt / odt 3.6pt / Word 0.08in) 여기서 한 번에 읽어
 * 셋 다 IR 값을 그대로 쓰게 한다. 없으면 0 — 계약에 안 적힌 여백은 넣지 않는다.
 */
export function readPadding(el: Element | null): [number, number, number, number] {
  const parts = (styleProp(el, 'padding') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((v) => toPt(v) ?? 0)
  const [top = 0, right = top, bottom = top, left = right] = parts
  return [top, right, bottom, left]
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
    vertAlign: tag === 'SUP' ? 'super' : tag === 'SUB' ? 'sub' : inherited.vertAlign,
    // 각주 참조(`data-fn-ref`)는 링크가 아니다 — href가 있는 것만 링크로 본다
    link: (tag === 'A' && el.getAttribute('href')) || inherited.link,
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

/**
 * 문단 하나를 읽는다.
 *
 * `only`를 주면 `p`의 자식 전부가 아니라 그 노드들만 읽는다 — 표 셀처럼 `<p>` 없이
 * 인라인 내용을 바로 담은 컨테이너에서 **암묵 문단**을 만들 때 쓴다. 정렬·여백은 여전히
 * 컨테이너에서 읽는다(브라우저가 익명 블록 박스에 적용하는 것과 같다).
 */
function readPara(p: Element, list: IrListRef | null = null, only?: Node[]): IrPara {
  const h = /^H([1-6])$/.exec(p.tagName)
  const heading = h ? Number(h[1]) : 0
  const para: IrPara = {
    align: alignOf(p),
    runs: [],
    images: [],
    heading,
    list,
    // 번호를 매길지는 IR이 정하고(스킴 참조), 몇 번인지는 렌더가 센다
    outline: heading && p.getAttribute('data-num') ? heading : null,
    indentPt: toPt(styleProp(p, 'margin-left')) ?? 0,
    firstLinePt: toPt(styleProp(p, 'text-indent')) ?? 0,
    // 제목 여백의 진실원은 IR이다. IR에 안 적혀 있을 때만 뷰어 CSS와 같은 기본값으로 채운다
    // — 그래야 백엔드 셋이 각자의 기본값(hwpx 180% / ODF 0 / Word 8pt)으로 갈라지지 않는다.
    spaceBeforePt: toPt(styleProp(p, 'margin-top')) ?? (heading ? HEADING_SPACE.beforePt : 0),
    spaceAfterPt: toPt(styleProp(p, 'margin-bottom')) ?? (heading ? HEADING_SPACE.afterPt : 0),
  }
  const base = readStyle(p, DEFAULT_STYLE)

  const push = (text: string, style: IrStyle) => {
    if (!text) return
    const last = para.runs[para.runs.length - 1]
    if (last && sameStyle(last, style)) last.text += text
    else para.runs.push({ ...style, text })
  }

  const walkNodes = (nodes: Node[], style: IrStyle) => {
    for (const child of nodes) {
      if (child.nodeType === 3) {
        push(displayText(child), style)
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      switch (el.tagName) {
        case 'BR':
          push('\n', style)
          break
        case 'DOC-FIELD': {
          const kind = el.getAttribute('data-kind')
          if (kind && (FIELD_KINDS as readonly string[]).includes(kind))
            para.runs.push({ ...style, text: '', field: kind as IrFieldKind })
          break
        }
        case 'A': {
          // 각주 참조는 링크가 아니라 표식이다 — 글자 없는 런 하나로 남긴다.
          // (`push`는 빈 글자를 버리므로 병합을 거치지 않고 직접 넣는다)
          const fn = el.getAttribute('data-fn-ref')
          if (fn) para.runs.push({ ...style, text: '', footnote: fn })
          else walkNodes(Array.from(el.childNodes), readStyle(el, style))
          break
        }
        case 'IMG': {
          const img = readImage(el)
          if (img) para.images.push(img)
          break
        }
        // 블록 자식은 문단의 글이 아니다 — readBlocks가 형제 블록으로 따로 꺼낸다.
        // (안 걸러내면 `<li>겉<ul><li>속</li></ul></li>`가 "겉속" 한 문단이 된다)
        case 'UL':
        case 'OL':
        case 'TABLE':
          break
        default:
          walkNodes(Array.from(el.childNodes), readStyle(el, style))
      }
    }
  }
  walkNodes(only ?? Array.from(p.childNodes), base)
  return para
}

function sameStyle(a: IrRun, b: IrStyle): boolean {
  return (
    a.sizePt === b.sizePt &&
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.family === b.family &&
    a.vertAlign === b.vertAlign &&
    a.link === b.link &&
    // 각주 참조·쪽번호 런에는 절대 글자를 붙이지 않는다 — 뒤따르는 글자가 필드 안으로 빨려 든다
    a.footnote === undefined &&
    a.field === undefined
  )
}

function readCellBorder(td: Element): IrBorder | null {
  const raw = styleProp(td, 'border')
  return raw === null ? CELL_BORDER : parseBorder(raw)
}

function readVAlign(td: Element): IrVAlign {
  const v = styleProp(td, 'vertical-align')
  return v === 'top' || v === 'bottom' || v === 'middle' ? v : CELL_VALIGN
}

function readTable(table: Element, ctx: ReadCtx): IrTable {
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
        paddingPt: readPadding(td),
        background: toHex(styleProp(td, 'background') ?? styleProp(td, 'background-color')),
        border: readCellBorder(td),
        vAlign: readVAlign(td),
        blocks: readBlocks(td, ctx),
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

/** 문서를 훑는 동안 이어지는 상태 — 지금은 목록 인스턴스 번호뿐 */
interface ReadCtx {
  lists: IrListDef[]
  nextListId: number
  footnotes: IrFootnote[]
}

/**
 * `ul`/`ol` 한 그루를 평평한 문단들로 편다. 중첩은 사라지지 않고 `list.level`로 남는다
 * — docx·hwpx는 어차피 평평한 문단에 수준을 매기고, odt만 이걸 다시 접는다(html2odt).
 *
 * 바깥쪽 `ul` 아래 `ol`이 오는 식으로 수준마다 종류가 다를 수 있어서 표시는 수준별로 기록한다.
 */
function readList(el: Element, def: IrListDef, level: number, ctx: ReadCtx, out: IrBlock[]): void {
  const marker: IrListMarker = el.tagName === 'OL' ? 'decimal' : 'bullet'
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') continue
    // 항목이 하나라도 있을 때만 수준을 등록한다 (빈 `<ul>`이 정의를 만들지 않게)
    if (def.levels[level] === undefined) def.levels[level] = marker
    out.push({ kind: 'p', para: readPara(li, { id: def.id, level }) })
    for (const child of Array.from(li.children)) {
      if (child.tagName === 'UL' || child.tagName === 'OL') readList(child, def, level + 1, ctx, out)
      else if (child.tagName === 'TABLE') out.push({ kind: 'table', table: readTable(child, ctx) })
    }
  }
}

/** 블록으로 다뤄야 하는 태그 — 나머지는 인라인이라 암묵 문단으로 묶인다 */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TABLE', 'UL', 'OL', 'DIV',
  'DOC-FOOTNOTE', 'DOC-PAGEBREAK', 'DOC-HEADER', 'DOC-FOOTER',
])

/** 그 노드가 문단에 담길 만한 내용을 갖고 있나 (공백만이면 아니다) */
function hasContent(nodes: Node[]): boolean {
  return nodes.some(
    (n) =>
      (n.textContent ?? '').trim() !== '' ||
      (n.nodeType === 1 && ((n as Element).tagName === 'IMG' || (n as Element).tagName === 'BR')),
  )
}

function readBlocks(container: Element, ctx: ReadCtx): IrBlock[] {
  const out: IrBlock[] = []
  // 표 셀처럼 `<p>` 없이 글자를 바로 담은 컨테이너 — 브라우저는 익명 블록으로 그리는데
  // 예전에는 백엔드 셋이 전부 **통째로 버렸다**. 인라인 내용을 모아 암묵 문단으로 만든다.
  let inline: Node[] = []
  const flush = () => {
    if (hasContent(inline)) out.push({ kind: 'p', para: readPara(container, null, inline) })
    inline = []
  }

  for (const child of Array.from(container.childNodes)) {
    const tag = child.nodeType === 1 ? (child as Element).tagName : null
    if (tag === null || !BLOCK_TAGS.has(tag)) {
      inline.push(child)
      continue
    }
    flush()
    const el = child as Element
    if (tag === 'P' || /^H[1-6]$/.test(tag) || tag === 'LI') {
      out.push({ kind: 'p', para: readPara(el) })
    } else if (tag === 'TABLE') {
      out.push({ kind: 'table', table: readTable(el, ctx) })
    } else if (tag === 'UL' || tag === 'OL') {
      // 최상위 목록 하나 = 인스턴스 하나. 중첩된 것들은 같은 인스턴스를 수준으로 공유한다
      const def: IrListDef = { id: ctx.nextListId++, levels: [] }
      readList(el, def, 0, ctx, out)
      if (def.levels.length) ctx.lists.push(def)
      else ctx.nextListId--
    } else if (tag === 'DIV') {
      out.push(...readBlocks(el, ctx))
    } else if (tag === 'DOC-FOOTNOTE') {
      // 본문 흐름에서 빠진다 — 참조 지점에서 불린다
      const id = el.getAttribute('id')
      if (id) ctx.footnotes.push({ id, blocks: readBlocks(el, ctx) })
    }
  }
  flush()
  return out
}

/** 구역의 머리말/꼬리말 — 조판이 페이지마다 복제한 사본(`data-pg`)은 세지 않는다 */
function hfBlocks(sec: Element, tag: 'doc-header' | 'doc-footer', ctx: ReadCtx): IrBlock[] | null {
  const el = Array.from(sec.children).find((c) => c.tagName === tag.toUpperCase() && !c.hasAttribute('data-pg'))
  return el ? readBlocks(el, ctx) : null
}

/** IR HTML의 body(또는 doc-section들을 담은 요소) → 중립 문서 트리 */
export function readIr(root: Element): IrDoc {
  const sections = Array.from(root.querySelectorAll('doc-section'))
  const targets = sections.length ? sections : [root]
  const ctx: ReadCtx = { lists: [], nextListId: 1, footnotes: [] }
  // 구역을 먼저 다 훑어야 ctx.lists가 채워진다 — 목록 정의는 문서 전역이라 순서가 중요하다
  const sectionsOut = targets.map((sec) => {
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
      // 머리말·꼬리말은 본문 흐름 밖이다 — 구역에 하나씩만 본다
      header: hfBlocks(sec, 'doc-header', ctx),
      footer: hfBlocks(sec, 'doc-footer', ctx),
      blocks: readBlocks(sec, ctx),
    }
  })
  // 개요 번호 정의는 문서에 하나. 쓰는 제목이 있을 때만 자리를 잡는다
  const hasOutline = (blocks: IrBlock[]): boolean =>
    blocks.some((b) =>
      b.kind === 'p'
        ? b.para.outline !== null
        : b.table.rows.some((row) => row.some((c) => hasOutline(c.blocks))),
    )
  const usesOutline = sectionsOut.some((sec) => hasOutline(sec.blocks))
  return {
    sections: sectionsOut,
    lists: ctx.lists,
    footnotes: ctx.footnotes,
    outlineId: usesOutline ? ctx.nextListId++ : null,
  }
}
