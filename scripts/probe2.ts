// 표 셀 내부까지 재귀 추출 검증
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'hwp.js'

const path = process.argv[2] ?? fileURLToPath(new URL('../samples/hwp/korean_출판규정.hwp', import.meta.url))
const doc = parse(readFileSync(path), { type: 'binary' })

function paraText(para: any): string {
  return para.content
    .filter((c: any) => c.type === 0 && typeof c.value === 'string')
    .map((c: any) => c.value)
    .join('')
}

function walkParagraph(para: any, depth: number) {
  const indent = '  '.repeat(depth)
  const text = paraText(para)
  if (text.trim()) console.log(`${indent}"${text}"`)
  para.controls?.forEach((ctrl: any) => {
    if (ctrl.rowCount !== undefined) {
      console.log(`${indent}[TABLE ${ctrl.rowCount}x${ctrl.columnCount}]`)
      ctrl.content.forEach((row: any[], ri: number) => {
        row.forEach((cell: any, ci: number) => {
          const a = cell.attribute
          console.log(`${indent}  cell(r${a.row},c${a.column}) span=${a.rowSpan}x${a.colSpan} w=${a.width}`)
          cell.items.forEach((p: any) => walkParagraph(p, depth + 2))
        })
      })
    }
  })
}

doc.sections.forEach((section: any) => {
  section.content.forEach((para: any) => walkParagraph(para, 0))
})
