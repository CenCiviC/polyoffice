// 머리말·꼬리말·쪽번호 헤드리스 검증 — bun run hf-sim
//
// 지키려는 것 셋.
//  1. 머리말·꼬리말이 **본문 흐름 밖**이다. 본문 문단으로 새면 페이지마다 되풀이되지 않고
//     한 번만 찍힌다.
//  2. **쪽번호는 저장되지 않는다.** IR에는 종류(`doc-field data-kind`)만 있고, 화면은 조판이,
//     파일은 각 포맷의 필드가 센다(IR-SPEC 규칙 2).
//  3. 조판이 페이지마다 복제한 머리말·꼬리말이 **저장 전에 걷힌다**. 안 그러면 저장물에
//     페이지 수만큼 중복된다 — 각주의 TAIL 처리와 같은 함정이다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'

import { IR_VERSION, normalizeIR, validateIR } from '../src/lib/ir'
import { HF_INSET_PT, readIr } from '../src/lib/ir-model'
import { BASE_CSS } from '../src/lib/narro'
import { unpaginate } from '../src/lib/paginate'
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
<doc-header><p style="text-align:right">2026년 사업 계획</p></doc-header>
<doc-footer><p style="text-align:center">- <doc-field data-kind="page"></doc-field> / <doc-field data-kind="pages"></doc-field> -</p></doc-footer>
<p>본문 문단입니다.</p>
</doc-section>`

const root = docOf(BODY)
normalizeIR(root)

// ── 1. 계약 ─────────────────────────────────────────────────────────
{
  const v = validateIR(root)
  check('머리말·꼬리말·쪽번호가 계약을 통과', v.length === 0, v.map((x) => x.message).join(' / '))

  const written = docOf(
    `<doc-section><doc-footer><p data-id="b1"><doc-field data-kind="3"></doc-field></p></doc-footer></doc-section>`,
  )
  check(
    '숫자를 적은 필드는 거절 (번호는 파생물이다)',
    validateIR(written).some((x) => x.rule === 'field-kind'),
  )

  const loose = docOf(`<doc-section><p data-id="b1"><doc-field data-kind="page"></doc-field></p></doc-section>`)
  check(
    '본문 한가운데의 쪽번호는 거절',
    validateIR(loose).some((x) => x.rule === 'field-kind'),
  )

  const misplaced = docOf(`<doc-section><p data-id="b1"><doc-header><p data-id="b2">안</p></doc-header></p></doc-section>`)
  check(
    '머리말은 구역 직계여야 한다',
    validateIR(misplaced).some((x) => x.rule === 'structure'),
  )
}

// ── 2. 중립 트리 ────────────────────────────────────────────────────
{
  const sec = readIr(root).sections[0]
  check('머리말·꼬리말이 본문 블록에서 빠진다', sec.blocks.length === 1, `본문 ${sec.blocks.length}블록`)
  check('머리말이 구역에 실린다', sec.header !== null && sec.header.length === 1)
  const fields = (sec.footer ?? [])
    .flatMap((b) => (b.kind === 'p' ? b.para.runs : []))
    .filter((r) => r.field)
    .map((r) => r.field)
  check('꼬리말에 page·pages 필드 둘', fields.join(' ') === 'page pages', fields.join(' '))
  check('필드 런에는 글자가 없다', (sec.footer ?? []).flatMap((b) => (b.kind === 'p' ? b.para.runs : [])).every((r) => !r.field || r.text === ''))
}

// ── 3. 뷰어 ─────────────────────────────────────────────────────────
{
  check('머리말·꼬리말을 여백 띠에 놓는다', BASE_CSS.includes(`doc-header { top: ${HF_INSET_PT}pt; }`))
  check('좌우 여백을 구역에서 물려받는다', BASE_CSS.includes('padding-left: inherit; padding-right: inherit;'))
  check('쪽번호는 counter로 그린다', BASE_CSS.includes('doc-field[data-kind="page"]::before { content: counter(pageno); }'))
  check('전체 쪽수는 조판이 넘긴 --pages를 쓴다', BASE_CSS.includes('content: var(--pages, "?")'))
}

// ── 4. 조판이 복제한 사본은 저장 전에 걷힌다 ────────────────────────
{
  const win = new Window()
  win.document.body.innerHTML = BODY
  const d = win.document as unknown as Document
  // paginate는 실제 레이아웃 측정이 필요해 happy-dom에서 못 돈다 — 결과 모양만 흉내 낸다
  const sec = d.querySelector('doc-section')!
  const page2 = sec.cloneNode(false) as Element
  page2.setAttribute('data-pg', '')
  for (const tag of ['doc-header', 'doc-footer']) {
    const copy = sec.querySelector(tag)!.cloneNode(true) as Element
    copy.setAttribute('data-pg', '')
    page2.appendChild(copy)
  }
  sec.after(page2)

  unpaginate(d.body as unknown as ParentNode)
  const headers = d.querySelectorAll('doc-header').length
  const footers = d.querySelectorAll('doc-footer').length
  check('되돌리면 머리말·꼬리말이 하나씩만 남는다', headers === 1 && footers === 1, `머리말 ${headers} 꼬리말 ${footers}`)
  check('페이지 구역도 사라진다', d.querySelectorAll('doc-section').length === 1)
}

// ── 5. docx ─────────────────────────────────────────────────────────
{
  const zip = unzipSync(html2docx(root).data)
  check('header1.xml · footer1.xml 파트', 'word/header1.xml' in zip && 'word/footer1.xml' in zip)
  const types = strFromU8(zip['[Content_Types].xml'])
  check('Content_Types 등록', types.includes('/word/header1.xml') && types.includes('/word/footer1.xml'))
  const rels = strFromU8(zip['word/_rels/document.xml.rels'])
  check('관계 등록', rels.includes('Target="header1.xml"') && rels.includes('Target="footer1.xml"'))
  const document = strFromU8(zip['word/document.xml'])
  check('sectPr가 두 파트를 가리킨다', document.includes('<w:headerReference') && document.includes('<w:footerReference'))
  check('여백은 뷰어와 같은 상수', document.includes(`w:header="${HF_INSET_PT * 20}" w:footer="${HF_INSET_PT * 20}"`))
  const footer = strFromU8(zip['word/footer1.xml'])
  check('PAGE·NUMPAGES 필드', footer.includes('w:instr=" PAGE') && footer.includes('w:instr=" NUMPAGES'))
  check('머리말 글자는 파트 안에만', strFromU8(zip['word/header1.xml']).includes('2026년 사업 계획') && !document.includes('2026년 사업 계획'))
}

// ── 6. odt ──────────────────────────────────────────────────────────
{
  const zip = unzipSync(html2odt(root).data)
  const styles = strFromU8(zip['styles.xml'])
  const content = strFromU8(zip['content.xml'])
  check('master-page에 header·footer', styles.includes('<style:header>') && styles.includes('<style:footer>'))
  check('page-layout에 머리말·꼬리말 높이', styles.includes('<style:header-style>') && styles.includes('<style:footer-style>'))
  check('쪽번호 전용 요소', styles.includes('<text:page-number') && styles.includes('<text:page-count>'))
  check('머리말 글자는 styles.xml에만', styles.includes('2026년 사업 계획') && !content.includes('2026년 사업 계획'))
  check('머리말 문단 스타일도 styles.xml에 등록', /<office:automatic-styles>[\s\S]*style:family="paragraph"[\s\S]*<\/office:automatic-styles>/.test(styles))
}

// ── 7. hwpx ─────────────────────────────────────────────────────────
{
  const section = strFromU8(unzipSync(html2hwpx(root, template).data)['Contents/section0.xml'])
  // 실물 한글 문서에서 확인한 형태
  check('hp:header · hp:footer ctrl', section.includes('<hp:header id="1" applyPageType="BOTH">') && section.includes('<hp:footer id="2" applyPageType="BOTH">'))
  check('내용은 subList 안에', /<hp:header[^>]*><hp:subList[^>]*>[\s\S]*?2026년 사업 계획/.test(section))
  check('쪽번호는 autoNum numType=PAGE', section.includes('<hp:autoNum num="1" numType="PAGE">'))
  check('autoNumFormat도 골든 그대로', section.includes('<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/>'))
  // 전체 쪽수는 numType 값을 실물로 못 봐서 쓰지 않는다 (강등)
  check('전체 쪽수는 강등 — 추측한 numType을 쓰지 않는다', !section.includes('TOTAL_PAGE'))
  check('머리말이 본문 문단으로 새지 않는다', (section.match(/2026년 사업 계획/g) ?? []).length === 1)
}

console.log(ok ? '\n✓ 머리말·꼬리말·쪽번호 검증 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
