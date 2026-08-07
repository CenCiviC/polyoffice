/**
 * TrueType 서브셋터 — 문서가 실제로 쓴 글자만 남긴 폰트를 만든다.
 *
 * 왜 필요한가: docx·hwpx·odt에는 글꼴 "이름"만 저장되므로, 받는 기기에 그 글꼴이 없으면
 * 워드/한글이 제멋대로 대체하고 글자 폭이 달라져 줄바꿈부터 어긋난다. 유일한 해법은
 * 글꼴 파일을 문서 안에 넣는 것인데, 한글 폰트는 11,172자를 담느라 6MB에 달한다.
 * 문서 한 편이 쓰는 글자는 보통 수백 자뿐이라, 그만 잘라내면 200~400KB로 줄어든다.
 *
 * 하는 일:
 *  - cmap에서 필요한 글리프 번호를 찾고, 복합 글리프가 참조하는 글리프까지 따라간다
 *  - 글리프 번호를 0부터 다시 매기고 glyf·loca·hmtx·cmap을 그 번호 체계로 다시 쓴다
 *  - 조판에 불필요한 표(GSUB/GPOS/DSIG/STAT…)는 버린다
 *
 * 지원: glyf 방식 TrueType만. CFF(OTF)와 가변 폰트는 대상이 아니다
 * (가변 폰트는 미리 정적 인스턴스로 만들어 둔다 — public/fonts).
 */

/** 서브셋에 남길 표. 나머지는 버린다. */
const KEEP_TABLES = ['head', 'hhea', 'maxp', 'OS/2', 'hmtx', 'cmap', 'loca', 'glyf', 'name', 'post', 'cvt ', 'fpgm', 'prep', 'gasp']

interface Sfnt {
  tables: Map<string, Uint8Array>
}

function u16(d: DataView, o: number) {
  return d.getUint16(o)
}
function i16(d: DataView, o: number) {
  return d.getInt16(o)
}
function u32(d: DataView, o: number) {
  return d.getUint32(o)
}

function readSfnt(buf: Uint8Array): Sfnt {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = u32(d, 0)
  if (tag === 0x74746366) throw new Error('TTC(폰트 모음)는 지원하지 않는다 — 단일 폰트를 넘길 것')
  if (tag !== 0x00010000 && tag !== 0x74727565) throw new Error('glyf 방식 TrueType이 아니다 (CFF/OTF 미지원)')
  const numTables = u16(d, 4)
  const tables = new Map<string, Uint8Array>()
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i
    const name = String.fromCharCode(buf[rec], buf[rec + 1], buf[rec + 2], buf[rec + 3])
    const off = u32(d, rec + 8)
    const len = u32(d, rec + 12)
    tables.set(name, buf.subarray(off, off + len))
  }
  return { tables }
}

/** cmap(형식 4·12) → 유니코드 → 글리프 번호 */
function readCmap(cmap: Uint8Array): Map<number, number> {
  const d = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength)
  const n = u16(d, 2)
  let best = -1
  let bestFmt = -1
  for (let i = 0; i < n; i++) {
    const off = u32(d, 4 + 8 * i + 4)
    const fmt = u16(d, off)
    // 형식 12(전체 유니코드)를 형식 4(BMP)보다 우선
    if (fmt === 12 || (fmt === 4 && bestFmt !== 12)) {
      if (fmt >= bestFmt) {
        best = off
        bestFmt = fmt
      }
    }
  }
  if (best < 0) throw new Error('쓸 수 있는 cmap 서브테이블(형식 4·12)이 없다')

  const map = new Map<number, number>()
  if (bestFmt === 12) {
    const nGroups = u32(d, best + 12)
    for (let i = 0; i < nGroups; i++) {
      const g = best + 16 + 12 * i
      const start = u32(d, g)
      const end = u32(d, g + 4)
      const gid = u32(d, g + 8)
      for (let c = start; c <= end; c++) map.set(c, gid + (c - start))
    }
  } else {
    const segX2 = u16(d, best + 6)
    const seg = segX2 / 2
    const END = best + 14
    const START = END + segX2 + 2
    const DELTA = START + segX2
    const RANGE = DELTA + segX2
    for (let i = 0; i < seg; i++) {
      const end = u16(d, END + 2 * i)
      const start = u16(d, START + 2 * i)
      const delta = i16(d, DELTA + 2 * i)
      const ro = u16(d, RANGE + 2 * i)
      if (start === 0xffff) continue
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let gid: number
        if (ro === 0) gid = (c + delta) & 0xffff
        else {
          const addr = RANGE + 2 * i + ro + 2 * (c - start)
          if (addr + 2 > cmap.byteLength) continue
          const g = u16(d, addr)
          gid = g === 0 ? 0 : (g + delta) & 0xffff
        }
        if (gid) map.set(c, gid)
      }
    }
  }
  return map
}

/** loca → 글리프별 [시작, 끝) 바이트 범위 */
function readLoca(loca: Uint8Array, numGlyphs: number, longFormat: boolean): number[] {
  const d = new DataView(loca.buffer, loca.byteOffset, loca.byteLength)
  const out: number[] = []
  for (let i = 0; i <= numGlyphs; i++) {
    out.push(longFormat ? u32(d, 4 * i) : u16(d, 2 * i) * 2)
  }
  return out
}

/** 복합 글리프가 참조하는 글리프 번호들 */
function componentsOf(glyph: Uint8Array): number[] {
  if (glyph.byteLength < 10) return []
  const d = new DataView(glyph.buffer, glyph.byteOffset, glyph.byteLength)
  if (i16(d, 0) >= 0) return [] // 단순 글리프
  const out: number[] = []
  let p = 10
  for (;;) {
    const flags = u16(d, p)
    out.push(u16(d, p + 2))
    p += 4
    p += flags & 0x0001 ? 4 : 2 // ARG_1_AND_2_ARE_WORDS
    if (flags & 0x0008) p += 2 // WE_HAVE_A_SCALE
    else if (flags & 0x0040) p += 4 // X_AND_Y_SCALE
    else if (flags & 0x0080) p += 8 // TWO_BY_TWO
    if (!(flags & 0x0020)) break // MORE_COMPONENTS
  }
  return out
}

/** 복합 글리프 안의 글리프 번호를 새 번호로 바꾼다 (복사본에 기록) */
function remapComponents(glyph: Uint8Array, remap: Map<number, number>): Uint8Array {
  const copy = new Uint8Array(glyph)
  const d = new DataView(copy.buffer)
  if (copy.byteLength < 10 || i16(d, 0) >= 0) return copy
  let p = 10
  for (;;) {
    const flags = u16(d, p)
    const old = u16(d, p + 2)
    d.setUint16(p + 2, remap.get(old) ?? 0)
    p += 4
    p += flags & 0x0001 ? 4 : 2
    if (flags & 0x0008) p += 2
    else if (flags & 0x0040) p += 4
    else if (flags & 0x0080) p += 8
    if (!(flags & 0x0020)) break
  }
  return copy
}

/** 새 글리프 번호 체계로 cmap 형식 4 생성 (BMP 전용, (3,1) 인코딩) */
function buildCmap4(pairs: [number, number][]): Uint8Array {
  // 문자 코드가 연속인 구간으로 나눈다
  const sorted = pairs.filter(([c]) => c <= 0xffff).sort((a, b) => a[0] - b[0])
  const segs: { start: number; end: number; gids: number[] }[] = []
  for (const [code, gid] of sorted) {
    const last = segs[segs.length - 1]
    if (last && code === last.end + 1) {
      last.end = code
      last.gids.push(gid)
    } else {
      segs.push({ start: code, end: code, gids: [gid] })
    }
  }
  segs.push({ start: 0xffff, end: 0xffff, gids: [0] }) // 규격상 마지막 세그먼트

  const segCount = segs.length
  const glyphIdArray: number[] = []
  const idRangeOffset: number[] = []
  for (let i = 0; i < segCount; i++) {
    if (segs[i].start === 0xffff) {
      idRangeOffset.push(0)
      continue
    }
    // 모든 세그먼트를 glyphIdArray 경유로 둔다 (delta 계산 실수 여지를 없앤다)
    const offsetFromHere = (segCount - i) * 2 + glyphIdArray.length * 2
    idRangeOffset.push(offsetFromHere)
    glyphIdArray.push(...segs[i].gids)
  }

  const size = 14 + segCount * 8 + 2 + glyphIdArray.length * 2
  const sub = new Uint8Array(size)
  const v = new DataView(sub.buffer)
  v.setUint16(0, 4)
  v.setUint16(2, size)
  v.setUint16(4, 0)
  v.setUint16(6, segCount * 2)
  const searchRange = 2 * Math.pow(2, Math.floor(Math.log2(segCount)))
  v.setUint16(8, searchRange)
  v.setUint16(10, Math.log2(searchRange / 2))
  v.setUint16(12, segCount * 2 - searchRange)
  const END = 14
  const START = END + segCount * 2 + 2
  const DELTA = START + segCount * 2
  const RANGE = DELTA + segCount * 2
  for (let i = 0; i < segCount; i++) {
    v.setUint16(END + 2 * i, segs[i].end)
    v.setUint16(START + 2 * i, segs[i].start)
    v.setInt16(DELTA + 2 * i, segs[i].start === 0xffff ? 1 : 0)
    v.setUint16(RANGE + 2 * i, idRangeOffset[i])
  }
  for (let i = 0; i < glyphIdArray.length; i++) {
    v.setUint16(RANGE + segCount * 2 + 2 * i, glyphIdArray[i])
  }

  // cmap 헤더 + (3,1) 서브테이블 하나
  const out = new Uint8Array(12 + size)
  const o = new DataView(out.buffer)
  o.setUint16(0, 0)
  o.setUint16(2, 1)
  o.setUint16(4, 3)
  o.setUint16(6, 1)
  o.setUint32(8, 12)
  out.set(sub, 12)
  return out
}

function pad4(n: number) {
  return (4 - (n % 4)) % 4
}

function checksum(data: Uint8Array): number {
  let sum = 0
  const d = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const full = Math.floor(data.byteLength / 4) * 4
  for (let i = 0; i < full; i += 4) sum = (sum + u32(d, i)) >>> 0
  if (full < data.byteLength) {
    let tail = 0
    for (let i = full; i < data.byteLength; i++) tail |= data[i] << (24 - 8 * (i - full))
    sum = (sum + tail) >>> 0
  }
  return sum >>> 0
}

function buildSfnt(tables: Map<string, Uint8Array>): Uint8Array {
  const names = [...tables.keys()].sort()
  const numTables = names.length
  const headerSize = 12 + 16 * numTables
  let total = headerSize
  for (const n of names) total += tables.get(n)!.byteLength + pad4(tables.get(n)!.byteLength)

  const out = new Uint8Array(total)
  const d = new DataView(out.buffer)
  d.setUint32(0, 0x00010000)
  d.setUint16(4, numTables)
  const searchRange = 16 * Math.pow(2, Math.floor(Math.log2(numTables)))
  d.setUint16(6, searchRange)
  d.setUint16(8, Math.log2(searchRange / 16))
  d.setUint16(10, numTables * 16 - searchRange)

  let off = headerSize
  names.forEach((name, i) => {
    const data = tables.get(name)!
    const rec = 12 + 16 * i
    for (let c = 0; c < 4; c++) out[rec + c] = name.charCodeAt(c)
    d.setUint32(rec + 4, checksum(data))
    d.setUint32(rec + 8, off)
    d.setUint32(rec + 12, data.byteLength)
    out.set(data, off)
    off += data.byteLength + pad4(data.byteLength)
  })

  // head.checkSumAdjustment = 0xB1B0AFBA - (전체 체크섬)
  const headIdx = names.indexOf('head')
  if (headIdx >= 0) {
    const headOff = u32(d, 12 + 16 * headIdx + 8)
    d.setUint32(headOff + 8, 0)
    const adj = (0xb1b0afba - checksum(out)) >>> 0
    d.setUint32(headOff + 8, adj)
  }
  return out
}

export interface SubsetResult {
  data: Uint8Array
  glyphs: number
  originalBytes: number
}

/**
 * ttf에서 chars에 든 글자만 남긴 폰트를 만든다.
 * chars에 없는 글자는 렌더할 수 없으니, 문서의 모든 글자를 빠짐없이 넘겨야 한다.
 */
export function subsetFont(ttf: Uint8Array, chars: Iterable<string>): SubsetResult {
  const { tables } = readSfnt(ttf)
  const need = (n: string) => {
    const t = tables.get(n)
    if (!t) throw new Error(`필수 표 없음: ${n}`)
    return t
  }

  const head = need('head')
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const longLoca = i16(headView, 50) === 1
  const maxp = need('maxp')
  const numGlyphs = u16(new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength), 4)
  const hhea = need('hhea')
  const numberOfHMetrics = u16(new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength), 34)

  const cmapMap = readCmap(need('cmap'))
  const loca = readLoca(need('loca'), numGlyphs, longLoca)
  const glyf = need('glyf')
  const hmtx = need('hmtx')
  const hmtxView = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength)

  // 1) 필요한 글리프 모으기 — .notdef + 문자별 글리프 + 복합 글리프가 참조하는 것들
  const keep = new Set<number>([0])
  const wanted: [number, number][] = []
  for (const ch of chars) {
    for (const cp of ch) {
      const code = cp.codePointAt(0)!
      const gid = cmapMap.get(code)
      if (gid === undefined) continue
      keep.add(gid)
      wanted.push([code, gid])
    }
  }
  const queue = [...keep]
  while (queue.length) {
    const g = queue.pop()!
    if (g + 1 >= loca.length) continue
    const data = glyf.subarray(loca[g], loca[g + 1])
    for (const c of componentsOf(data)) {
      if (!keep.has(c)) {
        keep.add(c)
        queue.push(c)
      }
    }
  }

  // 2) 번호 다시 매기기 (원래 순서 유지)
  const oldGids = [...keep].sort((a, b) => a - b)
  const remap = new Map<number, number>()
  oldGids.forEach((old, i) => remap.set(old, i))

  // 3) glyf · loca 재작성
  const parts: Uint8Array[] = []
  const offsets: number[] = [0]
  let cursor = 0
  for (const old of oldGids) {
    const raw = old + 1 < loca.length ? glyf.subarray(loca[old], loca[old + 1]) : new Uint8Array(0)
    const g = raw.byteLength ? remapComponents(raw, remap) : raw
    parts.push(g)
    const padded = g.byteLength + pad4(g.byteLength)
    if (pad4(g.byteLength)) parts.push(new Uint8Array(pad4(g.byteLength)))
    cursor += padded
    offsets.push(cursor)
  }
  const newGlyf = new Uint8Array(cursor)
  let p = 0
  for (const part of parts) {
    newGlyf.set(part, p)
    p += part.byteLength
  }
  const newLoca = new Uint8Array(4 * offsets.length)
  const locaView = new DataView(newLoca.buffer)
  offsets.forEach((o, i) => locaView.setUint32(4 * i, o))

  // 4) hmtx — 새 글리프마다 (advance, lsb)
  const newHmtx = new Uint8Array(4 * oldGids.length)
  const hv = new DataView(newHmtx.buffer)
  oldGids.forEach((old, i) => {
    const mi = Math.min(old, numberOfHMetrics - 1)
    const adv = hmtxView.byteLength >= 4 * mi + 2 ? u16(hmtxView, 4 * mi) : 0
    const lsbOff = old < numberOfHMetrics ? 4 * old + 2 : 4 * numberOfHMetrics + 2 * (old - numberOfHMetrics)
    const lsb = lsbOff + 2 <= hmtxView.byteLength ? i16(hmtxView, lsbOff) : 0
    hv.setUint16(4 * i, adv)
    hv.setInt16(4 * i + 2, lsb)
  })

  // 5) 헤더 표 갱신
  const newHead = new Uint8Array(head)
  new DataView(newHead.buffer).setInt16(50, 1) // indexToLocFormat = long
  const newMaxp = new Uint8Array(maxp)
  new DataView(newMaxp.buffer).setUint16(4, oldGids.length)
  const newHhea = new Uint8Array(hhea)
  new DataView(newHhea.buffer).setUint16(34, oldGids.length)

  // post는 글리프 이름을 담고 있어 크다 — 이름 없는 형식 3.0으로 대체
  const newPost = new Uint8Array(32)
  new DataView(newPost.buffer).setUint32(0, 0x00030000)

  const out = new Map<string, Uint8Array>()
  for (const name of KEEP_TABLES) {
    const t = tables.get(name)
    if (t) out.set(name, t)
  }
  out.set('head', newHead)
  out.set('maxp', newMaxp)
  out.set('hhea', newHhea)
  out.set('hmtx', newHmtx)
  out.set('loca', newLoca)
  out.set('glyf', newGlyf)
  out.set('post', newPost)
  out.set('cmap', buildCmap4(wanted.map(([c, g]) => [c, remap.get(g) ?? 0])))

  return { data: buildSfnt(out), glyphs: oldGids.length, originalBytes: ttf.byteLength }
}
