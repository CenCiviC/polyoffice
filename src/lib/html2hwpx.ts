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

import type { IrBorder, IrListMarker, IrVAlign } from './ir-model'
import {
  DEFAULT_LINE_HEIGHT,
  HEADING_SPACE,
  LIST_INDENT_PT,
  CELL_BORDER,
  CELL_VALIGN,
  OUTLINE_SCHEME,
  bulletChar,
  parseBorder,
  displayText,
  xmlSafe,
} from './ir-model'
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
  // 백분율은 기준 길이를 알아야 푼다 — ir-model의 toPt와 같은 규칙
  if (v.includes('%')) return null
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

/**
 * 테두리 종류·굵기 — 실물 한글 문서에서 쓰인 값만 쓴다.
 * 굵기는 HWP가 고르는 값이 이산적이라(0.1·0.12·0.15… mm) 가장 가까운 것으로 맞춘다.
 */
const HWPX_BORDER_TYPE: Record<IrBorder['style'], string> = {
  solid: 'SOLID',
  dashed: 'DASH',
  dotted: 'DOT',
  double: 'DOUBLE_SLIM',
}

/** 길이 — 백분율이면 기준 길이에 대해 푼다 */
function ptOfBase(v: string | undefined | null, basePt: number): number | null {
  if (!v) return null
  const pct = /(-?[\d.]+)\s*%/.exec(v)
  if (pct) return (parseFloat(pct[1]) / 100) * basePt
  return ptOf(v)
}

/** 셀 세로 정렬 — `hp:subList`의 vertAlign (실물 hwpx에서 CENTER·TOP 확인) */
const HWPX_VALIGN: Record<string, string> = { top: 'TOP', middle: 'CENTER', bottom: 'BOTTOM' }

const HWPX_BORDER_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1, 1.5, 2, 3, 4, 5]

function hwpxBorder(tag: string, b: IrBorder | null): string {
  if (!b) return `<hh:${tag} type="NONE" width="0.1 mm" color="#000000"/>`
  const mm = b.widthPt * 0.352778
  const snapped = HWPX_BORDER_MM.reduce((best, v) => (Math.abs(v - mm) < Math.abs(best - mm) ? v : best))
  return `<hh:${tag} type="${HWPX_BORDER_TYPE[b.style]}" width="${snapped} mm" color="${b.color}"/>`
}

const BORDERFILL_TMPL = (id: number, fill: string | null, border: IrBorder | null) => `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
<hh:slash type="NONE" Crooked="0" isCounter="0"/>
<hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
${hwpxBorder('leftBorder', border)}
${hwpxBorder('rightBorder', border)}
${hwpxBorder('topBorder', border)}
${hwpxBorder('bottomBorder', border)}
<hh:diagonal type="NONE" width="0.1 mm" color="#000000"/>
<hc:fillBrush>
<hc:winBrush faceColor="${fill ?? 'none'}" hatchColor="#000000" alpha="0"/>
</hc:fillBrush>
</hh:borderFill>`

/**
 * 목록 정의. 실물 한글 문서(공공기관 배포 hwpx)가 저장한 `hh:numbering`을 그대로 본떴다 —
 * 속성 이름·값, `charPrIDRef="4294967295"`(= -1, 문단 글자모양 상속), `^n` 치환 문법까지.
 *
 * `hh:paraHead`의 level은 **1부터**인데 `hh:heading`의 level은 **0부터**다(같은 골든 파일에서
 * 확인). 헷갈리기 쉬운 자리라 여기 한 번만 변환한다.
 *
 * 글머리표는 `hh:bullets`라는 별도 테이블이 OWPML에 있지만 **실물로 확인한 적이 없어서**
 * 쓰지 않는다. 대신 번호 서식 문자열에 `^n` 없이 글머리표 문자만 적는다 — 셀 것이 없으니
 * 번호는 안 나오고 문자만 남는다. 스키마상으로는 그냥 문자열이라 파일이 안 열릴 위험이 없다.
 * (`hh:bullets`를 쓰는 golden file이 생기면 갈아탄다.)
 */
const PARA_HEAD = (level: number, numFormat: string, text: string) =>
  `<hh:paraHead start="1" level="${level}" align="LEFT" useInstWidth="1" autoIndent="0" widthAdjust="0" ` +
  `textOffsetType="PERCENT" textOffset="50" numFormat="${numFormat}" charPrIDRef="4294967295" checkable="0">` +
  `${esc(text)}</hh:paraHead>`

const NUMBERING_TMPL = (id: number, levels: IrListMarker[]) => {
  const heads: string[] = []
  for (let i = 0; i < 10; i++) {
    // 정의보다 깊은 수준은 마지막 표시를 반복한다 (한글은 10수준을 모두 요구한다)
    const marker = levels[Math.min(i, levels.length - 1)] ?? 'bullet'
    heads.push(PARA_HEAD(i + 1, 'DIGIT', marker === 'decimal' ? `^${i + 1}.` : bulletChar(i)))
  }
  return `<hh:numbering id="${id}" start="0">${heads.join('')}</hh:numbering>`
}

/**
 * 개요 번호 정의. `HANGUL_SYLLABLE`(가·나·다)도 `^n` 치환도 실물 한글 문서에서 확인한 값이다 —
 * 골든 파일의 numbering이 정확히 `^1.` DIGIT → `^2.` HANGUL_SYLLABLE → `^3)` DIGIT 순서였다.
 * 우리 기본 스킴(OUTLINE_SCHEME)이 한글 공문서 관행과 같아서 그대로 겹친다.
 */
const OUTLINE_TMPL = (id: number) => {
  const heads: string[] = []
  for (let i = 0; i < 10; i++) {
    const lv = OUTLINE_SCHEME[Math.min(i, OUTLINE_SCHEME.length - 1)]
    heads.push(
      PARA_HEAD(
        i + 1,
        lv.style === 'hangul' ? 'HANGUL_SYLLABLE' : 'DIGIT',
        `${lv.prefix}^${i + 1}${lv.suffix}`,
      ),
    )
  }
  return `<hh:numbering id="${id}" start="0">${heads.join('')}</hh:numbering>`
}

/**
 * 문단이 붙을 번호 매김 — paraPr의 `hh:heading`이 가리킨다.
 * `NUMBER`는 목록(문단 번호), `OUTLINE`은 제목(개요 번호). 둘 다 실물 hwpx에서 확인한 값.
 */
interface NumberingRef {
  type: 'NUMBER' | 'OUTLINE'
  id: number
  /** 0부터 */
  level: number
}

class HwpxWriter {
  private charPrs = new Map<string, number>()
  private paraPrs = new Map<string, number>()
  private borderFills = new Map<string, number>()
  private newCharPrXml: string[] = []
  private newParaPrXml: string[] = []
  private newBorderFillXml: string[] = []
  private newNumberingXml: string[] = []
  private nextNumberingId: number
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
    this.nextNumberingId = this.maxId(/<hh:numbering id="(\d+)"/g) + 1
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
  paraPrId(
    align: string,
    lineHeight?: number | null,
    heading = false,
    margins?: ParaMargins,
    numbering?: NumberingRef | null,
  ): number {
    const horizontal = align === 'center' ? 'CENTER' : align === 'right' ? 'RIGHT' : 'LEFT'
    // CSS line-height 비율 ≈ 한글 줄간격 PERCENT (1.5 → 150%)
    const percent = lineHeight ? Math.round(lineHeight * 100) : heading ? Math.round(HEADING_SPACE.lineHeight * 100) : null
    const m = margins ?? { indentPt: 0, firstLinePt: 0, beforePt: 0, afterPt: 0 }
    const plainMargins = !m.indentPt && !m.firstLinePt && !m.beforePt && !m.afterPt
    if (horizontal === 'LEFT' && percent === null && !heading && plainMargins && !numbering) return 0
    const numKey = numbering ? `${numbering.type}:${numbering.id}:${numbering.level}` : ''
    const key = `${horizontal}|${percent ?? ''}|${heading ? 'h' : ''}|${m.indentPt}|${m.firstLinePt}|${m.beforePt}|${m.afterPt}|${numKey}`
    let id = this.paraPrs.get(key)
    if (id === undefined) {
      id = this.nextParaPrId++
      this.paraPrs.set(key, id)
      let xml = this.baseParaPrXml
        .replace(/id="0"/, `id="${id}"`)
        .replace(/horizontal="[A-Z]+"/, `horizontal="${horizontal}"`)
      if (percent !== null)
        xml = xml.replace(/lineSpacing type="PERCENT" value="\d+"/g, `lineSpacing type="PERCENT" value="${percent}"`)
      // 번호 매김에 묶는다. type/idRef/level 세 값의 의미는 실물 hwpx로 확인했다
      if (numbering)
        xml = xml.replace(
          /<hh:heading type="[A-Z]+" idRef="\d+" level="\d+"\/>/,
          `<hh:heading type="${numbering.type}" idRef="${numbering.id}" level="${numbering.level}"/>`,
        )
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

  /**
   * 목록 정의 등록 → numbering id. 수준 구성이 같아도 **목록마다 새로 만든다** —
   * 한글은 numbering id 단위로 번호를 세므로, 정의를 공유하면 둘째 목록이 1이 아니라
   * 이어서 세기 시작한다. (같은 이유로 docx도 num을 인스턴스마다 만든다.)
   */
  numberingId(levels: IrListMarker[]): number {
    const id = this.nextNumberingId++
    this.newNumberingXml.push(NUMBERING_TMPL(id, levels))
    return id
  }

  /** 개요 번호 정의 — 문서에 하나만 만든다 */
  private outlineNum: number | null = null
  outlineNumberingId(): number {
    if (this.outlineNum === null) {
      this.outlineNum = this.nextNumberingId++
      this.newNumberingXml.push(OUTLINE_TMPL(this.outlineNum))
    }
    return this.outlineNum
  }

  borderFillId(fillHex: string | null, border: IrBorder | null = CELL_BORDER): number {
    const key = `${fillHex ?? 'none'}|${border ? `${border.widthPt}:${border.style}:${border.color}` : 'none'}`
    let id = this.borderFills.get(key)
    if (id === undefined) {
      id = this.nextBorderFillId++
      this.borderFills.set(key, id)
      this.newBorderFillXml.push(BORDERFILL_TMPL(id, fillHex, border))
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
      numbering: this.newNumberingXml.length,
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
    patch('</hh:numberings>', this.newNumberingXml, 'numberings')
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
/** 블록으로 다루는 태그 — 나머지는 인라인이라 암묵 문단으로 묶인다 (ir-model의 BLOCK_TAGS와 같다) */
const HWPX_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TABLE', 'UL', 'OL', 'DIV',
  'DOC-FOOTNOTE', 'DOC-PAGEBREAK', 'DOC-HEADER', 'DOC-FOOTER',
])

/** 문단에 담길 만한 내용이 있나 (공백만이면 아니다) */
function hasInlineContent(nodes: Node[]): boolean {
  return nodes.some(
    (n) =>
      (n.textContent ?? '').trim() !== '' ||
      (n.nodeType === 1 && ((n as Element).tagName === 'IMG' || (n as Element).tagName === 'BR')),
  )
}

/** ul/ol 그루의 수준별 표시를 모은다 — 그 수준에 처음 나온 종류가 이긴다 */
function listLevels(el: Element, level: number, out: IrListMarker[]): void {
  const marker: IrListMarker = el.tagName === 'OL' ? 'decimal' : 'bullet'
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') continue
    if (out[level] === undefined) out[level] = marker
    for (const child of Array.from(li.children)) {
      if (child.tagName === 'UL' || child.tagName === 'OL') listLevels(child, level + 1, out)
    }
  }
}

function marginsOf(p: Element, heading: boolean, listLevel?: number): ParaMargins {
  // 목록 항목의 기본 들여쓰기는 뷰어 CSS(수준마다 padding-left 24pt)와 같은 값이고,
  // 번호·글머리표는 그 칸에 내어쓰기로 놓인다. IR에 값이 적혀 있으면 그쪽이 이긴다.
  const listIndent = listLevel === undefined ? null : LIST_INDENT_PT * (listLevel + 1)
  return {
    indentPt: ptOf(tdStyle(p, 'margin-left')) ?? listIndent ?? 0,
    firstLinePt: ptOf(tdStyle(p, 'text-indent')) ?? (listIndent === null ? 0 : -LIST_INDENT_PT),
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
  /**
   * 머리말·꼬리말 → 구역 첫 문단의 run에 얹는 ctrl.
   * 실물 한글 문서가 저장한 형태 그대로다 — `hp:footer id applyPageType` + 내용은 `hp:subList`.
   * (조판이 페이지마다 복제한 사본은 `data-pg`가 붙어 있어 세지 않는다.)
   */
  headerFooterXml(sec: Element): string {
    let out = ''
    let id = 0
    for (const tag of ['DOC-HEADER', 'DOC-FOOTER'] as const) {
      const el = Array.from(sec.children).find((c) => c.tagName === tag && !c.hasAttribute('data-pg'))
      if (!el) continue
      const name = tag === 'DOC-HEADER' ? 'header' : 'footer'
      const inst = this.w.nextObjId()
      out +=
        `<hp:run charPrIDRef="0"><hp:ctrl><hp:${name} id="${++id}" applyPageType="BOTH">` +
        `<hp:subList id="${inst}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${name === 'header' ? 'TOP' : 'BOTTOM'}" ` +
        `linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
        `${this.blockChildrenXml(el)}</hp:subList></hp:${name}></hp:ctrl></hp:run>`
    }
    return out
  }

  /** doc-footnote id → 내용 요소 (본문 흐름에서 제외하고 참조 지점에 인라인 삽입) */
  footnotes = new Map<string, Element>()
  /** 구역 본문 가용 폭(pt) — 표·셀의 백분율 폭을 푸는 기준 */
  availableWidthPt = 451

  constructor(w: HwpxWriter) {
    this.w = w
  }

  /** <hp:t> 내용: 텍스트 + <br>→<hp:lineBreak/> */

  private runsXml(p: Element, defaultStyle?: CharStyle, only?: Node[]): string {
    const defaultCharPr = defaultStyle ? this.w.charPrId(defaultStyle) : 0
    const runs = this.inlineRuns(p, defaultStyle ?? charStyleOf(null), defaultCharPr, null, only)
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
    only?: Node[],
  ): string[] {
    const runs: string[] = []
    /** 첨자가 걸려 있으면 기본 charPr을 그대로 못 쓴다 — 첨자를 얹은 것을 따로 등록한다 */
    const plainId = () => (vertAlign ? this.w.charPrId({ ...inherited, vertAlign }) : defaultCharPr)

    for (const child of only ?? Array.from(parent.childNodes)) {
      if (child.nodeType === 3) {
        // 소스 들여쓰기는 글자가 아니다 — ir-model과 같은 규칙을 쓴다
        const t = displayText(child)
        if (t) runs.push(`<hp:run charPrIDRef="${plainId()}"><hp:t>${esc(t)}</hp:t></hp:run>`)
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      if (el.tagName === 'SPAN') {
        // **재귀한다.** 예전에는 span을 잎으로 보고 안쪽을 글자로만 긁었는데(textXml),
        // 그러면 `<span>글 <sup><a data-fn-ref>…</sup> 글</span>` 같은 흔한 모양에서
        // 각주·링크·쪽번호가 조용히 사라졌다. 스타일은 지금처럼 span의 것을 쓴다.
        const style = { ...charStyleOf(el), vertAlign }
        runs.push(...this.inlineRuns(el, style, this.w.charPrId(style), vertAlign))
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
      } else if (el.tagName === 'DOC-FIELD') {
        // 쪽번호 — 실물 한글 꼬리말에서 확인한 형태 그대로.
        // 전체 쪽수(`pages`)는 numType 값을 실물로 못 봐서 **쓰지 않는다**(강등).
        if (el.getAttribute('data-kind') === 'page') {
          runs.push(
            `<hp:run charPrIDRef="${plainId()}"><hp:ctrl><hp:autoNum num="1" numType="PAGE">` +
              `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/>` +
              `</hp:autoNum></hp:ctrl><hp:t/></hp:run>`,
          )
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

  paragraphXml(
    p: Element,
    extraFirstRun = '',
    opts?: { pageBreak?: boolean; defaultStyle?: CharStyle; list?: NumberingRef; only?: Node[] },
  ): string {
    const align = tdStyle(p, 'text-align') ?? 'left'
    const lh = tdStyle(p, 'line-height')
    const m = /^H([1-6])$/.exec(p.tagName)
    const heading = m !== null
    // 제목이 개요 번호에 참여하면(`data-num`) 문서 하나뿐인 개요 정의에 묶는다
    const outline =
      m && p.getAttribute('data-num')
        ? {
            type: 'OUTLINE' as const,
            id: this.w.outlineNumberingId(),
            level: Math.min(Number(m[1]), OUTLINE_SCHEME.length) - 1,
          }
        : null
    const numbering = opts?.list ?? outline
    const paraPr = this.w.paraPrId(
      align,
      lh ? parseFloat(lh) : null,
      heading,
      marginsOf(p, heading, opts?.list?.level),
      numbering,
    )
    return `<hp:p paraPrIDRef="${paraPr}" styleIDRef="0" pageBreak="${opts?.pageBreak ? 1 : 0}" columnBreak="0" merged="0">${extraFirstRun}${this.runsXml(p, opts?.defaultStyle, opts?.only)}</hp:p>`
  }

  /** rowspan/colspan 점유를 시뮬레이션해 colAddr 계산 */
  tableXml(table: Element): string {
    const rows = Array.from(table.querySelectorAll('tr')).filter(
      (tr) => tr.closest('table') === table,
    )
    const occupied = new Map<string, boolean>() // "row,col"
    const cellsXml: string[][] = []
    let colCnt = 0

    // 표 전체 너비. 셀 폭을 안 준 문서가 흔해서(`<table style="width:100%">`) 그때는
    // 남은 폭을 균등 분배한다 — 예전에는 셀마다 100pt로 못 박아 좁은 표가 나갔다.
    const firstRow = Array.from(rows[0]?.children ?? []).filter((x) => x.tagName === 'TD')
    const declared = firstRow.map((td) => ptOfBase(tdStyle(td as Element, 'width'), this.availableWidthPt) ?? 0)
    const tableWidth = ptOfBase(tdStyle(table, 'width'), this.availableWidthPt) ?? this.availableWidthPt
    const blanks = declared.filter((w) => !w).length
    const evenWidth = blanks ? Math.max(0, tableWidth - declared.reduce((a, b) => a + b, 0)) / blanks : 0
    const firstRowWidth = declared.reduce((sum, w) => sum + (w || evenWidth || 100), 0)

    rows.forEach((tr, r) => {
      const rowXml: string[] = []
      let c = 0
      for (const td of Array.from(tr.children).filter((x) => x.tagName === 'TD')) {
        while (occupied.get(`${r},${c}`)) c++
        const colSpan = Number(td.getAttribute('colspan') ?? 1)
        const rowSpan = Number(td.getAttribute('rowspan') ?? 1)
        for (let rr = r; rr < r + rowSpan; rr++)
          for (let cc = c; cc < c + colSpan; cc++) occupied.set(`${rr},${cc}`, true)

        const wPt = ptOfBase(tdStyle(td, 'width'), this.availableWidthPt) ?? 0
        const hPt = ptOf(tdStyle(td, 'height')) ?? 15
        const bg = tdStyle(td, 'background')
        const rawBorder = tdStyle(td, 'border')
        const bfId = this.w.borderFillId(
          bg ? rgbToHex(bg) : null,
          rawBorder === null ? CELL_BORDER : parseBorder(rawBorder),
        )
        const vAlign = (tdStyle(td, 'vertical-align') ?? CELL_VALIGN) as IrVAlign
        const [padT, padR, padB, padL] = paddingOf(td)

        const inner = this.blockChildrenXml(td)
        rowXml.push(
          `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${bfId}">` +
            `<hp:subList id="${this.w.nextObjId()}" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${HWPX_VALIGN[vAlign] ?? 'CENTER'}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>` +
            `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>` +
            `<hp:cellSpan colSpan="${colSpan}" rowSpan="${rowSpan}"/>` +
            `<hp:cellSz width="${Math.round((wPt || evenWidth || 100) * 100)}" height="${Math.round(hPt * 100)}"/>` +
            `<hp:cellMargin left="${hwpUnit(padL)}" right="${hwpUnit(padR)}" top="${hwpUnit(padT)}" bottom="${hwpUnit(padB)}"/>`,
        )
        rowXml[rowXml.length - 1] += `</hp:tc>`
        c += colSpan
      }
      colCnt = Math.max(colCnt, c)
      cellsXml.push(rowXml)
    })

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
    // 제목 강등 스타일: 진하게 + 수준별 크기 (IR 스펙 — 개요 번호는 data-num이 켠다)
    const HEADING_PT: Record<string, number> = { H1: 16, H2: 14, H3: 13, H4: 12, H5: 12, H6: 12 }
    const out: string[] = []
    let first = true
    let pendingBreak = false

    // 표 셀처럼 `<p>` 없이 글자를 바로 담은 컨테이너 — 브라우저는 익명 블록으로 그리는데
    // 예전에는 여기서 통째로 버렸다(ir-model의 readBlocks와 같은 규칙으로 암묵 문단을 만든다).
    let inline: Node[] = []
    const flush = () => {
      if (hasInlineContent(inline)) {
        out.push(this.paragraphXml(container, first ? extraFirstRun : '', { pageBreak: pendingBreak, only: inline }))
        first = false
        pendingBreak = false
      }
      inline = []
    }

    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType !== 1 || !HWPX_BLOCK_TAGS.has((node as Element).tagName)) {
        inline.push(node)
        continue
      }
      flush()
      const el = node as Element
      const injected = first ? extraFirstRun : ''
      const tag = el.tagName

      if (tag === 'DOC-PAGEBREAK') {
        pendingBreak = true
        continue
      }
      if (tag === 'DOC-FOOTNOTE') continue // 참조 지점(sup>a)에서 인라인 처리됨
      if (tag === 'DOC-HEADER' || tag === 'DOC-FOOTER') continue // 구역 첫 문단의 ctrl로 나간다

      if (tag === 'P' || tag in HEADING_PT) {
        const defaultStyle: CharStyle | undefined =
          tag in HEADING_PT
            ? { sizePt: HEADING_PT[tag], color: '#000000', bold: true, italic: false, underline: false, strike: false, shade: null, family: null, vertAlign: null }
            : undefined
        out.push(this.paragraphXml(el, injected, { pageBreak: pendingBreak, defaultStyle }))
        first = false
        pendingBreak = false
      } else if (tag === 'UL' || tag === 'OL') {
        // 목록 하나 = numbering 정의 하나. 정의가 문단보다 먼저 필요해서 수준을 먼저 훑는다.
        const levels: IrListMarker[] = []
        listLevels(el, 0, levels)
        const numId = this.w.numberingId(levels)
        const emit = (list: Element, level: number) => {
          for (const li of Array.from(list.children)) {
            if (li.tagName !== 'LI') continue
            out.push(
              this.paragraphXml(li, first ? extraFirstRun : '', {
                pageBreak: pendingBreak,
                list: { type: 'NUMBER', id: numId, level },
              }),
            )
            first = false
            pendingBreak = false
            // 중첩 목록은 항목의 형제 문단으로 이어 붙인다 — 수준은 paraPr이 들고 있다
            for (const child of Array.from(li.children)) {
              if (child.tagName === 'UL' || child.tagName === 'OL') emit(child, level + 1)
            }
          }
        }
        emit(el, 0)
      } else if (tag === 'TABLE') {
        // 표는 자체 문단의 run에 실린다. 첫 블록이면 페이지설정 run을 같은 문단에 이식.
        out.push(
          `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="${pendingBreak ? 1 : 0}" columnBreak="0" merged="0">${injected}<hp:run charPrIDRef="0">${this.tableXml(el)}<hp:t/></hp:run></hp:p>`,
        )
        first = false
        pendingBreak = false
      }
    }
    flush()
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
  added: { charPr: number; paraPr: number; borderFill: number; numbering: number }
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
  // 페이지 설정 run 뒤에 머리말·꼬리말 ctrl을 같은(첫) 문단에 얹는다 — 실물 hwpx와 같은 자리
  // 백분율 폭의 기준 — 구역 본문 가용 폭(용지 폭 - 좌우 여백)
  const secEl = container as Element
  const secW = ptOf(tdStyle(secEl, 'width')) ?? 595
  const pad = (tdStyle(secEl, 'padding') ?? '').split(/\s+/).filter(Boolean)
  const padAt = (i: number, fb: number) => ptOf(pad[i]) ?? fb
  builder.availableWidthPt = Math.max(1, secW - padAt(3, padAt(1, 72)) - padAt(1, 72))

  const firstRun =
    patchPagePr(setupRun, container as Element) + builder.headerFooterXml(container as Element)
  let body = builder.blockChildrenXml(container, firstRun)
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
