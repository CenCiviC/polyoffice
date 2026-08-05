/**
 * Rust(hwp-core) WASM 파서 로더.
 * - 브라우저: initHwpWasm({ url }) — vite의 `?url` 자산 경로로 로드
 * - bun CLI: initHwpWasm({ bytes }) — 파일에서 읽은 바이트로 동기 초기화
 */
import initWasm, { initSync, parse_hwp_json } from '../../rust/hwp-core/pkg/hwp_core'
import type { DocModel } from './model'

let ready = false

export async function initHwpWasm(source: { url?: string; bytes?: Uint8Array }): Promise<void> {
  if (ready) return
  if (source.bytes) {
    initSync({ module: source.bytes })
  } else if (source.url) {
    await initWasm({ module_or_path: source.url })
  } else {
    throw new Error('initHwpWasm: url 또는 bytes 필요')
  }
  ready = true
}

export function isWasmReady(): boolean {
  return ready
}

export function parseHwpWasm(data: Uint8Array): DocModel {
  if (!ready) throw new Error('WASM 미초기화 — initHwpWasm을 먼저 호출')
  return JSON.parse(parse_hwp_json(data)) as DocModel
}
