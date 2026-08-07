/**
 * 문서 모델 → IR HTML 방출기.
 * 파서(Rust WASM 또는 hwp.js)가 만든 DocModel(model.ts 계약)을 받아
 * docs/IR-SPEC.md 어휘의 HTML을 생성한다.
 */
import { IR_VERSION, isSafeHref } from './ir'
import { ATTR } from './model'
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
  table.hwp-table { border-collapse: collapse; margin: 2pt 0; }
  table.hwp-table td { border: 1px solid #555; vertical-align: middle; }
  .hwp-page img { max-width: 100%; }
  .hwp-page h1, .hwp-page h2, .hwp-page h3, .hwp-page h4, .hwp-page h5, .hwp-page h6 { margin: 4pt 0 2pt; line-height: 1.4; }
  .hwp-page h1 { font-size: 16pt; } .hwp-page h2 { font-size: 14pt; } .hwp-page h3 { font-size: 13pt; }
  .hwp-page h4, .hwp-page h5, .hwp-page h6 { font-size: 12pt; }
  .hwp-page ul, .hwp-page ol { margin: 2pt 0; padding-left: 24pt; }
  .hwp-page li { min-height: 1em; line-height: 1.6; }
  doc-pagebreak { display: block; border-top: 2px dashed #b6bcc6; margin: 10pt 0; page-break-after: always; }
  @media print { doc-pagebreak { border: none; } }
  /* 하이퍼링크 — 색은 IR에 없고 여기서 칠한다. 백엔드 셋도 같은 값(LINK_COLOR)으로 칠해야
     화면과 저장물이 같아진다. 각주 참조(sup a[data-fn-ref])는 아래 규칙이 다시 덮는다. */
  .hwp-page a[href] { color: #1a4fd6; text-decoration: underline; text-underline-offset: 2px; }
  .hwp-page sup a { color: inherit; text-decoration: none; font-size: 0.75em; }
  doc-section { counter-reset: fn; }
  doc-footnote { display: block; counter-increment: fn; font-size: 0.85em; color: #333;
    margin-top: 6pt; padding-top: 3pt; border-top: 1px solid #999; }
  doc-footnote:not(:first-of-type) { border-top: none; margin-top: 1pt; padding-top: 0; }
  doc-footnote > p:first-child::before { content: counter(fn) ") "; }
`

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
    if (indentPt) styles.push(`margin-left:${indentPt.toFixed(1)}pt`)
    if (firstLinePt) styles.push(`text-indent:${firstLinePt.toFixed(1)}pt`)
    if (pt(shape?.spaceBefore)) styles.push(`margin-top:${pt(shape?.spaceBefore).toFixed(1)}pt`)
    if (pt(shape?.spaceAfter)) styles.push(`margin-bottom:${pt(shape?.spaceAfter).toFixed(1)}pt`)
    const styleAttr = styles.length ? ` style="${styles.join(';')}"` : ''

    const runs = para.runs
      .filter((r) => r.text.length > 0)
      .map((r) => {
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
        const content = fn.paragraphs.map((p) => this.paragraphHTML(p)).join('')
        this.fnBlocks.push(`<doc-footnote id="fn${n}" data-id="${this.nextId()}">${content}</doc-footnote>`)
        return `<sup><a data-fn-ref="fn${n}">${n})</a></sup>`
      })
      .join('')
    const tables = para.tables.map((t) => this.tableHTML(t))
    const p = `<p data-id="${this.nextId()}"${styleAttr}>${runs.join('')}${fnRefs}${images}</p>`
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
        const bg =
          cell.borderFillId != null
            ? this.model.info.borderFills[cell.borderFillId]?.backgroundColor
            : null
        if (bg) styles.push(`background:rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`)
        const span =
          (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '') +
          (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '')
        const inner = cell.paragraphs.map((p) => this.paragraphHTML(p)).join('')
        return `<td${span} style="${styles.join(';')}">${inner}</td>`
      })
      return `<tr>${cells.join('')}</tr>`
    })
    const caption = (table.caption ?? []).map((p) => this.paragraphHTML(p)).join('')
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
        const content = s.paragraphs.map((p) => this.paragraphHTML(p)).join('')
        return `<doc-section class="hwp-page" data-ir="${IR_VERSION}" style="${style}">${content}${this.fnBlocks.join('')}</doc-section>`
      })
      .join('')

    return { body, standalone: wrapStandalone(body), stats: this.stats }
  }
}

/** IR body → 완전한 standalone HTML 문서 (다운로드/미리보기 공용) */
export function wrapStandalone(body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HWP 변환 문서</title>
<style>${BASE_CSS}</style>
</head>
<body>${body}</body>
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
