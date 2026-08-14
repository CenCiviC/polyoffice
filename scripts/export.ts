// 손으로 쓴 IR HTML 한 장 → hwpx · docx · odt (+ 왕복 검증)
//   bun run export <ir.html> [out-dir] [--fix]
//
// convert.ts가 "문서 → IR"이라면 이건 반대 방향이다. LLM이나 사람이 IR 어휘로
// 직접 쓴 문서가 정말 세 포맷으로 자유롭게 나가는지를 확인한다.
//   --fix : data-id 등을 normalizeIR로 채워 원본 파일을 제자리 갱신
//
// 만드는 일 자체는 doc-core.ts가 한다 — MCP 서버(mcp/server.ts)와 같은 코드,
// 같은 검증. 여기 남은 건 파일 입출력과 사람이 읽을 출력뿐이다.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { buildDocument, IRContractError } from './doc-core'

const args = process.argv.slice(2)
const fix = args.includes('--fix')
const [input, outDirArg] = args.filter((a) => !a.startsWith('--'))
if (!input) {
  console.error('usage: bun run export <ir.html> [out-dir] [--fix]')
  process.exit(2)
}
const outDir = outDirArg ?? dirname(input)
const stem = basename(input).replace(/\.[^.]+$/, '')
mkdirSync(outDir, { recursive: true })

let built
try {
  built = await buildDocument(readFileSync(input, 'utf8'))
} catch (e) {
  if (!(e instanceof IRContractError)) throw e
  console.error(`✗ IR 계약 위반 ${e.violations.length}건`)
  for (const v of e.violations.slice(0, 20)) console.error(`  [${v.rule}] ${v.message}\n      ${v.path}`)
  process.exit(1)
}
console.log(`✓ IR 계약 통과 — 블록 ${built.blocks}개`)

if (fix) {
  writeFileSync(input, built.ir + '\n')
  console.log(`✓ ${input} 제자리 갱신 (data-id 부여)`)
}

// 브라우저로 볼 때 뷰어와 같게 보이도록 BASE_CSS를 씌운 사본.
// 원본은 계약대로 순수 IR을 유지하고, 스타일은 여기서만 붙인다.
const previewPath = join(outDir, `${stem}.preview.html`)
writeFileSync(previewPath, built.preview)
console.log(`✓ 미리보기 ${previewPath}`)

const { chars, regularBytes, boldBytes } = built.font.stats
console.log(
  `✓ 글꼴 서브셋 ${built.font.family} — 글자 ${chars}자 · ` +
    `보통 ${(regularBytes / 1024).toFixed(0)}KB + 굵게 ${(boldBytes / 1024).toFixed(0)}KB`,
)

let failures = 0
for (const o of built.outputs) {
  if (o.bytes.length) writeFileSync(join(outDir, `${stem}.${o.format}`), o.bytes)
  if (o.error) {
    console.log(`  ${o.format.padEnd(4)} ✗ ${o.error}`)
    failures++
    continue
  }
  if (!o.ok) failures++
  console.log(
    `  ${o.format.padEnd(4)} ${o.ok ? '✓' : '△'} ${(o.bytes.length / 1024).toFixed(1).padStart(7)}KB · ` +
      `문단 ${String(o.paragraphs).padStart(3)} 표 ${String(o.tables).padStart(2)} 그림 ${o.images}` +
      (o.missing.length ? `\n         누락 ${o.missing.length}개: ${o.missing.slice(0, 3).join(' / ')}` : ''),
  )
}

console.log(failures ? `\n✗ 실패 ${failures}건` : `\n✓ 3/3 포맷 내보내기 + 되읽기 통과 (텍스트 전수 대조)`)
process.exit(failures ? 1 : 0)
