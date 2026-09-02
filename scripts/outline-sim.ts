// 개요 번호 헤드리스 검증 — bun run outline-sim
//
// 지키려는 것: **번호는 어디에도 저장되지 않는다.** IR에는 "이 제목은 개요에 참여한다"는
// 스킴 참조(`data-num`)만 있고, 화면의 번호는 뷰어 CSS counter가, 파일의 번호는 각 포맷의
// numbering 정의가 센다(IR-SPEC 규칙 2).
//
// 그래서 진실원이 하나여야 한다 — `OUTLINE_SCHEME` 배열. 뷰어 CSS와 백엔드 셋이
// 같은 배열에서 나오는지까지 본다. 갈라지면 화면 번호와 저장된 번호가 달라진다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'

import { IR_VERSION, normalizeIR, validateIR } from '../src/lib/ir'
import { OUTLINE_SCHEME, readIr } from '../src/lib/ir-model'
import { BASE_CSS } from '../src/lib/polyoffice'
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
  <h1 data-num="outline">첫째 장</h1>
  <p>본문</p>
  <h2 data-num="outline">첫째 절</h2>
  <h2 data-num="outline">둘째 절</h2>
  <h1 data-num="outline">둘째 장</h1>
  <h1>번호 없는 제목</h1>
</doc-section>`

const root = docOf(BODY)
normalizeIR(root)

// ── 1. 계약 ─────────────────────────────────────────────────────────
{
  check('data-num="outline" 통과', validateIR(root).length === 0, validateIR(root).map((v) => v.message).join(' / '))

  // 번호를 직접 적는 건 규칙 2 위반 — 린터가 잡아야 한다
  const bad = docOf(`<doc-section><h1 data-id="b1" data-num="1.">직접 적은 번호</h1></doc-section>`)
  const v = validateIR(bad)
  check('data-num에 번호를 적으면 거절', v.some((x) => x.rule === 'outline-scheme'), v.map((x) => x.message).join(' / '))
}

// ── 2. 중립 트리 ────────────────────────────────────────────────────
{
  const doc = readIr(root)
  const paras = doc.sections[0].blocks.flatMap((b) => (b.kind === 'p' ? [b.para] : []))
  const shape = paras.map((p) => p.outline ?? '-').join('')
  check('개요 수준 h1·본문·h2·h2·h1·번호없는h1 = 1-221-', shape === '1-221-', shape)
  check('개요 정의 id가 목록과 같은 번호 공간에서 배정', doc.outlineId !== null, `outlineId=${doc.outlineId}`)

  const none = readIr(docOf(`<doc-section><h1 data-id="b1">번호 없음</h1></doc-section>`))
  check('개요를 안 쓰면 정의를 만들지 않는다', none.outlineId === null)
}

// ── 3. 뷰어 CSS — 스킴과 같은가 ─────────────────────────────────────
{
  check('@counter-style polyoffice-hangul 정의', BASE_CSS.includes('@counter-style polyoffice-hangul'))
  const mismatches = OUTLINE_SCHEME.filter((lv, i) => {
    const n = i + 1
    const counter = lv.style === 'hangul' ? `counter(o${n}, polyoffice-hangul)` : `counter(o${n})`
    const want = `.hwp-page h${n}[data-num]::before { content:${lv.prefix ? ` "${lv.prefix}"` : ''} ${counter}${lv.suffix ? ` "${lv.suffix}"` : ''} " "; }`
    return !BASE_CSS.includes(want)
  })
  check('뷰어 counter 규칙 6수준이 스킴과 일치', mismatches.length === 0, `어긋난 수준 ${mismatches.length}`)
}

// ── 4. docx ─────────────────────────────────────────────────────────
{
  const { data } = html2docx(root)
  const zip = unzipSync(data)
  const numbering = strFromU8(zip['word/numbering.xml'] ?? new Uint8Array())
  const document = strFromU8(zip['word/document.xml'])
  check('개요 abstractNum이 multilevel', numbering.includes('<w:multiLevelType w:val="multilevel"/>'))
  check('한글 수준은 numFmt=ganada', numbering.includes('w:val="ganada"'))
  check('수준별 서식 %1. · 가. · %3)', numbering.includes('w:val="%1."') && numbering.includes('w:val="%3)"'))
  const numPr = [...document.matchAll(/<w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/>/g)].map((m) => m[1])
  check('제목 4개만 묶이고 수준은 0·1·1·0', numPr.join('') === '0110', numPr.join(''))
  check('본문에 번호 텍스트가 없다', !/<w:t[^>]*>\s*(\d+\.|[가-힣]\.)\s*<\/w:t>/.test(document))

  // Word는 numbering.xml을 문서 순서대로 푼다 — abstractNum이 전부 먼저, 둘 다 id 오름차순.
  // 어기면 2수준부터 번호를 잃는다(가.→1., 3수준은 아예 사라짐). LibreOffice는 순서를 안 가려
  // 오래 안 들켰고, 진짜 Word로 열어 보고서야 드러났다.
  const order = [...numbering.matchAll(/<w:(abstractNum w:abstractNumId|num w:numId)="(\d+)"/g)].map((m) => ({
    kind: m[1].startsWith('abstractNum') ? 'a' : 'n',
    id: Number(m[2]),
  }))
  const firstNum = order.findIndex((o) => o.kind === 'n')
  check(
    'abstractNum이 전부 num보다 앞에',
    firstNum === -1 || order.slice(firstNum).every((o) => o.kind === 'n'),
    order.map((o) => o.kind + o.id).join(' '),
  )
  const asc = (xs: number[]) => xs.every((v, i) => i === 0 || xs[i - 1] < v)
  check(
    'abstractNum·num 둘 다 id 오름차순',
    asc(order.filter((o) => o.kind === 'a').map((o) => o.id)) &&
      asc(order.filter((o) => o.kind === 'n').map((o) => o.id)),
    order.map((o) => o.kind + o.id).join(' '),
  )

  // 목록과 개요가 섞인 문서라야 순서가 실제로 어긋난다 — 개요 정의는 문서를 훑는 도중에
  // id를 받아서, 정렬하지 않으면 목록 정의들 사이에 끼어 나간다.
  const mixed = docOf(
    `<doc-section data-ir="${IR_VERSION}">` +
      `<ul><li>글머리</li></ul><ol><li>번호</li></ol>` +
      `<h1 data-num="outline">제목</h1><h2 data-num="outline">절</h2>` +
      `</doc-section>`,
  )
  normalizeIR(mixed)
  const mixedNum = strFromU8(unzipSync(html2docx(mixed).data)['word/numbering.xml'] ?? new Uint8Array())
  const mo = [...mixedNum.matchAll(new RegExp(String.raw`<w:(abstractNum w:abstractNumId|num w:numId)="([0-9]+)"`, "g"))].map(
    (m) => (m[1].startsWith('abstractNum') ? 'a' : 'n') + m[2],
  )
  check(
    '목록+개요가 섞여도 a1 a2 a3 n1 n2 n3 꼴',
    mo.join(' ') === 'a1 a2 a3 n1 n2 n3',
    mo.join(' '),
  )
}

// ── 5. odt ──────────────────────────────────────────────────────────
{
  const content = strFromU8(unzipSync(html2odt(root).data)['content.xml'])
  const styles = strFromU8(unzipSync(html2odt(root).data)['styles.xml'])
  check('styles.xml에 text:outline-style', styles.includes('<text:outline-style'))
  check('한글 수준은 표본 문자열 num-format', styles.includes('style:num-format="가, 나, 다, ..."'))
  check('접두·접미가 num-prefix/num-suffix로', styles.includes('style:num-suffix="."') && styles.includes('style:num-prefix="("'))
  const levels = [...content.matchAll(/<text:h [^>]*text:outline-level="(\d+)"/g)].map((m) => m[1])
  check('참여하는 제목만 text:h · 수준 1·2·2·1', levels.join('') === '1221', levels.join(''))
  check('번호 없는 제목은 text:p로 남는다', content.includes('번호 없는 제목') && !/<text:h[^>]*>[^<]*번호 없는/.test(content))
}

// ── 6. hwpx ─────────────────────────────────────────────────────────
{
  const { data, added } = html2hwpx(root, template)
  const zip = unzipSync(data)
  const header = strFromU8(zip['Contents/header.xml'])
  const section = strFromU8(zip['Contents/section0.xml'])
  check('개요 numbering 정의 1개만 추가', added.numbering === 1, `numbering=${added.numbering}`)
  // 골든 파일(실물 한글 문서)이 쓴 값 그대로인가
  check('한글 수준은 numFormat=HANGUL_SYLLABLE', header.includes('numFormat="HANGUL_SYLLABLE"'))
  check('서식 문자열 ^1. · ^2. · ^3)', ['>^1.<', '>^2.<', '>^3)<'].every((t) => header.includes(t)))
  const heads = [...header.matchAll(/<hh:heading type="OUTLINE" idRef="(\d+)" level="(\d+)"\/>/g)]
    .filter((m) => m[1] !== '0') // 템플릿이 들고 있는 개요 스타일(idRef=0)은 제외
    .map((m) => m[2])
  check('paraPr가 OUTLINE 수준 0·1로 묶인다', heads.sort().join('') === '01', heads.join(''))
  check('본문에 번호 텍스트가 없다', !/<hp:t>\s*(\d+\.|[가-힣]\.)\s*<\/hp:t>/.test(section))
  check('제목 글자는 살아 있다', ['첫째 장', '둘째 절', '번호 없는 제목'].every((t) => section.includes(t)))

  // 문단 바인딩만으로는 한글에 번호가 안 나온다 — 구역이 가리키는 개요 모양을 바꿔야 한다.
  // (한글 2018 실기기에서 확인: 템플릿 기본값 1은 수준 1~7 서식이 비어 있어 번호가 안 그려진다)
  const outlineDef = header.match(/<hh:numbering id="(\d+)"(?:(?!<\/hh:numbering>)[\s\S])*?>\^1\.</)
  const secShape = section.match(/<hp:secPr\b[^>]*\boutlineShapeIDRef="(\d+)"/)
  check(
    'secPr가 우리 개요 numbering을 가리킨다',
    !!outlineDef && !!secShape && outlineDef[1] === secShape[1],
    `numbering=${outlineDef?.[1]} secPr=${secShape?.[1]}`,
  )

  // 개요를 안 쓴 문서까지 건드리면 템플릿 기본 개요 모양이 날아간다
  const plain = docOf(`<doc-section data-ir="${IR_VERSION}"><h1 data-id="b1">번호 없음</h1></doc-section>`)
  normalizeIR(plain)
  const plainSec = strFromU8(unzipSync(html2hwpx(plain, template).data)['Contents/section0.xml'])
  const tmplSec = strFromU8(unzipSync(template)['Contents/section0.xml'])
  const shapeOf = (s: string) => s.match(/<hp:secPr\b[^>]*\boutlineShapeIDRef="(\d+)"/)?.[1]
  check('개요가 없으면 구역 설정을 안 건드린다', shapeOf(plainSec) === shapeOf(tmplSec), `${shapeOf(plainSec)} vs 템플릿 ${shapeOf(tmplSec)}`)
}

console.log(ok ? '\n✓ 개요 번호 검증 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
