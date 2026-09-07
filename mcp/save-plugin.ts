/**
 * vite dev 미들웨어 — 저장 엔드포인트와 뷰어 탐지용 ping을 붙인다.
 *
 * 저장 로직 자체는 `save-handler.ts`에 있다. 배포 패키지의 정적 서버
 * (`static-server.ts`)가 **같은 핸들러**를 쓴다 — 계약이 두 벌로 갈라지지 않게.
 *
 * dev 서버 전용이다. `vite build` 결과물에는 들어가지 않는다.
 */
import type { Plugin } from 'vite'
import { PING_PATH, SAVE_PATH } from './paths.ts'
import { handleSave } from './save-handler.ts'

export function polyofficeSave(): Plugin {
  return {
    name: 'polyoffice-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(SAVE_PATH, async (req, res) => {
        await handleSave(req, res, (msg) => server.config.logger.info(msg))
      })
      // 이 포트에 뜬 게 정말 polyoffice인지 뷰어가 확인하는 자리
      server.middlewares.use(PING_PATH, (_req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ app: 'polyoffice', mode: 'dev' }))
      })
    },
  }
}
