// 편집 시나리오 헤드리스 검증:
// 변환 → (편집 시뮬레이션: 텍스트 수정 + contentEditable이 만드는 <div> 삽입)
// → normalizeIR → validateIR 통과 → 편집 반영된 hwpx 생성까지 확인
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'
import { normalizeIR, validateIR } from '../src/lib/ir'
import { html2hwpx } from '../src/lib/html2hwpx'
import { convertWithWasm } from './wasm'

const input = process.argv[2] ?? fileURLToPath(new URL('../samples/hwp/korean_출판규정.hwp', import.meta.url))
const { body } = await convertWithWasm(new Uint8Array(readFileSync(input)))

const window = new Window()
const doc = window.document
doc.body.innerHTML = body

// --- 편집 시뮬레이션 ---
// 1) 기존 문단 텍스트 수정
const firstSpan = doc.querySelector('td span')
const before = firstSpan?.textContent ?? ''
if (firstSpan) firstSpan.textContent = '수정된 제목입니다'
// 2) contentEditable이 흔히 만드는 비정규 DOM: <div> 블록 + contenteditable 속성
const section = doc.querySelector('doc-section')!
const div = doc.createElement('div')
div.innerHTML = '<span style="font-size:10.0pt">편집으로 추가된 새 문단</span>'
section.appendChild(div)
doc.querySelectorAll('p').forEach((p) => p.setAttribute('contenteditable', 'true'))
// 3) 서식 툴바(execCommand)가 만드는 레거시 태그
const legacy = doc.createElement('p')
legacy.innerHTML = '일반 <b>굵게한 부분</b>과 <font color="#ff0000">빨간 부분</font>'
section.appendChild(legacy)

// --- 정규화 + 검증 ---
const root = doc.body as unknown as Element
normalizeIR(root)
const violations = validateIR(root)

let ok = true
if (violations.length) {
  ok = false
  console.log(`✗ 정규화 후에도 IR 위반 ${violations.length}건:`, violations.slice(0, 5))
} else {
  console.log('✓ 편집 시뮬레이션 후 normalizeIR → IR 계약 통과')
}

const html = root.innerHTML
if (html.includes('contenteditable') || html.includes('<div')) {
  ok = false
  console.log('✗ 정규화 누락: contenteditable/div 잔존')
} else {
  console.log('✓ div→p 변환·편집 속성 제거 확인')
}
if (/<(b|font)\b/.test(html)) {
  ok = false
  console.log('✗ 레거시 서식 태그(<b>/<font>) 잔존')
} else if (html.includes('font-weight:bold">굵게한 부분') && html.includes('color:#ff0000">빨간 부분')) {
  console.log('✓ 레거시 서식 태그 → IR span 스타일 변환 확인')
} else {
  ok = false
  console.log('✗ 레거시 태그 변환 결과가 기대와 다름')
}

// --- 편집 반영 hwpx ---
const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url)))
const { data } = html2hwpx(root, template)
const section0 = strFromU8(unzipSync(data)['Contents/section0.xml'])
for (const [label, needle, expect] of [
  ['수정 텍스트 반영', '수정된 제목입니다', true],
  ['추가 문단 반영', '편집으로 추가된 새 문단', true],
  ['원본 텍스트 제거', before.trim(), false],
] as const) {
  const found = needle.length > 0 && section0.includes(needle)
  const pass = found === expect
  if (!pass) ok = false
  console.log(`${pass ? '✓' : '✗'} ${label} (${JSON.stringify(needle)} ${found ? '있음' : '없음'})`)
}

process.exit(ok ? 0 : 1)
