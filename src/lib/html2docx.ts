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

import type { IrBlock, IrBorder, IrCell, IrDoc, IrFootnote, IrImage, IrListDef, IrPara, IrRun } from './ir-model'
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
import { fontKeyFor, obfuscateFont, type EmbeddedFont } from './font-embed'

/** 뷰어 CSS의 기본 글꼴 대체 사슬(Apple SD Gothic Neo → Malgun Gothic)에서 Word가 쓸 수 있는 것 */
const DEFAULT_FONT = DOC_FONT

const esc = (s: string) =>
  xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const twip = (pt: number) => Math.max(0, Math.round(pt * 20))
const emu = (pt: number) => Math.max(0, Math.round(pt * 12700))

const CONTENT_TYPES = (
  exts: string[],
  embedded: boolean,
  numbering: boolean,
  footnotes: boolean,
  hf: { header: boolean; footer: boolean },
) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${exts.map((e) => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('')}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${
  numbering ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' : ''
}${
  footnotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ''
}${
  hf.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''
}${
  hf.footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''
}${
  embedded ? '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>' +
             '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' : ''
}</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

/**
 * styles.xml이 없으면 Word는 자기 내장 Normal 기본값(문단 뒤 8pt, 줄간격 1.08)을 쓴다.
 * hwpx 템플릿·ODF 기본값에는 그런 여백이 없어서 docx만 페이지 수가 늘어났다.
 * 뷰어 BASE_CSS(line-height 1.6, p margin 0)를 기준으로 기본값을 명시해 셋을 맞춘다.
 */
/**
 * 문단 줄간격·앞뒤 여백 — CSS line-height와 같은 의미(글자 크기 × 배수)를 pt로 못박는다.
 * 앞뒤 여백은 **IR이 준 값을 그대로 쓴다** — 제목 기본값은 `readPara`가 이미 채워 준다.
 */
const lineSpacingXml = (maxPt: number, beforePt = 0, afterPt = 0, heading = false) => {
  const ratio = heading ? HEADING_SPACE.lineHeight : DEFAULT_LINE_HEIGHT
  return `<w:spacing w:before="${twip(beforePt)}" w:after="${twip(afterPt)}" w:line="${Math.round(maxPt * ratio * 20)}" w:lineRule="atLeast"/>`
}

/** 들여쓰기 — 첫 줄이 음수면 내어쓰기라 Word에서는 부호를 뒤집어 hanging으로 간다 */
const indentXml = (indentPt: number, firstLinePt: number): string => {
  const attrs: string[] = []
  if (indentPt) attrs.push(`w:left="${twip(indentPt)}"`)
  if (firstLinePt > 0) attrs.push(`w:firstLine="${twip(firstLinePt)}"`)
  else if (firstLinePt < 0) attrs.push(`w:hanging="${twip(-firstLinePt)}"`)
  return attrs.length ? `<w:ind ${attrs.join(' ')}/>` : ''
}

/**
 * 셀 테두리. OOXML의 `w:sz`는 **1/8pt 단위**라 pt×8, 색은 `#` 없는 6자리.
 * 테두리가 없으면 `w:val="nil"` — 표 수준 `w:tblBorders`를 셀이 덮어써야 하기 때문에
 * 생략이 아니라 명시적으로 없앤다.
 */
const DOCX_BORDER_STYLE: Record<IrBorder['style'], string> = {
  solid: 'single',
  dashed: 'dashed',
  dotted: 'dotted',
  double: 'double',
}

const tcBordersXml = (b: IrBorder | null): string => {
  const one = b
    ? `w:val="${DOCX_BORDER_STYLE[b.style]}" w:sz="${Math.max(1, Math.round(b.widthPt * 8))}" w:space="0" w:color="${b.color.slice(1)}"`
    : 'w:val="nil"'
  return `<w:tcBorders>${['top', 'left', 'bottom', 'right'].map((s) => `<w:${s} ${one}/>`).join('')}</w:tcBorders>`
}

const HEADER_REL = 'rId8'
const FOOTER_REL = 'rId9'

/** 머리말·꼬리말 파트 — 본문과 같은 문단 방출기를 쓴다 */
const HEADER_FOOTER = (tag: 'hdr' | 'ftr', body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${tag} ${NS}>${body || '<w:p/>'}</w:${tag}>`

/** OOXML의 색은 `#` 없는 6자리다 */
const LINK_COLOR_HEX = LINK_COLOR.slice(1)

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="${DEFAULT_FONT}" w:hAnsi="${DEFAULT_FONT}" w:eastAsia="${DEFAULT_FONT}" w:cs="${DEFAULT_FONT}"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:kinsoku w:val="${LINE_BREAK === 'strict' ? 1 : 0}"/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/><w:snapToGrid w:val="0"/>${lineSpacingXml(10)}</w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`

/**
 * numbering.xml — 목록 정의 테이블. 이게 없으면 문단에 번호를 붙일 방법이 없어서
 * 예전에는 `"• "`를 본문 글자로 박았다(그래서 Word에서 항목을 추가해도 기호가 안 붙었다).
 *
 * 목록 인스턴스 하나 = abstractNum 하나 + num 하나. num을 따로 두는 이유는 **번호 세는 단위가
 * num**이기 때문 — 정의를 공유시키면 두 번째 목록이 1이 아니라 이어서 세기 시작한다.
 *
 * `w:lvlText`의 `%n`은 n번째 **수준의 현재 번호**다(1부터). 글머리표는 셀 것이 없으므로
 * `numFmt="bullet"`에 문자를 그대로 적는다.
 */
const OUTLINE_ABSTRACT = (outlineId: number) =>
  // 개요 번호는 문서에 하나. 들여쓰기를 주지 않는 이유는 뷰어가 `::before`로 제목 줄
  // 앞에 그냥 붙여 그리기 때문 — 화면과 저장물이 같아야 한다.
  `<w:abstractNum w:abstractNumId="${outlineId}"><w:multiLevelType w:val="multilevel"/>` +
  OUTLINE_SCHEME.map(
    (lv, i) =>
      // `w:suff`가 없으면 Word 기본이 **탭**이라 번호와 제목 사이가 다음 탭 정지까지
      // 벌어진다. 뷰어(`::before`)와 odt는 공백 하나라 셋이 어긋났다.
      // CT_Lvl은 순서 있는 sequence — suff는 lvlText보다 앞이다.
      `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>` +
      `<w:numFmt w:val="${lv.style === 'hangul' ? 'ganada' : 'decimal'}"/>` +
      `<w:suff w:val="space"/>` +
      `<w:lvlText w:val="${esc(`${lv.prefix}%${i + 1}${lv.suffix}`)}"/><w:lvlJc w:val="left"/>` +
      `<w:pPr><w:ind w:left="0" w:hanging="0"/></w:pPr></w:lvl>`,
  ).join('') +
  `</w:abstractNum>`

const LIST_ABSTRACT = (list: IrListDef) =>
  `<w:abstractNum w:abstractNumId="${list.id}"><w:multiLevelType w:val="${list.levels.length > 1 ? 'multilevel' : 'singleLevel'}"/>` +
  list.levels
    .map((marker, lv) => {
      const [fmt, text] =
        marker === 'decimal' ? ['decimal', `%${lv + 1}.`] : ['bullet', bulletChar(lv)]
      return (
        `<w:lvl w:ilvl="${lv}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
        `<w:lvlText w:val="${esc(text)}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${twip(LIST_INDENT_PT * (lv + 1))}" w:hanging="${twip(LIST_INDENT_PT)}"/></w:pPr>` +
        `</w:lvl>`
      )
    })
    .join('') +
  `</w:abstractNum>`

/**
 * Word는 `numbering.xml`을 **문서 순서대로** 푼다 — `w:abstractNum`이 전부 먼저 오고,
 * 둘 다 id 오름차순이어야 한다. 개요 정의는 문서를 훑는 도중에 id를 받기 때문에
 * 예전에는 `abstractNum 3 · num 3 · abstractNum 1 · abstractNum 2 · num 1 · num 2` 꼴로
 * 나갔고, 그러면 **Word가 2수준부터 번호를 잃는다**(가.→1., 3수준은 아예 없음).
 * LibreOffice는 순서를 안 가려서 오래 안 들켰다. 정렬만 해 주면 살아난다 — 실기기 확인.
 */
const NUMBERING = (lists: IrListDef[], outlineId: number | null) => {
  const abstracts = lists.map((l) => ({ id: l.id, xml: LIST_ABSTRACT(l) }))
  const nums = lists.map((l) => ({ id: l.id, xml: `<w:num w:numId="${l.id}"><w:abstractNumId w:val="${l.id}"/></w:num>` }))
  if (outlineId !== null) {
    abstracts.push({ id: outlineId, xml: OUTLINE_ABSTRACT(outlineId) })
    nums.push({ id: outlineId, xml: `<w:num w:numId="${outlineId}"><w:abstractNumId w:val="${outlineId}"/></w:num>` })
  }
  const byId = (a: { id: number }, b: { id: number }) => a.id - b.id
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${abstracts
    .sort(byId)
    .map((a) => a.xml)
    .join('')}${nums
    .sort(byId)
    .map((n) => n.xml)
    .join('')}</w:numbering>`
}

/**
 * footnotes.xml. Word는 id -1(구분선)·0(이어짐 구분선) 두 개를 **먼저 요구한다** —
 * 없어도 열리기는 하지만 각주 영역 위 가로선이 사라진다. 본문 각주는 1부터.
 */
const FOOTNOTES = (bodies: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${NS}>
<w:footnote w:id="-1" w:type="separator"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:id="0" w:type="continuationSeparator"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
${bodies.map((b, i) => `<w:footnote w:id="${i + 1}">${b || '<w:p/>'}</w:footnote>`).join('')}
</w:footnotes>`

/** 임베드한 글꼴을 실제로 쓰게 하는 선언 — 없으면 Word가 무시할 수 있다 */
const SETTINGS = (embedded: boolean) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${
  embedded ? '<w:embedTrueTypeFonts/><w:saveSubsetFonts/>' : ''
}</w:settings>`

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
  /** 개요 번호 정의 id (없으면 null) — 제목 문단이 여기 묶인다 */
  private outlineId: number | null
  /** doc-footnote id → footnotes.xml의 w:id (1부터. -1·0은 구분선용 예약) */
  private footnoteIds = new Map<string, number>()

  constructor(outlineId: number | null, footnotes: IrFootnote[]) {
    this.outlineId = outlineId
    footnotes.forEach((fn, i) => this.footnoteIds.set(fn.id, i + 1))
  }

  footnoteId(ref: string): number | null {
    return this.footnoteIds.get(ref) ?? null
  }

  /** 그림을 패키지에 넣고 관계 id를 돌려준다 */
  imageRel(img: IrImage): string {
    // 그림과 링크가 같은 관계 목록을 쓰므로 번호는 목록 길이에서 뽑는다 (겹치면 문서가 안 열린다)
    const id = `rId${100 + this.rels.length}`
    const name = `image${this.media.length + 1}.${img.ext}`
    this.media.push({ name, bytes: base64ToBytes(img.base64) })
    this.rels.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`,
    )
    return id
  }

  /**
   * 하이퍼링크. 외부 주소는 관계(rels)로 나가고 `TargetMode="External"`이 필수다.
   * 문서 내 앵커(`#b7`)는 관계 없이 `w:anchor`로 — 다만 대응하는 책갈피는 아직 안 쓰므로
   * Word에서 눌러도 이동하지 않는다 (책갈피는 목차와 함께 온다).
   */
  hyperlinkXml(href: string, inner: string): string {
    if (href.startsWith('#')) return `<w:hyperlink w:anchor="${esc(href.slice(1))}">${inner}</w:hyperlink>`
    const id = `rId${100 + this.rels.length}`
    this.rels.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`,
    )
    return `<w:hyperlink r:id="${id}">${inner}</w:hyperlink>`
  }

  /**
   * 런을 링크 단위로 묶는다. `w:hyperlink`는 런을 감싸는 문단 수준 요소라
   * 같은 링크에 붙은 연속 런은 **한 덩어리로 감싸야** 워드에서 한 링크로 잡힌다.
   * (런 병합은 `sameStyle`이 link까지 보므로, 여기 오는 경계는 서식이 다른 경우뿐이다.)
   */
  runsXml(runs: IrRun[]): string {
    const out: string[] = []
    for (let i = 0; i < runs.length; ) {
      const link = runs[i].link
      let j = i
      while (j < runs.length && runs[j].link === link) j++
      const inner = runs
        .slice(i, j)
        .map((r) => this.runXml(r))
        .join('')
      out.push(link ? this.hyperlinkXml(link, inner) : inner)
      i = j
    }
    return out.join('')
  }

  mediaFiles() {
    return this.media
  }

  extensions() {
    return [...new Set(this.media.map((m) => m.name.split('.').pop() as string))]
  }

  documentRels(embedded = false, numbering = false, footnotes = false, hf = { header: false, footer: false }) {
    // 그림 관계는 rId100부터라 부품 관계는 rId1~은 자유롭게 쓴다
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const parts = [
      `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>`,
      `<Relationship Id="rId4" Type="${R}/settings" Target="settings.xml"/>`,
    ]
    if (numbering) parts.push(`<Relationship Id="rId6" Type="${R}/numbering" Target="numbering.xml"/>`)
    if (footnotes) parts.push(`<Relationship Id="rId7" Type="${R}/footnotes" Target="footnotes.xml"/>`)
    if (hf.header) parts.push(`<Relationship Id="${HEADER_REL}" Type="${R}/header" Target="header1.xml"/>`)
    if (hf.footer) parts.push(`<Relationship Id="${FOOTER_REL}" Type="${R}/footer" Target="footer1.xml"/>`)
    // 글꼴 파트는 fontTable.xml의 관계다 — document.xml.rels가 아니라 fontTable.xml.rels에 들어간다
    if (embedded) parts.push(`<Relationship Id="rId5" Type="${R}/fontTable" Target="fontTable.xml"/>`)
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.join('')}${this.rels.join('')}</Relationships>`
  }

  runXml(run: IrRun): string {
    // 쪽번호 — 글자가 아니라 필드다. Word가 렌더할 때 센다.
    // `w:fldSimple`은 문단 안에 바로 놓는 축약형이라 run 삼형제(begin/instrText/end)가 필요 없다.
    if (run.field) {
      const instr = run.field === 'pages' ? 'NUMPAGES' : 'PAGE'
      return `<w:fldSimple w:instr=" ${instr}   \\* MERGEFORMAT "><w:r><w:t>1</w:t></w:r></w:fldSimple>`
    }
    // 각주 참조 — 글자가 아니라 참조다. 번호는 Word가 센다.
    if (run.footnote) {
      const id = this.footnoteId(run.footnote)
      if (id === null) return ''
      return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
    }
    const pr: string[] = []
    if (run.family) {
      const f = esc(run.family)
      pr.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`)
    }
    if (run.bold) pr.push('<w:b/>')
    if (run.italic) pr.push('<w:i/>')
    if (run.strike) pr.push('<w:strike/>')
    if (run.underline || run.link) pr.push('<w:u w:val="single"/>')
    // 색을 직접 지정한 런은 그 색이 이긴다 (뷰어에서 인라인 style이 a 규칙을 이기는 것과 같다)
    if (run.color && run.color !== '#000000') pr.push(`<w:color w:val="${run.color.slice(1)}"/>`)
    else if (run.link) pr.push(`<w:color w:val="${LINK_COLOR_HEX}"/>`)
    if (run.vertAlign)
      pr.push(`<w:vertAlign w:val="${run.vertAlign === 'super' ? 'superscript' : 'subscript'}"/>`)
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
    // OOXML의 lineRule="auto"는 "글꼴의 자연 줄높이 × 배수"라서, CSS line-height(글자 크기 × 배수)
    // 보다 30%쯤 커진다(맑은 고딕 기준 자연 줄높이 ≈ 1.33em). 브라우저와 같게 보이려면
    // 문단에서 가장 큰 글자 크기를 재서 pt로 못박는다. 그림·큰 글자가 잘리지 않게 atLeast.
    const maxPt = para.runs.reduce((m, r) => Math.max(m, r.sizePt), 0) || 10
    // CT_PPr는 순서가 정해진 sequence다 — numPr은 spacing보다 앞이다
    const num = para.list
      ? { ilvl: para.list.level, id: para.list.id }
      : para.outline !== null && this.outlineId !== null
        ? { ilvl: Math.min(para.outline, OUTLINE_SCHEME.length) - 1, id: this.outlineId }
        : null
    const parts = num ? [`<w:numPr><w:ilvl w:val="${num.ilvl}"/><w:numId w:val="${num.id}"/></w:numPr>`] : []
    parts.push(lineSpacingXml(maxPt, para.spaceBeforePt, para.spaceAfterPt, para.heading > 0))
    if (jc && jc !== 'left') parts.push(`<w:jc w:val="${jc}"/>`)
    const ind = indentXml(para.indentPt, para.firstLinePt)
    if (ind) parts.push(ind)
    // 제목은 개요 수준을 명시한다 — 이게 없으면 Word가 제목으로 안 보고(탐색 창·목차),
    // 우리 리더도 다시 열 때 제목인 줄 모른다. CT_PPr에서 outlineLvl은 jc 뒤다.
    if (para.heading > 0) parts.push(`<w:outlineLvl w:val="${Math.min(para.heading, 9) - 1}"/>`)
    const pPr = `<w:pPr>${parts.join('')}</w:pPr>`
    const runs = this.runsXml(para.runs)
    const imgs = para.images.map((im) => this.imageXml(im, ++seq.n)).join('')
    return `<w:p>${pPr}${runs}${imgs}</w:p>`
  }

  tableXml(rows: IrCell[][], colWidthsPt: number[], seq: { n: number }): string {
    const grid = colWidthsPt.map((w) => `<w:gridCol w:w="${twip(w)}"/>`).join('')
    const total = twip(colWidthsPt.reduce((a, b) => a + b, 0))
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      // 뷰어 CSS는 1px solid #555 — sz는 1/8pt 단위라 6 = 0.75pt ≈ 1px
      .map((s) => `<w:${s} w:val="single" w:sz="6" w:space="0" w:color="555555"/>`)
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
        // CT_TcPr 순서 고정: tcW → gridSpan → vMerge → tcBorders → shd → tcMar → vAlign
        if (cell.colSpan > 1) pr.push(`<w:gridSpan w:val="${cell.colSpan}"/>`)
        if (cell.rowSpan > 1) pr.push('<w:vMerge w:val="restart"/>')
        pr.push(tcBordersXml(cell.border))
        if (cell.background) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${cell.background.slice(1)}"/>`)
        // tcMar를 안 쓰면 Word가 자기 기본 셀 여백(좌우 0.08in)을 넣는다 — 0이어도 명시한다
        const [mt, mr, mb, ml] = cell.paddingPt
        pr.push(
          `<w:tcMar><w:top w:type="dxa" w:w="${twip(mt)}"/><w:left w:type="dxa" w:w="${twip(ml)}"/>` +
            `<w:bottom w:type="dxa" w:w="${twip(mb)}"/><w:right w:type="dxa" w:w="${twip(mr)}"/></w:tcMar>`,
        )
        // Word 기본은 위 정렬이라 항상 명시한다. OOXML은 middle을 center라 부른다
        pr.push(`<w:vAlign w:val="${cell.vAlign === 'middle' ? 'center' : cell.vAlign}"/>`)
        const inner = this.blocksXml(cell.blocks, seq) || '<w:p/>'
        tcs.push(`<w:tc><w:tcPr>${pr.join('')}</w:tcPr>${inner}</w:tc>`)
        c += cell.colSpan
      }
      while (covered.has(`${r},${c}`)) {
        tcs.push(vMergeContinueCell(colWidthsPt[c] ?? 60))
        c++
      }
      // 행 높이 — 뷰어에서 td height는 최소 높이로 동작한다
      const hPt = row.reduce((m, cell) => (cell.rowSpan > 1 ? m : Math.max(m, cell.heightPt)), 0)
      const trPr = hPt > 0 ? `<w:trPr><w:trHeight w:val="${twip(hPt)}" w:hRule="atLeast"/></w:trPr>` : ''
      trs.push(`<w:tr>${trPr}${tcs.join('')}</w:tr>`)
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

/** IR HTML의 body → docx 바이트. embed를 주면 글꼴을 문서에 심는다. */
export function html2docx(root: Element, embed?: EmbeddedFont): DocxResult {
  const doc: IrDoc = readIr(root)
  const w = new DocxWriter(doc.outlineId, doc.footnotes)
  const seq = { n: 0 }

  // 구역이 여럿이면 페이지 나누기로 이어 붙인다 (docx 본문은 하나의 흐름)
  const bodies = doc.sections.map((s, i) => {
    const brk = i > 0 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''
    return brk + w.blocksXml(s.blocks, seq)
  })

  const first = doc.sections[0]
  const headerBody = first?.header ? w.blocksXml(first.header, seq) : null
  const footerBody = first?.footer ? w.blocksXml(first.footer, seq) : null
  const hfRefs =
    (headerBody === null ? '' : `<w:headerReference w:type="default" r:id="${HEADER_REL}"/>`) +
    (footerBody === null ? '' : `<w:footerReference w:type="default" r:id="${FOOTER_REL}"/>`)
  const sectPr =
    `<w:sectPr>${hfRefs}<w:pgSz w:w="${twip(first?.widthPt ?? 595)}" w:h="${twip(first?.heightPt ?? 842)}"/>` +
    `<w:pgMar w:top="${twip(first?.padTopPt ?? 72)}" w:right="${twip(first?.padRightPt ?? 72)}" ` +
    `w:bottom="${twip(first?.padBottomPt ?? 72)}" w:left="${twip(first?.padLeftPt ?? 72)}" ` +
    `w:header="${twip(HF_INSET_PT)}" w:footer="${twip(HF_INSET_PT)}" w:gutter="0"/></w:sectPr>`

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${bodies.join('')}${sectPr}</w:body></w:document>`

  const hasLists = doc.lists.length > 0 || doc.outlineId !== null
  const hasFootnotes = doc.footnotes.length > 0
  // 각주 본문도 같은 방출기를 쓴다 — 본문 뒤에 만들어야 그림 관계 id가 겹치지 않는다
  const footnoteBodies = doc.footnotes.map((fn) => w.blocksXml(fn.blocks, seq))
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      CONTENT_TYPES(w.extensions(), !!embed, hasLists, hasFootnotes, {
        header: headerBody !== null,
        footer: footerBody !== null,
      }),
    ),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(STYLES),
    'word/settings.xml': strToU8(SETTINGS(!!embed)),
    'word/_rels/document.xml.rels': strToU8(
      w.documentRels(!!embed, hasLists, hasFootnotes, {
        header: headerBody !== null,
        footer: footerBody !== null,
      }),
    ),
  }
  if (hasLists) files['word/numbering.xml'] = strToU8(NUMBERING(doc.lists, doc.outlineId))
  if (hasFootnotes) files['word/footnotes.xml'] = strToU8(FOOTNOTES(footnoteBodies))
  if (headerBody !== null) files['word/header1.xml'] = strToU8(HEADER_FOOTER('hdr', headerBody))
  if (footerBody !== null) files['word/footer1.xml'] = strToU8(HEADER_FOOTER('ftr', footerBody))
  for (const m of w.mediaFiles()) files[`word/media/${m.name}`] = m.bytes

  // 글꼴 파트는 난독화된 .odttf로만 받아들여진다 (ECMA-376 §17.8.1)
  if (embed) {
    const faces: string[] = []
    const fontRels: string[] = []
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    const add = (tag: 'embedRegular' | 'embedBold', bytes: Uint8Array, rid: string, file: string) => {
      const key = fontKeyFor(`${embed.family}:${tag}:${bytes.length}`)
      files[`word/fonts/${file}`] = obfuscateFont(bytes, key)
      faces.push(`<w:${tag} r:id="${rid}" w:fontKey="${key}" w:subsetted="1"/>`)
      fontRels.push(`<Relationship Id="${rid}" Type="${R}/font" Target="fonts/${file}"/>`)
    }
    add('embedRegular', embed.regular, 'rId1', 'font1.odttf')
    if (embed.bold) add('embedBold', embed.bold, 'rId2', 'font2.odttf')
    files['word/_rels/fontTable.xml.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${fontRels.join('')}</Relationships>`,
    )
    files['word/fontTable.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:font w:name="${esc(embed.family)}"><w:charset w:val="81"/><w:family w:val="swiss"/><w:pitch w:val="variable"/>${faces.join('')}</w:font>
</w:fonts>`,
    )
  }

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
