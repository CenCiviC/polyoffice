// IR 계약 검증 CLI: bun run validate [input.hwp]
// hwp → IR(HTML) 변환 결과가 docs/IR-SPEC.md 계약을 통과하는지 검사한다.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { validateIR, IR_VERSION } from '../src/lib/ir'
import { convertWithWasm } from './wasm'

const input = process.argv[2] ?? fileURLToPath(new URL('../samples/hwp/korean_출판규정.hwp', import.meta.url))

const { body, stats } = await convertWithWasm(new Uint8Array(readFileSync(input)))

const window = new Window()
window.document.body.innerHTML = body
const violations = validateIR(window.document.body as unknown as Element)

console.log(`IR v${IR_VERSION} · ${input}`)
console.log(`stats: ${JSON.stringify(stats)}`)

if (violations.length === 0) {
  console.log('✓ IR 계약 통과 (위반 0건)')
  process.exit(0)
}

console.log(`✗ 계약 위반 ${violations.length}건:`)
for (const v of violations) {
  console.log(`  [${v.rule}] ${v.message}\n    at ${v.path}`)
}
process.exit(1)
