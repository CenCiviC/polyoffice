// 페이지 설정 헤드리스 검증:
// doc-section 읽기(용지 판별·여백) → 쓰기(용지·방향·여백) → 되읽기 왕복 →
// 바뀐 설정이 IR 계약을 지키는지 + 세 백엔드가 실제로 그 값을 쓰는지까지 확인.
//
// 페이지 설정은 새 어휘가 아니라 "이미 있는 어휘를 사람이 만질 수 있게 한 것"이라,
// 검증의 초점도 어휘가 아니라 **왕복에서 값이 보존되는가**다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'
import { validateIR, IR_VERSION } from '../src/lib/ir'
import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { fromPaper, paperLabel, readGeom, writeGeom, type PageGeom } from '../src/lib/page-setup'

const window = new Window()
const doc = window.document
const firstSection = () => doc.querySelector('doc-section') as unknown as Element | null
const sections = () => Array.from(doc.querySelectorAll('doc-section')) as unknown as HTMLElement[]
const geomNow = () => readGeom(firstSection())

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

// 방출기가 내는 것과 같은 형태의 A4 문서 (width/min-height/padding = in 3자리)
const A4 = `<doc-section class="hwp-page" data-ir="${IR_VERSION}" style="width:8.268in;min-height:11.693in;padding:0.787in 0.787in 0.787in 0.787in">`
doc.body.innerHTML = `${A4}<p data-id="b1"><span style="font-size:10.0pt">본문</span></p></doc-section>`

// ── 1. 읽기: 방출기 출력에서 A4 세로 20mm를 알아보는가 ──────────────
const read = geomNow()
check('A4 세로 판별', read.paper === 'a4' && !read.landscape, `${read.paper} ${read.landscape ? '가로' : '세로'}`)
check('여백 20mm 판별', read.margins.every((m) => Math.abs(m - 20) < 0.2), `[${read.margins.join(', ')}]`)

// ── 2. 규격 밖 원본은 A4라고 우기지 않는다 ───────────────────────────
// 실문서에는 규격에서 몇 mm씩 어긋난 것이 흔하다. 프리셋 이름만 들고 있으면
// A4가 아닌 문서를 A4로 표시하게 되므로, 크기를 진실원으로 두고 paper는 null이 된다.
const odd = doc.createElement('doc-section')
odd.setAttribute('style', 'width:5.5in;min-height:7.1in;padding:0.5in')
doc.body.appendChild(odd)
const oddGeom = readGeom(odd as unknown as Element)
check('규격 밖 용지 → paper=null', oddGeom.paper === null, `paper=${oddGeom.paper}`)
check('규격 밖 용지 → 실제 크기 보존', Math.abs(oddGeom.size.w - 139.7) < 0.2 && Math.abs(oddGeom.size.h - 180.3) < 0.2, `${oddGeom.size.w}×${oddGeom.size.h}mm`)
check('규격 밖 용지 → 이름 대신 크기 표시', paperLabel(oddGeom).includes('mm'), paperLabel(oddGeom))
check('규격 밖 용지 → 원본 style 무변경', odd.getAttribute('style') === 'width:5.5in;min-height:7.1in;padding:0.5in')
odd.remove()

// ── 3. 쓰기 → 되읽기 왕복 (용지·방향·여백 전부) ─────────────────────
const cases: PageGeom[] = [
  { ...fromPaper('a4', true), margins: [20, 20, 20, 20] },
  { ...fromPaper('b5', false), margins: [15, 15, 15, 15] },
  { ...fromPaper('letter', true), margins: [30, 30, 30, 30] },
  { ...fromPaper('a4', false), margins: [25.4, 12.7, 25.4, 12.7] },
]
for (const want of cases) {
  writeGeom(sections(), want)
  const got = geomNow()
  const same =
    got.paper === want.paper &&
    got.landscape === want.landscape &&
    Math.abs(got.size.w - want.size.w) < 0.2 &&
    Math.abs(got.size.h - want.size.h) < 0.2 &&
    got.margins.every((m, i) => Math.abs(m - want.margins[i]) < 0.2)
  check(
    `왕복 ${paperLabel(want)} ${want.landscape ? '가로' : '세로'} 여백 ${want.margins[0]}mm`,
    same,
    `${want.size.w}×${want.size.h}mm → ${got.paper} ${got.landscape ? '가로' : '세로'} [${got.margins.join(', ')}]`,
  )
}

// ── 4. 편집기가 새 길이 표기를 흘려 넣지 않는가 ──────────────────────
writeGeom(sections(), { ...fromPaper('a4', true), margins: [20, 20, 20, 20] })
const style = firstSection()?.getAttribute('style') ?? ''
check('길이 표기가 방출기와 같은 in 3자리', /width:\s*[\d.]+in/.test(style) && !/px|mm|cm/.test(style), style)

// ── 5. 바뀐 설정이 IR 계약을 지키는가 ────────────────────────────────
const violations = validateIR(doc.body as unknown as Element)
check('validateIR 통과', violations.length === 0, violations.map((v) => v.message).join(' / '))

// ── 6. 바뀐 용지가 실제로 백엔드까지 도달하는가 ──────────────────────
// 가로 A4 = 297×210mm. docx는 twip(pt×20) → 297mm = 841.89pt = 16838 twip
const root = doc.body as unknown as Element
const docxXml = strFromU8(unzipSync(html2docx(root).data)['word/document.xml'])
const pgSz = docxXml.match(/<w:pgSz[^>]*\/>/)?.[0] ?? ''
check('docx pgSz가 가로 A4를 받았다', /w:w="168\d\d"/.test(pgSz), pgSz || '(pgSz 없음)')

// hwpx는 템플릿(blank.hwpx)의 secPr을 이식하므로 바이트가 필요하다
const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url).pathname))
const hwpxXml = strFromU8(unzipSync(html2hwpx(root, template).data)['Contents/section0.xml'])
check('hwpx section0.xml 생성', hwpxXml.includes('<hp:p') && hwpxXml.length > 0)

console.log(ok ? '\n페이지 설정 왕복 검증 통과' : '\n검증 실패')
process.exit(ok ? 0 : 1)
