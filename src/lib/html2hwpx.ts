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

import { DEFAULT_LINE_HEIGHT, HEADING_SPACE, xmlSafe } from './ir-model'
import type { EmbeddedFont } from './font-embed'

/**
 * 템플릿(blank.hwpx)의 기본 문단모양을 IR 기준으로 맞춘다.
 * 템플릿 값은 줄간격 180% · 문단 뒤 여백 1000 hwpunit(10pt)이라, 그대로 두면
 * 같은 IR인데 hwpx만 docx/odt보다 세로로 훨씬 길어진다(문단 수 × 10pt).
 */
function patchBaseParaPr(headerXml: string): string {
  const percent = Math.round(DEFAULT_LINE_HEIGHT * 100)
  return headerXml.replace(/<hh:paraPr id="0".*?<\/hh:paraPr>/s, (block) =>
    block
      .replace(/lineSpacing type="PERCENT" value="\d+"/g, `lineSpacing type="PERCENT" value="${percent}"`)
      .replace(/(<hc:prev value=")\d+(")/, '$10$2')
      .replace(/(<hc:next value=")\d+(")/, '$10$2')
      .replace(/snapToGrid="1"/, 'snapToGrid="0"')
      // 한글도 어절 단위로 끊는다 (템플릿 기본은 글자 단위 — Word·뷰어와 줄 수가 달라진다)
      .replace(/breakNonLatinWord="\w+"/, 'breakNonLatinWord="KEEP_WORD"'),
  )
}

const esc = (s: string) =>
  xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

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
  // 부호를 반드시 받는다 — 내어쓰기(text-indent 음수)에서 -가 빠지면 값이 조용히 뒤집힌다
  const m = v.match(/(-?[\d.]+)\s*(pt|in|mm)?/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (m[2] === 'in') return n * 72
  if (m[2] === 'mm') return n * 2.8346
  return n
}

/** 문단 여백(pt) — paraPr `<hh:margin>`에 실린다 */
interface ParaMargins {
  indentPt: number
  /** 첫 줄 — 음수면 내어쓰기 */
  firstLinePt: number
  beforePt: number
  afterPt: number
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
  /** 위/아래첨자 — charPr의 무속성 자식 `<hh:supscript/>` `<hh:subscript/>` */
  vertAlign: 'super' | 'sub' | null
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
}${s.vertAlign === 'super' ? '\n<hh:supscript/>' : s.vertAlign === 'sub' ? '\n<hh:subscript/>' : ''}
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
    this.headerXml = patchBaseParaPr(headerXml)
    headerXml = this.headerXml
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

  /**
   * 기본형은 템플릿 paraPr 0 재사용, 정렬/줄간격/여백이 다르면 paraPr 0을 복제해 해당 값만 교체.
   *
   * 여백은 paraPr의 `<hh:margin>` 자식들이다 (실물 hwpx로 확인):
   * `<hc:intent>` 첫 줄 · `<hc:left>` 왼쪽 · `<hc:prev>`/`<hc:next>` 문단 앞뒤. 단위는 HWPUNIT(pt×100).
   * 템플릿에 이 다섯이 이미 있으므로 값만 갈아끼운다.
   */
  paraPrId(align: string, lineHeight?: number | null, heading = false, margins?: ParaMargins): number {
    const horizontal = align === 'center' ? 'CENTER' : align === 'right' ? 'RIGHT' : 'LEFT'
    // CSS line-height 비율 ≈ 한글 줄간격 PERCENT (1.5 → 150%)
    const percent = lineHeight ? Math.round(lineHeight * 100) : heading ? Math.round(HEADING_SPACE.lineHeight * 100) : null
    const m = margins ?? { indentPt: 0, firstLinePt: 0, beforePt: 0, afterPt: 0 }
    const plainMargins = !m.indentPt && !m.firstLinePt && !m.beforePt && !m.afterPt
    if (horizontal === 'LEFT' && percent === null && !heading && plainMargins) return 0
    const key = `${horizontal}|${percent ?? ''}|${heading ? 'h' : ''}|${m.indentPt}|${m.firstLinePt}|${m.beforePt}|${m.afterPt}`
    let id = this.paraPrs.get(key)
    if (id === undefined) {
      id = this.nextParaPrId++
      this.paraPrs.set(key, id)
      let xml = this.baseParaPrXml
        .replace(/id="0"/, `id="${id}"`)
        .replace(/horizontal="[A-Z]+"/, `horizontal="${horizontal}"`)
      if (percent !== null)
        xml = xml.replace(/lineSpacing type="PERCENT" value="\d+"/g, `lineSpacing type="PERCENT" value="${percent}"`)
      // 앞뒤 여백·들여쓰기는 IR이 준 값 그대로 (제목 기본값은 ir-model의 readPara가 채워 준다)
      xml = xml
        .replace(/(<hc:intent value=")-?\d+(")/g, `$1${hwpUnit(m.firstLinePt)}$2`)
        .replace(/(<hc:left value=")-?\d+(")/g, `$1${hwpUnit(m.indentPt)}$2`)
        .replace(/(<hc:prev value=")-?\d+(")/g, `$1${hwpUnit(m.beforePt)}$2`)
        .replace(/(<hc:next value=")-?\d+(")/g, `$1${hwpUnit(m.afterPt)}$2`)
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

  /** 임베드한 글꼴 이름 → BinData 항목 이름 (fontface에 isEmbedded="1"로 표시) */
  embeddedFace: { face: string; item: string } | null = null

  /** header.xml에 신규 항목 삽입 + itemCnt 갱신 */
  patchHeader(): string {
    let xml = this.headerXml
    // 신규 폰트: 7개 언어 그룹 전부에 등록 + 그룹별 fontCnt 갱신
    if (this.newFonts.length) {
      const entries = this.newFonts
        .map((f) =>
          this.embeddedFace && f.face === this.embeddedFace.face
            ? `<hh:font id="${f.id}" face="${esc(f.face)}" type="TTF" isEmbedded="1" binaryItemIDRef="${this.embeddedFace.item}"/>`
            : `<hh:font id="${f.id}" face="${esc(f.face)}" type="TTF" isEmbedded="0"/>`,
        )
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
    vertAlign: null,
  }
}

/**
 * 문단 여백을 인라인 style에서 읽는다 (ir-model.readPara와 같은 규칙).
 * 제목은 IR에 안 적혀 있을 때만 뷰어 CSS와 같은 기본값으로 채운다 — 백엔드 셋이 같은 값을 내야 한다.
 */
function marginsOf(p: Element, heading: boolean): ParaMargins {
  return {
    indentPt: ptOf(tdStyle(p, 'margin-left')) ?? 0,
    firstLinePt: ptOf(tdStyle(p, 'text-indent')) ?? 0,
    beforePt: ptOf(tdStyle(p, 'margin-top')) ?? (heading ? HEADING_SPACE.beforePt : 0),
    afterPt: ptOf(tdStyle(p, 'margin-bottom')) ?? (heading ? HEADING_SPACE.afterPt : 0),
  }
}

/** 1pt = 100 hwpunit */
const hwpUnit = (pt: number) => Math.round(pt * 100)

/** CSS padding 단축 표기 → [상, 우, 하, 좌] (pt). ir-model.readPadding과 같은 규칙. */
function paddingOf(el: Element): [number, number, number, number] {
  const parts = (tdStyle(el, 'padding') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((v) => ptOf(v) ?? 0)
  const [top = 0, right = top, bottom = top, left = right] = parts
  return [top, right, bottom, left]
}

/**
 * 템플릿 secPr의 페이지 설정을 IR doc-section 값으로 교체한다.
 * 이걸 안 하면 hwpx만 템플릿 고정값(위 0.59in + 머리말 0.59in …)을 써서
 * 같은 IR인데 docx/odt와 본문 영역이 달라진다. 머리말/꼬리말은 아직 안 만들므로
 * 0으로 두고 그만큼을 위/아래 여백에 그대로 준다.
 */
function patchPagePr(run: string, section: Element): string {
  const w = ptOf(tdStyle(section, 'width'))
  const h = ptOf(tdStyle(section, 'min-height') ?? tdStyle(section, 'height'))
  if (!w || !h) return run
  const [top, right, bottom, left] = tdStyle(section, 'padding') ? paddingOf(section) : [72, 72, 72, 72]
  return run
    .replace(/(<hp:pagePr[^>]*\bwidth=")\d+(")/, `$1${hwpUnit(w)}$2`)
    .replace(/(<hp:pagePr[^>]*\bheight=")\d+(")/, `$1${hwpUnit(h)}$2`)
    .replace(
      /<hp:margin\b[^>]*\/>/,
      `<hp:margin header="0" footer="0" gutter="0" left="${hwpUnit(left)}" ` +
        `right="${hwpUnit(right)}" top="${hwpUnit(top)}" bottom="${hwpUnit(bottom)}"/>`,
    )
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
    const runs = this.inlineRuns(p, defaultStyle ?? charStyleOf(null), defaultCharPr, null)
    return runs.length ? runs.join('') : `<hp:run charPrIDRef="${defaultCharPr}"><hp:t/></hp:run>`
  }

  /**
   * 인라인 자식 → hp:run 목록.
   *
   * `<a>`·`<sup>`·`<sub>`는 안쪽에 다시 `<span>`을 품을 수 있어서 재귀한다. 재귀하지 않으면
   * **그 안의 글자가 통째로 사라진다** — 예전에는 이 셋에 해당하는 분기가 없어서
   * 링크 텍스트가 조용히 없어졌다.
   *
   * `vertAlign`은 조상에서 물려받아 안쪽 런의 charPr에 얹는다.
   */
  private inlineRuns(
    parent: Element,
    inherited: CharStyle,
    defaultCharPr: number,
    vertAlign: 'super' | 'sub' | null,
  ): string[] {
    const runs: string[] = []
    /** 첨자가 걸려 있으면 기본 charPr을 그대로 못 쓴다 — 첨자를 얹은 것을 따로 등록한다 */
    const plainId = () => (vertAlign ? this.w.charPrId({ ...inherited, vertAlign }) : defaultCharPr)

    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) {
        const t = child.textContent ?? ''
        if (t) runs.push(`<hp:run charPrIDRef="${plainId()}"><hp:t>${esc(t)}</hp:t></hp:run>`)
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      if (el.tagName === 'SPAN') {
        const id = this.w.charPrId({ ...charStyleOf(el), vertAlign })
        runs.push(`<hp:run charPrIDRef="${id}"><hp:t>${this.textXml(el)}</hp:t></hp:run>`)
      } else if (el.tagName === 'BR') {
        runs.push(`<hp:run charPrIDRef="${plainId()}"><hp:t><hp:lineBreak/></hp:t></hp:run>`)
      } else if (el.tagName === 'IMG') {
        const pic = this.imageXml(el)
        if (pic) runs.push(pic)
      } else if (el.tagName === 'SUP' || el.tagName === 'SUB') {
        // 각주 참조 → hp:footNote 컨트롤 (내용을 참조 지점에 인라인 삽입, pypandoc 패턴)
        const ref = el.querySelector('a[data-fn-ref]')?.getAttribute('data-fn-ref')
        const content = ref ? this.footnotes.get(ref) : undefined
        if (content) {
          const inst = this.w.nextObjId()
          runs.push(
            `<hp:run charPrIDRef="0"><hp:ctrl><hp:footNote number="0" instId="${inst}">` +
              `<hp:autoNum num="0" numType="FOOTNOTE"/>` +
              `<hp:subList id="${inst}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${this.blockChildrenXml(content)}</hp:subList>` +
              `</hp:footNote></hp:ctrl></hp:run>`,
          )
        } else {
          // 각주가 아닌 위/아래첨자
          runs.push(...this.inlineRuns(el, inherited, defaultCharPr, el.tagName === 'SUP' ? 'super' : 'sub'))
        }
      } else if (el.tagName === 'A') {
        // 하이퍼링크 **강등**: 주소를 버리고 안쪽 내용만 살린다.
        // hwpx의 HYPERLINK 필드는 타입명(hwpxlib FieldType)까지는 확정됐지만
        // hp:stringParam name="Command"의 문자열 문법이 미확인이라, 추측해서 쓰면
        // 한글이 파일을 못 여는 쪽이 더 위험하다. IR-SPEC 매핑표의 강등 규칙과 같다.
        runs.push(...this.inlineRuns(el, inherited, defaultCharPr, vertAlign))
      }
    }
    return runs
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
    const heading = /^H[1-6]$/.test(p.tagName)
    const paraPr = this.w.paraPrId(align, lh ? parseFloat(lh) : null, heading, marginsOf(p, heading))
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
        const [padT, padR, padB, padL] = paddingOf(td)

        const inner = this.blockChildrenXml(td)
        rowXml.push(
          `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${bfId}">` +
            `<hp:subList id="${this.w.nextObjId()}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>` +
            `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>` +
            `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
            `<hp:cellSz width="${Math.round(wPt * 100)}" height="${Math.round(hPt * 100)}"/>` +
            `<hp:cellMargin left="${hwpUnit(padL)}" right="${hwpUnit(padR)}" top="${hwpUnit(padT)}" bottom="${hwpUnit(padB)}"/>`,
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
      `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
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
            ? { sizePt: HEADING_PT[tag], color: '#000000', bold: true, italic: false, underline: false, strike: false, shade: null, family: null, vertAlign: null }
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
/**
 * content.hpf 매니페스트에 그림을 등록한다.
 * zip에 파일만 넣어 두면 한글은 열지만 매니페스트로 id를 찾는 읽기 구현은 그림을 놓친다
 * (한컴이 만든 hwpx도 BinData를 여기에 전부 등록해 둔다).
 */
function patchManifest(hpf: string, bins: { path: string; bytes: Uint8Array }[]): string {
  if (!bins.length) return hpf
  const items = bins
    .map(({ path }) => {
      const name = path.replace(/^BinData\//, '').replace(/\.[^.]+$/, '')
      const ext = path.split('.').pop() ?? 'png'
      const type = ext === 'ttf' ? 'application/x-font-ttf' : `image/${ext}`
      return `<opf:item id="${name}" href="${path}" media-type="${type}" isEmbeded="1"/>`
    })
    .join('')
  return hpf.includes('</opf:manifest>')
    ? hpf.replace('</opf:manifest>', `${items}</opf:manifest>`)
    : hpf
}

export function html2hwpx(root: Element, template: Uint8Array, embed?: EmbeddedFont): HwpxResult {
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
  let body = builder.blockChildrenXml(container, patchPagePr(setupRun, container as Element))
  for (const extra of sections.slice(1)) {
    body += builder.blockChildrenXml(extra)
  }

  // 글꼴 임베딩 — OWPML의 hh:font isEmbedded/binaryItemIDRef 규격.
  // 한글이 실제로 읽어주는지는 이 기기에 한글이 없어 검증하지 못했다.
  const fontBins: { path: string; bytes: Uint8Array }[] = []
  if (embed) {
    writer.embeddedFace = { face: embed.family, item: 'fontR' }
    fontBins.push({ path: 'BinData/fontR.ttf', bytes: embed.regular })
    if (embed.bold) fontBins.push({ path: 'BinData/fontB.ttf', bytes: embed.bold })
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
    else if (name === 'Contents/content.hpf')
      out[name] = [strToU8(patchManifest(strFromU8(data), [...writer.binFiles(), ...fontBins])), { level: 6 }]
    else out[name] = [data, { level: 6 }]
  }
  // 이미지 바이너리 (이미 압축 포맷이므로 무압축 저장)
  for (const { path, bytes } of writer.binFiles()) out[path] = [bytes, { level: 0 }]
  for (const { path, bytes } of fontBins) out[path] = [bytes, { level: 6 }]
  // 글꼴 임베딩 — OWPML의 hh:font isEmbedded/binaryItemIDRef 규격.
  // 한글이 실제로 읽어주는지는 이 기기에 한글이 없어 검증하지 못했다.


  return { data: zipSync(out), added: writer.addedCounts() }
}
