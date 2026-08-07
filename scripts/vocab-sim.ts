// IR v0.2.0에서 늘어난 어휘 헤드리스 검증:
//   a[href] · sup/sub · margin-left/text-indent/margin-top/margin-bottom
// 계약(validateIR·normalizeIR)과 쓰기 백엔드 3종을 한 번에 본다.
//
// 특히 지키려는 것: **hwpx 링크 강등에서 글자가 사라지지 않는가.**
// 예전 hwpx 백엔드에는 <a>·<sub> 분기가 없어서 그 안의 글자가 조용히 없어졌다.
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'
import { normalizeIR, validateIR, IR_VERSION } from '../src/lib/ir'
import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'

const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url).pathname))

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

const docOf = (body: string) => {
  const w = new Window()
  w.document.body.innerHTML = body
  return w.document
}

// ── 1. 계약: link-target 규칙 ────────────────────────────────────────
{
  const good = docOf(
    `<doc-section data-ir="${IR_VERSION}"><p data-id="b1">` +
      `<a href="https://mois.go.kr">외부</a> <a href="#b1">내부</a> <a href="mailto:a@b.kr">메일</a>` +
      `</p></doc-section>`,
  )
  check('안전한 href 3종 통과', validateIR(good.body as unknown as Element).length === 0)

  const bad = docOf(`<doc-section><p data-id="b1"><a href="javascript:alert(1)">위험</a></p></doc-section>`)
  const v = validateIR(bad.body as unknown as Element)
  check('javascript: 스킴 거절', v.some((x) => x.rule === 'link-target'), v.map((x) => x.message).join(' / '))

  const both = docOf(`<doc-section><p data-id="b1"><a href="https://a.kr" data-fn-ref="fn1">겸용</a></p></doc-section>`)
  check(
    'href와 data-fn-ref 동시 지정 거절',
    validateIR(both.body as unknown as Element).some((x) => x.rule === 'link-target'),
  )
}

// ── 2. normalizeIR: 붙여넣기 세탁 ────────────────────────────────────
{
  const d = docOf(
    `<doc-section><p data-id="b1">` +
      `<a href="https://a.kr" target="_blank" rel="noopener" title="t">정상</a>` +
      `<a href="javascript:evil()">위험한글자</a>` +
      `</p></doc-section>`,
  )
  normalizeIR(d.body as unknown as Element)
  const html = d.body.innerHTML
  check('계약 밖 속성(target·rel·title) 제거', !/target=|rel=|title=/.test(html), html.slice(0, 120))
  check('위험한 링크는 벗기고 글자는 남긴다', !html.includes('javascript:') && html.includes('위험한글자'))
  check('세탁 후 validateIR 통과', validateIR(d.body as unknown as Element).length === 0)
}

// ── 3. 쓰기 3종 ──────────────────────────────────────────────────────
// 링크 + 첨자 + 들여쓰기/여백 + 그림(관계 id 충돌 확인용)을 한 문서에 담는다
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SOT =
  `<doc-section data-ir="${IR_VERSION}" style="width:8.268in;min-height:11.693in;padding:0.787in">` +
  `<p data-id="b1" style="margin-left:20.0pt;text-indent:13.0pt;margin-top:5.0pt;margin-bottom:3.0pt">` +
  `들여쓴 문단과 <a href="https://mois.go.kr/manual">링크된글자</a>와 ` +
  `면적 1,200m<sup>2</sup>와 H<sub>2</sub>O` +
  `</p>` +
  `<p data-id="b2" style="text-indent:-15.0pt;margin-left:30.0pt">내어쓴 문단</p>` +
  `<p data-id="b3"><img src="data:image/png;base64,${PNG}" alt="" style="width:10.0pt;height:10.0pt"></p>` +
  `</doc-section>`

const root = docOf(SOT).body as unknown as Element
check('SOT가 IR 계약 통과', validateIR(root).length === 0, validateIR(root).map((v) => v.message).join(' / '))

// docx
{
  const files = unzipSync(html2docx(root).data)
  const xml = strFromU8(files['word/document.xml'])
  const rels = strFromU8(files['word/_rels/document.xml.rels'])
  check('docx w:hyperlink 생성', /<w:hyperlink r:id="rId\d+">/.test(xml))
  check(
    'docx 링크 관계가 External',
    /Type="[^"]*\/hyperlink" Target="https:\/\/mois\.go\.kr\/manual" TargetMode="External"/.test(rels),
  )
  const ids = [...rels.matchAll(/Id="(rId\d+)"/g)].map((m) => m[1])
  check('docx 관계 id 충돌 없음 (그림+링크)', new Set(ids).size === ids.length, ids.join(' '))
  check('docx 위첨자', xml.includes('<w:vertAlign w:val="superscript"/>'))
  check('docx 아래첨자', xml.includes('<w:vertAlign w:val="subscript"/>'))
  // 20pt = 400twip, 첫 줄 13pt = 260twip
  check('docx 들여쓰기 w:ind', /<w:ind w:left="400" w:firstLine="260"\/>/.test(xml), xml.match(/<w:ind[^>]*>/)?.[0] ?? '')
  // 내어쓰기 -15pt → hanging 300
  check('docx 내어쓰기 → w:hanging', /<w:ind w:left="600" w:hanging="300"\/>/.test(xml))
  // 앞 5pt=100twip, 뒤 3pt=60twip
  check('docx 단락 앞뒤 여백', /<w:spacing w:before="100" w:after="60"/.test(xml), xml.match(/<w:spacing[^>]*>/)?.[0] ?? '')
  check('docx 링크 글자 살아 있음', xml.includes('링크된글자'))
}

// odt
{
  const xml = strFromU8(unzipSync(html2odt(root).data)['content.xml'])
  check('odt text:a 생성', /<text:a xlink:type="simple" xlink:href="https:\/\/mois\.go\.kr\/manual">/.test(xml))
  check('odt 위첨자', xml.includes('style:text-position="super 58%"'))
  check('odt 아래첨자', xml.includes('style:text-position="sub 58%"'))
  check('odt 들여쓰기', /fo:margin-left="20.00pt"/.test(xml) && /fo:text-indent="13.00pt"/.test(xml))
  check('odt 내어쓰기(음수 유지)', /fo:text-indent="-15.00pt"/.test(xml))
  check('odt 단락 앞뒤 여백', /fo:margin-top="5.00pt"/.test(xml) && /fo:margin-bottom="3.00pt"/.test(xml))
  check('odt 링크 글자 살아 있음', xml.includes('링크된글자'))
}

// hwpx — 링크는 강등, 나머지는 실물 매핑
{
  const xml = strFromU8(unzipSync(html2hwpx(root, template).data)['Contents/section0.xml'])
  const header = strFromU8(unzipSync(html2hwpx(root, template).data)['Contents/header.xml'])
  check('hwpx 위첨자 charPr', header.includes('<hh:supscript/>'))
  check('hwpx 아래첨자 charPr', header.includes('<hh:subscript/>'))
  // 20pt → 2000 HWPUNIT, 첫 줄 13pt → 1300, 앞 5pt → 500, 뒤 3pt → 300
  check('hwpx 들여쓰기 hc:left', /<hc:left value="2000"/.test(header), header.match(/<hc:left[^>]*>/)?.[0] ?? '')
  check('hwpx 첫 줄 hc:intent', /<hc:intent value="1300"/.test(header))
  check('hwpx 내어쓰기(음수 intent)', /<hc:intent value="-1500"/.test(header))
  check('hwpx 단락 앞뒤 여백', /<hc:prev value="500"/.test(header) && /<hc:next value="300"/.test(header))
  // ★ 강등의 핵심: 주소는 버려도 글자는 남아야 한다
  check('hwpx 링크 강등 — 글자 보존', xml.includes('링크된글자'))
  check('hwpx 링크 강등 — 주소 없음', !xml.includes('mois.go.kr'))
  check('hwpx 첨자 글자 보존', xml.includes('H') && xml.includes('2'))
}

console.log(ok ? '\nIR v0.2.0 어휘 검증 통과' : '\n검증 실패')
process.exit(ok ? 0 : 1)
