/**
 * IR(HTML) → odt (OpenDocument Text, ODF) 쓰기 백엔드.
 *
 * ODF는 서식을 본문에 인라인으로 쓸 수 없고 전부 이름 붙은 스타일로 빼야 한다.
 * 그래서 순회하며 스타일을 모아 자동 스타일(P1·T1·ce1…)로 등록하고,
 * 본문은 이름만 참조한다.
 *
 * zip 규칙: `mimetype`이 **첫 항목이고 무압축(STORED)** 이어야 한다.
 */
import { zipSync, strToU8 } from 'fflate'

import type { IrBlock, IrBorder, IrCell, IrDoc, IrFootnote, IrImage, IrListDef, IrPara, IrRun, IrStyle } from './ir-model'
import {
  DEFAULT_LINE_HEIGHT,
  DOC_FONT,
  HEADING_SPACE,
  LINE_BREAK,
  LINK_COLOR,
  HF_INSET_PT,
  LIST_INDENT_PT,
  OUTLINE_SCHEME,
  bulletChar,
  readIr,
  xmlSafe,
} from './ir-model'
import type { EmbeddedFont } from './font-embed'

const esc = (s: string) =>
  xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const pt = (v: number) => `${(Math.round(v * 100) / 100).toFixed(2)}pt`

/** ODF의 fo:border는 CSS와 문법이 같다 — 값이 없으면 'none' */
const borderCss = (b: IrBorder | null) => (b ? `${pt(b.widthPt)} ${b.style} ${b.color}` : 'none')

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
].join(' ')

class OdtWriter {
  /** 목록 인스턴스 id → 정의 (수준별 표시를 꺼내 쓴다) */
  private lists: Map<number, IrListDef>
  /** doc-footnote id → 내용 (본문 흐름에서 빠지고 참조 지점에 통째로 들어간다) */
  private footnotes: Map<string, IrFootnote>
  /** 각주 번호 — ODF의 text:note-citation은 글자라서 여기서 센다 */
  private fnSeq = 0

  constructor(lists: IrListDef[], footnotes: IrFootnote[]) {
    this.lists = new Map(lists.map((l) => [l.id, l]))
    this.footnotes = new Map(footnotes.map((f) => [f.id, f]))
  }

  /** 스타일 XML → 이름 (같은 서식은 한 번만 등록) */
  private textStyles = new Map<string, string>()
  private paraStyles = new Map<string, string>()
  private rowStyles = new Map<string, string>()
  private cellStyles = new Map<string, string>()
  private colStyles = new Map<string, string>()
  /** 수준 서명("bullet,decimal") → 목록 스타일 이름 */
  private listStyles = new Map<string, string>()
  private frameStyle = false
  pictures: { name: string; bytes: Uint8Array }[] = []

  private intern(map: Map<string, string>, prefix: string, props: string): string {
    const found = map.get(props)
    if (found) return found
    const name = `${prefix}${map.size + 1}`
    map.set(props, name)
    return name
  }

  textStyle(run: IrStyle): string {
    // ODF는 글꼴 속성을 스크립트별로 따로 본다. 한글·한자는 "asian",
    // 아랍어 등은 "complex" 계열을 쓰기 때문에, fo:* 만 쓰면 한글에는 아무것도 안 먹는다.
    // (LibreOffice가 저장한 odt도 세 벌을 모두 적는다.)
    const p: string[] = []
    const perScript = (foName: string, styleName: string, value: string) => {
      p.push(`${foName}="${value}"`, `style:${styleName}-asian="${value}"`, `style:${styleName}-complex="${value}"`)
    }
    perScript('fo:font-size', 'font-size', pt(run.sizePt))
    if (run.bold) perScript('fo:font-weight', 'font-weight', 'bold')
    if (run.italic) perScript('fo:font-style', 'font-style', 'italic')
    if (run.family) {
      const f = esc(run.family)
      p.push(`style:font-name="${f}"`, `style:font-name-asian="${f}"`, `style:font-name-complex="${f}"`)
    }
    // 밑줄·취소선·색은 스크립트와 무관하다
    if (run.color && run.color !== '#000000') p.push(`fo:color="${run.color}"`)
    else if (run.link) p.push(`fo:color="${LINK_COLOR}"`)
    // 첨자 — ODF는 위치와 크기를 함께 준다. 58%는 LibreOffice·한글이 쓰는 기본 축소율
    if (run.vertAlign) p.push(`style:text-position="${run.vertAlign === 'super' ? 'super' : 'sub'} 58%"`)
    if (run.underline || run.link) {
      p.push(
        'style:text-underline-style="solid"',
        'style:text-underline-width="auto"',
        'style:text-underline-color="font-color"',
      )
    }
    if (run.strike) p.push('style:text-line-through-style="solid"', 'style:text-line-through-type="single"')
    return this.intern(this.textStyles, 'T', p.join(' '))
  }

  /**
   * fo:line-height의 백분율은 구현마다 "글자 크기 기준"과 "자연 줄높이 기준"으로 갈린다.
   * docx와 같은 이유로 여기서도 pt로 못박는다(style:line-height-at-least = 최소값이라 안 잘림).
   */
  paraStyle(para: IrPara, maxPt: number): string {
    const align = para.align
    const fo = align === 'justify' ? 'justify' : align === 'center' ? 'center' : align === 'right' ? 'end' : 'start'
    const ratio = para.heading ? HEADING_SPACE.lineHeight : DEFAULT_LINE_HEIGHT
    // 앞뒤 여백·들여쓰기는 IR이 준 값 그대로 (제목 기본값은 readPara가 채워 준다)
    const extra: string[] = []
    if (para.spaceBeforePt) extra.push(`fo:margin-top="${pt(para.spaceBeforePt)}"`)
    if (para.spaceAfterPt) extra.push(`fo:margin-bottom="${pt(para.spaceAfterPt)}"`)
    if (para.indentPt) extra.push(`fo:margin-left="${pt(para.indentPt)}"`)
    // ODF는 내어쓰기도 음수 text-indent 그대로 — docx처럼 부호를 뒤집지 않는다
    if (para.firstLinePt) extra.push(`fo:text-indent="${pt(para.firstLinePt)}"`)
    return this.intern(
      this.paraStyles,
      'P',
      `fo:text-align="${fo}" style:line-height-at-least="${pt(maxPt * ratio)}"` +
        ` style:snap-to-layout-grid="false" style:line-break="${LINE_BREAK}"` +
        (extra.length ? ` ${extra.join(' ')}` : ''),
    )
  }

  /**
   * 목록 스타일. 수준 구성이 같은 목록끼리는 하나를 나눠 쓴다 —
   * ODF는 번호를 `text:list` 요소마다 새로 세므로, 정의를 공유해도 목록이 이어지지 않는다.
   *
   * 들여쓰기는 문단 스타일이 아니라 **여기**에 적는다. label-alignment 모드에서는
   * 수준 정의의 margin/indent가 문단 여백을 덮어쓰기 때문에 문단 쪽에 적으면 무시된다.
   */
  listStyle(def: IrListDef): string {
    const sig = def.levels.join(',')
    const found = this.listStyles.get(sig)
    if (found) return found
    const name = `L${this.listStyles.size + 1}`
    this.listStyles.set(sig, name)
    return name
  }

  private listStyleXml(sig: string, name: string): string {
    const levels = sig.split(',')
    const body = levels
      .map((marker, i) => {
        const left = LIST_INDENT_PT * (i + 1)
        const align =
          `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">` +
          `<style:list-level-label-alignment text:label-followed-by="listtab" ` +
          `text:list-tab-stop-position="${pt(left)}" fo:text-indent="${pt(-LIST_INDENT_PT)}" ` +
          `fo:margin-left="${pt(left)}"/></style:list-level-properties>`
        return marker === 'decimal'
          ? `<text:list-level-style-number text:level="${i + 1}" style:num-format="1" style:num-suffix=".">${align}</text:list-level-style-number>`
          : `<text:list-level-style-bullet text:level="${i + 1}" text:bullet-char="${esc(bulletChar(i))}">${align}</text:list-level-style-bullet>`
      })
      .join('')
    return `<text:list-style style:name="${name}">${body}</text:list-style>`
  }

  cellStyle(cell: IrCell): string {
    const bg = cell.background ? ` fo:background-color="${cell.background}"` : ''
    const [t, r, b, l] = cell.paddingPt
    // ODF의 세로 정렬은 middle이 아니라 'middle'/'top'/'bottom' — CSS와 이름이 같다
    return this.intern(
      this.cellStyles,
      'ce',
      `fo:padding-top="${pt(t)}" fo:padding-right="${pt(r)}" fo:padding-bottom="${pt(b)}" ` +
        `fo:padding-left="${pt(l)}" fo:border="${borderCss(cell.border)}" ` +
        `style:vertical-align="${cell.vAlign}"${bg}`,
    )
  }

  rowStyle(minHeightPt: number): string {
    return this.intern(this.rowStyles, 'ro', `style:min-row-height="${pt(minHeightPt)}"`)
  }

  colStyle(widthPt: number): string {
    return this.intern(this.colStyles, 'co', `style:column-width="${pt(widthPt)}"`)
  }

  picture(img: IrImage): string {
    this.frameStyle = true
    const name = `Pictures/image${this.pictures.length + 1}.${img.ext}`
    this.pictures.push({ name, bytes: base64ToBytes(img.base64) })
    return name
  }

  automaticStyles(): string {
    const out: string[] = []
    for (const [props, name] of this.textStyles) {
      out.push(
        `<style:style style:name="${name}" style:family="text"><style:text-properties ${props}/></style:style>`,
      )
    }
    for (const [props, name] of this.paraStyles) {
      out.push(
        `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard">` +
          `<style:paragraph-properties ${props}/></style:style>`,
      )
    }
    for (const [props, name] of this.rowStyles) {
      out.push(
        `<style:style style:name="${name}" style:family="table-row"><style:table-row-properties ${props}/></style:style>`,
      )
    }
    for (const [props, name] of this.cellStyles) {
      out.push(
        `<style:style style:name="${name}" style:family="table-cell"><style:table-cell-properties ${props}/></style:style>`,
      )
    }
    for (const [props, name] of this.colStyles) {
      out.push(
        `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties ${props}/></style:style>`,
      )
    }
    for (const [sig, name] of this.listStyles) out.push(this.listStyleXml(sig, name))
    if (this.frameStyle) {
      out.push(
        `<style:style style:name="fr1" style:family="graphic"><style:graphic-properties ` +
          `style:vertical-pos="top" style:vertical-rel="baseline" style:horizontal-pos="left" ` +
          `style:horizontal-rel="paragraph" style:wrap="none"/></style:style>`,
      )
    }
    return out.join('')
  }

  private runXml(run: IrRun): string {
    // 쪽번호 — ODF는 전용 요소가 있다. 숫자는 열 때 계산된다
    if (run.field)
      return run.field === 'pages'
        ? '<text:page-count>1</text:page-count>'
        : '<text:page-number text:select-page="current">1</text:page-number>'
    // 각주 — ODF는 별도 파트 없이 **참조 지점에 내용을 통째로** 넣는다
    if (run.footnote) {
      const fn = this.footnotes.get(run.footnote)
      if (!fn) return ''
      const n = ++this.fnSeq
      const body = this.blocksXml(fn.blocks, { n: 0 }) || '<text:p/>'
      return (
        `<text:note text:id="${esc(run.footnote)}" text:note-class="footnote">` +
        `<text:note-citation>${n}</text:note-citation>` +
        `<text:note-body>${body}</text:note-body></text:note>`
      )
    }
    const name = this.textStyle(run)
    // 줄바꿈·탭은 전용 요소로 나가야 한다
    const body = run.text
      .split(/(\n|\t)/)
      .filter((piece) => piece !== '')
      .map((piece) =>
        piece === '\n' ? '<text:line-break/>' : piece === '\t' ? '<text:tab/>' : esc(piece),
      )
      .join('')
    return `<text:span text:style-name="${name}">${body}</text:span>`
  }

  /** 링크 단위로 묶어 `text:a`로 감싼다 (같은 링크의 연속 런은 한 덩어리) */
  private runsXml(runs: IrRun[]): string {
    const out: string[] = []
    for (let i = 0; i < runs.length; ) {
      const link = runs[i].link
      let j = i
      while (j < runs.length && runs[j].link === link) j++
      const inner = runs
        .slice(i, j)
        .map((r) => this.runXml(r))
        .join('')
      out.push(link ? `<text:a xlink:type="simple" xlink:href="${esc(link)}">${inner}</text:a>` : inner)
      i = j
    }
    return out.join('')
  }

  paraXml(para: IrPara): string {
    const maxPt = para.runs.reduce((m, r) => Math.max(m, r.sizePt), 0) || 10
    const style = this.paraStyle(para, maxPt)
    const runs = this.runsXml(para.runs)
    const imgs = para.images
      .map((im) => {
        const href = this.picture(im)
        const w = im.widthPt || 216
        const h = im.heightPt || 162
        return (
          `<draw:frame draw:style-name="fr1" draw:name="${href}" text:anchor-type="as-char" ` +
          `svg:width="${pt(w)}" svg:height="${pt(h)}">` +
          `<draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
          `</draw:frame>`
        )
      })
      .join('')
    // 개요 번호에 참여하는 제목만 `text:h`로 낸다. ODF의 개요 번호는 `text:h`에만 붙고,
    // 우리 IR은 제목마다 참여 여부를 고를 수 있어서(`data-num`) 참여하는 것만 승격한다.
    if (para.outline !== null) {
      const level = Math.min(para.outline, OUTLINE_SCHEME.length)
      return `<text:h text:style-name="${style}" text:outline-level="${level}">${runs}${imgs}</text:h>`
    }
    return `<text:p text:style-name="${style}">${runs}${imgs}</text:p>`
  }

  tableXml(rows: IrCell[][], colWidthsPt: number[], seq: { n: number }): string {
    const cols = colWidthsPt
      .map((w) => `<table:table-column table:style-name="${this.colStyle(w)}"/>`)
      .join('')

    const covered = new Set<string>()
    const trs: string[] = []
    rows.forEach((row, r) => {
      const cells: string[] = []
      let c = 0
      for (const cell of row) {
        while (covered.has(`${r},${c}`)) {
          cells.push('<table:covered-table-cell/>')
          c++
        }
        for (let rr = r + 1; rr < r + cell.rowSpan; rr++) {
          for (let cc = c; cc < c + cell.colSpan; cc++) covered.add(`${rr},${cc}`)
        }
        const span =
          (cell.colSpan > 1 ? ` table:number-columns-spanned="${cell.colSpan}"` : '') +
          (cell.rowSpan > 1 ? ` table:number-rows-spanned="${cell.rowSpan}"` : '')
        const inner = this.blocksXml(cell.blocks, seq) || '<text:p/>'
        cells.push(
          `<table:table-cell table:style-name="${this.cellStyle(cell)}"${span} office:value-type="string">${inner}</table:table-cell>`,
        )
        // 가로 병합에 먹힌 칸도 자리를 채워 줘야 열이 맞는다
        for (let k = 1; k < cell.colSpan; k++) cells.push('<table:covered-table-cell/>')
        c += cell.colSpan
      }
      while (covered.has(`${r},${c}`)) {
        cells.push('<table:covered-table-cell/>')
        c++
      }
      const hPt = row.reduce((m, cell) => (cell.rowSpan > 1 ? m : Math.max(m, cell.heightPt)), 0)
      const rowStyle = hPt > 0 ? ` table:style-name="${this.rowStyle(hPt)}"` : ''
      trs.push(`<table:table-row${rowStyle}>${cells.join('')}</table:table-row>`)
    })

    seq.n++
    return `<table:table table:name="Table${seq.n}">${cols}${trs.join('')}</table:table>`
  }

  /**
   * 평평한 수준 정보를 ODF가 요구하는 트리로 되접는다.
   * docx·hwpx는 문단마다 "몇 번째 수준"이라고 적으면 그만이지만, ODF에는 그런 속성이 없다 —
   * `text:list > text:list-item > (text:p | text:list)` 중첩만이 수준을 표현한다.
   */
  private listXml(items: IrPara[], def: IrListDef): string {
    const styleName = this.listStyle(def)
    const render = (start: number, level: number): { xml: string; next: number } => {
      const parts: string[] = []
      let i = start
      while (i < items.length && (items[i].list?.level ?? 0) >= level) {
        if ((items[i].list?.level ?? 0) === level) {
          let inner = this.paraXml(items[i])
          i++
          // 이 항목에 딸린 더 깊은 수준은 **이 항목 안에** 들어가야 한다
          if (i < items.length && (items[i].list?.level ?? 0) > level) {
            const sub = render(i, level + 1)
            inner += sub.xml
            i = sub.next
          }
          parts.push(`<text:list-item>${inner}</text:list-item>`)
        } else {
          // 목록이 더 깊은 수준에서 시작한 경우 — 빈 항목으로 한 겹 감싼다
          const sub = render(i, level + 1)
          parts.push(`<text:list-item>${sub.xml}</text:list-item>`)
          i = sub.next
        }
      }
      // 중첩된 목록은 바깥 스타일을 물려받는다 — 최상위에만 이름을 적는다
      const attr = level === 0 ? ` text:style-name="${styleName}"` : ''
      return { xml: `<text:list${attr}>${parts.join('')}</text:list>`, next: i }
    }
    return render(0, 0).xml
  }

  blocksXml(blocks: IrBlock[], seq: { n: number }): string {
    const out: string[] = []
    for (let i = 0; i < blocks.length; ) {
      const b = blocks[i]
      const list = b.kind === 'p' ? b.para.list : null
      if (list) {
        // 같은 목록에 속한 연속 문단을 한 덩어리로 모은다.
        // (항목 사이에 표가 끼면 목록이 끊기고 번호가 다시 1부터 — 드문 경우라 그대로 둔다)
        const items: IrPara[] = []
        let j = i
        while (j < blocks.length) {
          const nb = blocks[j]
          if (nb.kind !== 'p' || nb.para.list?.id !== list.id) break
          items.push(nb.para)
          j++
        }
        const def = this.lists.get(list.id)
        out.push(def ? this.listXml(items, def) : items.map((p) => this.paraXml(p)).join(''))
        i = j
        continue
      }
      out.push(b.kind === 'p' ? this.paraXml(b.para) : this.tableXml(b.table.rows, b.table.colWidthsPt, seq))
      i++
    }
    return out.join('')
  }
}

/**
 * 개요 번호 정의. ODF는 CJK 번호 체계를 **표본 문자열**로 적는다(`"가, 나, 다, ..."`) —
 * 값이 문자열이라 못 알아듣는 구현에서도 파일이 깨지지는 않고 번호 모양만 달라진다.
 * 들여쓰기를 주지 않는 건 docx·뷰어와 같은 이유 — 번호는 제목 줄 앞에 그냥 붙는다.
 */
const OUTLINE_STYLE = () =>
  `<text:outline-style style:name="Outline">${OUTLINE_SCHEME.map((lv, i) => {
    const fmt = lv.style === 'hangul' ? '가, 나, 다, ...' : '1'
    const affix =
      (lv.prefix ? ` style:num-prefix="${esc(lv.prefix)}"` : '') +
      (lv.suffix ? ` style:num-suffix="${esc(lv.suffix)}"` : '')
    return (
      `<text:outline-level-style text:level="${i + 1}" style:num-format="${esc(fmt)}"${affix}>` +
      `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">` +
      `<style:list-level-label-alignment text:label-followed-by="space" fo:text-indent="0pt" fo:margin-left="0pt"/>` +
      `</style:list-level-properties></text:outline-level-style>`
    )
  }).join('')}</text:outline-style>`

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface OdtResult {
  data: Uint8Array
  stats: { paragraphs: number; tables: number; images: number }
}

/** IR HTML의 body → odt 바이트 */
export function html2odt(root: Element, embed?: EmbeddedFont): OdtResult {
  const doc: IrDoc = readIr(root)
  const w = new OdtWriter(doc.lists, doc.footnotes)
  const seq = { n: 0 }
  const body = doc.sections.map((s) => w.blocksXml(s.blocks, seq)).join('')
  const first = doc.sections[0]
  // 머리말·꼬리말은 master-page에 산다. 본문과 같은 방출기를 쓰지만 자동 스타일이
  // content.xml이 아니라 styles.xml에 등록돼야 해서, 전용 writer로 따로 모은다.
  const hfWriter = new OdtWriter(doc.lists, doc.footnotes)
  const headerXml = first?.header ? hfWriter.blocksXml(first.header, { n: 0 }) : null
  const footerXml = first?.footer ? hfWriter.blocksXml(first.footer, { n: 0 }) : null

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS} office:version="1.3">
<office:automatic-styles>${w.automaticStyles()}</office:automatic-styles>
<office:body><office:text>${body}</office:text></office:body>
</office:document-content>`

  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS} office:version="1.3">
${embed ? `<office:font-face-decls><style:font-face style:name="${embed.family}" svg:font-family="&apos;${embed.family}&apos;" style:font-family-generic="swiss" style:font-pitch="variable"><svg:font-face-src><svg:font-face-uri xlink:href="Fonts/regular.ttf" xlink:type="simple" xlink:actuate="onRequest"><svg:font-face-format svg:string="truetype"/></svg:font-face-uri></svg:font-face-src></style:font-face></office:font-face-decls>` : ''}
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties style:line-height-at-least="${pt(10 * DEFAULT_LINE_HEIGHT)}" fo:margin-top="0pt" fo:margin-bottom="0pt" style:text-autospace="none"/><style:text-properties style:font-name="${DOC_FONT}" fo:font-size="10pt" style:font-size-asian="10pt" style:font-size-complex="10pt"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph"/>
${doc.outlineId === null ? '' : OUTLINE_STYLE()}
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="pm1"><style:page-layout-properties
 fo:page-width="${pt(first?.widthPt ?? 595)}" fo:page-height="${pt(first?.heightPt ?? 842)}"
 fo:margin-top="${pt(first?.padTopPt ?? 72)}" fo:margin-bottom="${pt(first?.padBottomPt ?? 72)}"
 fo:margin-left="${pt(first?.padLeftPt ?? 72)}" fo:margin-right="${pt(first?.padRightPt ?? 72)}"
 style:print-orientation="portrait"/>${
   headerXml === null ? '' : `<style:header-style><style:header-footer-properties fo:min-height="${pt(HF_INSET_PT / 2)}" fo:margin-bottom="${pt(HF_INSET_PT / 2)}"/></style:header-style>`
 }${
   footerXml === null ? '' : `<style:footer-style><style:header-footer-properties fo:min-height="${pt(HF_INSET_PT / 2)}" fo:margin-top="${pt(HF_INSET_PT / 2)}"/></style:footer-style>`
 }</style:page-layout>
${hfWriter.automaticStyles()}
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="Standard" style:page-layout-name="pm1">${
  headerXml === null ? '' : `<style:header>${headerXml}</style:header>`
}${footerXml === null ? '' : `<style:footer>${footerXml}</style:footer>`}</style:master-page>
</office:master-styles>
</office:document-styles>`

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
${w.pictures.map((p) => `<manifest:file-entry manifest:full-path="${p.name}" manifest:media-type="image/${p.name.split('.').pop() === 'jpg' ? 'jpeg' : p.name.split('.').pop()}"/>`).join('')}${embed ? '<manifest:file-entry manifest:full-path="Fonts/regular.ttf" manifest:media-type="application/x-font-ttf"/>' + (embed.bold ? '<manifest:file-entry manifest:full-path="Fonts/bold.ttf" manifest:media-type="application/x-font-ttf"/>' : '') : ''}
</manifest:manifest>`

  // mimetype은 첫 항목 + 무압축이어야 한다 (ODF 패키지 규칙)
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
    'META-INF/manifest.xml': [strToU8(manifest), { level: 6 }],
    'content.xml': [strToU8(content), { level: 6 }],
    'styles.xml': [strToU8(styles), { level: 6 }],
  }
  for (const p of w.pictures) files[p.name] = [p.bytes, { level: 6 }]
  if (embed) {
    files['Fonts/regular.ttf'] = [embed.regular, { level: 6 }]
    if (embed.bold) files['Fonts/bold.ttf'] = [embed.bold, { level: 6 }]
  }

  const count = (re: RegExp) => (content.match(re) ?? []).length
  return {
    data: zipSync(files as never, { level: 6 }),
    stats: {
      paragraphs: count(/<text:(p|h)[ >/]/g),
      tables: count(/<table:table[ >]/g),
      images: w.pictures.length,
    },
  }
}
