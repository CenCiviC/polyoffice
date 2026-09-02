/**
 * polyoffice MCP 서버 (stdio) — 프롬프트에서 한글·Word 문서를 만들고 곧바로 열어 본다.
 *
 *   polyoffice_guide   IR 어휘 설명서 (문서를 쓰기 전에 이걸 먼저 읽는다)
 *   polyoffice_write   IR HTML → hwpx·docx·odt + 로컬 편집기 링크
 *   polyoffice_read    기존 문서 → IR HTML (고쳐 쓰려면 여기서 출발)
 *   polyoffice_open    기존 문서를 편집기로 열기 — 고쳐서 원본 자리에 되쓸 수 있다
 *   polyoffice_viewer  로컬 dev 서버 상태·시작·정지
 *
 * 전부 이 컴퓨터 안에서 돈다. 파일도 뷰어(vite dev 서버)도 로컬이고,
 * 문서가 밖으로 나가지 않는다 — "파일이 서버로 안 올라간다"는 이 프로젝트의 전제 그대로.
 *
 * stdout은 MCP 프로토콜 전용이다. 로그는 전부 stderr로.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { FORMATS, IRContractError, buildDocument, readDocument, type Format } from '../scripts/doc-core'
import { REPO, editorUrl, ensureViewer, publish, slug, stopViewer, viewerStatus } from './viewer'
import { grant } from './session'

const GUIDE = new URL('../docs/IR-AUTHORING.md', import.meta.url)

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] }
}

function fail(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true }
}

/** 기본 브라우저로 연다 — 로컬 URL만 넘어온다 */
function openInBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* 브라우저를 못 열어도 링크는 돌려준다 */
  }
}

const server = new McpServer({ name: 'polyoffice', version: '0.2.0' })

server.registerTool(
  'polyoffice_guide',
  {
    title: 'IR 어휘 설명서',
    description:
      '한글(.hwpx)·Word(.docx)·ODF(.odt) 문서를 만들 때 쓰는 Document IR(HTML 기반 중간표현) 작성법을 돌려준다. ' +
      'polyoffice_write로 문서를 만들기 전에 반드시 먼저 호출할 것 — 허용 요소·style 속성·강등 규칙이 정해져 있고, ' +
      '벗어나면 저장이 거부된다.',
    inputSchema: {},
  },
  async () => text(readFileSync(GUIDE, 'utf8')),
)

server.registerTool(
  'polyoffice_write',
  {
    title: '문서 만들기',
    description:
      'Document IR HTML 한 장을 받아 .hwpx(한글) · .docx(Word) · .odt 파일을 만들고, 로컬 편집기 링크를 돌려준다. ' +
      '만든 파일은 곧바로 되읽어 텍스트가 살아남았는지 대조한다. IR 어휘는 polyoffice_guide 참고.',
    inputSchema: {
      ir_html: z
        .string()
        .describe('doc-section 루트로 시작하는 IR HTML 전문. polyoffice_guide가 설명하는 어휘만 쓸 것'),
      name: z.string().optional().describe('파일 이름(확장자 없이). 기본값 "문서"'),
      formats: z
        .array(z.enum(FORMATS))
        .optional()
        .describe('만들 포맷. 기본값은 셋 다 ["hwpx","docx","odt"]'),
      out_dir: z
        .string()
        .optional()
        .describe('결과 파일을 따로 둘 절대경로 디렉터리(예: ~/Downloads). 생략하면 프로젝트 scratch에만 둔다'),
      open: z.boolean().optional().describe('브라우저를 자동으로 열지. 기본값 true'),
    },
  },
  async ({ ir_html, name, formats, out_dir, open }) => {
    const stem = name?.trim() || '문서'
    const want = (formats?.length ? formats : [...FORMATS]) as Format[]

    let built
    try {
      built = await buildDocument(ir_html, want)
    } catch (e) {
      if (e instanceof IRContractError) {
        const lines = e.violations.slice(0, 20).map((v) => `  [${v.rule}] ${v.message}\n      ${v.path}`)
        return fail(
          `IR 계약 위반 ${e.violations.length}건 — 문서를 만들지 않았습니다.\n` +
            `${lines.join('\n')}\n\n허용 어휘는 polyoffice_guide를 확인하고 고쳐서 다시 호출하세요.`,
        )
      }
      throw e
    }

    const files: { filename: string; bytes: Uint8Array | string }[] = [
      { filename: `${stem}.html`, bytes: built.ir },
      { filename: `${stem}.preview.html`, bytes: built.preview },
    ]
    for (const o of built.outputs) if (o.bytes.length) files.push({ filename: `${stem}.${o.format}`, bytes: o.bytes })

    const { dir, paths, hrefs } = publish(stem, files)

    // 사용자가 지정한 곳에도 사본을 둔다 — scratch는 작업 공간이지 보관함이 아니다
    const copied: string[] = []
    if (out_dir) {
      const target = resolve(out_dir.replace(/^~/, process.env.HOME ?? '~'))
      mkdirSync(target, { recursive: true })
      for (const [i, f] of files.entries()) {
        if (!/\.(hwpx|docx|odt)$/.test(f.filename)) continue
        const to = join(target, f.filename)
        copyFileSync(paths[i], to)
        copied.push(to)
      }
    }

    // 편집기에 띄울 한 장 — hwpx를 우선하되 없으면 만든 것 중 첫 번째
    const primary = built.outputs.find((o) => o.format === 'hwpx' && o.bytes.length) ?? built.outputs.find((o) => o.bytes.length)
    let viewerLine = '뷰어: 띄우지 못했습니다'
    if (primary) {
      try {
        const v = await ensureViewer()
        const href = hrefs[files.findIndex((f) => f.filename === `${stem}.${primary.format}`)]
        const url = editorUrl(v.url, href)
        if (open !== false) openInBrowser(url)
        viewerLine =
          `편집기: ${url}\n` +
          `        (${v.started ? '이번에 dev 서버를 띄웠습니다' : `이미 떠 있던 :${v.port}에 붙였습니다`}` +
          `${open === false ? '' : ' · 브라우저를 열었습니다'})`
      } catch (e) {
        viewerLine = `뷰어: dev 서버 실패 — ${e instanceof Error ? e.message : String(e)}`
      }
    }

    const rows = built.outputs.map((o) => {
      if (o.error) return `  ${o.format.padEnd(4)} ✗ ${o.error}`
      const size = `${(o.bytes.length / 1024).toFixed(1)}KB`
      const detail = `문단 ${o.paragraphs} 표 ${o.tables} 그림 ${o.images}`
      const miss = o.missing.length ? ` · 누락 ${o.missing.length}개: ${o.missing.slice(0, 3).join(' / ')}` : ''
      return `  ${o.format.padEnd(4)} ${o.ok ? '✓' : '△'} ${size.padStart(8)} · ${detail}${miss}`
    })

    return text(
      [
        `✓ IR 계약 통과 — 블록 ${built.blocks}개`,
        `✓ 글꼴 서브셋 ${built.font.family} — ${built.font.stats.chars}자`,
        '',
        ...rows,
        '',
        viewerLine,
        `파일: ${dir}`,
        ...(copied.length ? [`사본: ${copied.join('\n      ')}`] : []),
      ].join('\n'),
    )
  },
)

server.registerTool(
  'polyoffice_read',
  {
    title: '문서 읽기',
    description:
      '기존 .hwp · .doc · .hwpx · .docx · .odt 문서를 Document IR HTML로 변환해 돌려준다. ' +
      '고쳐서 polyoffice_write에 다시 넘기면 편집이 된다. data-id는 블록 주소이므로 바꾸지 말 것.',
    inputSchema: {
      path: z.string().describe('문서 파일의 절대경로'),
      max_chars: z.number().optional().describe('돌려줄 최대 글자 수. 기본 200000, 넘으면 잘라서 알려준다'),
    },
  },
  async ({ path, max_chars }) => {
    const abs = resolve(path.replace(/^~/, process.env.HOME ?? '~'))
    const { ir, stats } = await readDocument(new Uint8Array(readFileSync(abs)))
    const limit = max_chars ?? 200_000
    const head = `<!-- ${basename(abs)} · 구역 ${stats.sections} 문단 ${stats.paragraphs} 표 ${stats.tables} 그림 ${stats.images} · 파서 ${stats.parser} -->\n`
    if (ir.length <= limit) return text(head + ir)
    return text(`${head}<!-- 전체 ${ir.length}자 중 앞 ${limit}자만 돌려줍니다 -->\n${ir.slice(0, limit)}`)
  },
)

server.registerTool(
  'polyoffice_open',
  {
    title: '문서 열기',
    description:
      '이미 있는 .hwp · .doc · .hwpx · .docx · .odt 문서를 로컬 편집기(브라우저)로 연다. ' +
      '사람이 화면에서 직접 고치고 저장하면 **원본이 있던 폴더에 되쓴다** — 문서 내용이 대화로 오가지 않는다. ' +
      '문서를 읽어서 프로그램적으로 고치려는 게 아니라 사람이 손으로 고칠 것이면 polyoffice_read 대신 이 도구를 쓸 것.',
    inputSchema: {
      path: z.string().describe('문서 파일의 절대경로'),
      open: z.boolean().optional().describe('브라우저를 자동으로 열지. 기본값 true'),
      can_save: z
        .boolean()
        .optional()
        .describe('편집 결과를 원본 폴더에 되쓸 수 있게 할지. 기본값 true. false면 읽기 전용으로 연다'),
    },
  },
  async ({ path, open, can_save }) => {
    const abs = resolve(path.replace(/^~/, process.env.HOME ?? '~'))
    const name = basename(abs)
    const ext = (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
    if (!['.hwp', '.hwpx', '.doc', '.docx', '.odt'].includes(ext)) {
      return fail(`.hwp · .hwpx · .doc · .docx · .odt만 엽니다: ${name}`)
    }

    // 편집기는 http로만 문서를 가져올 수 있어서 서빙되는 자리로 복사한다
    const { hrefs } = publish(`열기-${slug(name)}`, [{ filename: name, bytes: new Uint8Array(readFileSync(abs)) }])
    const v = await ensureViewer()

    // 저장 토큰 — 이게 있어야 편집기가 /__polyoffice/save로 되쓸 수 있다.
    // 토큰이 원본 경로를 들고 있어서, 편집기는 "어디에 쓸지"를 요청에 담지 않는다.
    const token = can_save === false ? null : grant(abs, ext)
    const url = editorUrl(v.url, hrefs[0]) + (token ? `&save=${token}` : '')
    if (open !== false) openInBrowser(url)

    const writable = ext === '.hwp' ? '.hwpx' : ext === '.doc' ? '.docx' : ext
    const lines = [`편집기: ${url}`, `원본: ${abs}`]
    if (token) {
      lines.push(
        `저장하면 → ${abs.replace(/\.[^.]+$/, '')}.edited${writable} (원본은 그대로 둡니다)`,
        ...(writable !== ext ? [`※ ${ext}는 쓰기 백엔드가 없어 ${writable}로 저장됩니다`] : []),
        '사람이 화면에서 고치고 저장 버튼을 누르면 됩니다 — 내용이 여기로 돌아오지는 않습니다.',
      )
    } else {
      lines.push('읽기 전용으로 열었습니다 (can_save:false)')
    }
    return text(lines.join('\n'))
  },
)

server.registerTool(
  'polyoffice_viewer',
  {
    title: '뷰어 서버',
    description: '로컬 편집기(vite dev 서버)의 상태를 보거나 띄우거나 끈다. 이 컴퓨터의 localhost에서만 돈다.',
    inputSchema: {
      action: z.enum(['status', 'start', 'stop']).optional().describe('기본값 status'),
    },
  },
  async ({ action }) => {
    switch (action ?? 'status') {
      case 'start': {
        const v = await ensureViewer()
        return text(`${v.url} — ${v.started ? '띄웠습니다' : '이미 떠 있습니다'}`)
      }
      case 'stop':
        return text(stopViewer() ? '이 MCP 서버가 띄운 dev 서버를 껐습니다' : '이 MCP 서버가 띄운 dev 서버가 없습니다')
      default: {
        const v = await viewerStatus()
        return text(v ? `${v.url} — 떠 있습니다` : '떠 있는 polyoffice dev 서버가 없습니다 (action:"start"로 띄웁니다)')
      }
    }
  },
)

await server.connect(new StdioServerTransport())
process.stderr.write(`polyoffice MCP 서버 준비 완료 — ${REPO}\n`)
