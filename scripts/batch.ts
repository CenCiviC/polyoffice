// 배치 코퍼스 테스트: bun run scripts/batch.ts <corpus-dir> <out.json>
// 디렉토리의 모든 .hwp를 WASM 파서 → IR 변환 → 린터로 돌리고 결과를 JSON으로 남긴다.
// WASM 실패 시 hwp.js 폴백도 시도해 파서별 상태를 기록한다.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { convertModel, type ConvertResult } from '../src/lib/hwp2html'
import { validateIR } from '../src/lib/ir'
import { parseHwpJs } from '../src/lib/parser-js'
import { initHwpWasm, parseHwpWasm } from '../src/lib/parser-wasm'

interface FileResult {
  name: string
  bytes: number
  status: 'ok' | 'fallback' | 'rejected' | 'failed'
  parser?: 'wasm' | 'js'
  error?: string
  stats?: ConvertResult['stats']
  violations: number
  violationSamples: string[]
  /** 미리보기용 standalone HTML (실패 시 없음) */
  html?: string
}

const dir = process.argv[2] ?? 'corpus'
const outPath = process.argv[3] ?? 'batch-results.json'

const wasmBytes = new Uint8Array(
  readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url)),
)
await initHwpWasm({ bytes: wasmBytes })

const window = new Window()

function validate(body: string): string[] {
  window.document.body.innerHTML = body
  return validateIR(window.document.body as unknown as Element).map((v) => `[${v.rule}] ${v.message}`)
}

const files = readdirSync(dir)
  .filter((f) => f.toLowerCase().endsWith('.hwp'))
  .sort()

const results: FileResult[] = []

for (const name of files) {
  const path = join(dir, name)
  const bytes = statSync(path).size
  const data = new Uint8Array(readFileSync(path))

  let converted: ConvertResult | null = null
  let status: FileResult['status'] = 'ok'
  let parser: 'wasm' | 'js' | undefined
  let error: string | undefined

  try {
    converted = convertModel(parseHwpWasm(data), 'wasm')
    parser = 'wasm'
  } catch (e) {
    const wasmError = e instanceof Error ? e.message : String(e)
    try {
      converted = convertModel(parseHwpJs(data), 'js')
      parser = 'js'
      status = 'fallback'
      error = `wasm: ${wasmError}`
    } catch (e2) {
      const jsError = e2 instanceof Error ? e2.message : String(e2)
      // 명시적 거부(시그니처/암호화)인지, 예상 못 한 파싱 실패인지 구분
      status = /시그니처|암호화|CFB/.test(wasmError) ? 'rejected' : 'failed'
      error = `wasm: ${wasmError} · js: ${jsError}`
    }
  }

  let violations: string[] = []
  if (converted) violations = validate(converted.body)

  results.push({
    name,
    bytes,
    status,
    parser,
    error,
    stats: converted?.stats,
    violations: violations.length,
    violationSamples: violations.slice(0, 3),
    html: converted && converted.standalone.length < 400_000 ? converted.standalone : undefined,
  })

  const mark = { ok: '✓', fallback: '△', rejected: '⊘', failed: '✗' }[status]
  console.log(
    `${mark} ${name} (${bytes}B) ${converted ? `paras=${converted.stats.paragraphs} tables=${converted.stats.tables} chars=${converted.stats.chars} viol=${violations.length}` : error}`,
  )
}

const summary = {
  total: results.length,
  ok: results.filter((r) => r.status === 'ok').length,
  fallback: results.filter((r) => r.status === 'fallback').length,
  rejected: results.filter((r) => r.status === 'rejected').length,
  failed: results.filter((r) => r.status === 'failed').length,
  cleanIR: results.filter((r) => r.stats && r.violations === 0).length,
}
console.log('\nsummary:', JSON.stringify(summary))
writeFileSync(outPath, JSON.stringify({ summary, results }, null, 1))
console.log(`written: ${outPath}`)
