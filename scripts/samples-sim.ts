// 손으로 쓴 IR 전수 검사 — bun run samples-sim
//
// 왜 있나: **sim들은 저마다 자기가 만든 픽스처만 본다.** 그 픽스처는 우리가 썼으니까
// 우리가 아는 함정만 피해 간다. 실제로 sim 열 종이 전부 초록불인 상태에서, 사람이 HTML
// 쓰듯 쓴 IR 한 장(첫 행에만 폭을 주고 높이는 안 준 표)이 한글에서 표를 통째로 뭉갰다.
//
// 그래서 여기서는 `samples/ir/*.html` — **우리가 계약만 주고 내용은 맡긴 문서들** — 을
// 전부 돌려서, 문서 내용과 무관하게 **어떤 문서에나 성립해야 하는 불변식**을 본다.
// 특정 문구를 기대하지 않는다(문서가 늘어나도 검사가 안 깨진다).
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'

import { buildDocument, IRContractError } from './doc-core'

const dir = fileURLToPath(new URL('../samples/ir/', import.meta.url))
const files = readdirSync(dir).filter((f) => f.endsWith('.html') && !f.endsWith('.preview.html'))

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

if (!files.length) {
  console.log('samples/ir 에 문서가 없다 — 검사할 것이 없다')
  process.exit(1)
}

for (const name of files) {
  console.log(`\n── ${name} ─────────────────────────`)
  let built
  try {
    built = await buildDocument(readFileSync(join(dir, name), 'utf8'))
  } catch (e) {
    if (!(e instanceof IRContractError)) throw e
    check('IR 계약 통과', false, e.violations.slice(0, 3).map((v) => `[${v.rule}] ${v.message}`).join(' / '))
    continue
  }
  check('IR 계약 통과', true, `블록 ${built.blocks}개`)

  for (const o of built.outputs) {
    check(`${o.format} 쓰기 + 되읽기`, o.ok && !o.error, o.error ?? (o.missing.length ? `누락 ${o.missing.length}개` : `문단 ${o.paragraphs} 표 ${o.tables}`))
  }

  const zipOf = (fmt: string) => {
    const out = built.outputs.find((o) => o.format === fmt)
    return out?.bytes.length ? unzipSync(out.bytes) : null
  }

  // ── hwpx 불변식 ────────────────────────────────────────────────
  const hz = zipOf('hwpx')
  if (hz) {
    const header = strFromU8(hz['Contents/header.xml'])
    const section = strFromU8(hz['Contents/section0.xml'])

    // 한글 2018이 `none`을 검정으로 읽어 본문을 새까맣게 칠한다
    check('색에 none 표기가 없다', !/(shadeColor|faceColor)="none"/.test(header))

    // 셀마다 폭·높이가 실제 값이어야 한다 — 한글은 저장된 값을 그대로 쓴다.
    // 100pt(=10000)는 예전에 폭을 모를 때 박던 값, 15pt(=1500)는 한 줄 높이 기본값.
    const cells = [...section.matchAll(/<hp:cellSz width="(\d+)" height="(\d+)"\/>/g)]
    if (cells.length) {
      const oneLine = cells.filter((m) => m[2] === '1500').length
      check('표 행 높이가 한 줄로 굳지 않았다', oneLine === 0, `${oneLine}/${cells.length}개가 15pt`)
      check('셀 폭이 0이 아니다', cells.every((m) => Number(m[1]) > 0))
    }

    // 셀 여백을 쓰겠다고 표시해야 한글이 hp:cellMargin을 본다
    const tcs = (section.match(/<hp:tc /g) ?? []).length
    if (tcs) check('셀이 자기 여백을 쓴다고 표시', !/<hp:tc [^>]*hasMargin="0"/.test(section))

    // 개요 문단이 있으면 구역이 우리 개요 정의를 가리켜야 번호가 그려진다
    const outlineRef = /<hh:heading type="OUTLINE" idRef="([1-9]\d*)"/.exec(header)
    if (outlineRef) {
      const secShape = /<hp:secPr\b[^>]*\boutlineShapeIDRef="(\d+)"/.exec(section)
      check('개요를 쓰면 secPr이 그 정의를 가리킨다', secShape?.[1] === outlineRef[1], `secPr=${secShape?.[1]} heading=${outlineRef[1]}`)
    }

    // 머리말·꼬리말이 있으면 본문과 겹치지 않게 여백을 쪼개야 한다
    const margin = /<hp:margin header="(\d+)" footer="(\d+)"/.exec(section)
    if (/<hp:header /.test(section)) check('머리말이 있으면 header 여백이 0이 아니다', Number(margin?.[1]) > 0, `header=${margin?.[1]}`)
    if (/<hp:footer /.test(section)) check('꼬리말이 있으면 footer 여백이 0이 아니다', Number(margin?.[2]) > 0, `footer=${margin?.[2]}`)

    // 각주 번호는 subList 안에 있어야 한글이 그린다
    const notes = (section.match(/<hp:footNote /g) ?? []).length
    if (notes) {
      const inside = (section.match(/<hp:footNote [^>]*><hp:subList[^>]*><hp:p[^>]*><hp:run[^>]*><hp:ctrl><hp:autoNum num="1" numType="FOOTNOTE"/g) ?? []).length
      check('각주 번호가 전부 subList 안에', inside === notes, `${inside}/${notes}`)
    }

    // 링크는 강등되지 않는다 — fieldBegin/End가 짝을 이룬다
    const fb = (section.match(/<hp:fieldBegin/g) ?? []).length
    const fe = (section.match(/<hp:fieldEnd/g) ?? []).length
    check('링크 필드가 짝을 이룬다', fb === fe, `begin ${fb} / end ${fe}`)
  }

  // ── docx 불변식 ────────────────────────────────────────────────
  const dz = zipOf('docx')
  if (dz?.['word/numbering.xml']) {
    const numbering = strFromU8(dz['word/numbering.xml'])
    const order = [...numbering.matchAll(/<w:(abstractNum w:abstractNumId|num w:numId)="([0-9]+)"/g)].map((m) => ({
      kind: m[1].startsWith('abstractNum') ? 'a' : 'n',
      id: Number(m[2]),
    }))
    const firstNum = order.findIndex((o) => o.kind === 'n')
    const asc = (xs: number[]) => xs.every((v, i) => i === 0 || xs[i - 1] < v)
    check(
      'numbering이 Word가 읽는 순서 (abstractNum 먼저 · id 오름차순)',
      (firstNum === -1 || order.slice(firstNum).every((o) => o.kind === 'n')) &&
        asc(order.filter((o) => o.kind === 'a').map((o) => o.id)) &&
        asc(order.filter((o) => o.kind === 'n').map((o) => o.id)),
      order.map((o) => o.kind + o.id).join(' '),
    )
  }
}

console.log(ok ? '\n✓ 손으로 쓴 IR 전수 검사 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
