/**
 * 로컬 뷰어 — 편집기를 띄우고, 문서를 그 서버가 읽을 수 있는 자리에 떨군다.
 *
 * App.tsx의 `?doc=`은 `fetch`라 `file://`로는 안 열린다 — http 오리진이 필요하다.
 * 그래서 정적 파일 열기가 아니라 서버를 쓴다. 서버는 모드에 따라 둘 중 하나다:
 *
 * - **레포 체크아웃**: 이미 떠 있는 vite dev 서버를 찾아 쓰고, 없으면 띄운다(HMR).
 * - **설치된 패키지**: 동봉한 SPA를 정적 서버로 올린다 — vite도 node_modules도 없다.
 *
 * 어느 쪽이든 `/__polyoffice/ping`으로 "이 포트에 뜬 게 정말 우리 것인지" 확인한다.
 * (남의 dev 서버에 문서를 던지지 않으려고.)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { IS_REPO, PING_PATH, ROOT, SCRATCH } from './paths.ts'
import { startStaticServer } from './static-server.ts'

export { ROOT as REPO, SCRATCH }

/** vite가 5173부터 비어 있는 포트로 올라간다 — 그 범위만 훑는다 */
const PORTS = [5173, 5174, 5175, 5176, 5177]

/** 그 포트에 뜬 게 정말 polyoffice인가 */
async function isPolyOffice(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}${PING_PATH}`, {
      signal: AbortSignal.timeout(800),
    })
    if (!res.ok) return false
    return ((await res.json()) as { app?: string }).app === 'polyoffice'
  } catch {
    return false
  }
}

async function findServer(): Promise<number | null> {
  for (const p of PORTS) if (await isPolyOffice(p)) return p
  return null
}

let child: ChildProcess | null = null
let staticServer: Server | null = null

function spawnDev(): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bun', ['run', 'dev'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    child = proc
    let log = ''
    const timer = setTimeout(() => {
      reject(new Error(`dev 서버가 60초 안에 뜨지 않았습니다\n${log.slice(-800)}`))
    }, 60_000)

    const onData = (buf: Buffer) => {
      log += buf.toString()
      const m = log.match(/http:\/\/localhost:(\d+)/)
      if (m) {
        clearTimeout(timer)
        proc.stdout?.off('data', onData)
        proc.stderr?.off('data', onData)
        resolve(Number(m[1]))
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      child = null
      reject(new Error(`dev 서버가 코드 ${code}로 종료했습니다\n${log.slice(-800)}`))
    })
  })
}

// 우리가 띄운 서버는 우리가 치운다 — MCP 클라이언트가 죽을 때 고아로 남지 않게.
for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    child?.kill()
    staticServer?.close()
  })
}

export interface ViewerState {
  url: string
  port: number
  /** 이번 호출이 서버를 띄웠는가 (false면 이미 떠 있던 것에 붙은 것) */
  started: boolean
}

export async function ensureViewer(): Promise<ViewerState> {
  const found = await findServer()
  if (found) return { url: `http://localhost:${found}`, port: found, started: false }

  if (IS_REPO) {
    const port = await spawnDev()
    return { url: `http://localhost:${port}`, port, started: true }
  }
  const { server, port } = await startStaticServer(PORTS)
  staticServer = server
  return { url: `http://localhost:${port}`, port, started: true }
}

export async function viewerStatus(): Promise<ViewerState | null> {
  const found = await findServer()
  return found ? { url: `http://localhost:${found}`, port: found, started: false } : null
}

/** 우리가 띄운 서버만 끈다. 사용자가 직접 띄운 건 건드리지 않는다. */
export function stopViewer(): boolean {
  if (child) {
    child.kill()
    child = null
    return true
  }
  if (staticServer) {
    staticServer.close()
    staticServer = null
    return true
  }
  return false
}

/** 경로 구분자와 공백만 걷어낸다 — 한글 파일명은 그대로 쓴다 */
export function slug(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'document'
}

/** scratch에 문서를 놓고 편집기가 읽을 수 있는 경로를 만든다 */
export function publish(
  dirName: string,
  files: { filename: string; bytes: Uint8Array | string }[],
): { dir: string; paths: string[]; hrefs: string[] } {
  const folder = slug(dirName)
  const dir = join(SCRATCH, folder)
  mkdirSync(dir, { recursive: true })
  const paths: string[] = []
  const hrefs: string[] = []
  for (const f of files) {
    const path = join(dir, f.filename)
    writeFileSync(path, f.bytes)
    paths.push(path)
    hrefs.push(`/scratch/${encodeURIComponent(folder)}/${encodeURIComponent(f.filename)}`)
  }
  return { dir, paths, hrefs }
}

export function editorUrl(base: string, href: string): string {
  return `${base}/?doc=${href}`
}
