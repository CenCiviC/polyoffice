/**
 * IR(HTML) → hwpx (OWPML, KS X 6101) 쓰기 백엔드.
 *
 * 전략: 템플릿+주입 (docs/IR-SPEC.md v0.2 로드맵)
 * - blank.hwpx(MIT, pypandoc-hwpx)를 템플릿으로 쓰고,
 * - Contents/section0.xml 본문을 IR에서 생성해 교체,
 * - Contents/header.xml에 charPr(글자모양)·paraPr(문단모양)·borderFill만 추가 등록.
 * - 페이지 설정(secPr)은 템플릿 첫 문단의 run을 추출해 우리 첫 문단에 이식.
 *
 * 단위: 1pt = 100 hwpunit. charPr height = pt×100. 색 = #RRGGBB.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function rgbToHex(rgb: string): string | null {
  const m = rgb.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  if (!m) return rgb.startsWith('#') ? rgb : null
  return (
    '#' +
    [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0').toUpperCase()).join('')
  )
}

function ptOf(v: string | undefined | null): number | null {
  if (!v) return null
  const m = v.match(/([\d.]+)\s*(pt|in|mm)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (m[2] === 'in') return n * 72
  if (m[2] === 'mm') return n * 2.8346
  return n
}

interface CharStyle {
  sizePt: number
  color: string // #RRGGBB
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** 형광펜(음영) — #RRGGBB 또는 null */
  shade: string | null
  /** 첫 번째 font-family (없으면 null → 템플릿 기본 폰트) */
  family: string | null
}

const CHARPR_TMPL = (id: number, s: CharStyle, fontId: number) => `<hh:charPr id="${id}" height="${Math.round(
  s.sizePt * 100,
)}" textColor="${s.color}" shadeColor="${s.shade ?? 'none'}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">
<hh:fontRef hangul="${fontId}" latin="${fontId}" hanja="${fontId}" japanese="${fontId}" other="${fontId}" symbol="${fontId}" user="${fontId}"/>
<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
<hh:underline type="${s.underline ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="#000000"/>
<hh:strikeout shape="${s.strike ? 'SOLID' : 'NONE'}" color="#000000"/>
<hh:outline type="NONE"/>
<hh:shadow type="NONE" color="#C0C0C0" offsetX="5" offsetY="5"/>${s.bold ? '\n<hh:bold/>' : ''}${
  s.italic ? '\n<hh:italic/>' : ''
}
</hh:charPr>`

const BORDERFILL_TMPL = (id: number, fill: string | null) => `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
<hh:slash type="NONE" Crooked="0" isCounter="0"/>
<hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
<hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>
<hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>
<hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>
<hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>
<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>
<hc:fillBrush>
<hc:winBrush faceColor="${fill ?? 'none'}" hatchColor="#000000" alpha="0"/>
</hc:fillBrush>
</hh:borderFill>`

class HwpxWriter {
  private charPrs = new Map<string, number>()
  private paraPrs = new Map<string, number>()
  private borderFills = new Map<string, number>()
  private newCharPrXml: string[] = []
  private newParaPrXml: string[] = []
  private newBorderFillXml: string[] = []
  private nextCharPrId: number
  private nextParaPrId: number
  private nextBorderFillId: number
  private objId = 90_000_000 // tbl/subList 등 개체 id (문서 내 유일하면 됨)
  private baseParaPrXml: string
  private headerXml: string
  private binItems: { name: string; ext: string; b64: string }[] = []
  private fontRegistry = new Map<string, number>()
  private newFonts: { id: number; face: string }[] = []
  private nextFontId = 0

  constructor(headerXml: string) {
    this.headerXml = headerXml
    this.nextCharPrId = this.maxId(/<hh:charPr id="(\d+)"/g) + 1
    this.nextParaPrId = this.maxId(/<hh:paraPr id="(\d+)"/g) + 1
    this.nextBorderFillId = this.maxId(/<hh:borderFill id="(\d+)"/g) + 1
    const base = headerXml.match(/<hh:paraPr id="0".*?<\/hh:paraPr>/s)
    if (!base) throw new Error('템플릿 header.xml에 paraPr id=0 없음')
    this.baseParaPrXml = base[0]

    // 템플릿의 기존 폰트 등록 정보 (HANGUL 그룹 기준 — 그룹 간 동일 가정)
    const hangul = headerXml.match(/<hh:fontface lang="HANGUL"[^>]*>([\s\S]*?)<\/hh:fontface>/)
    for (const fm of (hangul?.[1] ?? '').matchAll(/<hh:font id="(\d+)" face="([^"]+)"/g)) {
      this.fontRegistry.set(fm[2], Number(fm[1]))
      this.nextFontId = Math.max(this.nextFontId, Number(fm[1]) + 1)
    }
  }

  /** font-family → 폰트 id. 미등록 폰트는 7개 언어 그룹 전부에 신규 등록 */
  fontId(family: string | null): number {
    if (!family) return 0
    const face = family.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
    if (!face) return 0
    let id = this.fontRegistry.get(face)
    if (id === undefined) {
      id = this.nextFontId++
      this.fontRegistry.set(face, id)
      this.newFonts.push({ id, face })
    }
    return id
  }

  private binDedup = new Map<string, string>()

  /** 이미지 바이너리 등록 → binaryItemIDRef로 쓸 이름 반환. 동일 바이너리는 재사용(dedup) */
  addBinData(ext: string, b64: string): string {
    const key = `${ext}:${b64}`
    const existing = this.binDedup.get(key)
    if (existing) return existing
    const name = `img${this.binItems.length + 1}`
    this.binItems.push({ name, ext, b64 })
    this.binDedup.set(key, name)
    return name
  }

  binFiles(): { path: string; bytes: Uint8Array }[] {
    return this.binItems.map((item) => {
      const bin = atob(item.b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return { path: `BinData/${item.name}.${item.ext}`, bytes }
    })
  }

  private maxId(re: RegExp): number {
    let max = 0
    for (const m of this.headerXml.matchAll(re)) max = Math.max(max, Number(m[1]))
    return max
  }

  charPrId(s: CharStyle): number {
    const key = JSON.stringify(s)
    let id = this.charPrs.get(key)
    if (id === undefined) {
      id = this.nextCharPrId++
      this.charPrs.set(key, id)
      this.newCharPrXml.push(CHARPR_TMPL(id, s, this.fontId(s.family)))
    }
    return id
  }

  /** 기본형은 템플릿 paraPr 0 재사용, 정렬/줄간격이 다르면 paraPr 0을 복제해 해당 값만 교체 */
  paraPrId(align: string, lineHeight?: number | null): number {
    const horizontal = align === 'center' ? 'CENTER' : align === 'right' ? 'RIGHT' : 'LEFT'
    // CSS line-height 비율 ≈ 한글 줄간격 PERCENT (1.5 → 150%)
    const percent = lineHeight ? Math.round(lineHeight * 100) : null
    if (horizontal === 'LEFT' && percent === null) return 0
    const key = `${horizontal}|${percent ?? ''}`
    let id = this.paraPrs.get(key)
    if (id === undefined) {
      id = this.nextParaPrId++
      this.paraPrs.set(key, id)
      let xml = this.baseParaPrXml
        .replace(/id="0"/, `id="${id}"`)
        .replace(/horizontal="[A-Z]+"/, `horizontal="${horizontal}"`)
      if (percent !== null)
        xml = xml.replace(/lineSpacing type="PERCENT" value="\d+"/g, `lineSpacing type="PERCENT" value="${percent}"`)
      this.newParaPrXml.push(xml)
    }
    return id
  }

  borderFillId(fillHex: string | null): number {
    const key = fillHex ?? 'none'
    let id = this.borderFills.get(key)
    if (id === undefined) {
      id = this.nextBorderFillId++
      this.borderFills.set(key, id)
      this.newBorderFillXml.push(BORDERFILL_TMPL(id, fillHex))
    }
    return id
  }

  nextObjId(): number {
    return ++this.objId
  }

  addedCounts() {
    return {
      charPr: this.newCharPrXml.length,
      paraPr: this.newParaPrXml.length,
      borderFill: this.newBorderFillXml.length,
    }
  }

  /** header.xml에 신규 항목 삽입 + itemCnt 갱신 */
  patchHeader(): string {
    let xml = this.headerXml
    // 신규 폰트: 7개 언어 그룹 전부에 등록 + 그룹별 fontCnt 갱신
    if (this.newFonts.length) {
      const entries = this.newFonts
        .map((f) => `<hh:font id="${f.id}" face="${esc(f.face)}" type="TTF" isEmbedded="0"/>`)
        .join('')
      xml = xml.replace(
        /(<hh:fontface lang="[A-Z]+" fontCnt=")(\d+)(">)/g,
        (_, a, cnt, b) => `${a}${Number(cnt) + this.newFonts.length}${b}`,
      )
      xml = xml.replace(/<\/hh:fontface>/g, `${entries}</hh:fontface>`)
    }
    const patch = (closeTag: string, items: string[], cntTag: string) => {
      if (!items.length) return
      xml = xml.replace(closeTag, items.join('\n') + closeTag)
      xml = xml.replace(new RegExp(`<hh:${cntTag} itemCnt="(\\d+)"`), (_, n) => {
        return `<hh:${cntTag} itemCnt="${Number(n) + items.length}"`
      })
    }
    patch('</hh:charProperties>', this.newCharPrXml, 'charProperties')
    patch('</hh:paraProperties>', this.newParaPrXml, 'paraProperties')
    patch('</hh:borderFills>', this.newBorderFillXml, 'borderFills')
    return xml
  }
}

/** span의 computed-ish 스타일 → CharStyle (IR 어휘만 해석) */
function charStyleOf(el: Element | null): CharStyle {
  const style = el?.getAttribute('style') ?? ''
  const get = (prop: string) => {
    const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))
    return m ? m[1].trim() : null
  }
  const deco = get('text-decoration') ?? ''
  const bg = get('background')
  return {
    sizePt: ptOf(get('font-size')) ?? 10,
    color: rgbToHex(get('color') ?? '') ?? '#000000',
    bold: (get('font-weight') ?? '') === 'bold',
    italic: (get('font-style') ?? '') === 'italic',
    underline: deco.includes('underline'),
    strike: deco.includes('line-through'),
    shade: bg ? rgbToHex(bg) : null,
    family: get('font-family'),
  }
}

function tdStyle(el: Element, prop: string): string | null {
  const style = el.getAttribute('style') ?? ''
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))
  return m ? m[1].trim() : null
}

class SectionBuilder {
  private w: HwpxWriter
  /** doc-footnote id → 내용 요소 (본문 흐름에서 제외하고 참조 지점에 인라인 삽입) */
  footnotes = new Map<string, Element>()

  constructor(w: HwpxWriter) {
    this.w = w
  }

  /** <hp:t> 내용: 텍스트 + <br>→<hp:lineBreak/> */
  private textXml(node: Node): string {
    let out = ''
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) out += esc(child.textContent ?? '')
      else if ((child as Element).tagName === 'BR') out += '<hp:lineBreak/>'
      else out += this.textXml(child) // 중첩 인라인은 텍스트만 취함
    }
    return out
  }

  private runsXml(p: Element, defaultStyle?: CharStyle): string {
    const defaultCharPr = defaultStyle ? this.w.charPrId(defaultStyle) : 0
    const runs: string[] = []
    for (const child of Array.from(p.childNodes)) {
      if (child.nodeType === 3) {
        const t = child.textContent ?? ''
        if (t) runs.push(`<hp:run charPrIDRef="${defaultCharPr}"><hp:t>${esc(t)}</hp:t></hp:run>`)
        continue
      }
      const el = child as Element
      if (el.tagName === 'SPAN') {
        const id = this.w.charPrId(charStyleOf(el))
        runs.push(`<hp:run charPrIDRef="${id}"><hp:t>${this.textXml(el)}</hp:t></hp:run>`)
      } else if (el.tagName === 'BR') {
        runs.push(`<hp:run charPrIDRef="${defaultCharPr}"><hp:t><hp:lineBreak/></hp:t></hp:run>`)
      } else if (el.tagName === 'IMG') {
        const pic = this.imageXml(el)
        if (pic) runs.push(pic)
      } else if (el.tagName === 'SUP') {
        // 각주 참조 → hp:footNote 컨트롤 (내용을 참조 지점에 인라인 삽입, pypandoc 패턴)
        const ref = el.querySelector('a[data-fn-ref]')?.getAttribute('data-fn-ref')
        const content = ref ? this.footnotes.get(ref) : undefined
        if (content) {
          const inst = this.w.nextObjId()
          runs.push(
            `<hp:run charPrIDRef="0"><hp:ctrl><hp:footNote number="0" instId="${inst}">` +
              `<hp:autoNum num="0" numType="FOOTNOTE"/>` +
              `<hp:subList id="${inst}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${this.blockChildrenXml(content)}</hp:subList>` +
              `</hp:footNote></hp:ctrl></hp:run>`,
          )
        }
      }
    }
    return runs.length ? runs.join('') : `<hp:run charPrIDRef="${defaultCharPr}"><hp:t/></hp:run>`
  }

  /** data URI 이미지 → zip의 BinData 항목 + hp:pic run (pypandoc-hwpx 검증 패턴) */
  private imageXml(img: Element): string | null {
    const src = img.getAttribute('src') ?? ''
    const m = src.match(/^data:image\/(\w+);base64,(.+)$/s)
    if (!m) return null
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    const name = this.w.addBinData(ext, m[2])
    const wPt = ptOf(tdStyle(img, 'width')) ?? 200
    const hPt = ptOf(tdStyle(img, 'height')) ?? 150
    const w = Math.round(wPt * 100)
    const h = Math.round(hPt * 100)
    return (
      `<hp:run charPrIDRef="0">` +
      `<hp:pic id="${this.w.nextObjId()}" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${this.w.nextObjId()}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/>` +
      `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="0" centerY="0" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
      `<hc:img binaryItemIDRef="${name}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:imgDim dimwidth="0" dimheight="0"/><hp:effects/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment/>` +
      `</hp:pic></hp:run>`
    )
  }

  paragraphXml(p: Element, extraFirstRun = '', opts?: { pageBreak?: boolean; defaultStyle?: CharStyle }): string {
    const align = tdStyle(p, 'text-align') ?? 'left'
    const lh = tdStyle(p, 'line-height')
    const paraPr = this.w.paraPrId(align, lh ? parseFloat(lh) : null)
    return `<hp:p paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${opts?.pageBreak ? 1 : 0}" columnBreak="0" merged="0">${extraFirstRun}${this.runsXml(p, opts?.defaultStyle)}</hp:p>`
  }

  /** rowspan/colspan 점유를 시뮬레이션해 colAddr 계산 */
  tableXml(table: Element): string {
    const rows = Array.from(table.querySelectorAll('tr')).filter(
      (tr) => tr.closest('table') === table,
    )
    const occupied = new Map<string, boolean>() // "row,col"
    const cellsXml: string[][] = []
    let colCnt = 0

    rows.forEach((tr, r) => {
      const rowXml: string[] = []
      let c = 0
      for (const td of Array.from(tr.children).filter((x) => x.tagName === 'TD')) {
        while (occupied.get(`${r},${c}`)) c++
        const colSpan = Number(td.getAttribute('colspan') ?? 1)
        const rowSpan = Number(td.getAttribute('rowspan') ?? 1)
        for (let rr = r; rr < r + rowSpan; rr++)
          for (let cc = c; cc < c + colSpan; cc++) occupied.set(`${rr},${cc}`, true)

        const wPt = ptOf(tdStyle(td, 'width')) ?? 100
        const hPt = ptOf(tdStyle(td, 'height')) ?? 15
        const bg = tdStyle(td, 'background')
        const bfId = this.w.borderFillId(bg ? rgbToHex(bg) : null)

        const inner = this.blockChildrenXml(td)
        rowXml.push(
          `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${bfId}">` +
            `<hp:subList id="${this.w.nextObjId()}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>` +
            `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>` +
            `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
            `<hp:cellSz width="${Math.round(wPt * 100)}" height="${Math.round(hPt * 100)}"/>` +
            `<hp:cellMargin left="510" right="510" top="141" bottom="141"/>`,
        )
        rowXml[rowXml.length - 1] += `</hp:tc>`
        c += colSpan
      }
      colCnt = Math.max(colCnt, c)
      cellsXml.push(rowXml)
    })

    // 표 전체 너비 = 1행 셀 너비 합
    const firstRowWidth = Array.from(rows[0]?.children ?? [])
      .filter((x) => x.tagName === 'TD')
      .reduce((sum, td) => sum + (ptOf(tdStyle(td as Element, 'width')) ?? 100), 0)
    const defaultBf = this.w.borderFillId(null)

    return (
      `<hp:tbl id="${this.w.nextObjId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${defaultBf}" noAdjust="0">` +
      `<hp:sz width="${Math.round(firstRowWidth * 100)}" widthRelTo="ABSOLUTE" height="1000" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="141" bottom="141"/>` +
      `<hp:inMargin left="510" right="510" top="141" bottom="141"/>` +
      cellsXml.map((row) => `<hp:tr>${row.join('')}</hp:tr>`).join('') +
      `</hp:tbl>`
    )
  }

  /** td/doc-section 공통: 블록 자식들(p, h1-6, ul/ol, doc-pagebreak, table) → 문단 XML 나열 */
  blockChildrenXml(container: Element, extraFirstRun = ''): string {
    // 제목 강등 스타일: 진하게 + 수준별 크기 (IR 스펙 — 번호 스킴은 v0.3)
    const HEADING_PT: Record<string, number> = { H1: 16, H2: 14, H3: 13, H4: 12, H5: 12, H6: 12 }
    const out: string[] = []
    let first = true
    let pendingBreak = false

    for (const el of Array.from(container.children)) {
      const injected = first ? extraFirstRun : ''
      const tag = el.tagName

      if (tag === 'DOC-PAGEBREAK') {
        pendingBreak = true
        continue
      }
      if (tag === 'DOC-FOOTNOTE') continue // 참조 지점(sup>a)에서 인라인 처리됨

      if (tag === 'P' || tag in HEADING_PT) {
        const defaultStyle: CharStyle | undefined =
          tag in HEADING_PT
            ? { sizePt: HEADING_PT[tag], color: '#000000', bold: true, italic: false, underline: false, strike: false, shade: null, family: null }
            : undefined
        out.push(this.paragraphXml(el, injected, { pageBreak: pendingBreak, defaultStyle }))
        first = false
        pendingBreak = false
      } else if (tag === 'UL' || tag === 'OL') {
        // 목록 강등: 글머리표/번호를 텍스트 접두로 (한글 numbering 매핑은 v0.3)
        let n = 0
        for (const li of Array.from(el.children).filter((x) => x.tagName === 'LI')) {
          n++
          const prefix = tag === 'UL' ? '• ' : `${n}. `
          out.push(
            `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="${pendingBreak ? 1 : 0}" columnBreak="0" merged="0">${first ? extraFirstRun : ''}<hp:run charPrIDRef="0"><hp:t>${esc(prefix)}</hp:t></hp:run>${this.runsXml(li)}</hp:p>`,
          )
          first = false
          pendingBreak = false
        }
      } else if (tag === 'TABLE') {
        // 표는 자체 문단의 run에 실린다. 첫 블록이면 페이지설정 run을 같은 문단에 이식.
        out.push(
          `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="${pendingBreak ? 1 : 0}" columnBreak="0" merged="0">${injected}<hp:run charPrIDRef="0">${this.tableXml(el)}<hp:t/></hp:run></hp:p>`,
        )
        first = false
        pendingBreak = false
      }
    }
    if (pendingBreak)
      out.push(`<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="1" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`)
    if (!out.length)
      out.push(
        `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${extraFirstRun}<hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`,
      )
    return out.join('')
  }
}

export interface HwpxResult {
  data: Uint8Array
  added: { charPr: number; paraPr: number; borderFill: number }
}

/**
 * IR HTML 루트(doc-section들을 담은 컨테이너 요소) → .hwpx 바이너리.
 * template = blank.hwpx 바이트.
 */
export function html2hwpx(root: Element, template: Uint8Array): HwpxResult {
  const files = unzipSync(template)
  const headerXml = strFromU8(files['Contents/header.xml'])
  const sectionXml = strFromU8(files['Contents/section0.xml'])

  // 템플릿에서 페이지 설정 run(secPr + colPr ctrl) 추출 → 우리 첫 문단에 이식
  const secPrIdx = sectionXml.indexOf('<hp:secPr')
  if (secPrIdx < 0) throw new Error('템플릿 section0.xml에 secPr 없음')
  const runStart = sectionXml.lastIndexOf('<hp:run', secPrIdx)
  const runEnd = sectionXml.indexOf('</hp:run>', secPrIdx) + '</hp:run>'.length
  const setupRun = sectionXml.slice(runStart, runEnd)

  const secOpenEnd = sectionXml.indexOf('>', sectionXml.indexOf('<hs:sec')) + 1
  let prefix = sectionXml.slice(0, secOpenEnd)
  // 이미지(hc:img 등)가 쓰는 hc 네임스페이스를 루트에 보장 — 템플릿(blank)에는 없음
  if (!prefix.includes('xmlns:hc=')) {
    prefix = prefix.replace(
      /<hs:sec /,
      '<hs:sec xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ',
    )
  }

  const writer = new HwpxWriter(headerXml)
  const builder = new SectionBuilder(writer)

  // 각주 내용 수집 (본문 흐름에서 제외, 참조 지점에 인라인)
  for (const fn of Array.from(root.querySelectorAll('doc-footnote'))) {
    const id = fn.getAttribute('id')
    if (id) builder.footnotes.set(id, fn)
  }

  // doc-section이 있으면 그 안의 블록을, 없으면 root 직계 블록을 사용
  const sections = Array.from(root.querySelectorAll('doc-section'))
  const container = sections.length ? sections[0] : root
  // v0: 다중 섹션은 첫 섹션의 페이지 설정으로 병합 (섹션별 secPr는 v0.3)
  let body = builder.blockChildrenXml(container, setupRun)
  for (const extra of sections.slice(1)) {
    body += builder.blockChildrenXml(extra)
  }

  const newSection = `${prefix}\n${body}\n</hs:sec>`
  const newHeader = writer.patchHeader()

  // zip 재조립 — mimetype은 반드시 첫 항목 + 무압축(STORED)
  const out: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    mimetype: [files['mimetype'], { level: 0 }],
  }
  for (const [name, data] of Object.entries(files)) {
    if (name === 'mimetype') continue
    if (name === 'Contents/section0.xml') out[name] = [strToU8(newSection), { level: 6 }]
    else if (name === 'Contents/header.xml') out[name] = [strToU8(newHeader), { level: 6 }]
    else out[name] = [data, { level: 6 }]
  }
  // 이미지 바이너리 (이미 압축 포맷이므로 무압축 저장)
  for (const { path, bytes } of writer.binFiles()) out[path] = [bytes, { level: 0 }]

  return { data: zipSync(out), added: writer.addedCounts() }
}
