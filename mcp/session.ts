/**
 * 저장 세션 — MCP 서버(문서를 여는 쪽)와 vite dev 미들웨어(파일을 쓰는 쪽)가
 * **다른 프로세스**라서 "이 편집기가 어느 파일에 써도 되는가"를 공유할 자리가 필요하다.
 *
 * 파일 하나(`public/scratch/.sessions.json`)를 브로커로 쓴다. MCP가 문서를 열 때
 * 토큰 하나를 발급해 기록하고, 편집기는 URL로 받은 그 토큰을 저장 요청에 싣는다.
 * 미들웨어는 토큰이 가리키는 항목의 경로에만 쓴다.
 *
 * **토큰이 없으면 아무 데도 못 쓴다.** localhost라도 브라우저의 다른 탭이 fetch로
 * 이 엔드포인트를 때릴 수 있으므로, 경로를 요청 본문에서 받지 않는 게 핵심이다.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SESSION_FILE = join(REPO, 'public', 'scratch', '.sessions.json')

/** 하루 지난 세션은 지운다 — 편집기 탭을 며칠 열어둔 채로 쓰기 권한이 살아 있지 않게 */
const TTL_MS = 24 * 60 * 60 * 1000

export interface SaveSession {
  /** 문서를 가져온 원본 절대경로 */
  src: string
  /** 덮어쓰기 대신 사본을 둘 기본 자리 (원본과 같은 디렉터리) */
  dir: string
  /** 원본 확장자 (쓰기 불가 포맷 판별용) */
  ext: string
  createdAt: number
}

type Store = Record<string, SaveSession>

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Store
    const now = Date.now()
    const live: Store = {}
    for (const [k, v] of Object.entries(raw)) if (now - v.createdAt < TTL_MS) live[k] = v
    return live
  } catch {
    return {}
  }
}

function save(store: Store): void {
  mkdirSync(dirname(SESSION_FILE), { recursive: true })
  writeFileSync(SESSION_FILE, JSON.stringify(store, null, 2))
}

/** 원본 경로에 대한 저장 토큰을 발급한다 */
export function grant(src: string, ext: string): string {
  const store = load()
  const token = randomBytes(16).toString('hex')
  store[token] = { src, dir: dirname(src), ext, createdAt: Date.now() }
  save(store)
  return token
}

/** 토큰이 가리키는 세션. 없거나 만료면 null */
export function lookup(token: string): SaveSession | null {
  return load()[token] ?? null
}

export { SESSION_FILE }
