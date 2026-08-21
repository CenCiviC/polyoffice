// E2E: bun run tohwpx <input.hwp> [output.hwpx]
// .hwp → IR(HTML) → .hwpx 풀 사이클 + 검증:
//   1) 생성된 XML well-formed 검사 (fast-xml-parser)
//   2) 텍스트 왕복 검사 — IR의 텍스트가 hwpx <hp:t>에 전부 존재하는지
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { html2hwpx } from '../src/lib/html2hwpx'
import { convertWithWasm } from './wasm'

const input = process.argv[2] ?? fileURLToPath(new URL('../samples/hwp/korean_출판규정.hwp', import.meta.url))
const output = process.argv[3] ?? input.replace(/\.hwp$/i, '') + '.roundtrip.hwpx'
const templatePath = new URL('../public/blank.hwpx', import.meta.url)

// 1. hwp → IR (Rust WASM 파서)
const { body, stats } = await convertWithWasm(new Uint8Array(readFileSync(input)))
console.log(`[1] hwp → IR: ${JSON.stringify(stats)}`)

// 2. IR → hwpx
const window = new Window()
window.document.body.innerHTML = body
const root = window.document.body as unknown as Element
const template = new Uint8Array(readFileSync(templatePath))
const { data, added } = html2hwpx(root, template)
writeFileSync(output, data)
console.log(`[2] IR → hwpx: ${output} (${data.length} bytes) · 등록: charPr ${added.charPr}, paraPr ${added.paraPr}, borderFill ${added.borderFill}`)

// 3. 검증
const files = unzipSync(new Uint8Array(readFileSync(output)))
let ok = true

for (const name of ['Contents/section0.xml', 'Contents/header.xml']) {
  const result = XMLValidator.validate(strFromU8(files[name]))
  if (result !== true) {
    ok = false
    console.log(`✗ ${name} XML 오류:`, JSON.stringify(result))
  } else {
    console.log(`✓ ${name} well-formed`)
  }
}

// 텍스트 왕복: IR 텍스트 조각들이 hwpx 본문에 모두 있는지
const sectionOut = strFromU8(files['Contents/section0.xml'])
const hwpxText = [...sectionOut.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)]
  .map((m) => m[1].replace(/<hp:lineBreak\/>/g, '\n'))
  .join('\n')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

// 태그 경계를 공백으로 치환해 셀/블록 경계가 텍스트 조각을 잇지 않게 함.
// 각주 참조 번호(<sup>1)</sup>)는 렌더 파생물 — hwpx에선 autoNum이므로 비교에서 제외.
const irText = body
  .replace(/<sup>[\s\S]*?<\/sup>/g, ' ')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
const missing: string[] = []
for (const piece of irText.split(/\s+/).filter((s) => s.length > 0)) {
  if (!hwpxText.includes(piece)) missing.push(piece)
}
if (missing.length) {
  ok = false
  console.log(`✗ 텍스트 왕복 실패 — hwpx에 없는 조각 ${missing.length}개:`, missing.slice(0, 10))
} else {
  console.log(`✓ 텍스트 왕복 통과 (IR의 모든 텍스트 조각이 hwpx에 존재)`)
}

// mimetype이 첫 항목 + 무압축인지 (zip 로컬 헤더 직접 확인)
const raw = new Uint8Array(readFileSync(output))
const nameAt30 = new TextDecoder().decode(raw.slice(30, 38))
const method = raw[8] | (raw[9] << 8)
if (nameAt30 === 'mimetype' && method === 0) {
  console.log('✓ mimetype 첫 항목 + STORED')
} else {
  ok = false
  console.log(`✗ mimetype 규칙 위반 (first="${nameAt30}", method=${method})`)
}

process.exit(ok ? 0 : 1)
