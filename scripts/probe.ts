// CLI probe: hwp.js가 실제 파일을 파싱할 수 있는지 검증
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'hwp.js'

const path = process.argv[2] ?? fileURLToPath(new URL('../samples/hwp/korean_출판규정.hwp', import.meta.url))
const buf = readFileSync(path)

const doc = parse(buf, { type: 'binary' })

console.log('=== HWP Header ===')
console.log('version:', JSON.stringify(doc.header.version))
console.log('sections:', doc.sections.length)

doc.sections.forEach((section: any, si: number) => {
  console.log(`\n=== Section ${si}: ${section.content.length} paragraphs ===`)
  section.content.forEach((para: any, pi: number) => {
    const text = para.content
      .filter((c: any) => c.type === 0) // char type
      .map((c: any) => (typeof c.value === 'string' ? c.value : ''))
      .join('')
    const ctrlCount = para.controls?.length ?? 0
    console.log(`[p${pi}] text="${text}" controls=${ctrlCount}`)
    para.controls?.forEach((ctrl: any, ci: number) => {
      console.log(`   ctrl${ci}: ${ctrl.constructor?.name ?? typeof ctrl}`, ctrl.id ? `id=${ctrl.id}` : '')
      if (ctrl.content) {
        // table: content = rows of paragraph lists
        console.log(`   -> table? rows=${ctrl.rowCount ?? '?'} cols=${ctrl.columnCount ?? '?'}`)
      }
    })
  })
})
