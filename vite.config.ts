import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { polyofficeSave } from './mcp/save-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  // polyofficeSave는 dev 전용 — 편집 결과를 원본 자리로 되쓰는 엔드포인트(/__polyoffice/save).
  // MCP가 발급한 토큰이 있는 요청만 받는다. 빌드 산출물에는 안 들어간다.
  plugins: [react(), polyofficeSave()],
  // lightningcss 네이티브 바이너리가 bun 설치에서 누락되는 문제 우회
  css: { transformer: 'postcss' },
  build: { cssMinify: 'esbuild' },
})
