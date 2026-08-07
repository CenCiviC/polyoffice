// 변환 매트릭스 검증: SOT(HTML) → 각 포맷 → 다시 읽기 → 내용 대조
//   bun run matrix [out-dir]
//
// "자유롭게 변환되는가"를 말이 아니라 왕복으로 증명한다. 쓰기 백엔드가 있는
// 포맷만 나갈 수 있고, 나간 파일은 우리 리더로 다시 읽어 텍스트·서식·표 구조를
// 원본 SOT와 비교한다.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'
import { convertModel } from '../src/lib/narro'
import { initHwpWasm, parseHwpWasm } from '../src/lib/parser-wasm'
import type { DocModel, ParagraphModel } from '../src/lib/model'

const outDir = process.argv[2] ?? 'matrix-out'
mkdirSync(outDir, { recursive: true })

// ── SOT: 값을 아는 문서 하나 ────────────────────────────────
// 8×8 빨강 PNG — CRC까지 유효한 진짜 이미지여야 한다.
// (처음엔 대충 만든 base64를 썼는데 LibreOffice가 IDAT CRC 오류를 뱉어 들켰다.)
const RED_SQUARE =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mO4oKiIFTEMLQkA8A5E' +
  'gd8holoAAAAASUVORK5CYII='

const SOT = `<doc-section class="hwp-page" data-ir="0.2" style="width:8.268in;min-height:11.693in;padding:1.000in 1.000in 1.000in 1.000in">
<p data-id="b1" style="text-align:center"><span style="font-size:20.0pt;font-weight:bold;font-family:맑은 고딕">변환 매트릭스 검증 문서</span></p>
<p data-id="b2"><span style="font-size:10.5pt">보통 글자, </span><span style="font-size:10.5pt;font-weight:bold">굵게</span><span style="font-size:10.5pt">, </span><span style="font-size:10.5pt;font-style:italic">기울임</span><span style="font-size:10.5pt">, </span><span style="font-size:10.5pt;text-decoration:underline">밑줄</span><span style="font-size:10.5pt">, </span><span style="font-size:14.0pt;color:rgb(192, 0, 0)">빨강 14pt</span><span style="font-size:10.5pt">.</span></p>
<p data-id="b3" style="text-align:right"><span style="font-size:9.0pt">오른쪽 정렬 줄</span></p>
<p data-id="b4"><span style="font-size:10.5pt">줄바꿈 앞<br>줄바꿈 뒤\t탭 뒤</span></p>
<table class="hwp-table" data-id="b5">
<tr>
<td colspan="2" style="width:240.0pt;height:20.0pt;padding:3.0pt;background:rgb(217, 226, 243)"><p data-id="b6" style="text-align:center"><span style="font-size:11.0pt;font-weight:bold">두 칸 병합 머리글</span></p></td>
</tr>
<tr>
<td rowspan="2" style="width:120.0pt;height:20.0pt;padding:3.0pt"><p data-id="b7"><span style="font-size:10.0pt">세로 병합</span></p></td>
<td style="width:120.0pt;height:20.0pt;padding:3.0pt"><p data-id="b8"><span style="font-size:10.0pt">오른쪽 위</span></p></td>
</tr>
<tr>
<td style="width:120.0pt;height:20.0pt;padding:3.0pt"><p data-id="b9"><span style="font-size:10.0pt">오른쪽 아래</span></p></td>
</tr>
</table>
<p data-id="b10"><span style="font-size:10.5pt">그림: </span><img src="data:image/png;base64,${RED_SQUARE}" alt="" style="width:24.0pt;height:24.0pt"></p>
</doc-section>`

// 원본에서 반드시 살아남아야 하는 것들
const MUST_KEEP = [
  '변환 매트릭스 검증 문서',
  '보통 글자',
  '굵게',
  '기울임',
  '밑줄',
  '빨강 14pt',
  '오른쪽 정렬 줄',
  '줄바꿈 앞',
  '줄바꿈 뒤',
  '탭 뒤',
  '두 칸 병합 머리글',
  '세로 병합',
  '오른쪽 위',
  '오른쪽 아래',
]

// ── 헬퍼 ────────────────────────────────────────────────────
function domOf(html: string): Element {
  const win = new Window()
  win.document.body.innerHTML = html
  return win.document.body as unknown as Element
}

function allText(model: DocModel): string {
  let out = ''
  const walk = (paras: ParagraphModel[]) => {
    for (const p of paras) {
      for (const r of p.runs) out += r.text
      for (const t of p.tables) {
        for (const row of t.rows) for (const c of row) walk(c.paragraphs)
      }
      out += '\n'
    }
  }
  for (const s of model.sections) walk(s.paragraphs)
  return out
}

function summarize(model: DocModel) {
  let paragraphs = 0
  let tables = 0
  let images = 0
  let maxColSpan = 0
  let maxRowSpan = 0
  let shaded = 0
  const walk = (paras: ParagraphModel[]) => {
    for (const p of paras) {
      paragraphs++
      images += p.images?.length ?? 0
      for (const t of p.tables) {
        tables++
        for (const row of t.rows) {
          for (const c of row) {
            maxColSpan = Math.max(maxColSpan, c.colSpan)
            maxRowSpan = Math.max(maxRowSpan, c.rowSpan)
            if (c.borderFillId != null && model.info.borderFills[c.borderFillId]?.backgroundColor) shaded++
            walk(c.paragraphs)
          }
        }
      }
    }
  }
  for (const s of model.sections) walk(s.paragraphs)
  const styles = model.info.charShapes
  return {
    paragraphs,
    tables,
    images,
    maxColSpan,
    maxRowSpan,
    shaded,
    bold: styles.some((c) => c.attr & 0b10),
    italic: styles.some((c) => c.attr & 0b01),
    underline: styles.some((c) => ((c.attr >> 2) & 0b11) === 1),
    red: styles.some((c) => c.color[0] > 150 && c.color[1] < 80 && c.color[2] < 80),
    big: styles.some((c) => c.baseSize >= 1900),
  }
}

// ── 실행 ────────────────────────────────────────────────────
await initHwpWasm({
  bytes: new Uint8Array(readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url))),
})

const template = new Uint8Array(readFileSync('public/blank.hwpx'))
writeFileSync(join(outDir, 'sot.html'), SOT)

type Target = { ext: string; write: (root: Element) => Uint8Array | null; note?: string }
const TARGETS: Target[] = [
  { ext: 'hwpx', write: (root) => html2hwpx(root, template).data },
  { ext: 'docx', write: (root) => html2docx(root).data },
  { ext: 'odt', write: (root) => html2odt(root).data },
  { ext: 'hwp', write: () => null, note: 'OLE 바이너리 쓰기 백엔드 없음' },
  { ext: 'doc', write: () => null, note: 'OLE 바이너리 쓰기 백엔드 없음' },
]

const rows: string[] = []
let failures = 0

for (const target of TARGETS) {
  const bytes = target.write(domOf(SOT))
  if (!bytes) {
    rows.push(`  ${target.ext.padEnd(5)} ✗ 쓰기 불가 — ${target.note}`)
    continue
  }
  const path = join(outDir, `sot.${target.ext}`)
  writeFileSync(path, bytes)

  // 다시 읽어서 대조
  let model: DocModel
  try {
    model = parseHwpWasm(new Uint8Array(readFileSync(path)))
  } catch (e) {
    rows.push(`  ${target.ext.padEnd(5)} ✗ 되읽기 실패 — ${e instanceof Error ? e.message : e}`)
    failures++
    continue
  }
  const text = allText(model).replace(/\s+/g, '')
  const missing = MUST_KEEP.filter((w) => !text.includes(w.replace(/\s+/g, '')))
  const s = summarize(model)

  // 되읽은 모델을 다시 IR HTML로 — 사이클이 닫히는지까지 본다
  const back = convertModel(model, 'wasm')
  writeFileSync(join(outDir, `sot.${target.ext}.html`), back.standalone)

  const marks = [
    s.bold ? '굵게' : '굵게✗',
    s.italic ? '기울임' : '기울임✗',
    s.underline ? '밑줄' : '밑줄✗',
    s.red ? '빨강' : '빨강✗',
    s.big ? '큰글자' : '큰글자✗',
    s.maxColSpan >= 2 ? '가로병합' : '가로병합✗',
    s.maxRowSpan >= 2 ? '세로병합' : '세로병합✗',
    s.shaded > 0 ? '셀배경' : '셀배경✗',
    s.images > 0 ? '그림' : '그림✗',
  ]
  const ok = missing.length === 0 && !marks.some((m) => m.endsWith('✗'))
  if (!ok) failures++
  rows.push(
    `  ${target.ext.padEnd(5)} ${ok ? '✓' : '△'} ${(bytes.length / 1024).toFixed(1).padStart(6)}KB · ` +
      `문단 ${String(s.paragraphs).padStart(2)} 표 ${s.tables} 그림 ${s.images} · ${marks.join(' ')}` +
      (missing.length ? `\n         누락 텍스트: ${missing.join(', ')}` : ''),
  )
}

console.log(`SOT: ${MUST_KEEP.length}개 문구 · 표 1개(가로/세로 병합, 셀 배경) · 그림 1개`)
console.log(`출력: ${outDir}/\n`)
console.log(rows.join('\n'))
console.log(
  `\n쓰기 가능 ${TARGETS.filter((t) => t.write(domOf(SOT)) !== null).length}/${TARGETS.length} 포맷` +
    (failures ? ` · 검증 실패 ${failures}건` : ' · 왕복 검증 전부 통과'),
)
process.exit(failures ? 1 : 0)
