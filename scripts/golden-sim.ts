// 골든 대조 — bun run golden-sim
//
// 지키려는 것: **hwpx 어휘를 추측으로 쓰지 않는다.**
// `samples/hwpx/golden/`은 한글이 자기 손으로 저장한 파일이다(출처는 그 폴더의 README).
// 여기서는 골든이 실제로 그렇게 적혀 있는지 먼저 확인하고, 우리 출력이 같은 어휘를
// 쓰는지 대조한다. 골든이 바뀌면(다른 한글 버전에서 다시 뜨면) 이 검사가 먼저 깨진다.
//
// 색·링크·각주 번호는 전부 이 대조 없이는 "화면으로 봐야만" 알 수 있던 것들이다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'

import { IR_VERSION, normalizeIR } from '../src/lib/ir'
import { html2hwpx } from '../src/lib/html2hwpx'

const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url)))
const goldenDir = new URL('../samples/hwpx/golden/', import.meta.url)

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

const golden = (name: string) => {
  const zip = unzipSync(new Uint8Array(readFileSync(new URL(name, goldenDir))))
  return {
    header: strFromU8(zip['Contents/header.xml']),
    section: strFromU8(zip['Contents/section0.xml']),
  }
}

const oursOf = (body: string) => {
  const w = new Window()
  w.document.body.innerHTML = body
  const root = w.document.body as unknown as Element
  normalizeIR(root)
  const zip = unzipSync(html2hwpx(root, template).data)
  return {
    header: strFromU8(zip['Contents/header.xml']),
    section: strFromU8(zip['Contents/section0.xml']),
  }
}

const SECTION = (inner: string) =>
  `<doc-section data-ir="${IR_VERSION}" style="width:8.268in;min-height:11.693in;padding:1in 1in 1in 1in">${inner}</doc-section>`

// ── 1. 색은 #BBGGRR ─────────────────────────────────────────────────
{
  const g = golden('golden-color.hwpx')
  // 한글에게 RGBColor(255,0,0) = 순수 빨강을 지정하고 저장시킨 파일이다
  check('골든: 빨강이 #0000FF로 저장돼 있다', g.header.includes('textColor="#0000FF"'))
  check('골든: 없음 센티넬은 #FFFFFFFF', g.header.includes('shadeColor="#FFFFFFFF"'))
  check('골든: none 표기는 안 쓴다(한글 2018)', !g.header.includes('="none"'))

  const ours = oursOf(SECTION('<p data-id="b1"><span style="color:rgb(255, 0, 0)">빨강</span></p>'))
  check('우리도 빨강을 #0000FF로 쓴다', ours.header.includes('textColor="#0000FF"'), 'BGR')
  check('우리도 없음을 #FFFFFFFF로 쓴다', ours.header.includes('shadeColor="#FFFFFFFF"'))
  check('none이 한 군데도 안 남는다(템플릿 것 포함)', !ours.header.includes('="none"'))

  // 대칭이 아닌 색으로 한 번 더 — 자리만 맞고 값이 틀리는 걸 잡는다
  const g2 = oursOf(SECTION('<p data-id="b1"><span style="color:rgb(18, 52, 86)">색</span></p>'))
  check('#123456 → #563412', g2.header.includes('textColor="#563412"'))
}

// ── 2. 하이퍼링크 필드 ──────────────────────────────────────────────
{
  const g = golden('golden-hyperlink.hwpx')
  const params = [
    '<hp:integerParam name="Prop">0</hp:integerParam>',
    '<hp:stringParam name="Command">',
    '<hp:stringParam name="Path">',
    'HWPHYPERLINK_TYPE_HWP',
    'HWPHYPERLINK_TARGET_BOOKMARK',
    'HWPHYPERLINK_JUMP_CURRENTTAB',
  ]
  check('골든: HYPERLINK 필드', /<hp:fieldBegin[^>]*type="HYPERLINK"/.test(g.section))
  check('골든: 파라미터 여섯 개', g.section.includes('<hp:parameters cnt="6"') && params.every((p) => g.section.includes(p)))
  check('골든: 주소가 Command·Path에 그대로', (g.section.match(/hancom\.com/g) ?? []).length >= 2)

  const ours = oursOf(SECTION('<p data-id="b1"><a href="https://www.hancom.com/">한컴</a></p>'))
  check('우리도 HYPERLINK 필드로 쓴다', /<hp:fieldBegin[^>]*type="HYPERLINK"/.test(ours.section))
  check('우리도 파라미터 여섯 개가 같다', ours.section.includes('<hp:parameters cnt="6"') && params.every((p) => ours.section.includes(p)))
  check('우리도 주소를 Command·Path 둘 다에', (ours.section.match(/hancom\.com/g) ?? []).length >= 2)
  check(
    'fieldBegin/fieldEnd가 같은 fieldid로 짝',
    (() => {
      const b = /<hp:fieldBegin[^>]*fieldid="(\d+)"/.exec(ours.section)?.[1]
      const e = /<hp:fieldEnd[^>]*fieldid="(\d+)"/.exec(ours.section)?.[1]
      return !!b && b === e
    })(),
  )
}

// ── 3. 각주 번호의 자리 ─────────────────────────────────────────────
{
  const g = golden('golden-footnote.hwpx')
  // 한글은 번호를 각주 subList 안, 첫 문단의 run에 둔다 — 밖에 두면 번호가 안 그려진다
  check(
    '골든: 번호가 각주 subList 안에 있다',
    /<hp:footNote[^>]*>[\s\S]{0,200}?<hp:subList[^>]*>[\s\S]{0,400}?numType="FOOTNOTE"/.test(g.section),
  )
  check('골든: autoNumFormat이 번호에 딸려 있다', /numType="FOOTNOTE">\s*<hp:autoNumFormat/.test(g.section))

  const ours = oursOf(
    SECTION(
      '<p data-id="b1">본문<sup><a data-fn-ref="f1"></a></sup></p>' +
        '<doc-footnote id="f1" data-id="b2"><p data-id="b3">각주</p></doc-footnote>',
    ),
  )
  check(
    '우리도 번호를 subList 안에 둔다',
    /<hp:footNote[^>]*>[\s\S]{0,200}?<hp:subList[^>]*>[\s\S]{0,400}?numType="FOOTNOTE"/.test(ours.section),
  )
  check('우리도 autoNumFormat을 딸려 보낸다', /numType="FOOTNOTE">\s*<hp:autoNumFormat/.test(ours.section))
}

console.log(ok ? '\n✓ 골든 대조 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
