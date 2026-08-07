/**
 * 문서에 글꼴을 심는다 (서브셋 임베딩).
 *
 * docx·hwpx·odt에는 글꼴 "이름"만 저장되므로, 받는 기기에 그 글꼴이 없으면 대체되어
 * 글자 폭이 달라지고 줄바꿈부터 어긋난다. 글꼴 파일 자체를 문서에 넣으면 그 문제가 사라진다.
 * 통째로 넣으면 6MB라 문서가 못 쓰게 되니, 문서가 실제로 쓴 글자만 잘라 넣는다(subset.ts).
 */
import { subsetFont } from './subset'

export interface FontSource {
  /** docx·hwpx·odt에 적을 글꼴 이름. IR의 font-family와 같아야 한다 */
  family: string
  regular: Uint8Array
  bold?: Uint8Array
}

export interface EmbeddedFont {
  family: string
  /** 서브셋된 TTF 바이트 */
  regular: Uint8Array
  bold?: Uint8Array
  stats: { chars: number; regularBytes: number; boldBytes: number }
}

/** IR DOM에서 실제로 쓰인 글자를 모은다 (공백류 제외) */
export function usedChars(root: Element): Set<string> {
  const out = new Set<string>()
  for (const ch of root.textContent ?? '') {
    if (ch.trim()) out.add(ch)
  }
  return out
}

/**
 * 문서가 쓴 글자만 남긴 서브셋을 만든다.
 * 굵은 글씨가 쓰였는지와 무관하게 bold 원본이 있으면 함께 넣는다 — Word가 가짜 굵게로
 * 대체하면 글자 폭이 달라지기 때문이다.
 */
export function buildEmbeddedFont(source: FontSource, chars: Set<string>): EmbeddedFont {
  const regular = subsetFont(source.regular, chars)
  const bold = source.bold ? subsetFont(source.bold, chars) : undefined
  return {
    family: source.family,
    regular: regular.data,
    bold: bold?.data,
    stats: { chars: chars.size, regularBytes: regular.data.length, boldBytes: bold?.data.length ?? 0 },
  }
}

/**
 * docx 글꼴 파트 난독화 (ECMA-376 §17.8.1).
 * 앞 32바이트를 fontKey GUID에서 뽑은 16바이트 키로 두 번 XOR 한다.
 * Word는 난독화되지 않은 글꼴 파트를 거부한다.
 */
export function obfuscateFont(data: Uint8Array, fontKey: string): Uint8Array {
  const hex = fontKey.replace(/[{}-]/g, '')
  const key = new Uint8Array(16)
  for (let i = 0; i < 16; i++) key[i] = parseInt(hex.substr(i * 2, 2), 16)
  key.reverse()
  const out = new Uint8Array(data)
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= key[i % 16]
  return out
}

/** 결정적 GUID — 같은 입력이면 같은 문서가 나오도록 난수를 쓰지 않는다 */
export function fontKeyFor(seed: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0
    h2 = Math.imul(h2 + seed.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0').toUpperCase()
  const a = hex(h1)
  const b = hex(h2)
  const c = hex((h1 ^ h2) >>> 0)
  const d = hex((h1 + h2) >>> 0)
  return `{${a}-${b.slice(0, 4)}-${b.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}${d}}`
}
