import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // lightningcss 네이티브 바이너리가 bun 설치에서 누락되는 문제 우회
  css: { transformer: 'postcss' },
  build: { cssMinify: 'esbuild' },
})
