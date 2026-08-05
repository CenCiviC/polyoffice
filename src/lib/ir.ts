/**
 * Document IR 계약 — docs/IR-SPEC.md v0.1.0의 실행 가능한 형태.
 * 스펙 변경 없는 이 파일의 변경 금지, 그 역도 금지.
 */

export const IR_VERSION = '0.1.0'

/** 요소별 허용 속성. data-id / style은 공통 허용이라 목록에서 제외. */
const ELEMENT_ATTRS: Record<string, Set<string>> = {
  'DOC-SECTION': new Set(['data-ir', 'class']),
  P: new Set([]),
  H1: new Set(['data-num']),
  H2: new Set(['data-num']),
  H3: new Set(['data-num']),
  H4: new Set(['data-num']),
  H5: new Set(['data-num']),
  H6: new Set(['data-num']),
  TABLE: new Set(['class']),
  TBODY: new Set([]), // HTML 파서가 자동 삽입하는 투명 래퍼 — 직렬화 시 생략
  UL: new Set([]),
  OL: new Set([]),
  LI: new Set([]),
  TR: new Set([]),
  TD: new Set(['colspan', 'rowspan']),
  'DOC-FOOTNOTE': new Set(['id']),
  'DOC-TEXTBOX': new Set(['data-anchor', 'data-wrap']),
  'DOC-EQ': new Set(['data-latex']),
  'DOC-PAGEBREAK': new Set([]),
  'DOC-HEADER': new Set([]),
  'DOC-FOOTER': new Set([]),
  SPAN: new Set([]),
  BR: new Set([]),
  IMG: new Set(['src', 'alt']),
  SUP: new Set([]),
  A: new Set(['data-fn-ref']),
}

const STYLE_PROPS = new Set([
  'font-size',
  'color',
  'font-family',
  'font-style',
  'font-weight',
  'text-decoration',
  'text-align',
  'line-height',
  'width',
  'height',
  'min-height',
  'padding',
  'background',
  'float',
])

/** data-id가 필수인 콘텐츠 블록 */
const ID_REQUIRED = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TABLE', 'DOC-FOOTNOTE', 'DOC-TEXTBOX', 'DOC-EQ'])

const COMMON_ATTRS = new Set(['data-id', 'style'])

export interface Violation {
  rule: string
  message: string
  path: string
}

/**
 * 편집(contentEditable)이 만든 비정규 DOM을 IR 계약으로 되돌린다.
 * - 편집기가 삽입한 <div> → <p>
 * - 편집용 속성(contenteditable 등) 제거
 * - 새로 생긴 블록에 data-id 부여 (기존 최대 번호 이후)
 * root가 속한 Document를 사용하므로 iframe 문서에도 안전.
 */
export function normalizeIR(root: Element): void {
  const doc = root.ownerDocument
  for (const div of Array.from(root.querySelectorAll('div'))) {
    const p = doc.createElement('p')
    while (div.firstChild) p.appendChild(div.firstChild)
    div.replaceWith(p)
  }

  // 서식 명령(execCommand)이 만드는 레거시 태그 → IR span 스타일로 변환
  const LEGACY: Record<string, string> = {
    B: 'font-weight:bold',
    STRONG: 'font-weight:bold',
    I: 'font-style:italic',
    EM: 'font-style:italic',
    U: 'text-decoration:underline',
    S: 'text-decoration:line-through',
    STRIKE: 'text-decoration:line-through',
    DEL: 'text-decoration:line-through',
  }
  for (const el of Array.from(root.querySelectorAll('b, strong, i, em, u, s, strike, del, font'))) {
    const span = doc.createElement('span')
    const styles: string[] = []
    const own = el.getAttribute('style')
    if (own) styles.push(own.replace(/;\s*$/, ''))
    if (LEGACY[el.tagName]) styles.push(LEGACY[el.tagName])
    const color = el.getAttribute('color')
    if (color) styles.push(`color:${color}`)
    if (styles.length) span.setAttribute('style', styles.join(';'))
    while (el.firstChild) span.appendChild(el.firstChild)
    el.replaceWith(span)
  }

  for (const el of Array.from(root.querySelectorAll('*'))) {
    el.removeAttribute('contenteditable')
    el.removeAttribute('spellcheck')
    // 스타일 어휘 밖 속성 제거 (편집기·붙여넣기가 유입시키는 것들)
    const style = el.getAttribute('style')
    if (style) {
      const kept = style
        .split(';')
        .map((d) => d.trim())
        // 편집기가 만드는 background-color는 IR 어휘의 background로 정규화
        .map((d) => d.replace(/^background-color\s*:/, 'background:'))
        .filter((d) => {
          const prop = d.split(':')[0]?.trim()
          return prop && STYLE_PROPS.has(prop)
        })
      if (kept.length) el.setAttribute('style', kept.join(';'))
      else el.removeAttribute('style')
    }
  }
  let max = 0
  for (const el of Array.from(root.querySelectorAll('[data-id]'))) {
    const m = el.getAttribute('data-id')?.match(/^b(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  for (const el of Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, table'))) {
    if (!el.getAttribute('data-id')) el.setAttribute('data-id', `b${++max}`)
  }
}

function pathOf(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.tagName !== 'BODY') {
    const id = cur.getAttribute?.('data-id')
    parts.unshift(id ? `${cur.tagName.toLowerCase()}#${id}` : cur.tagName.toLowerCase())
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

/**
 * IR 계약 검증. root의 하위 요소 전체를 검사한다 (root 자신은 제외).
 * 위반 없으면 빈 배열.
 */
export function validateIR(root: Element): Violation[] {
  const violations: Violation[] = []
  const seenIds = new Map<string, Element>()
  const fnRefs: string[] = []
  const fnIds = new Set<string>()

  const all = root.querySelectorAll('*')
  for (const el of Array.from(all)) {
    const tag = el.tagName
    const path = pathOf(el)

    // 1. element-allowed
    if (!(tag in ELEMENT_ATTRS)) {
      violations.push({ rule: 'element-allowed', message: `허용되지 않은 요소 <${tag.toLowerCase()}>`, path })
      continue
    }

    // 2. attr-allowed
    for (const attr of Array.from(el.attributes)) {
      if (!COMMON_ATTRS.has(attr.name) && !ELEMENT_ATTRS[tag].has(attr.name)) {
        violations.push({ rule: 'attr-allowed', message: `<${tag.toLowerCase()}>에 허용되지 않은 속성 ${attr.name}`, path })
      }
    }

    // 3. style-allowed
    const style = el.getAttribute('style')
    if (style) {
      for (const decl of style.split(';')) {
        const prop = decl.split(':')[0]?.trim()
        if (prop && !STYLE_PROPS.has(prop)) {
          violations.push({ rule: 'style-allowed', message: `허용되지 않은 스타일 속성 ${prop}`, path })
        }
      }
    }

    // 4. block-id
    if (ID_REQUIRED.has(tag)) {
      const id = el.getAttribute('data-id')
      if (!id) {
        violations.push({ rule: 'block-id', message: `<${tag.toLowerCase()}> 블록에 data-id 없음`, path })
      } else if (seenIds.has(id)) {
        violations.push({ rule: 'block-id', message: `data-id 중복: ${id}`, path })
      } else {
        seenIds.set(id, el)
      }
    }

    // 5. structure
    const parentTag = el.parentElement?.tagName
    if (tag === 'TR' && parentTag !== 'TABLE' && parentTag !== 'TBODY')
      violations.push({ rule: 'structure', message: '<tr>은 <table>/<tbody> 직계여야 함', path })
    if (tag === 'TBODY' && parentTag !== 'TABLE')
      violations.push({ rule: 'structure', message: '<tbody>는 <table> 직계여야 함', path })
    if (tag === 'TD' && parentTag !== 'TR')
      violations.push({ rule: 'structure', message: '<td>는 <tr> 직계여야 함', path })
    if (tag === 'TABLE' || tag === 'TBODY') {
      for (const child of Array.from(el.children)) {
        if (child.tagName !== 'TR' && !(tag === 'TABLE' && child.tagName === 'TBODY'))
          violations.push({ rule: 'structure', message: `<${tag.toLowerCase()}> 직계에 <${child.tagName.toLowerCase()}> 금지`, path })
      }
    }
    if (tag === 'P') {
      if (el.querySelector('p, table, ul, ol, doc-textbox, doc-eq, doc-pagebreak'))
        violations.push({ rule: 'structure', message: '<p> 안에 블록 요소 금지', path })
    }
    if (tag === 'LI' && parentTag !== 'UL' && parentTag !== 'OL')
      violations.push({ rule: 'structure', message: '<li>는 <ul>/<ol> 직계여야 함', path })
    if (tag === 'UL' || tag === 'OL') {
      for (const child of Array.from(el.children)) {
        if (child.tagName !== 'LI')
          violations.push({ rule: 'structure', message: `<${tag.toLowerCase()}> 직계에 <${child.tagName.toLowerCase()}> 금지`, path })
      }
    }
    if (tag === 'DOC-SECTION' && el.parentElement?.closest('doc-section'))
      violations.push({ rule: 'structure', message: '<doc-section> 중첩 금지', path })
    if ((tag === 'DOC-HEADER' || tag === 'DOC-FOOTER') && parentTag !== 'DOC-SECTION')
      violations.push({ rule: 'structure', message: `<${tag.toLowerCase()}>는 <doc-section> 직계여야 함`, path })

    // 6. footnote-pair 수집
    if (tag === 'A') {
      const ref = el.getAttribute('data-fn-ref')
      if (ref) fnRefs.push(ref)
    }
    if (tag === 'DOC-FOOTNOTE') {
      const id = el.getAttribute('id')
      if (id) fnIds.add(id)
    }

    // 7. eq-truth
    if (tag === 'DOC-EQ' && !el.getAttribute('data-latex'))
      violations.push({ rule: 'eq-truth', message: '<doc-eq>에 data-latex 필수', path })
  }

  for (const ref of fnRefs) {
    if (!fnIds.has(ref))
      violations.push({ rule: 'footnote-pair', message: `data-fn-ref="${ref}"에 대응하는 doc-footnote 없음`, path: '(document)' })
  }

  return violations
}
