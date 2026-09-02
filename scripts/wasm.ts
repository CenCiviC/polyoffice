// CLI 공용: WASM 파서 초기화 + 변환 (브라우저와 동일한 프로덕션 경로)
import { readFileSync } from 'node:fs'
import { convertModel, type ConvertResult } from '../src/lib/polyoffice'
import { initHwpWasm, parseHwpWasm } from '../src/lib/parser-wasm'

export async function convertWithWasm(data: Uint8Array): Promise<ConvertResult> {
  const wasmBytes = new Uint8Array(
    readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url)),
  )
  await initHwpWasm({ bytes: wasmBytes })
  return convertModel(parseHwpWasm(data), 'wasm')
}
