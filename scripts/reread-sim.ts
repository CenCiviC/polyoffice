// 읽기 대칭 검증 — bun run reread-sim
//
// IR → 파일 → **다시 IR**. 여태 검증기들은 "쓴 파일에 글자가 있나"만 봤는데,
// 그건 쓰기 절반이다. 앱은 저장한 문서를 다시 열어 고치는 도구라 **읽기가 빠지면
// 열 때마다 서식이 깎인다** — 목록은 평범한 문단이 되고, 머리말은 통째로 사라진다.
//
// 그래서 여기서는 되읽은 IR이 원래 IR과 같은 어휘를 갖고 있는지를 본다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

import { IR_VERSION, normalizeIR, validateIR } from '../src/lib/ir'
import { convertModel } from '../src/lib/narro'
import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'
import { initHwpWasm, parseHwpWasm } from '../src/lib/parser-wasm'

const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url)))
await initHwpWasm({
  bytes: new Uint8Array(readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url))),
})

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

const SOURCE = `<doc-section data-ir="${IR_VERSION}" style="width:8.268in;min-height:11.693in;padding:1in 1in 1in 1in">
<doc-header><p style="text-align:right">머리말 글자</p></doc-header>
<doc-footer><p style="text-align:center">쪽 <doc-field data-kind="page"></doc-field></p></doc-footer>
<h1 data-num="outline">첫째 장</h1>
<h2 data-num="outline">첫째 절</h2>
<p>본문 문단</p>
<ol><li>번호 하나</li><li>번호 둘<ol><li>하위 항목</li></ol></li></ol>
<ul><li>글머리 하나</li></ul>
<table style="width:100%"><tr>
  <td style="padding:6pt;border:2pt dashed #c2352b;vertical-align:top">파선 셀</td>
  <td style="padding:6pt;border:none">민 셀</td>
</tr></table>
</doc-section>`

const docOf = (body: string) => {
  const w = new Window()
  w.document.body.innerHTML = body
  const root = w.document.body as unknown as Element
  normalizeIR(root)
  return root
}

const source = docOf(SOURCE)
check('원본이 계약을 통과', validateIR(source).length === 0)

/** 파일 바이트 → 되읽은 IR 루트 */
function reread(bytes: Uint8Array): Element {
  const root = docOf(convertModel(parseHwpWasm(bytes), 'wasm').body)
  const v = validateIR(root)
  if (v.length) console.log(`    (되읽은 IR 계약 위반 ${v.length}건: ${v[0].message})`)
  return root
}

const FORMATS: { name: string; bytes: () => Uint8Array }[] = [
  { name: 'hwpx', bytes: () => html2hwpx(source, template).data },
  { name: 'docx', bytes: () => html2docx(source).data },
  { name: 'odt', bytes: () => html2odt(source).data },
]

for (const f of FORMATS) {
  console.log(`\n── ${f.name} 왕복 ──`)
  let back: Element
  try {
    back = reread(f.bytes())
  } catch (e) {
    check(`${f.name} 되읽기`, false, e instanceof Error ? e.message : String(e))
    continue
  }
  const q = (sel: string) => Array.from(back.querySelectorAll(sel))
  const text = (sel: string) => q(sel).map((el) => (el.textContent ?? '').trim()).join('|')

  check(`${f.name} 개요 제목 2개가 h1·h2로 돌아온다`, text('h1[data-num], h2[data-num]') === '첫째 장|첫째 절', text('h1,h2,h3'))
  check(`${f.name} 번호 목록이 ol로 돌아온다`, q('ol').length >= 1 && q('ol > li').length >= 2, `ol ${q('ol').length} · li ${q('ol > li').length}`)
  check(`${f.name} 중첩 수준이 남는다`, q('ol ol > li').length === 1, `${q('ol ol > li').length}개`)
  check(`${f.name} 글머리표 목록이 ul로 돌아온다`, q('ul > li').length === 1, `${q('ul > li').length}개`)
  check(`${f.name} 본문 문단은 그대로 p`, text('doc-section > p') === '본문 문단', text('doc-section > p'))

  const cells = q('td')
  const border = cells[0]?.getAttribute('style') ?? ''
  // 굵기는 포맷마다 이산값으로 스냅된다(hwpx는 mm 눈금) — 2pt 근처면 통과로 본다
  const w = Number(/border:\s*([\d.]+)pt/.exec(border)?.[1] ?? 0)
  check(
    `${f.name} 셀 테두리(파선·굵기·색)가 돌아온다`,
    /dashed/.test(border) && Math.abs(w - 2) < 0.1 && /194|c2352b/i.test(border),
    border,
  )
  check(`${f.name} 테두리 없는 셀은 none으로`, /border:\s*none/.test(cells[1]?.getAttribute('style') ?? ''), cells[1]?.getAttribute('style') ?? '')
  check(`${f.name} 셀 세로 정렬이 돌아온다`, /vertical-align:\s*top/.test(border), border)

  check(`${f.name} 머리말이 돌아온다`, text('doc-header') === '머리말 글자', text('doc-header'))
  check(`${f.name} 꼬리말과 쪽번호 필드가 돌아온다`, q('doc-footer doc-field[data-kind="page"]').length === 1, text('doc-footer'))
  check(`${f.name} 쪽번호가 글자로 굳지 않았다`, !/\\d/.test(text('doc-footer')), text('doc-footer'))
}

console.log(ok ? '\n✓ 읽기 대칭 검증 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
