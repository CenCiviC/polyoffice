/**
 * 조립한 `build/npm/` 패키지를 **설치된 것처럼** 검증한다.
 *
 * 레포에서 돌려 보는 건 의미가 적다 — 옆에 소스와 node_modules가 있으니 뭐든 된다.
 * 여기서는 번들을 **node로**(bun 아님) 띄우고, vite 없이 정적 서버로 편집기를
 * 서빙하는 길까지 실제로 밟는다. 사용자가 `npx polyoffice-mcp`로 마주칠 경로다.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PKG = join(REPO, 'build', 'npm')

let failed = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// ── 레이아웃 — 자산 경로가 레포와 같아야 doc-core의 상대 경로가 성립한다
console.log('\n패키지 레이아웃')
const must = [
  'package.json',
  'bin/polyoffice-mcp.js',
  'public/app/index.html',
  'public/blank.hwpx',
  'public/fonts/NotoSansKR-Regular.ttf',
  'public/fonts/NotoSansKR-Bold.ttf',
  'public/fonts/LICENSE-OFL.txt',
  'rust/poly-core/pkg/poly_core_bg.wasm',
  'docs/IR-AUTHORING.md',
  'LICENSE',
  'README.md',
]
for (const f of must) check(f, existsSync(join(PKG, f)))
check('vite.config.ts 없음 (패키지 모드로 감지되게)', !existsSync(join(PKG, 'vite.config.ts')))
check('SPA에 TTF 중복 없음', !existsSync(join(PKG, 'public/app/fonts/NotoSansKR-Regular.ttf')))
check('남의 문서(scratch)가 안 실림', !existsSync(join(PKG, 'public/app/scratch')))

const bin = readFileSync(join(PKG, 'bin', 'polyoffice-mcp.js'), 'utf8')
check('shebang', bin.startsWith('#!/usr/bin/env node'))
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
check('bin 항목', manifest.bin?.['polyoffice-mcp'] === 'bin/polyoffice-mcp.js')
check('private 아님', manifest.private !== true)
// README가 없으면 npm 페이지가 빈 채로 올라간다
const readme = readFileSync(join(PKG, 'README.md'), 'utf8')
check('README에 설치 한 줄', readme.includes('claude mcp add polyoffice'))

// 사람이 터미널에서 쳐 봤을 때 멈춰 있지 않아야 한다
const { execFileSync } = await import('node:child_process')
const node = process.execPath.includes('bun') ? 'node' : process.execPath
const help = execFileSync(node, [join(PKG, 'bin', 'polyoffice-mcp.js'), '--help'], {
  encoding: 'utf8',
  timeout: 20_000,
})
check('--help 이 설명하고 끝난다', help.includes('claude mcp add polyoffice'))
const ver = execFileSync(node, [join(PKG, 'bin', 'polyoffice-mcp.js'), '--version'], {
  encoding: 'utf8',
  timeout: 20_000,
}).trim()
check('--version 이 매니페스트와 같다', ver === manifest.version, `${ver} vs ${manifest.version}`)

let total = 0
const walk = (dir: string) => {
  for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else total += statSync(p).size
  }
}
walk(PKG)
console.log(`  · 패키지 크기 ${(total / 1024 / 1024).toFixed(1)}MB`)

// ── node로 띄워 실제 MCP 왕복
console.log('\nnode로 띄운 MCP 왕복 (bun 없이)')
const client = new Client({ name: 'polyoffice-pack-check', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath.includes('bun') ? 'node' : process.execPath,
  args: [join(PKG, 'bin', 'polyoffice-mcp.js')],
  // 레포 밖에서 띄운다 — cwd에 기대는 코드가 남아 있으면 여기서 드러난다
  cwd: mkdtempSync(join(tmpdir(), 'polyoffice-pack-')),
})
await client.connect(transport)
check('stdio 연결', true)

const tools = await client.listTools()
const names = tools.tools.map((t) => t.name).sort()
check('도구 5종', names.length === 5, names.join(' '))

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[]
    isError?: boolean
  }
  return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError === true }
}

const guide = await call('polyoffice_guide')
check('polyoffice_guide', !guide.isError && guide.text.includes('doc-section'), `${guide.text.length}자`)

const IR = `<doc-section class="hwp-page" data-ir="0.2.0" style="width:8.268in;min-height:11.693in;padding:1.000in 1.000in 1.000in 1.000in">
<p><span style="font-size:10.5pt">패키지에서 만든 문서</span></p>
<table style="width:100%"><tr><td style="padding:6pt"><span style="font-size:10.5pt">셀</span></td></tr></table>
</doc-section>`
const written = await call('polyoffice_write', { ir_html: IR, name: '패키지검증', open: false })
check('polyoffice_write — 3포맷', !written.isError && ['hwpx', 'docx', 'odt'].every((f) => written.text.includes(f)))

// 편집기 링크 → 정적 서버가 실제로 바이트를 주는가 (vite 없이)
const link = written.text.match(/http:\/\/localhost:\d+\/\?doc=\S+/)?.[0]
check('편집기 링크', Boolean(link), link ?? '없음')
if (link) {
  const base = new URL(link).origin
  const ping = await fetch(`${base}/__polyoffice/ping`).then((r) => r.json() as Promise<{ mode?: string }>)
  check('정적 서버 모드', ping.mode === 'static', `mode=${ping.mode}`)
  const index = await fetch(`${base}/`)
  check('편집기 SPA 서빙', index.ok && (await index.text()).includes('PolyOffice'))
  const doc = await fetch(`${base}${new URL(link).search.replace('?doc=', '')}`)
  check('문서 바이트 서빙', doc.ok && (await doc.arrayBuffer()).byteLength > 1000)
  const escape = await fetch(`${base}/scratch/..%2f..%2fpackage.json`)
  check('경로 탈출 차단', escape.status === 404, `${escape.status}`)
}

// 되읽기 — 패키지에 동봉한 wasm 파서가 도는가
const tmpDoc = join(mkdtempSync(join(tmpdir(), 'polyoffice-read-')), 'a.hwpx')
const hwpxPath = written.text.match(/파일: (.+)$/m)?.[1]
if (hwpxPath && existsSync(join(hwpxPath, '패키지검증.hwpx'))) {
  writeFileSync(tmpDoc, readFileSync(join(hwpxPath, '패키지검증.hwpx')))
  const read = await call('polyoffice_read', { path: tmpDoc })
  check('polyoffice_read — 동봉 wasm 파서', !read.isError && read.text.includes('패키지에서 만든 문서'))
} else {
  check('polyoffice_read — 동봉 wasm 파서', false, '생성 파일을 못 찾음')
}

await call('polyoffice_viewer', { action: 'stop' }).catch(() => {})
await client.close()

console.log(failed ? `\n✗ ${failed}건 실패` : '\n✓ 패키지 검증 전부 통과')
process.exit(failed ? 1 : 0)
