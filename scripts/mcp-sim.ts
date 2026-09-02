// MCP 서버를 진짜 MCP 클라이언트로 두들겨 본다 — bun run mcp-sim
//
// edit-sim·page-sim·vocab-sim과 같은 자리의 검증기. 여기서 도는 경로가
// Claude Desktop·Cursor가 도는 경로와 정확히 같다(stdio JSON-RPC).
// dev 서버까지 실제로 띄우므로 끝나면 꺼 준다.
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

const DOC = `<doc-section class="hwp-page" data-ir="0.2.0"
  style="width:8.268in;min-height:11.693in;padding:1.000in 1.000in 1.000in 1.000in">
  <p style="text-align:center"><span style="font-size:20.0pt;font-weight:bold">MCP 왕복 확인서</span></p>
  <h2><span style="font-size:14.0pt;font-weight:bold;color:rgb(94, 106, 210)">1. 목적</span></h2>
  <p><span style="font-size:10.5pt">프롬프트에서 만든 문서가 세 포맷으로 나가는지 확인한다.</span></p>
  <table style="width:100%">
    <tr><td style="background:#f1f3f5;padding:6pt"><span style="font-weight:bold">항목</span></td>
        <td style="background:#f1f3f5;padding:6pt"><span style="font-weight:bold">값</span></td></tr>
    <tr><td style="padding:6pt"><span style="font-size:10.5pt">포맷</span></td>
        <td style="padding:6pt"><span style="font-size:10.5pt">hwpx · docx · odt</span></td></tr>
  </table>
</doc-section>`

// 일부러 어휘를 벗어난 문서 — 계약 위반이 도구 오류로 되돌아오는지 본다
const BAD = `<doc-section data-ir="0.2.0"><blockquote>계약에 없는 요소</blockquote></doc-section>`

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const client = new Client({ name: 'polyoffice-mcp-sim', version: '0.0.0' })
const transport = new StdioClientTransport({ command: 'bun', args: ['run', 'mcp/server.ts'], cwd: REPO })
await client.connect(transport)
console.log('✓ stdio 연결 · initialize')

const { tools } = await client.listTools()
const names = tools.map((t) => t.name).sort()
check('도구 5종 노출', names.length === 5, names.join(' '))

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[]
    isError?: boolean
  }
  return { text: res.content.map((c) => c.text ?? '').join('\n'), isError: res.isError === true }
}

const guide = await call('polyoffice_guide')
check('polyoffice_guide가 어휘를 돌려준다', guide.text.includes('doc-section') && guide.text.length > 1000, `${guide.text.length}자`)

const bad = await call('polyoffice_write', { ir_html: BAD, open: false })
check('계약 위반은 오류로 돌아온다', bad.isError && bad.text.includes('element-allowed'), bad.text.split('\n')[0])

console.log('  … dev 서버를 띄우는 중 (처음이면 수십 초)')
const write = await call('polyoffice_write', { ir_html: DOC, name: 'MCP-왕복확인서', open: false })
for (const f of ['hwpx', 'docx', 'odt']) {
  check(`${f} 생성 + 되읽기`, new RegExp(`${f}\\s+✓`).test(write.text))
}
const url = write.text.match(/http:\/\/localhost:\d+\/\?doc=\S+/)?.[0]
check('편집기 링크', Boolean(url), url ?? write.text)

// 링크가 진짜 문서를 서빙하는가 — 편집기는 이 URL을 fetch한다
if (url) {
  const docPath = new URL(url).searchParams.get('doc')!
  const res = await fetch(new URL(docPath, url).href)
  const bytes = new Uint8Array(await res.arrayBuffer())
  check('링크가 hwpx 바이트를 준다', res.ok && bytes[0] === 0x50 && bytes[1] === 0x4b, `${res.status} · ${bytes.length}B`)
}

const dir = write.text.match(/파일: (.+)/)?.[1]
if (dir) {
  const read = await call('polyoffice_read', { path: `${dir}/MCP-왕복확인서.hwpx` })
  check('polyoffice_read가 IR로 되돌린다', read.text.includes('MCP 왕복 확인서') && read.text.includes('<doc-section'))
}

const status = await call('polyoffice_viewer', { action: 'status' })
check('뷰어 status', status.text.includes('http://localhost:'), status.text)

const stop = await call('polyoffice_viewer', { action: 'stop' })
console.log(`  · ${stop.text}`)

await client.close()
console.log(failures ? `\n✗ 실패 ${failures}건` : '\n✓ MCP 왕복 전부 통과')
process.exit(failures ? 1 : 0)
