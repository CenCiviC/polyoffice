// 각주 헤드리스 검증 — bun run footnote-sim
//
// 지키려는 것 둘.
//  1. **각주 내용이 사라지지 않는다.** 예전에는 hwpx만 각주를 쓸 줄 알았고 docx·odt는
//     `doc-footnote` 블록을 통째로 버렸다 — 본문에 참조만 남고 내용이 없어졌다.
//  2. **번호는 어디에도 저장되지 않는다.** 참조의 `<a>`는 비어 있고, 화면은 뷰어 CSS counter가,
//     파일은 각 포맷의 각주 기능이 센다(IR-SPEC 규칙 2). 중간에 하나 끼워도 뒤 번호를
//     고쳐 쓸 일이 없어야 한다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'

import { IR_VERSION, normalizeIR, validateIR } from '../src/lib/ir'
import { readIr } from '../src/lib/ir-model'
import { BASE_CSS } from '../src/lib/narro'
import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'

const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url)))

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

const docOf = (body: string) => {
  const w = new Window()
  w.document.body.innerHTML = body
  return w.document.body as unknown as Element
}

const BODY = `<doc-section data-ir="${IR_VERSION}" style="width:8.268in;min-height:11.693in;padding:1in 1in 1in 1in">
<p>첫 문단에 각주가 하나<sup><a data-fn-ref="fn1"></a></sup> 있고,</p>
<p>둘째 문단에도 하나<sup><a data-fn-ref="fn2"></a></sup> 있다.</p>
<doc-footnote id="fn1"><p>첫째 각주 내용입니다.</p></doc-footnote>
<doc-footnote id="fn2"><p>둘째 각주 내용입니다.</p></doc-footnote>
</doc-section>`

const root = docOf(BODY)
normalizeIR(root)

// ── 1. 계약 ─────────────────────────────────────────────────────────
{
  const v = validateIR(root)
  check('참조·내용 쌍이 계약을 통과', v.length === 0, v.map((x) => x.message).join(' / '))

  const orphan = docOf(
    `<doc-section><p data-id="b1">짝 없는 참조<sup><a data-fn-ref="fn9"></a></sup></p></doc-section>`,
  )
  check(
    '짝 없는 참조는 footnote-pair가 잡는다',
    validateIR(orphan).some((x) => x.rule === 'footnote-pair'),
  )
}

// ── 2. 중립 트리 ────────────────────────────────────────────────────
{
  const doc = readIr(root)
  check('각주 2개가 본문 밖으로 빠진다', doc.footnotes.map((f) => f.id).join(' ') === 'fn1 fn2')
  const blocks = doc.sections[0].blocks
  check('본문 블록은 문단 2개뿐 (각주는 흐름에서 빠졌다)', blocks.length === 2, `${blocks.length}개`)
  const runs = blocks.flatMap((b) => (b.kind === 'p' ? b.para.runs : []))
  const refs = runs.filter((r) => r.footnote)
  check('참조가 글자 없는 런으로 남는다', refs.length === 2 && refs.every((r) => r.text === ''))
  check('참조 런이 본문 글자와 합쳐지지 않는다', refs.every((r) => r.footnote?.startsWith('fn')))
  check(
    '본문 어디에도 번호가 글자로 없다',
    !runs.some((r) => /^\d+\)$/.test(r.text.trim())),
    runs.map((r) => JSON.stringify(r.text)).join(' '),
  )
}

// ── 3. 뷰어 CSS ─────────────────────────────────────────────────────
{
  check('참조 번호는 counter로 그린다', BASE_CSS.includes('.hwp-page sup a[data-fn-ref]::before'))
  check('내용 번호도 counter로 그린다', BASE_CSS.includes('doc-footnote > p:first-child::before'))
  check('구역마다 두 counter를 되돌린다', /counter-reset: fn fnref/.test(BASE_CSS))
}

// ── 4. docx ─────────────────────────────────────────────────────────
{
  const zip = unzipSync(html2docx(root).data)
  check('footnotes.xml 파트 존재', 'word/footnotes.xml' in zip)
  const fn = strFromU8(zip['word/footnotes.xml'] ?? new Uint8Array())
  const document = strFromU8(zip['word/document.xml'])
  check('Content_Types 등록', strFromU8(zip['[Content_Types].xml']).includes('/word/footnotes.xml'))
  check('관계 등록', strFromU8(zip['word/_rels/document.xml.rels']).includes('Target="footnotes.xml"'))
  check('구분선 각주 -1·0을 먼저 넣는다', fn.includes('w:id="-1"') && fn.includes('w:id="0"'))
  check('각주 내용이 살아 있다', fn.includes('첫째 각주 내용입니다') && fn.includes('둘째 각주 내용입니다'))
  const refs = [...document.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)].map((m) => m[1])
  check('본문 참조 2개 · id 1·2', refs.join(' ') === '1 2', refs.join(' '))
  check('참조는 위첨자', document.includes('<w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference'))
  check('본문에 각주 내용이 새지 않는다', !document.includes('첫째 각주 내용입니다'))
}

// ── 5. odt ──────────────────────────────────────────────────────────
{
  const content = strFromU8(unzipSync(html2odt(root).data)['content.xml'])
  const notes = [...content.matchAll(/<text:note text:id="(\w+)" text:note-class="footnote">/g)].map((m) => m[1])
  check('text:note 2개', notes.join(' ') === 'fn1 fn2', notes.join(' '))
  check('citation 번호는 방출 시점에 센다', content.includes('<text:note-citation>1</text:note-citation>'))
  check(
    '내용이 note-body 안에 있다',
    /<text:note-body><text:p[\s\S]{0,200}?첫째 각주 내용입니다[\s\S]{0,200}?<\/text:note-body>/.test(content),
  )
  check(
    '각주 내용이 본문 문단으로 새지 않는다',
    (content.match(/첫째 각주 내용입니다/g) ?? []).length === 1,
  )
}

// ── 6. hwpx ─────────────────────────────────────────────────────────
{
  const section = strFromU8(unzipSync(html2hwpx(root, template).data)['Contents/section0.xml'])
  const notes = (section.match(/<hp:footNote /g) ?? []).length
  check('hp:footNote 컨트롤 2개', notes === 2, `${notes}개`)
  // 번호 run은 subList **안**(각주 첫 문단)에 있어야 한글이 그린다 — 밖에 두면 내용만 나온다.
  // 한글이 저장한 각주를 그대로 본떴다: samples/hwpx/golden/golden-footnote.hwpx
  check('autoNum으로 번호를 맡긴다', section.includes('<hp:autoNum num="1" numType="FOOTNOTE">'))
  check(
    '번호가 각주 subList 안에 있다',
    /<hp:footNote [^>]*><hp:subList[^>]*><hp:p[^>]*><hp:run[^>]*><hp:ctrl><hp:autoNum num="1" numType="FOOTNOTE"/.test(section),
  )
  check('내용이 subList 안에 있다', /<hp:subList[^>]*>[\s\S]*?첫째 각주 내용입니다/.test(section))
  check('본문 문단으로도 새지 않는다', (section.match(/둘째 각주 내용입니다/g) ?? []).length === 1)
}

// ── 7. span 안에 든 참조 ────────────────────────────────────────────
// LLM·편집기가 만드는 가장 흔한 모양인데, hwpx 백엔드가 span을 잎으로 보고 안쪽을
// 글자로만 긁던 시절에는 **각주가 통째로 사라졌다**. 링크·쪽번호도 같이 없어졌었다.
{
  const nested = docOf(
    `<doc-section data-ir="${IR_VERSION}">` +
      `<p><span style="font-size:10.5pt">본문<sup><a data-fn-ref="fn1"></a></sup> 뒤</span></p>` +
      `<doc-footnote id="fn1"><p><span style="font-size:9.0pt">span 안 각주</span></p></doc-footnote>` +
      `</doc-section>`,
  )
  normalizeIR(nested)
  const section = strFromU8(unzipSync(html2hwpx(nested, template).data)['Contents/section0.xml'])
  check('span 안의 참조도 hwpx 각주가 된다', section.includes('<hp:footNote '), 'span 재귀 회귀')
  check('span 안 각주 내용이 살아 있다', section.includes('span 안 각주'))
  const docx = strFromU8(unzipSync(html2docx(nested).data)['word/footnotes.xml'])
  check('docx도 마찬가지', docx.includes('span 안 각주'))
}

console.log(ok ? '\n✓ 각주 검증 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
