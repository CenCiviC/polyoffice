// 손으로 쓴 IR HTML 한 장 → hwpx · docx · odt (+ 왕복 검증)
//   bun run export <ir.html> [out-dir] [--fix]
//
// convert.ts가 "문서 → IR"이라면 이건 반대 방향이다. LLM이나 사람이 IR 어휘로
// 직접 쓴 문서가 정말 세 포맷으로 자유롭게 나가는지를 확인한다.
//   --fix : data-id 등을 normalizeIR로 채워 원본 파일을 제자리 갱신
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Window } from 'happy-dom'

import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'
import { wrapStandalone } from '../src/lib/narro'
import { normalizeIR, validateIR } from '../src/lib/ir'
import { buildEmbeddedFont, usedChars } from '../src/lib/font-embed'
import { DOC_FONT } from '../src/lib/ir-model'
import { initHwpWasm, parseHwpWasm } from '../src/lib/parser-wasm'
import type { DocModel, ParagraphModel } from '../src/lib/model'

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

const win = new Window()
win.document.body.innerHTML = readFileSync(input, 'utf8')
const root = win.document.body as unknown as Element

normalizeIR(root)
const violations = validateIR(root)
if (violations.length) {
  console.error(`✗ IR 계약 위반 ${violations.length}건`)
  for (const v of violations.slice(0, 20)) console.error(`  [${v.rule}] ${v.message}\n      ${v.path}`)
  process.exit(1)
}
console.log(`✓ IR 계약 통과 — 블록 ${root.querySelectorAll('[data-id]').length}개`)

if (fix) {
  writeFileSync(input, root.innerHTML.trim() + '\n')
  console.log(`✓ ${input} 제자리 갱신 (data-id 부여)`)
}

// 브라우저로 볼 때 뷰어와 같게 보이도록 BASE_CSS를 씌운 사본.
// 원본은 계약대로 순수 IR을 유지하고, 스타일은 여기서만 붙인다.
const previewPath = join(outDir, `${stem}.preview.html`)
writeFileSync(previewPath, wrapStandalone(root.innerHTML.trim()))
console.log(`✓ 미리보기 ${previewPath}`)

// 원본에서 살아남아야 할 텍스트 — 블록마다 첫 24자
const expected = Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li'))
  .map((el) => (el.textContent ?? '').replace(/\s+/g, ''))
  .filter((t) => t.length >= 4)
  .map((t) => t.slice(0, 24))

function allText(model: DocModel): string {
  let out = ''
  const walk = (paras: ParagraphModel[]) => {
    for (const p of paras) {
      for (const r of p.runs) out += r.text
      for (const t of p.tables) for (const row of t.rows) for (const c of row) walk(c.paragraphs)
      out += '\n'
    }
  }
  for (const s of model.sections) walk(s.paragraphs)
  return out
}

function count(model: DocModel) {
  let paragraphs = 0
  let tables = 0
  let images = 0
  const walk = (paras: ParagraphModel[]) => {
    for (const p of paras) {
      paragraphs++
      images += p.images?.length ?? 0
      for (const t of p.tables) {
        tables++
        for (const row of t.rows) for (const c of row) walk(c.paragraphs)
      }
    }
  }
  for (const s of model.sections) walk(s.paragraphs)
  return { paragraphs, tables, images }
}

await initHwpWasm({
  bytes: new Uint8Array(readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url))),
})
const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url)))

// 글꼴 임베딩 — 문서가 쓴 글자만 잘라 넣는다 (받는 기기에 글꼴이 없어도 같게 보이도록)
const fontDir = new URL('../public/fonts/', import.meta.url)
const chars = usedChars(root)
const embed = buildEmbeddedFont(
  {
    family: DOC_FONT,
    regular: new Uint8Array(readFileSync(new URL('NotoSansKR-Regular.ttf', fontDir))),
    bold: new Uint8Array(readFileSync(new URL('NotoSansKR-Bold.ttf', fontDir))),
  },
  chars,
)
console.log(
  `✓ 글꼴 서브셋 ${embed.family} — 글자 ${embed.stats.chars}자 · ` +
    `보통 ${(embed.stats.regularBytes / 1024).toFixed(0)}KB + 굵게 ${(embed.stats.boldBytes / 1024).toFixed(0)}KB`,
)

const TARGETS = [
  { ext: 'hwpx', write: () => html2hwpx(root, template, embed).data },
  { ext: 'docx', write: () => html2docx(root, embed).data },
  { ext: 'odt', write: () => html2odt(root, embed).data },
]

let failures = 0
for (const t of TARGETS) {
  const path = join(outDir, `${stem}.${t.ext}`)
  let bytes: Uint8Array
  try {
    bytes = t.write()
  } catch (e) {
    console.log(`  ${t.ext.padEnd(4)} ✗ 쓰기 실패 — ${e instanceof Error ? e.message : e}`)
    failures++
    continue
  }
  writeFileSync(path, bytes)

  let model: DocModel
  try {
    model = parseHwpWasm(new Uint8Array(readFileSync(path)))
  } catch (e) {
    console.log(`  ${t.ext.padEnd(4)} ✗ 되읽기 실패 — ${e instanceof Error ? e.message : e}`)
    failures++
    continue
  }
  const text = allText(model).replace(/\s+/g, '')
  const missing = expected.filter((w) => !text.includes(w))
  const c = count(model)
  const ok = missing.length === 0
  if (!ok) failures++
  console.log(
    `  ${t.ext.padEnd(4)} ${ok ? '✓' : '△'} ${(bytes.length / 1024).toFixed(1).padStart(7)}KB · ` +
      `문단 ${String(c.paragraphs).padStart(3)} 표 ${String(c.tables).padStart(2)} 그림 ${c.images}` +
      (missing.length ? `\n         누락 ${missing.length}개: ${missing.slice(0, 3).join(' / ')}` : ''),
  )
}

console.log(failures ? `\n✗ 실패 ${failures}건` : `\n✓ 3/3 포맷 내보내기 + 되읽기 통과 (텍스트 ${expected.length}블록 전수 대조)`)
process.exit(failures ? 1 : 0)
