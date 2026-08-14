// 표 셀 테두리·세로 정렬 헤드리스 검증 — bun run cell-sim
//
// 지키려는 것: **셀마다 다른 테두리가 세 포맷에 그대로 간다.**
// 예전에는 세 백엔드가 테두리를 각자 하드코딩했다 — hwpx는 검정 0.12mm, docx·odt는 회색 —
// 그래서 같은 IR인데 포맷마다 표가 다르게 보였고, IR로 바꿀 수단도 없었다.
//
// 기본값(`CELL_BORDER`·`CELL_VALIGN`)의 진실원이 하나인지도 본다. 뷰어 CSS가 그 상수에서
// 나오지 않으면 화면과 저장물의 표가 갈라진다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'

import { IR_VERSION, normalizeIR, validateIR } from '../src/lib/ir'
import { CELL_BORDER, CELL_VALIGN, parseBorder, readIr } from '../src/lib/ir-model'
import { BASE_CSS } from '../src/lib/narro'
import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'

const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url)))

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

const docOf = (body: string) => {
  const w = new Window()
  w.document.body.innerHTML = body
  return w.document.body as unknown as Element
}

// 셀 넷: 기본 · 굵은 빨강 파선 + 위 정렬 · 테두리 없음 + 아래 정렬 · 배경만
const BODY = `<doc-section data-ir="${IR_VERSION}" style="width:8.268in;min-height:11.693in;padding:1in 1in 1in 1in">
<table style="width:100%"><tr>
  <td style="padding:6pt">기본</td>
  <td style="padding:6pt;border:2pt dashed #c2352b;vertical-align:top">굵은 빨강 파선</td>
  <td style="padding:6pt;border:none;vertical-align:bottom">테두리 없음</td>
  <td style="padding:6pt;background:#f1f3f5">배경만</td>
</tr></table>
</doc-section>`

const root = docOf(BODY)
normalizeIR(root)

// ── 1. 계약 ─────────────────────────────────────────────────────────
{
  const v = validateIR(root)
  check('border·vertical-align이 어휘에 들어왔다', v.length === 0, v.map((x) => x.message).join(' / '))

  const bad = docOf(`<doc-section><table data-id="b1"><tr><td style="box-shadow:0 0 2px #000">그림자</td></tr></table></doc-section>`)
  check(
    '어휘 밖 속성은 그대로 거절',
    validateIR(bad).some((x) => x.rule === 'style-allowed'),
  )
}

// ── 2. 중립 트리 ────────────────────────────────────────────────────
{
  const cells = readIr(root).sections[0].blocks.flatMap((b) => (b.kind === 'table' ? b.table.rows[0] : []))
  check('셀 4개', cells.length === 4)
  check(
    '값이 없으면 기본 테두리·기본 정렬',
    cells[0].border?.widthPt === CELL_BORDER.widthPt &&
      cells[0].border?.color === CELL_BORDER.color &&
      cells[0].vAlign === CELL_VALIGN,
    JSON.stringify(cells[0].border),
  )
  check(
    'border 축약 파싱 — 굵기·종류·색',
    cells[1].border?.widthPt === 2 && cells[1].border?.style === 'dashed' && cells[1].border?.color.toLowerCase() === '#c2352b',
    JSON.stringify(cells[1].border),
  )
  check('vertical-align:top', cells[1].vAlign === 'top')
  check('border:none → null', cells[2].border === null && cells[2].vAlign === 'bottom')
  check('배경은 그대로 살아 있다', cells[3].background?.toLowerCase() === '#f1f3f5', String(cells[3].background))

  // 순서를 바꿔 써도 같은 값이어야 한다 (CSS 축약은 순서가 자유롭다)
  const shuffled = parseBorder('#c2352b dashed 2pt')
  check(
    '축약 속성 순서 무관',
    shuffled?.widthPt === 2 && shuffled.style === 'dashed' && shuffled.color.toLowerCase() === '#c2352b',
    JSON.stringify(shuffled),
  )
}

// ── 3. 뷰어 CSS — 기본값과 같은가 ───────────────────────────────────
{
  const want = `table.hwp-table td { border: ${CELL_BORDER.widthPt}pt ${CELL_BORDER.style} ${CELL_BORDER.color}; vertical-align: ${CELL_VALIGN}; }`
  check('뷰어 td 규칙이 기본 상수에서 나온다', BASE_CSS.includes(want), want)
}

// ── 4. docx ─────────────────────────────────────────────────────────
{
  const document = strFromU8(unzipSync(html2docx(root).data)['word/document.xml'])
  const borders = [...document.matchAll(/<w:tcBorders><w:top ([^/]*)\/>/g)].map((m) => m[1])
  check('셀마다 tcBorders를 적는다', borders.length === 4, `${borders.length}개`)
  // sz는 1/8pt — 0.75pt=6, 2pt=16
  check('기본 셀 = single 6 · 555555', borders[0].includes('w:val="single"') && borders[0].includes('w:sz="6"') && borders[0].includes('w:color="555555"'), borders[0])
  check('굵은 빨강 파선 = dashed 16 · c2352b', borders[1].includes('w:val="dashed"') && borders[1].includes('w:sz="16"') && borders[1].toLowerCase().includes('w:color="c2352b"'), borders[1])
  check('테두리 없음 = nil (표 수준 테두리를 덮는다)', borders[2].includes('w:val="nil"'), borders[2])
  const valigns = [...document.matchAll(/<w:vAlign w:val="(\w+)"\/>/g)].map((m) => m[1])
  check('세로 정렬 center·top·bottom·center', valigns.join(' ') === 'center top bottom center', valigns.join(' '))
}

// ── 5. odt ──────────────────────────────────────────────────────────
{
  const content = strFromU8(unzipSync(html2odt(root).data)['content.xml'])
  check('기본 테두리', content.includes(`fo:border="${CELL_BORDER.widthPt.toFixed(2)}pt solid ${CELL_BORDER.color}"`))
  check('굵은 빨강 파선', content.toLowerCase().includes('fo:border="2.00pt dashed #c2352b"'))
  check('테두리 없음', content.includes('fo:border="none"'))
  // 배경이 다른 셀은 스타일이 따로 등록되므로 middle이 둘이다
  const valigns = [...content.matchAll(/style:vertical-align="(\w+)"/g)].map((m) => m[1]).sort()
  check('세로 정렬이 셀 스타일마다 등록', valigns.join(' ') === 'bottom middle middle top', valigns.join(' '))
}

// ── 6. hwpx ─────────────────────────────────────────────────────────
{
  const zip = unzipSync(html2hwpx(root, template).data)
  const header = strFromU8(zip['Contents/header.xml'])
  const section = strFromU8(zip['Contents/section0.xml'])
  const fills = [...header.matchAll(/<hh:borderFill id="\d+"[\s\S]*?<\/hh:borderFill>/g)].map((m) => m[0])
  const ours = fills.filter((f) => /#c2352b|#555555/i.test(f))
  check('셀 테두리가 borderFill로 등록된다', ours.length >= 2, `${ours.length}개`)
  // 실물 한글 문서에서 확인한 종류·굵기 표기
  check(
    '파선은 DASH · 굵기는 한글이 고르는 mm 값으로 스냅',
    /type="DASH" width="0\.7 mm" color="#[Cc]2352[Bb]"/.test(header),
    (header.match(/type="DASH"[^/]*/) ?? [''])[0],
  )
  check('기본 테두리는 SOLID 0.25mm · #555555', /type="SOLID" width="0\.25 mm" color="#555555"/.test(header))
  check('테두리 없음은 NONE', header.includes('type="NONE" width="0.1 mm"'))
  const valigns = [...section.matchAll(/<hp:subList [^>]*vertAlign="(\w+)"/g)].map((m) => m[1])
  check('subList vertAlign CENTER·TOP·BOTTOM', valigns.join(' ') === 'CENTER TOP BOTTOM CENTER', valigns.join(' '))
  check('셀 글자는 살아 있다', ['기본', '굵은 빨강 파선', '테두리 없음', '배경만'].every((t) => section.includes(t)))
}

console.log(ok ? '\n✓ 표 셀 테두리·세로 정렬 검증 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
