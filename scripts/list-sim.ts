// 목록 numbering 헤드리스 검증 — bun run list-sim
//
// 지키려는 것: **글머리표·번호가 본문 글자가 아니어야 한다.**
// 예전에는 세 백엔드가 `"• "`/`"1. "`를 텍스트로 박았다. 그러면 한글·Word에서 열었을 때
// 목록처럼 보이기만 하고 목록이 아니라서, 항목을 추가해도 기호가 안 붙고 지우면 기호만 남는다.
//
// 함께 보는 것:
//   - 목록 인스턴스마다 번호를 새로 세는가 (둘째 `<ol>`이 1부터)
//   - 중첩이 수준으로 남는가 (docx ilvl · hwpx heading level · odt 트리 깊이)
//   - `<li>` 주위 들여쓰기 공백이 줄바꿈으로 새지 않는가
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unzipSync, strFromU8 } from 'fflate'

import { IR_VERSION, normalizeIR, validateIR } from '../src/lib/ir'
import { readIr } from '../src/lib/ir-model'
import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'

const template = new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url)))

let ok = true
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) ok = false
}

// 일부러 소스를 예쁘게 들여써서 공백 처리까지 같이 본다
const BODY = `<doc-section data-ir="${IR_VERSION}" style="width:8.268in;min-height:11.693in;padding:1in 1in 1in 1in">
  <p>머리말</p>
  <ol>
    <li>첫째</li>
    <li>둘째
      <ol>
        <li>둘째의 하위</li>
      </ol>
    </li>
  </ol>
  <ul>
    <li>사과</li>
    <li>배</li>
  </ul>
  <ol>
    <li>다시 하나</li>
    <li>다시 둘</li>
  </ol>
</doc-section>`

const win = new Window()
win.document.body.innerHTML = BODY
const root = win.document.body as unknown as Element
normalizeIR(root)

// ── 1. 계약 ─────────────────────────────────────────────────────────
{
  const v = validateIR(root)
  check('중첩 목록이 IR 계약을 통과', v.length === 0, v.map((x) => x.message).join(' / '))
}

// ── 2. 중립 트리 ────────────────────────────────────────────────────
{
  const doc = readIr(root)
  check('목록 인스턴스 3개', doc.lists.length === 3, doc.lists.map((l) => `${l.id}:${l.levels.join('/')}`).join(' '))
  check(
    '수준별 표시가 ol=decimal · ul=bullet',
    doc.lists[0].levels.join(',') === 'decimal,decimal' &&
      doc.lists[1].levels.join(',') === 'bullet' &&
      doc.lists[2].levels.join(',') === 'decimal',
  )
  const paras = doc.sections[0].blocks.flatMap((b) => (b.kind === 'p' ? [b.para] : []))
  const items = paras.filter((p) => p.list)
  check('목록 문단 7개 · 수준 0/0/1/0/0/0/0', items.map((p) => p.list?.level).join('') === '0010000')
  check(
    '항목 글자에 글머리표·번호가 섞여 있지 않다',
    items.every((p) => !/^[•◦▪]|^\d+\./.test(p.runs.map((r) => r.text).join(''))),
  )
  check(
    '들여쓰기 공백이 줄바꿈으로 새지 않는다',
    items.every((p) => !p.runs.some((r) => r.text.includes('\n'))),
    items.map((p) => JSON.stringify(p.runs.map((r) => r.text).join(''))).join(' '),
  )
}

// ── 3. docx — numbering.xml 파트 ────────────────────────────────────
{
  const { data } = html2docx(root)
  const zip = unzipSync(data)
  check('numbering.xml 파트 존재', 'word/numbering.xml' in zip)
  const numbering = strFromU8(zip['word/numbering.xml'] ?? new Uint8Array())
  const doc = strFromU8(zip['word/document.xml'])
  const types = strFromU8(zip['[Content_Types].xml'])
  const rels = strFromU8(zip['word/_rels/document.xml.rels'])
  check('Content_Types에 numbering 등록', types.includes('/word/numbering.xml'))
  check('document.xml.rels에 numbering 관계', rels.includes('Target="numbering.xml"'))
  check('abstractNum 3개 (목록마다 따로 — 번호를 새로 세려고)', (numbering.match(/<w:abstractNum /g) ?? []).length === 3)
  check('num 3개', (numbering.match(/<w:num /g) ?? []).length === 3)
  check('번호 서식 %1. / 글머리표 •', numbering.includes('w:val="%1."') && numbering.includes('w:val="•"'))
  const numPr = [...doc.matchAll(/<w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/>/g)].map((m) => `${m[2]}.${m[1]}`)
  check('문단이 numId.ilvl로 묶인다', numPr.join(' ') === '1.0 1.0 1.1 2.0 2.0 3.0 3.0', numPr.join(' '))
  check('본문에 "• "/"1. " 텍스트가 없다', !/<w:t[^>]*>\s*(•|\d+\.)\s*<\/w:t>/.test(doc))
}

// ── 4. odt — text:list 트리 ─────────────────────────────────────────
{
  const { data } = html2odt(root)
  const content = strFromU8(unzipSync(data)['content.xml'])
  check('list-style 3종 등록', (content.match(/<text:list-style /g) ?? []).length === 3)
  check(
    '번호는 list-level-style-number · 글머리표는 -bullet',
    content.includes('<text:list-level-style-number') && content.includes('text:bullet-char="•"'),
  )
  check('text:list 4개 (최상위 3 + 중첩 1)', (content.match(/<text:list[ >]/g) ?? []).length === 4)
  check('중첩이 list-item 안에 들어간다', /<text:list-item>(?:(?!<\/text:list-item>).)*<text:list>/s.test(content))
  check('줄바꿈이 새지 않는다', !content.includes('<text:line-break/>'))
  check('본문에 글머리표 글자가 없다', !content.includes('>•<'))
}

// ── 5. hwpx — hh:numbering + heading ────────────────────────────────
{
  const { data, added } = html2hwpx(root, template)
  const zip = unzipSync(data)
  const header = strFromU8(zip['Contents/header.xml'])
  const section = strFromU8(zip['Contents/section0.xml'])
  check('numbering 3개 추가 등록', added.numbering === 3, `numbering=${added.numbering}`)
  check(
    'numberings itemCnt가 함께 늘었다',
    header.includes('<hh:numberings itemCnt="4"'),
    (header.match(/<hh:numberings itemCnt="\d+"/) ?? [''])[0],
  )
  // 골든 파일(실물 한글 문서)에서 확인한 형태 그대로인가
  check('paraHead 번호 서식 ^1. · 글머리표 •', header.includes('>^1.</hh:paraHead>') && header.includes('>•</hh:paraHead>'))
  check('paraHead charPrIDRef=4294967295 (문단 글자모양 상속)', header.includes('charPrIDRef="4294967295"'))
  const heads = [...header.matchAll(/<hh:heading type="NUMBER" idRef="(\d+)" level="(\d+)"\/>/g)].map(
    (m) => `${m[1]}.${m[2]}`,
  )
  check('heading type=NUMBER가 목록 3개 · 수준 2종을 가리킨다', heads.length === 4, heads.join(' '))
  check('본문에 "• "/"1. " 텍스트가 없다', !/<hp:t>\s*(•|\d+\.)\s*<\/hp:t>/.test(section))
  check('항목 글자는 살아 있다', ['첫째', '둘째의 하위', '사과', '다시 둘'].every((t) => section.includes(t)))
}

console.log(ok ? '\n✓ 목록 numbering 검증 통과' : '\n✗ 실패')
process.exit(ok ? 0 : 1)
