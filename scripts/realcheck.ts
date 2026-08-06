// 실문서 E2E: 임의 포맷 문서 → IR → docx/odt로 저장
//   bun run realcheck <out-dir> <input...>
// 저장된 파일을 실제 앱(LibreOffice 등)으로 열어보는 건 이 스크립트 밖에서 한다.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Window } from 'happy-dom'

import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'
import { convertModel } from '../src/lib/hwp2html'
import { initHwpWasm, parseHwpWasm } from '../src/lib/parser-wasm'

const [outDir, ...inputs] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })

await initHwpWasm({
  bytes: new Uint8Array(readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url))),
})

for (const input of inputs) {
  const stem = basename(input).replace(/\.[^.]+$/, '')
  try {
    const model = parseHwpWasm(new Uint8Array(readFileSync(input)))
    const { body, stats } = convertModel(model, 'wasm')
    const win = new Window()
    win.document.body.innerHTML = body
    const root = win.document.body as unknown as Element

    const docx = html2docx(root)
    const odt = html2odt(root)
    writeFileSync(join(outDir, `${stem}.docx`), docx.data)
    writeFileSync(join(outDir, `${stem}.odt`), odt.data)
    console.log(
      `${stem}\n  읽기 ${stats.version} · 문단 ${stats.paragraphs} 표 ${stats.tables} 그림 ${stats.images}` +
        `\n  docx ${(docx.data.length / 1024).toFixed(0)}KB (문단 ${docx.stats.paragraphs} 표 ${docx.stats.tables} 그림 ${docx.stats.images})` +
        ` · odt ${(odt.data.length / 1024).toFixed(0)}KB (문단 ${odt.stats.paragraphs} 표 ${odt.stats.tables} 그림 ${odt.stats.images})`,
    )
  } catch (e) {
    console.log(`${stem}\n  ✗ ${e instanceof Error ? e.message : e}`)
  }
}
