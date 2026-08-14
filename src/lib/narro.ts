/**
 * 문서 모델 → IR HTML 방출기.
 * 파서(Rust WASM 또는 hwp.js)가 만든 DocModel(model.ts 계약)을 받아
 * docs/IR-SPEC.md 어휘의 HTML을 생성한다.
 */
import { IR_VERSION, isSafeHref } from './ir'
import { CELL_BORDER, CELL_VALIGN, HANGUL_ORDINALS, HF_INSET_PT, OUTLINE_SCHEME } from './ir-model'
import { ATTR, HEAD } from './model'
import type { DocModel, ParagraphModel, TableModel } from './model'
import { parseHwpJs } from './parser-js'

export interface ConvertStats {
  version: string
  sections: number
  paragraphs: number
  tables: number
  chars: number
  images: number
  parser: 'wasm' | 'js'
}

export interface ConvertResult {
  /** 페이지 doc-section들만 (앱 미리보기용 body 콘텐츠) */
  body: string
  /** 다운로드용 완전한 standalone HTML 문서 */
  standalone: string
  stats: ConvertStats
}

const TEXT_ALIGN: Record<number, string> = { 0: 'justify', 1: 'left', 2: 'right', 3: 'center' }

const BASE_CSS = `
  /* 본문 글꼴은 제품이 직접 들고 다닌다 — CDN에 기대면 오프라인·사내망에서 대체되고,
     내보낸 docx·hwpx에는 어차피 이름만 들어가므로 화면과 문서가 어긋난다.
     같은 파일을 내보내기 때 서브셋해 문서에 심는다(font-embed.ts). */
  @font-face { font-family: 'Noto Sans KR'; font-weight: 400; font-display: swap;
    src: url('/fonts/NotoSansKR-Regular.woff2') format('woff2'); }
  @font-face { font-family: 'Noto Sans KR'; font-weight: 700; font-display: swap;
    src: url('/fonts/NotoSansKR-Bold.woff2') format('woff2'); }
  body { margin: 0; background: #e8eaed; font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; }
  doc-section.hwp-page { display: block; box-sizing: border-box; background: #fff; margin: 20px auto; box-shadow: 0 1px 3px 1px rgba(60,64,67,.15); overflow: hidden; }
  /* 줄바꿈 단위: 한글도 어절(띄어쓰기) 단위로 끊는다.
     word-break:normal이면 브라우저가 한글을 CJK로 보고 음절 아무 데서나 끊어서,
     같은 문단이 Word(어절 단위)와 다른 줄 수로 조판된다 — keep-all이 그 둘을 맞춘다.
     끊을 곳이 없어 넘칠 때만 overflow-wrap이 강제로 자른다. */
  /* 기본 글자 크기는 IR 계약의 기본값(10pt)과 같게 못박는다 — 안 그러면 브라우저 기본 16px가
     빈 문단 높이가 되어 쓰기 백엔드(1.6×10pt=16pt)와 어긋난다. */
  .hwp-page { font-size: 10pt; }
  .hwp-page p { margin: 0; min-height: 1em; white-space: pre-wrap; word-break: keep-all; line-break: strict; overflow-wrap: break-word; font-kerning: none; line-height: 1.6; }
  /* 빈 문단은 한 줄 높이를 차지한다 (백엔드의 빈 문단과 같은 16pt) */
  .hwp-page p:empty { min-height: 1.6em; }
  /* 클래스에 기대지 않는다 — hwp-table은 리더와 편집기가 붙이는 것이라
     손으로(또는 LLM이) 쓴 IR의 표에는 없다. 그러면 화면에만 테두리가 없어서
     저장물과 어긋난다(백엔드는 IR에 값이 없으면 CELL_BORDER를 쓴다). */
  .hwp-page table { border-collapse: collapse; margin: 2pt 0; }
  /* 셀 기본 테두리·세로 정렬 — 백엔드 셋이 IR에 값이 없을 때 쓰는 것과 같은 상수에서 나온다 */
  .hwp-page table td { border: ${CELL_BORDER.widthPt}pt ${CELL_BORDER.style} ${CELL_BORDER.color}; vertical-align: ${CELL_VALIGN}; }
  .hwp-page img { max-width: 100%; }
  .hwp-page h1, .hwp-page h2, .hwp-page h3, .hwp-page h4, .hwp-page h5, .hwp-page h6 { margin: 4pt 0 2pt; line-height: 1.4; }
  .hwp-page h1 { font-size: 16pt; } .hwp-page h2 { font-size: 14pt; } .hwp-page h3 { font-size: 13pt; }
  .hwp-page h4, .hwp-page h5, .hwp-page h6 { font-size: 12pt; }
  .hwp-page ul, .hwp-page ol { margin: 2pt 0; padding-left: 24pt; }
  .hwp-page li { min-height: 1em; line-height: 1.6; }
  /* 머리말·꼬리말 — 본문 흐름 밖이라 여백 띠에 절대배치한다. 좌우는 inherit으로 구역의
     안쪽 여백을 그대로 물려받아야 본문과 세로선이 맞는다(구역마다 여백이 다르다).
     가장자리까지의 거리는 백엔드(docx w:pgMar header/footer)와 같은 상수를 쓴다. */
  doc-header, doc-footer { display: block; position: absolute; left: 0; right: 0;
    padding-left: inherit; padding-right: inherit; box-sizing: border-box;
    font-size: 9pt; color: #5b6270; }
  doc-header { top: ${HF_INSET_PT}pt; }
  doc-footer { bottom: ${HF_INSET_PT}pt; }
  doc-header p, doc-footer p { margin: 0; }
  /* 쪽번호도 파생물이다 — 문서에는 종류만 있고 숫자는 여기서 센다.
     전체 쪽수는 counter로 못 세서 조판(paginate)이 --pages에 채워 준다. */
  body { counter-reset: pageno; }
  doc-section { counter-increment: pageno; }
  doc-field { display: inline; }
  doc-field[data-kind="page"]::before { content: counter(pageno); }
  doc-field[data-kind="pages"]::before { content: var(--pages, "?"); }
  doc-pagebreak { display: block; border-top: 2px dashed #b6bcc6; margin: 10pt 0; page-break-after: always; }
  @media print { doc-pagebreak { border: none; } }
  /* 하이퍼링크 — 색은 IR에 없고 여기서 칠한다. 백엔드 셋도 같은 값(LINK_COLOR)으로 칠해야
     화면과 저장물이 같아진다. 각주 참조(sup a[data-fn-ref])는 아래 규칙이 다시 덮는다. */
  .hwp-page a[href] { color: #1a4fd6; text-decoration: underline; text-underline-offset: 2px; }
  .hwp-page sup a { color: inherit; text-decoration: none; font-size: 0.75em; }
  /* 개요 번호 — **번호는 IR에 없다**. 여기서 세고, 백엔드 셋은 같은 스킴(OUTLINE_SCHEME)으로
     자기 포맷의 numbering 정의를 만든다. 화면과 저장물의 번호가 같아야 하므로 진실원은 하나다. */
  @counter-style narro-hangul { system: alphabetic; symbols: ${HANGUL_ORDINALS.map((c) => `"${c}"`).join(' ')}; }
${OUTLINE_SCHEME.map((lv, i) => {
  const n = i + 1
  const deeper = OUTLINE_SCHEME.slice(i + 1)
    .map((_, k) => `o${i + k + 2}`)
    .join(' ')
  const counter = lv.style === 'hangul' ? `counter(o${n}, narro-hangul)` : `counter(o${n})`
  const quote = (t: string) => (t ? ` "${t}"` : '')
  return (
    `  .hwp-page h${n}[data-num] { counter-increment: o${n};${deeper ? ` counter-reset: ${deeper};` : ''} }\n` +
    `  .hwp-page h${n}[data-num]::before { content:${quote(lv.prefix)} ${counter}${quote(lv.suffix)} " "; }`
  )
}).join('\n')}
  doc-section { counter-reset: fn fnref ${OUTLINE_SCHEME.map((_, i) => `o${i + 1}`).join(' ')}; }
  /* 각주 참조 번호도 파생물이다 — 본문에는 빈 <a>만 있고 번호는 여기서 센다.
     비어 있으면 클릭할 자리가 없으므로 최소 폭을 준다(편집기에서 캐럿이 들어갈 곳). */
  .hwp-page sup a[data-fn-ref] { counter-increment: fnref; }
  .hwp-page sup a[data-fn-ref]::before { content: counter(fnref) ")"; }
  doc-footnote { display: block; counter-increment: fn; font-size: 0.85em; color: #333;
    margin-top: 6pt; padding-top: 3pt; border-top: 1px solid #999; }
  doc-footnote:not(:first-of-type) { border-top: none; margin-top: 1pt; padding-top: 0; }
  doc-footnote > p:first-child::before { content: counter(fn) ") "; }
`

/** 평평한 (수준, 종류) 목록 → 중첩된 ul/ol. 더 깊은 수준은 직전 항목 안으로 들어간다 */
function listHTML(
  items: { html: string; level: number; ordered: boolean }[],
  start: number,
  level = 0,
): { xml: string; next: number } {
  const tag = items[start]?.ordered ? 'ol' : 'ul'
  const parts: string[] = []
  let i = start
  while (i < items.length && items[i].level >= level) {
    if (items[i].level === level) {
      parts.push(items[i].html)
      i++
      if (i < items.length && items[i].level > level) {
        const sub = listHTML(items, i, level + 1)
        // 중첩 목록은 직전 항목 **안**에 들어가야 한다
        parts[parts.length - 1] = parts[parts.length - 1].replace(/<\/li>$/, `${sub.xml}</li>`)
        i = sub.next
      }
    } else {
      const sub = listHTML(items, i, level + 1)
      parts.push(`<li>${sub.xml}</li>`)
      i = sub.next
    }
  }
  return { xml: `<${tag}>${parts.join('')}</${tag}>`, next: i }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

class Emitter {
  private model: DocModel
  private blockSeq = 0
  private fnSeq = 0
  private fnBlocks: string[] = []
  stats: ConvertStats

  constructor(model: DocModel, parser: 'wasm' | 'js') {
    this.model = model
    this.stats = {
      version: model.version,
      sections: model.sections.length,
      paragraphs: 0,
      tables: 0,
      chars: 0,
      images: 0,
      parser,
    }
  }

  private nextId(): string {
    return `b${++this.blockSeq}`
  }

  private charRunStyle(shapeId: number): string {
    const cs = this.model.info.charShapes[shapeId]
    if (!cs) return ''
    const parts: string[] = []
    const sizePt = (cs.baseSize / 100) * (cs.ratio / 100)
    parts.push(`font-size:${sizePt.toFixed(1)}pt`)
    const [r, g, b] = cs.color
    if (r || g || b) parts.push(`color:rgb(${r}, ${g}, ${b})`)
    const family = this.model.info.fontFaces[cs.fontId]
    if (family) parts.push(`font-family:${family.replace(/"/g, "'")}`)
    // attr: bit0 italic, bit1 bold, bit2-3 underline(1=밑줄, 3=윗줄)
    if (cs.attr & 0b01) parts.push('font-style:italic')
    if (cs.attr & 0b10) parts.push('font-weight:bold')
    const underline = (cs.attr >> 2) & 0b11
    if (underline === 1) parts.push('text-decoration:underline')
    else if (underline === 3) parts.push('text-decoration:overline')
    return parts.join(';')
  }

  private paragraphHTML(para: ParagraphModel): string {
    this.stats.paragraphs++
    const shape = this.model.info.paraShapes[para.shapeIndex]
    const head = shape?.headKind ?? HEAD.none
    const align = TEXT_ALIGN[shape?.align ?? 0]
    const styles: string[] = []
    if (align && align !== 'justify') styles.push(`text-align:${align}`)
    // hwpunit(1/7200in) → pt. 0은 생략 (기본값 생략 원칙)
    const pt = (u: number | undefined) => (u ? u / 100 : 0)
    const indentPt = pt(shape?.indent)
    /**
     * 내어쓰기는 **왼쪽 들여쓰기 안에서만** 의미가 있다 — 첫 줄이 본문 왼쪽 경계보다
     * 더 왼쪽으로 나가면 글자가 여백 밖으로 흘러 조판이 깨진다.
     *
     * 실문서에서 실제로 걸린다: 재정경제부 보도자료의 개요 문단들은 `left=0`인데
     * `intent`가 -168pt까지 간다(번호를 한글 엔진이 따로 붙여 주는 목록 문단이라 그렇다).
     * 그대로 흘리면 미리보기·docx·odt가 전부 왼쪽으로 삐져나간다.
     */
    const firstLinePt = Math.max(pt(shape?.firstLine), -indentPt)
    // 목록 항목의 들여쓰기는 **목록 어휘가 만든다** — 문서에서 온 값을 그대로 흘리면
    // 뷰어의 수준별 들여쓰기와 겹쳐 두 번 밀린다. (번호와 같은 이유로 파생물이다.)
    const isListItem = head === HEAD.number || head === HEAD.bullet
    if (indentPt && !isListItem) styles.push(`margin-left:${indentPt.toFixed(1)}pt`)
    if (firstLinePt && !isListItem) styles.push(`text-indent:${firstLinePt.toFixed(1)}pt`)
    if (pt(shape?.spaceBefore)) styles.push(`margin-top:${pt(shape?.spaceBefore).toFixed(1)}pt`)
    if (pt(shape?.spaceAfter)) styles.push(`margin-bottom:${pt(shape?.spaceAfter).toFixed(1)}pt`)
    const styleAttr = styles.length ? ` style="${styles.join(';')}"` : ''

    const runs = para.runs
      .filter((r) => r.text.length > 0 || r.field)
      .map((r) => {
        // 쪽번호 등 계산 필드 — 글자가 아니다. 번호는 저장하지 않는다(규칙 2)
        if (r.field) return `<doc-field data-kind="${esc(r.field)}"></doc-field>`
        this.stats.chars += r.text.length
        const style = this.charRunStyle(r.charShapeId)
        let html = `<span${style ? ` style="${style}"` : ''}>${esc(r.text).replace(/\n/g, '<br>')}</span>`
        // 첨자는 스타일이 아니라 요소다 (IR 어휘)
        const attr = this.model.info.charShapes[r.charShapeId]?.attr ?? 0
        if (attr & ATTR.super) html = `<sup>${html}</sup>`
        else if (attr & ATTR.sub) html = `<sub>${html}</sub>`
        // 문서에서 온 링크도 계약을 지켜야 한다 — 못 미더운 스킴은 통째로 버린다
        if (r.link && isSafeHref(r.link)) html = `<a href="${esc(r.link)}">${html}</a>`
        return html
      })

    const images = (para.images ?? []).map((img) => this.imageHTML(img)).join('')
    // 각주: 참조는 위첨자로, 내용은 섹션 끝 doc-footnote 블록으로 (IR 쌍 규칙)
    const fnRefs = (para.footnotes ?? [])
      .map((fn) => {
        const n = ++this.fnSeq
        const content = this.blocksHTML(fn.paragraphs)
        this.fnBlocks.push(`<doc-footnote id="fn${n}" data-id="${this.nextId()}">${content}</doc-footnote>`)
        // 번호는 담지 않는다 — 뷰어 CSS counter가 그린다(IR-SPEC 규칙 2).
        // 중간에 각주를 하나 끼우면 뒤 번호가 전부 밀리는데, 그때 문서를 고쳐 쓰지 않으려는 것이다.
        return `<sup><a data-fn-ref="fn${n}"></a></sup>`
      })
      .join('')
    const tables = para.tables.map((t) => this.tableHTML(t))
    // 개요 수준은 제목으로, 목록 항목은 li로 되돌린다. 표를 품은 문단은 목록으로 보지 않는다
    // (목록 한가운데 표가 오면 어차피 목록이 끊긴다).
    const level = Math.min((shape?.headLevel ?? 0) + 1, 6)
    const tag =
      head === HEAD.outline ? `h${level}` : isListItem && !tables.length ? 'li' : 'p'
    const numAttr = head === HEAD.outline ? ' data-num="outline"' : ''
    const p = `<${tag} data-id="${this.nextId()}"${numAttr}${styleAttr}>${runs.join('')}${fnRefs}${images}</${tag}>`
    const hasOwnContent = runs.length > 0 || images.length > 0 || fnRefs.length > 0
    return tables.length ? (hasOwnContent ? p : '') + tables.join('') : p
  }

  private imageHTML(img: { binDataId: number; width: number; height: number }): string {
    const bin = this.model.info.binData?.[img.binDataId]
    if (!bin) return ''
    const MIME: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      bmp: 'image/bmp',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    }
    const mime = MIME[bin.ext]
    // 브라우저가 렌더 못 하는 포맷(wmf/emf 등)은 자리표시 텍스트로 강등
    if (!mime) return `<span>[이미지: ${esc(bin.ext)}]</span>`
    this.stats.images++
    const style = img.width
      ? ` style="width:${(img.width / 100).toFixed(1)}pt;height:${(img.height / 100).toFixed(1)}pt"`
      : ''
    return `<img src="data:${mime};base64,${bin.data}" alt=""${style}>`
  }

  /**
   * 문단 목록 → 블록 HTML. 연속된 목록 항목을 `<ul>`/`<ol>` 트리로 되접는다.
   *
   * 모델은 문단마다 "몇 수준의 무슨 머리"만 들고 있다(포맷들이 그렇게 저장한다).
   * IR은 진짜 중첩을 요구하므로 여기서 한 번 접는다 — html2odt가 반대 방향으로 하는 일과 같다.
   */
  private blocksHTML(paras: ParagraphModel[]): string {
    const kindOf = (p: ParagraphModel) => {
      const sh = this.model.info.paraShapes[p.shapeIndex]
      const k = sh?.headKind ?? HEAD.none
      // 표를 품은 문단은 목록으로 다루지 않는다 (paragraphHTML과 같은 규칙)
      if ((k !== HEAD.number && k !== HEAD.bullet) || p.tables.length) return null
      return { ordered: k === HEAD.number, level: sh?.headLevel ?? 0, id: sh?.headId ?? 0 }
    }

    const out: string[] = []
    for (let i = 0; i < paras.length; ) {
      const first = kindOf(paras[i])
      if (!first) {
        out.push(this.paragraphHTML(paras[i]))
        i++
        continue
      }
      // 같은 목록에 속한 연속 문단을 모은다 — 정의 id가 바뀌면 다른 목록이다
      const items: { html: string; level: number; ordered: boolean }[] = []
      while (i < paras.length) {
        const k = kindOf(paras[i])
        if (!k || k.id !== first.id) break
        items.push({ html: this.paragraphHTML(paras[i]), level: k.level, ordered: k.ordered })
        i++
      }
      out.push(listHTML(items, 0).xml)
    }
    return out.join('')
  }

  private tableHTML(table: TableModel): string {
    this.stats.tables++
    const rows = table.rows.map((row) => {
      const cells = row.map((cell) => {
        const styles: string[] = []
        // HWPUNIT = 1/7200 inch → pt = unit / 100
        if (cell.width) styles.push(`width:${(cell.width / 100).toFixed(1)}pt`)
        if (cell.height) styles.push(`height:${(cell.height / 100).toFixed(1)}pt`)
        styles.push(
          `padding:${cell.padding.map((p) => `${Math.max(p / 100, 2).toFixed(1)}pt`).join(' ')}`,
        )
        const fill = cell.borderFillId != null ? this.model.info.borderFills[cell.borderFillId] : undefined
        const bg = fill?.backgroundColor
        if (bg) styles.push(`background:rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`)
        // 테두리: 리더가 읽었으면(`border` 키가 있으면) 그 값을, 읽었는데 없으면 none.
        // 키 자체가 없으면 그 리더가 아직 테두리를 안 읽는 것이라 기본값에 맡긴다.
        if (fill && 'border' in fill) {
          const b = fill.border
          styles.push(
            b
              ? `border:${b.widthPt.toFixed(2)}pt ${b.style} rgb(${b.color[0]}, ${b.color[1]}, ${b.color[2]})`
              : 'border:none',
          )
        }
        if (cell.vertAlign && cell.vertAlign !== 'middle') styles.push(`vertical-align:${cell.vertAlign}`)
        const span =
          (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '') +
          (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '')
        const inner = this.blocksHTML(cell.paragraphs)
        return `<td${span} style="${styles.join(';')}">${inner}</td>`
      })
      return `<tr>${cells.join('')}</tr>`
    })
    const caption = this.blocksHTML(table.caption ?? [])
    return `<table class="hwp-table" data-id="${this.nextId()}">${rows.join('')}</table>${caption}`
  }

  convert(): ConvertResult {
    const inch = (v: number) => `${(v / 7200).toFixed(3)}in`
    const body = this.model.sections
      .map((s) => {
        const style = [
          `width:${inch(s.width)}`,
          `min-height:${inch(s.height)}`,
          `padding:${inch(s.paddingTop + s.headerPadding)} ${inch(s.paddingRight)} ${inch(s.paddingBottom)} ${inch(s.paddingLeft)}`,
        ].join(';')
        this.fnBlocks = []
        // 머리말·꼬리말은 본문 흐름 밖이라 구역 직계로 낸다 (IR 구조 규칙)
        const band = (tag: 'doc-header' | 'doc-footer', paras: ParagraphModel[] | undefined) =>
          paras && paras.length ? `<${tag}>${this.blocksHTML(paras)}</${tag}>` : ''
        const head = band('doc-header', s.header) + band('doc-footer', s.footer)
        const content = this.blocksHTML(s.paragraphs)
        return `<doc-section class="hwp-page" data-ir="${IR_VERSION}" style="${style}">${head}${content}${this.fnBlocks.join('')}</doc-section>`
      })
      .join('')

    return { body, standalone: wrapStandalone(body), stats: this.stats }
  }
}

/** IR body → 완전한 standalone HTML 문서 (다운로드/미리보기 공용) */
export function wrapStandalone(body: string): string {
  // 전체 쪽수는 조판만 아는 값인데(편집기의 paginate가 --pages에 채운다) 정적 미리보기에는
  // 조판이 없다. 여기서는 구역 수가 곧 쪽수라 그대로 박아 준다 — 안 그러면 `?`가 남는다.
  const pages = (body.match(/<doc-section[\s>]/g) ?? []).length || 1
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HWP 변환 문서</title>
<style>${BASE_CSS}</style>
</head>
<body style="--pages:'${pages}'">${body}</body>
</html>`
}

/** 문서 모델 → IR HTML (파서 무관 공용 경로) */
export function convertModel(model: DocModel, parser: 'wasm' | 'js'): ConvertResult {
  return new Emitter(model, parser).convert()
}

/** HWP 바이너리 → IR HTML — hwp.js 폴백 경로 (WASM은 App/CLI에서 parseHwpWasm + convertModel) */
export function convertHWP(data: Uint8Array): ConvertResult {
  return convertModel(parseHwpJs(data), 'js')
}

export { BASE_CSS }
