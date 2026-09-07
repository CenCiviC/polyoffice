/**
 * 이 프로세스가 **레포 체크아웃**에서 도는지 **설치된 npm 패키지**에서 도는지 가르고,
 * 그에 맞는 자산·작업 디렉터리를 정한다.
 *
 * 두 모드가 갈리는 지점은 둘뿐이다:
 *
 * 1. **편집기를 어떻게 띄우나** — 레포에서는 vite dev 서버(HMR이 필요하니까),
 *    패키지에서는 미리 빌드한 SPA를 정적 서버로. 편집기 자체는 정적 SPA라
 *    런타임에 vite가 할 일이 없다.
 * 2. **문서를 어디에 떨구나** — 레포에서는 `public/scratch/`(vite가 서빙하는 자리),
 *    패키지에서는 `~/.polyoffice/scratch`. node_modules 안이나 npx 캐시에
 *    사용자 문서를 쓰지 않으려는 것이다.
 *
 * 자산(폰트·wasm·blank.hwpx)은 **양쪽 레이아웃을 같게** 맞춰 두었으므로
 * `scripts/doc-core.ts`의 `import.meta.url` 상대 경로가 그대로 성립한다.
 * (`scripts/`와 패키지의 `bin/`이 같은 깊이다.)
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 자산이 놓인 뿌리 — 레포 루트이거나 설치된 패키지 루트 */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** vite.config.ts는 레포에만 있다 — 배포 패키지에는 넣지 않는다 */
export const IS_REPO = existsSync(join(ROOT, 'vite.config.ts'))

/** 편집기가 읽어갈 문서를 떨구는 자리 */
export const SCRATCH = IS_REPO
  ? join(ROOT, 'public', 'scratch')
  : join(homedir(), '.polyoffice', 'scratch')

/** 미리 빌드한 편집기 SPA. 레포에서는 `bun run build` 결과, 패키지에서는 동봉본 */
export const APP_DIR = IS_REPO ? join(ROOT, 'dist') : join(ROOT, 'public', 'app')

/** 정적 서버·vite 양쪽이 자기가 polyoffice임을 알리는 자리 (뷰어 탐지용) */
export const PING_PATH = '/__polyoffice/ping'
export const SAVE_PATH = '/__polyoffice/save'
