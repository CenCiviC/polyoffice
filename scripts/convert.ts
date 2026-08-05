// CLI: bun run scripts/convert.ts <input.hwp> [output.html]
// 브라우저와 동일한 경로(Rust WASM 파서)로 변환한다.
import { readFileSync, writeFileSync } from 'node:fs'
import { convertWithWasm } from './wasm'

const input = process.argv[2] ?? '/Users/deargen/Downloads/BlogForm_BookReview.hwp'
const output = process.argv[3] ?? 'out.html'

const data = new Uint8Array(readFileSync(input))
const { standalone, stats } = await convertWithWasm(data)
writeFileSync(output, standalone)

console.log('stats:', JSON.stringify(stats))
console.log(`written: ${output} (${standalone.length} bytes)`)
