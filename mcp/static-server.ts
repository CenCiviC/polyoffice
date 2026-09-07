/**
 * 편집기를 띄우는 정적 서버 — **설치된 패키지에서 vite 없이** 도는 길.
 *
 * 편집기는 정적 SPA다(`bun run build` 결과가 html + js + wasm + css 넉 장뿐).
 * 런타임에 vite가 할 일이 없으므로, 배포 패키지에서는 이 서버가 그 자리를 대신한다.
 * 개발 중에는 계속 vite를 쓴다 — HMR이 필요하니까.
 *
 * 서빙하는 것 셋:
 *   /                 → 편집기 SPA (APP_DIR)
 *   /scratch/…        → MCP가 떨군 문서 (SCRATCH)
 *   PUT /…/save       → save-handler (vite 미들웨어와 같은 함수)
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { APP_DIR, PING_PATH, SAVE_PATH, SCRATCH } from './paths.ts'
import { handleSave } from './save-handler.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.hwpx': 'application/octet-stream',
  '.docx': 'application/octet-stream',
  '.odt': 'application/octet-stream',
}

/**
 * URL 경로를 뿌리 안의 실제 파일로 푼다. 뿌리를 벗어나면 null —
 * `%2e%2e%2f` 같은 인코딩된 상위 이동까지 decode 뒤에 검사해야 막힌다.
 */
function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const full = resolve(join(root, normalize(decoded)))
  const base = resolve(root)
  if (full !== base && !full.startsWith(base + sep)) return null
  return full
}

function sendFile(res: import('node:http').ServerResponse, path: string): void {
  res.setHeader('content-type', MIME[extname(path).toLowerCase()] ?? 'application/octet-stream')
  res.setHeader('content-length', statSync(path).size)
  createReadStream(path).pipe(res)
}

export function createStaticServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === SAVE_PATH) return void (await handleSave(req, res, () => {}))
    if (path === PING_PATH) {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      return void res.end(JSON.stringify({ app: 'polyoffice', mode: 'static' }))
    }

    // MCP가 떨군 문서
    if (path.startsWith('/scratch/')) {
      const file = safeJoin(SCRATCH, path.slice('/scratch/'.length))
      if (file && existsSync(file) && statSync(file).isFile()) return sendFile(res, file)
      res.statusCode = 404
      return void res.end('not found')
    }

    // 편집기 SPA — 없는 경로는 index.html로 넘긴다(클라이언트 라우팅)
    const asset = safeJoin(APP_DIR, path === '/' ? 'index.html' : path)
    if (asset && existsSync(asset) && statSync(asset).isFile()) return sendFile(res, asset)
    const index = join(APP_DIR, 'index.html')
    if (existsSync(index)) return sendFile(res, index)
    res.statusCode = 500
    res.end(`편집기 번들이 없습니다: ${APP_DIR}`)
  })
}

/** 비어 있는 포트에 정적 서버를 올린다. 돌려주는 값은 실제로 잡은 포트 */
export function startStaticServer(ports: number[]): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePort, reject) => {
    const tryPort = (i: number) => {
      if (i >= ports.length) return reject(new Error(`빈 포트가 없습니다: ${ports.join(', ')}`))
      const server = createStaticServer()
      server.once('error', () => tryPort(i + 1))
      server.listen(ports[i], '127.0.0.1', () => resolvePort({ server, port: ports[i] }))
    }
    tryPort(0)
  })
}
