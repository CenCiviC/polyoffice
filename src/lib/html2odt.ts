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

import type { IrBlock, IrCell, IrDoc, IrImage, IrPara, IrRun, IrStyle } from './ir-model'
import { DEFAULT_LINE_HEIGHT, DOC_FONT, HEADING_SPACE, LINE_BREAK, readIr, xmlSafe } from './ir-model'
import type { EmbeddedFont } from './font-embed'

const esc = (s: string) =>
  xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const pt = (v: number) => `${(Math.round(v * 100) / 100).toFixed(2)}pt`

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
  /** 스타일 XML → 이름 (같은 서식은 한 번만 등록) */
  private textStyles = new Map<string, string>()
  private paraStyles = new Map<string, string>()
  private rowStyles = new Map<string, string>()
  private cellStyles = new Map<string, string>()
  private colStyles = new Map<string, string>()
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
    if (run.underline) {
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
  paraStyle(align: string, maxPt: number, heading: number): string {
    const fo = align === 'justify' ? 'justify' : align === 'center' ? 'center' : align === 'right' ? 'end' : 'start'
    const ratio = heading ? HEADING_SPACE.lineHeight : DEFAULT_LINE_HEIGHT
    const space = heading
      ? ` fo:margin-top="${pt(HEADING_SPACE.beforePt)}" fo:margin-bottom="${pt(HEADING_SPACE.afterPt)}"`
      : ''
    return this.intern(
      this.paraStyles,
      'P',
      `fo:text-align="${fo}" style:line-height-at-least="${pt(maxPt * ratio)}"` +
        ` style:snap-to-layout-grid="false" style:line-break="${LINE_BREAK}"${space}`,
    )
  }

  cellStyle(background: string | null, padding: [number, number, number, number]): string {
    const bg = background ? ` fo:background-color="${background}"` : ''
    const [t, r, b, l] = padding
    return this.intern(
      this.cellStyles,
      'ce',
      `fo:padding-top="${pt(t)}" fo:padding-right="${pt(r)}" fo:padding-bottom="${pt(b)}" ` +
        `fo:padding-left="${pt(l)}" fo:border="0.75pt solid #555555" style:vertical-align="middle"${bg}`,
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

  paraXml(para: IrPara): string {
    const maxPt = para.runs.reduce((m, r) => Math.max(m, r.sizePt), 0) || 10
    const style = this.paraStyle(para.align, maxPt, para.heading)
    const runs = para.runs.map((r) => this.runXml(r)).join('')
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
          `<table:table-cell table:style-name="${this.cellStyle(cell.background, cell.paddingPt)}"${span} office:value-type="string">${inner}</table:table-cell>`,
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

  blocksXml(blocks: IrBlock[], seq: { n: number }): string {
    return blocks
      .map((b) =>
        b.kind === 'p' ? this.paraXml(b.para) : this.tableXml(b.table.rows, b.table.colWidthsPt, seq),
      )
      .join('')
  }
}

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
  const w = new OdtWriter()
  const seq = { n: 0 }
  const body = doc.sections.map((s) => w.blocksXml(s.blocks, seq)).join('')
  const first = doc.sections[0]

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
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="pm1"><style:page-layout-properties
 fo:page-width="${pt(first?.widthPt ?? 595)}" fo:page-height="${pt(first?.heightPt ?? 842)}"
 fo:margin-top="${pt(first?.padTopPt ?? 72)}" fo:margin-bottom="${pt(first?.padBottomPt ?? 72)}"
 fo:margin-left="${pt(first?.padLeftPt ?? 72)}" fo:margin-right="${pt(first?.padRightPt ?? 72)}"
 style:print-orientation="portrait"/></style:page-layout>
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="Standard" style:page-layout-name="pm1"/>
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
      paragraphs: count(/<text:p[ >/]/g),
      tables: count(/<table:table[ >]/g),
      images: w.pictures.length,
    },
  }
}
