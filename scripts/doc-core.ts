/**
 * IR HTML 한 장 ↔ 문서 파일 — CLI(scripts/export.ts)와 MCP 서버가 공유하는 코어.
 *
 * 여기엔 파일 경로도 표준출력도 없다. 바이트만 오간다 —
 * 어디에 쓸지·무엇을 찍을지는 부르는 쪽이 정한다.
 */
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

import { html2hwpx } from '../src/lib/html2hwpx'
import { html2docx } from '../src/lib/html2docx'
import { html2odt } from '../src/lib/html2odt'
import { convertModel, wrapStandalone } from '../src/lib/polyoffice'
import { normalizeIR, validateIR, type Violation } from '../src/lib/ir'
import { buildEmbeddedFont, usedChars, type EmbeddedFont } from '../src/lib/font-embed'
import { DOC_FONT } from '../src/lib/ir-model'
import { initHwpWasm, isWasmReady, parseHwpWasm } from '../src/lib/parser-wasm'
import type { DocModel, ParagraphModel } from '../src/lib/model'

export const FORMATS = ['hwpx', 'docx', 'odt'] as const
export type Format = (typeof FORMATS)[number]

/** IR 계약 위반 — 부르는 쪽(사람이든 LLM이든)이 고쳐야 하는 것이라 예외로 올린다. */
export class IRContractError extends Error {
  violations: Violation[]
  constructor(violations: Violation[]) {
    super(`IR 계약 위반 ${violations.length}건`)
    this.name = 'IRContractError'
    this.violations = violations
  }
}

export interface WrittenFormat {
  format: Format
  bytes: Uint8Array
  /** 되읽기까지 성공했는가 (쓰기 실패·파싱 실패면 false) */
  ok: boolean
  /** 되읽었을 때 사라진 텍스트 조각 (앞 24자 단위) */
  missing: string[]
  paragraphs: number
  tables: number
  images: number
  error?: string
}

export interface BuildResult {
  /** 정규화된 IR (data-id 부여 후) — 다음 편집의 입력이 된다 */
  ir: string
  /** 뷰어 CSS를 씌운 standalone HTML */
  preview: string
  blocks: number
  font: EmbeddedFont
  outputs: WrittenFormat[]
}

let wasmReady: Promise<void> | null = null

/** WASM 파서 초기화 — 되읽기 검증에 쓴다. 프로세스당 한 번. */
export function initRuntime(): Promise<void> {
  wasmReady ??= (async () => {
    if (isWasmReady()) return
    await initHwpWasm({
      bytes: new Uint8Array(readFileSync(new URL('../rust/hwp-core/pkg/hwp_core_bg.wasm', import.meta.url))),
    })
  })()
  return wasmReady
}

let assets: { template: Uint8Array; regular: Uint8Array; bold: Uint8Array } | null = null

function loadAssets() {
  const fontDir = new URL('../public/fonts/', import.meta.url)
  assets ??= {
    template: new Uint8Array(readFileSync(new URL('../public/blank.hwpx', import.meta.url))),
    regular: new Uint8Array(readFileSync(new URL('NotoSansKR-Regular.ttf', fontDir))),
    bold: new Uint8Array(readFileSync(new URL('NotoSansKR-Bold.ttf', fontDir))),
  }
  return assets
}

/** IR HTML 문자열 → 정규화·검증을 마친 DOM 루트. 위반이 있으면 던진다. */
export function parseIR(html: string): Element {
  const win = new Window()
  win.document.body.innerHTML = html
  const root = win.document.body as unknown as Element
  normalizeIR(root)
  const violations = validateIR(root)
  if (violations.length) throw new IRContractError(violations)
  return root
}

function allText(model: DocModel): string {
  let out = ''
  const walk = (paras: ParagraphModel[]) => {
    for (const p of paras) {
      for (const r of p.runs) out += r.text
      for (const t of p.tables) for (const row of t.rows) for (const c of row) walk(c.paragraphs)
      // 각주 내용도 본문만큼 지켜야 한다 — 리더가 읽어 오므로 대조에 넣는다
      for (const fn of p.footnotes ?? []) walk(fn.paragraphs)
      out += '\n'
    }
  }
  for (const s of model.sections) walk(s.paragraphs)
  return out
}

function count(model: DocModel) {
  let paragraphs = 0
  let tables = 0
  let images = 0
  const walk = (paras: ParagraphModel[]) => {
    for (const p of paras) {
      paragraphs++
      images += p.images?.length ?? 0
      for (const t of p.tables) {
        tables++
        for (const row of t.rows) for (const c of row) walk(c.paragraphs)
      }
    }
  }
  for (const s of model.sections) walk(s.paragraphs)
  return { paragraphs, tables, images }
}

/**
 * 원본에서 살아남아야 할 텍스트 — 블록마다 첫 24자.
 *
 * `td`가 목록에 있는 이유: 셀에 `<p>` 없이 바로 쓴 글자를 세 백엔드가 **통째로 버리던**
 * 버그가 여기 없어서 오래 통과했다. 셀은 문단을 품든 안 품든 글자가 남아야 한다.
 *
 * 반대로 **머리말·꼬리말은 뺀다**. 쓰기는 되지만 리더가 아직 그 영역을 읽지 않아서,
 * 넣으면 "쓰기가 틀렸다"가 아니라 "읽기가 없다"를 실패로 보고하게 된다.
 * 읽기가 생기면 이 예외를 지운다(TODO 검증 부채).
 */
function expectedText(root: Element): string[] {
  return Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td'))
    .filter((el) => !el.closest('doc-header, doc-footer'))
    .map((el) => (el.textContent ?? '').replace(/\s+/g, ''))
    .filter((t) => t.length >= 4)
    .map((t) => t.slice(0, 24))
}

/**
 * IR HTML → 요청한 포맷들의 바이트. 각 결과는 곧바로 되읽어 텍스트를 대조한다
 * (쓰기만 성공하고 내용이 날아간 파일을 성공이라 부르지 않으려고).
 */
export async function buildDocument(
  html: string,
  formats: readonly Format[] = FORMATS,
  opts: { verify?: boolean } = {},
): Promise<BuildResult> {
  const verify = opts.verify !== false
  if (verify) await initRuntime()

  const root = parseIR(html)
  const { template, regular, bold } = loadAssets()

  // 글꼴 임베딩 — 문서가 쓴 글자만 잘라 넣는다 (받는 기기에 글꼴이 없어도 같게 보이도록)
  const font = buildEmbeddedFont({ family: DOC_FONT, regular, bold }, usedChars(root))

  const writers: Record<Format, () => Uint8Array> = {
    hwpx: () => html2hwpx(root, template, font).data,
    docx: () => html2docx(root, font).data,
    odt: () => html2odt(root, font).data,
  }

  const expected = expectedText(root)
  const outputs: WrittenFormat[] = []
  for (const format of formats) {
    const base = { format, bytes: new Uint8Array(), ok: false, missing: [], paragraphs: 0, tables: 0, images: 0 }
    let bytes: Uint8Array
    try {
      bytes = writers[format]()
    } catch (e) {
      outputs.push({ ...base, error: `쓰기 실패 — ${e instanceof Error ? e.message : String(e)}` })
      continue
    }
    if (!verify) {
      outputs.push({ ...base, bytes, ok: true })
      continue
    }
    try {
      const model = parseHwpWasm(bytes)
      const text = allText(model).replace(/\s+/g, '')
      const missing = expected.filter((w) => !text.includes(w))
      outputs.push({ ...base, bytes, ok: missing.length === 0, missing, ...count(model) })
    } catch (e) {
      outputs.push({ ...base, bytes, error: `되읽기 실패 — ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  const ir = root.innerHTML.trim()
  return { ir, preview: wrapStandalone(ir), blocks: root.querySelectorAll('[data-id]').length, font, outputs }
}

/** 기존 문서(hwp·doc·hwpx·docx·odt) → IR HTML. 고쳐 쓰려면 여기서 출발한다. */
export async function readDocument(bytes: Uint8Array) {
  await initRuntime()
  const { body, stats } = convertModel(parseHwpWasm(bytes), 'wasm')
  return { ir: body, stats }
}
