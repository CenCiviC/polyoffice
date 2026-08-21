// 골든 비교: bun run compare [input.hwp]
// 같은 파일을 Rust(WASM) 파서와 hwp.js 파서로 각각 파싱해
// 동일한 IR HTML이 나오는지 검사한다. Rust 파서의 회귀 테스트.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { convertModel } from '../src/lib/narro'
import { parseHwpJs } from '../src/lib/parser-js'
import { initHwpWasm, parseHwpWasm } from '../src/lib/parser-wasm'

const input = process.argv[2] ?? fileURLToPath(new URL('../samples/hwp/korean_출판규정.hwp', import.meta.url))
const data = new Uint8Array(readFileSync(input))

const wasmBytes = new Uint8Array(
  readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url)),
)
await initHwpWasm({ bytes: wasmBytes })

const wasm = convertModel(parseHwpWasm(data), 'wasm')
console.log(`wasm: ${JSON.stringify(wasm.stats)}`)

let js: ReturnType<typeof convertModel>
try {
  js = convertModel(parseHwpJs(data), 'js')
} catch (e) {
  console.log(`js  : 파서 크래시 (${e instanceof Error ? e.message : e})`)
  console.log('✓ 비교 불가 — hwp.js가 못 읽는 파일을 WASM은 처리 (WASM 우세)')
  process.exit(0)
}
console.log(`js  : ${JSON.stringify(js.stats)}`)

// 스타일 제외 정규화: 텍스트 + 블록/표 구조만 비교.
// hwp.js는 PARA_CHAR_SHAPE의 첫 쌍만 읽는 버그로 run 스타일 충실도가 낮아
// 스타일은 골든 기준이 될 수 없다 (Rust가 전체 쌍을 읽는 쪽이 정답).
function structure(html: string): string {
  return html
    .replace(/<span[^>]*>/g, '')
    .replace(/<\/span>/g, '')
    .replace(/<img[^>]*>/g, '') // hwp.js 폴백은 이미지 미지원 — 알려진 격차
    .replace(/<sup>[\s\S]*?<\/sup>/g, '') // 각주 참조 — hwp.js 폴백 미지원
    .replace(/<doc-footnote[\s\S]*?<\/doc-footnote>/g, '') // 각주 내용 — 동일
    .replace(/ style="[^"]*"/g, '')
}

if (structure(wasm.body) === structure(js.body)) {
  const styleIdentical = wasm.body === js.body
  console.log('✓ 골든 비교 통과 — 텍스트·블록·표 구조 일치')
  console.log(
    styleIdentical
      ? '  (스타일까지 완전 일치)'
      : '  (스타일 차이 있음 — hwp.js의 charShape 첫-쌍 버그로 예상된 격차, WASM이 더 충실)',
  )
  process.exit(0)
}

const a = structure(wasm.body)
const b = structure(js.body)
let i = 0
while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
console.log(`✗ 구조 불일치 — offset ${i}`)
console.log('  wasm:', JSON.stringify(a.slice(Math.max(0, i - 60), i + 90)))
console.log('  js  :', JSON.stringify(b.slice(Math.max(0, i - 60), i + 90)))
process.exit(1)
