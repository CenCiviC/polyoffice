/**
 * IR(HTML) → docx (OOXML, ECMA-376) 쓰기 백엔드.
 *
 * hwpx 백엔드는 빈 템플릿을 열어 본문만 갈아끼우지만, docx는 필요한 부품이 적어
 * 패키지를 통째로 새로 만든다. 최소 구성: [Content_Types] · 관계 · document.xml
 * (+ 그림이 있으면 media와 관계 파일).
 *
 * 단위: 1pt = 20twip · 1pt = 12700EMU · 글자 크기는 하프포인트.
 */
import { zipSync, strToU8 } from 'fflate'

import type { IrBlock, IrCell, IrDoc, IrImage, IrPara, IrRun } from './ir-model'
import { readIr, xmlSafe } from './ir-model'

const esc = (s: string) =>
  xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const twip = (pt: number) => Math.max(0, Math.round(pt * 20))
const emu = (pt: number) => Math.max(0, Math.round(pt * 12700))

const CONTENT_TYPES = (exts: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${exts.map((e) => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('')}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ')

const JC: Record<string, string> = { left: 'left', center: 'center', right: 'right', justify: 'both' }

class DocxWriter {
  private media: { name: string; bytes: Uint8Array }[] = []
  private rels: string[] = []

  /** 그림을 패키지에 넣고 관계 id를 돌려준다 */
  imageRel(img: IrImage): string {
    const id = `rId${100 + this.media.length}`
    const name = `image${this.media.length + 1}.${img.ext}`
    this.media.push({ name, bytes: base64ToBytes(img.base64) })
    this.rels.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`,
    )
    return id
  }

  mediaFiles() {
    return this.media
  }

  extensions() {
    return [...new Set(this.media.map((m) => m.name.split('.').pop() as string))]
  }

  documentRels() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.rels.join('')}</Relationships>`
  }

  runXml(run: IrRun): string {
    const pr: string[] = []
    if (run.family) {
      const f = esc(run.family)
      pr.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`)
    }
    if (run.bold) pr.push('<w:b/>')
    if (run.italic) pr.push('<w:i/>')
    if (run.strike) pr.push('<w:strike/>')
    if (run.underline) pr.push('<w:u w:val="single"/>')
    if (run.color && run.color !== '#000000') pr.push(`<w:color w:val="${run.color.slice(1)}"/>`)
    pr.push(`<w:sz w:val="${Math.max(2, Math.round(run.sizePt * 2))}"/>`)
    const rPr = `<w:rPr>${pr.join('')}</w:rPr>`

    // 줄바꿈·탭은 텍스트가 아니라 별도 요소다
    const body = run.text
      .split(/(\n|\t)/)
      .filter((piece) => piece !== '')
      .map((piece) =>
        piece === '\n'
          ? '<w:br/>'
          : piece === '\t'
            ? '<w:tab/>'
            : `<w:t xml:space="preserve">${esc(piece)}</w:t>`,
      )
      .join('')
    return `<w:r>${rPr}${body}</w:r>`
  }

  imageXml(img: IrImage, seq: number): string {
    const rel = this.imageRel(img)
    // 크기 미상이면 3인치 폭으로 둔다 (0을 쓰면 Word가 그림을 감춘다)
    const cx = emu(img.widthPt || 216)
    const cy = emu(img.heightPt || 162)
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${seq}" name="Picture ${seq}"/>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${seq}" name="Picture ${seq}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    )
  }

  paraXml(para: IrPara, seq: { n: number }): string {
    const jc = JC[para.align]
    const pPr = jc && jc !== 'left' ? `<w:pPr><w:jc w:val="${jc}"/></w:pPr>` : ''
    const runs = para.runs.map((r) => this.runXml(r)).join('')
    const imgs = para.images.map((im) => this.imageXml(im, ++seq.n)).join('')
    return `<w:p>${pPr}${runs}${imgs}</w:p>`
  }

  tableXml(rows: IrCell[][], colWidthsPt: number[], seq: { n: number }): string {
    const grid = colWidthsPt.map((w) => `<w:gridCol w:w="${twip(w)}"/>`).join('')
    const total = twip(colWidthsPt.reduce((a, b) => a + b, 0))
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="555555"/>`)
      .join('')

    // 세로 병합에 먹힌 자리에도 셀이 있어야 Word가 격자를 맞춘다
    const covered = new Set<string>()
    const trs: string[] = []
    rows.forEach((row, r) => {
      const tcs: string[] = []
      let c = 0
      for (const cell of row) {
        while (covered.has(`${r},${c}`)) {
          tcs.push(vMergeContinueCell(colWidthsPt[c] ?? 60))
          c++
        }
        for (let rr = r + 1; rr < r + cell.rowSpan; rr++) {
          for (let cc = c; cc < c + cell.colSpan; cc++) covered.add(`${rr},${cc}`)
        }
        const pr: string[] = [
          `<w:tcW w:type="dxa" w:w="${twip(cell.widthPt || colWidthsPt.slice(c, c + cell.colSpan).reduce((a, b) => a + (b || 0), 0) || 60)}"/>`,
        ]
        if (cell.colSpan > 1) pr.push(`<w:gridSpan w:val="${cell.colSpan}"/>`)
        if (cell.rowSpan > 1) pr.push('<w:vMerge w:val="restart"/>')
        if (cell.background) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${cell.background.slice(1)}"/>`)
        const inner = this.blocksXml(cell.blocks, seq) || '<w:p/>'
        tcs.push(`<w:tc><w:tcPr>${pr.join('')}</w:tcPr>${inner}</w:tc>`)
        c += cell.colSpan
      }
      while (covered.has(`${r},${c}`)) {
        tcs.push(vMergeContinueCell(colWidthsPt[c] ?? 60))
        c++
      }
      trs.push(`<w:tr>${tcs.join('')}</w:tr>`)
    })

    return (
      `<w:tbl><w:tblPr><w:tblW w:type="dxa" w:w="${total}"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
      `<w:tblGrid>${grid}</w:tblGrid>${trs.join('')}</w:tbl>`
    )
  }

  blocksXml(blocks: IrBlock[], seq: { n: number }): string {
    return blocks
      .map((b) =>
        b.kind === 'p'
          ? this.paraXml(b.para, seq)
          : this.tableXml(b.table.rows, b.table.colWidthsPt, seq),
      )
      .join('')
  }
}

/** 세로 병합에 먹힌 자리를 채우는 빈 셀 */
function vMergeContinueCell(widthPt: number): string {
  return `<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="${twip(widthPt)}"/><w:vMerge/></w:tcPr><w:p/></w:tc>`
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface DocxResult {
  data: Uint8Array
  stats: { paragraphs: number; tables: number; images: number }
}

/** IR HTML의 body → docx 바이트 */
export function html2docx(root: Element): DocxResult {
  const doc: IrDoc = readIr(root)
  const w = new DocxWriter()
  const seq = { n: 0 }

  // 구역이 여럿이면 페이지 나누기로 이어 붙인다 (docx 본문은 하나의 흐름)
  const bodies = doc.sections.map((s, i) => {
    const brk = i > 0 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''
    return brk + w.blocksXml(s.blocks, seq)
  })

  const first = doc.sections[0]
  const sectPr =
    `<w:sectPr><w:pgSz w:w="${twip(first?.widthPt ?? 595)}" w:h="${twip(first?.heightPt ?? 842)}"/>` +
    `<w:pgMar w:top="${twip(first?.padTopPt ?? 72)}" w:right="${twip(first?.padRightPt ?? 72)}" ` +
    `w:bottom="${twip(first?.padBottomPt ?? 72)}" w:left="${twip(first?.padLeftPt ?? 72)}" ` +
    `w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${bodies.join('')}${sectPr}</w:body></w:document>`

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES(w.extensions())),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(w.documentRels()),
  }
  for (const m of w.mediaFiles()) files[`word/media/${m.name}`] = m.bytes

  const count = (re: RegExp) => (document.match(re) ?? []).length
  return {
    data: zipSync(files, { level: 6 }),
    stats: {
      paragraphs: count(/<w:p[ >]/g),
      tables: count(/<w:tbl>/g),
      images: w.mediaFiles().length,
    },
  }
}
