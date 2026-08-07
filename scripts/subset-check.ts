// 서브셋터 검증: 문서 글자만 남긴 폰트를 만들고 원본과 대조한다
//   bun run scripts/subset-check.ts <ir.html> [out.ttf]
import { readFileSync, writeFileSync } from 'node:fs'

import { subsetFont } from '../src/lib/subset'

const [input, outPath] = process.argv.slice(2)
const html = readFileSync(input ?? 'README.md', 'utf8')
const text = html.replace(/src="data:[^"]*"/g, '').replace(/<[^>]+>/g, '')
const chars = new Set([...text].filter((c) => c.trim()))

const full = new Uint8Array(readFileSync('public/fonts/NotoSansKR-Regular.ttf'))
const t0 = performance.now()
const { data, glyphs, originalBytes } = subsetFont(full, chars)
const ms = performance.now() - t0

writeFileSync(outPath ?? 'subset.ttf', data)
console.log(`문서 글자 ${chars.size}자 → 글리프 ${glyphs}개 (복합 글리프 참조 포함)`)
console.log(`원본 ${(originalBytes / 1024 / 1024).toFixed(1)}MB → 서브셋 ${(data.length / 1024).toFixed(0)}KB ` +
  `(${((data.length / originalBytes) * 100).toFixed(2)}%) · ${ms.toFixed(0)}ms`)
console.log(`저장: ${outPath ?? 'subset.ttf'}`)
