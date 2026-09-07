import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { polyofficeSave } from './mcp/save-plugin.ts'

/**
 * `public/scratch/`는 MCP가 사람 문서를 떨구는 자리다. vite는 `public/`을 통째로
 * 산출물에 복사하므로, 그대로 두면 **남의 문서가 배포 번들에 실려 나간다.**
 * dev 서버는 `public/`에서 바로 서빙하므로 이 정리는 빌드에만 건다.
 */
function dropScratch(): Plugin {
  return {
    name: 'polyoffice-drop-scratch',
    apply: 'build',
    closeBundle() {
      rmSync(join(this.environment?.config?.build?.outDir ?? 'dist', 'scratch'), {
        recursive: true,
        force: true,
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // polyofficeSave는 dev 전용 — 편집 결과를 원본 자리로 되쓰는 엔드포인트(/__polyoffice/save).
  // MCP가 발급한 토큰이 있는 요청만 받는다. 빌드 산출물에는 안 들어간다.
  plugins: [react(), polyofficeSave(), dropScratch()],
  // lightningcss 네이티브 바이너리가 bun 설치에서 누락되는 문제 우회
  css: { transformer: 'postcss' },
  build: { cssMinify: 'esbuild' },
})
