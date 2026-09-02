/**
 * vite dev 미들웨어 — 편집기가 고친 문서를 **원본이 있던 자리**에 되쓴다.
 *
 * 이게 없으면 편집 결과는 브라우저 다운로드(~/Downloads)로만 나가고 원본은 그대로다.
 * 왕복을 닫는 마지막 한 칸.
 *
 * 쓸 자리는 요청이 정하지 않는다 — MCP가 문서를 열 때 발급한 토큰(mcp/session.ts)이
 * 정한다. localhost라도 브라우저의 다른 탭이 이 엔드포인트를 때릴 수 있으므로,
 * 경로를 본문에서 받으면 "아무 파일이나 덮어쓰는 구멍"이 된다.
 *
 * dev 서버 전용이다. `vite build` 결과물에는 들어가지 않는다.
 */
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Plugin } from 'vite'
import { lookup } from './session.ts'

/** 원본 확장자 → 실제로 쓸 수 있는 확장자. .hwp·.doc는 쓰기 백엔드가 없다 */
const WRITABLE: Record<string, string> = {
  '.hwp': '.hwpx',
  '.hwpx': '.hwpx',
  '.doc': '.docx',
  '.docx': '.docx',
  '.odt': '.odt',
}

function readBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function polyofficeSave(): Plugin {
  return {
    name: 'polyoffice-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__polyoffice/save', async (req, res) => {
        const json = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        }

        if (req.method !== 'PUT') return json(405, { error: 'PUT만 받습니다' })

        const token = String(req.headers['x-polyoffice-token'] ?? '')
        const session = token && lookup(token)
        if (!session) {
          return json(403, {
            error: '저장 토큰이 없거나 만료됐습니다. polyoffice_open으로 문서를 다시 여세요.',
          })
        }

        // 확장자는 편집기가 고르지만(hwpx/docx/odt 중), 쓸 수 있는 것만 허용한다
        const ext = String(req.headers['x-polyoffice-ext'] ?? WRITABLE[session.ext] ?? '.hwpx')
        if (!['.hwpx', '.docx', '.odt', '.html'].includes(ext)) {
          return json(400, { error: `쓸 수 없는 확장자: ${ext}` })
        }

        // 덮어쓰기는 명시적으로 요청할 때만. IR은 손실 변환이라 기본값이면 위험하다.
        //
        // 그리고 **원본과 같은 확장자일 때만** 덮어쓰기가 성립한다. `.hwp`를 열어 덮어쓰기를
        // 눌러도 쓸 수 있는 건 `.hwpx`뿐이라, 그걸 원본 이름으로 쓰면 원본 `.hwp`는 남고
        // 옆에 `.hwpx`가 하나 더 생긴다 — 파일은 둘인데 사용자가 원한 건 없는 상태가 된다.
        // 그런 경우는 조용히 사본으로 되돌린다(응답의 overwrote가 false로 나가 편집기가 알린다).
        const canOverwrite = req.headers['x-polyoffice-overwrite'] === '1' && ext === session.ext
        const stem = basename(session.src).replace(/\.(hwpx?|docx?|odt)$/i, '')
        // basename으로 감싸 `../`가 세션 디렉터리를 벗어나지 못하게 한다
        const filename = basename(canOverwrite ? `${stem}${ext}` : `${stem}.edited${ext}`)
        const target = join(session.dir, filename)

        try {
          const body = await readBody(req)
          if (!body.length) return json(400, { error: '빈 본문' })
          writeFileSync(target, body)
          server.config.logger.info(`[polyoffice] 저장 → ${target} (${body.length} bytes)`)
          return json(200, {
            path: target,
            bytes: body.length,
            overwrote: canOverwrite,
            // 원본과 확장자가 다르면 왜 그런지 편집기가 사람에게 알려줄 수 있게
            note: WRITABLE[session.ext] !== session.ext ? `${session.ext}는 쓰기 백엔드가 없어 ${ext}로 저장했습니다` : null,
          })
        } catch (e) {
          return json(500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}
