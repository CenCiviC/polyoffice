// polyoffice_open → 편집 → 원본 자리로 되쓰기 왕복 검증: bun run open-sim
//
// mcp-sim이 "문서 만들기"를 보는 자리라면, 여기는 "남의 문서를 열어 고치고 되돌리기"를 본다.
// 브라우저 없이 편집기가 하는 일(HTTP 요청)만 그대로 흉내 낸다 —
// 진짜 dev 서버를 띄우므로 미들웨어·토큰·경로 결정이 실제 경로 그대로 돈다.
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── 원본을 임시 폴더로 복사한다. 저장이 정말 "원본 폴더"로 가는지 보려면
//    레포 밖의 자리여야 한다 (그리고 샘플을 건드리지 않는다).
const pick = (dir: string, re: RegExp) =>
  existsSync(join(REPO, dir)) ? readdirSync(join(REPO, dir)).find((f) => re.test(f)) : undefined

const srcName = pick('samples/hwp', /\.hwp$/i)
if (!srcName) {
  console.log('samples/hwp에 .hwp가 없어 건너뜁니다')
  process.exit(0)
}
const work = mkdtempSync(join(tmpdir(), 'polyoffice-open-sim-'))
const original = join(work, srcName)
copyFileSync(join(REPO, 'samples/hwp', srcName), original)
const before = readFileSync(original)
console.log(`\n원본: ${original} (${before.length}B)\n`)

const client = new Client({ name: 'polyoffice-open-sim', version: '0.0.0' })
await client.connect(new StdioClientTransport({ command: 'bun', args: ['run', 'mcp/server.ts'], cwd: REPO }))

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[]
    isError?: boolean
  }
  return { text: res.content.map((c) => c.text ?? '').join('\n'), isError: res.isError === true }
}

console.log('  … dev 서버를 띄우는 중 (처음이면 수십 초)')
const opened = await call('polyoffice_open', { path: original, open: false })
const url = opened.text.match(/http:\/\/localhost:\d+\/\?doc=\S+/)?.[0]
check('polyoffice_open이 편집기 링크를 준다', Boolean(url), url ?? opened.text)
if (!url) process.exit(1)

const token = new URL(url).searchParams.get('save')
check('저장 토큰이 실려 온다', Boolean(token))
check('.hwp는 .hwpx로 저장된다고 알린다', opened.text.includes('.hwpx'), opened.text.split('\n').find((l) => l.includes('저장하면')) ?? '')

const base = new URL(url).origin

// ── 편집기가 하는 일: 문서를 fetch → (사람이 고침) → PUT /__polyoffice/save
const docHref = new URL(url).searchParams.get('doc')!
const fetched = await fetch(new URL(docHref, base).href)
check('링크가 원본 바이트를 준다', fetched.ok && (await fetched.arrayBuffer()).byteLength === before.length)

const put = (headers: Record<string, string>, body: BodyInit) =>
  fetch(`${base}/__polyoffice/save`, { method: 'PUT', headers, body })

// 1) 토큰 없이는 못 쓴다 — 이게 뚫리면 아무 탭이나 파일을 덮어쓸 수 있다
const noToken = await put({ 'x-polyoffice-ext': '.hwpx' }, new Uint8Array([1, 2, 3]))
check('토큰 없는 저장은 403', noToken.status === 403, String(noToken.status))

const badToken = await put({ 'x-polyoffice-token': 'deadbeef', 'x-polyoffice-ext': '.hwpx' }, new Uint8Array([1, 2, 3]))
check('가짜 토큰도 403', badToken.status === 403, String(badToken.status))

// 2) 진짜 저장 — 편집기가 html2hwpx로 만든 바이트라 치고 hwpx 한 덩이를 보낸다
const payload = new Uint8Array(readFileSync(join(REPO, 'public/blank.hwpx')))
const saved = await put({ 'x-polyoffice-token': token!, 'x-polyoffice-ext': '.hwpx' }, payload)
const savedBody = (await saved.json()) as { path?: string; error?: string; note?: string | null }
check('토큰이 있으면 저장된다', saved.ok, savedBody.error ?? savedBody.path ?? '')

const expected = join(work, `${basename(srcName, '.hwp')}.edited.hwpx`)
check('원본 폴더에 .edited.hwpx로 떨어진다', savedBody.path === expected, savedBody.path ?? '')
check('그 자리에 파일이 실제로 있다', existsSync(expected) && readFileSync(expected).length === payload.length)
check('.hwp 강등을 응답이 설명한다', Boolean(savedBody.note), savedBody.note ?? '(없음)')

// 3) 원본은 손대지 않았다 — 기본값이 덮어쓰기가 아니라는 게 이 기능의 안전선
check('원본이 그대로다', Buffer.compare(readFileSync(original), before) === 0)

// 4) 경로 탈출 시도 — 확장자를 이상하게 줘도 세션 폴더 밖으로 못 나간다
const escape = await put({ 'x-polyoffice-token': token!, 'x-polyoffice-ext': '../../../../etc/passwd' }, payload)
check('허용 밖 확장자는 400', escape.status === 400, String(escape.status))

// 5) 덮어쓰기는 명시했을 때만 — .hwp 원본은 .hwpx로 쓸 수 없으니 여전히 사본이 되어야 한다
const over = await put({ 'x-polyoffice-token': token!, 'x-polyoffice-ext': '.hwpx', 'x-polyoffice-overwrite': '1' }, payload)
const overBody = (await over.json()) as { path?: string }
check('.hwp 원본은 덮어쓰기를 요청해도 사본으로 간다', overBody.path === expected, overBody.path ?? '')
check('그래도 원본은 그대로다', Buffer.compare(readFileSync(original), before) === 0)

// ── .hwpx 원본: 여기서는 덮어쓰기가 진짜로 성립해야 한다 ────────────────────
// (.hwp는 쓸 수 없어서 사본이 되지만, .hwpx는 같은 확장자로 되쓸 수 있다)
const hwpxName = pick('samples/hwpx/golden', /\.hwpx$/i)
if (hwpxName) {
  const hwpxSrc = join(work, hwpxName)
  copyFileSync(join(REPO, 'samples/hwpx/golden', hwpxName), hwpxSrc)
  const hwpxBefore = readFileSync(hwpxSrc)

  const o2 = await call('polyoffice_open', { path: hwpxSrc, open: false })
  const t2 = new URL(o2.text.match(/http:\/\/localhost:\d+\/\?doc=\S+/)![0]).searchParams.get('save')!

  // 기본값은 여전히 사본이다
  const copy = await put({ 'x-polyoffice-token': t2, 'x-polyoffice-ext': '.hwpx' }, payload)
  const copyBody = (await copy.json()) as { path?: string; overwrote?: boolean }
  check(
    'hwpx도 기본값은 사본',
    copyBody.path === join(work, `${basename(hwpxName, '.hwpx')}.edited.hwpx`) && copyBody.overwrote === false,
    copyBody.path ?? '',
  )
  check('그 시점까지 원본은 그대로', Buffer.compare(readFileSync(hwpxSrc), hwpxBefore) === 0)

  // 명시하면 진짜로 원본을 덮어쓴다
  const ow = await put({ 'x-polyoffice-token': t2, 'x-polyoffice-ext': '.hwpx', 'x-polyoffice-overwrite': '1' }, payload)
  const owBody = (await ow.json()) as { path?: string; overwrote?: boolean }
  check('hwpx는 덮어쓰기가 원본 경로로 간다', owBody.path === hwpxSrc && owBody.overwrote === true, owBody.path ?? '')
  check('원본이 실제로 바뀌었다', Buffer.compare(readFileSync(hwpxSrc), hwpxBefore) !== 0)

  // 다른 포맷으로는 덮어쓰기가 성립하지 않는다 — 사본이어야 한다
  const cross = await put({ 'x-polyoffice-token': t2, 'x-polyoffice-ext': '.odt', 'x-polyoffice-overwrite': '1' }, payload)
  const crossBody = (await cross.json()) as { path?: string; overwrote?: boolean }
  check('다른 포맷 덮어쓰기는 사본으로 강등', crossBody.overwrote === false && crossBody.path?.endsWith('.edited.odt') === true, crossBody.path ?? '')
}

const stop = await call('polyoffice_viewer', { action: 'stop' })
console.log(`  · ${stop.text}`)
await client.close()

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n✗ 실패 ${failures}건` : '\n✓ 열기→편집→되쓰기 왕복 전부 통과')
process.exit(failures ? 1 : 0)
