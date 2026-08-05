/**
 * hwp.js 폴백 파서 — 출력을 Rust 파서와 동일한 문서 모델(model.ts)로 정규화.
 * shape pointer 위치는 스펙대로 wchar 단위(일반 문자 1, 인라인/확장 컨트롤 8)로 해석해
 * Rust 다이제스트와 같은 결과를 낸다.
 */
import { parse } from 'hwp.js'
import type {
  CellModel,
  DocModel,
  ParagraphModel,
  RunModel,
  TableModel,
} from './model'

function digestParagraph(para: any): ParagraphModel {
  const pointers: { pos: number; shapeIndex: number }[] = [...(para.shapeBuffer ?? [])].sort(
    (a, b) => a.pos - b.pos,
  )
  const shapeAt = (wpos: number): number => {
    let id = pointers[0]?.shapeIndex ?? 0
    for (const p of pointers) {
      if (p.pos <= wpos) id = p.shapeIndex
      else break
    }
    return id
  }

  const runs: RunModel[] = []
  const push = (wpos: number, piece: string) => {
    const shape = shapeAt(wpos)
    const last = runs[runs.length - 1]
    if (last && last.charShapeId === shape) last.text += piece
    else runs.push({ charShapeId: shape, text: piece })
  }

  let wpos = 0
  for (const ch of para.content ?? []) {
    if (ch.type === 0) {
      // Char (1칸). U+F53A = 한컴 PUA "한" 로고 글리프 → 텍스트로 정규화 (Rust와 동일)
      if (typeof ch.value === 'string') push(wpos, ch.value === '\uF53A' ? '한' : ch.value)
      else if (ch.value === 13 || ch.value === 10) push(wpos, '\n')
      wpos += 1
    } else {
      // Inline/Extended (8칸). 탭(9)만 텍스트로 반영, 표(11)는 controls에서 처리
      if (ch.type === 1 && ch.value === 9) push(wpos, '\t')
      wpos += 8
    }
  }

  const tables: TableModel[] = (para.controls ?? [])
    .filter((c: any) => c && c.rowCount !== undefined && Array.isArray(c.content))
    .map(
      (c: any): TableModel => ({
        rowCount: c.rowCount,
        colCount: c.columnCount,
        rows: c.content.map((row: any[]) =>
          row.map((cell: any): CellModel => {
            const a = cell.attribute ?? {}
            return {
              col: a.column ?? 0,
              row: a.row ?? 0,
              colSpan: a.colSpan ?? 1,
              rowSpan: a.rowSpan ?? 1,
              width: a.width ?? 0,
              height: a.height ?? 0,
              padding: a.padding ?? [0, 0, 0, 0],
              borderFillId: a.borderFillID ?? null,
              paragraphs: (cell.items ?? []).map(digestParagraph),
            }
          }),
        ),
      }),
    )

  return { shapeIndex: para.shapeIndex ?? 0, runs, tables, images: [], footnotes: [] }
}

export function parseHwpJs(data: Uint8Array): DocModel {
  const doc: any = parse(data as never, { type: 'array' } as never)
  const v = doc.header?.version
  return {
    version:
      v && typeof v === 'object' && 'major' in v
        ? [v.major, v.minor, v.build, v.revision].join('.')
        : String(v ?? '?'),
    info: {
      charShapes: (doc.info.charShapes ?? []).map((cs: any) => ({
        baseSize: Math.round(cs.fontBaseSize * 100), // hwp.js는 이미 /100된 pt를 저장
        ratio: Array.isArray(cs.fontRatio) ? cs.fontRatio[0] : 100,
        color: cs.color ?? [0, 0, 0],
        attr: cs.attr ?? 0,
        fontId: Array.isArray(cs.fontId) ? cs.fontId[0] : 0,
      })),
      fontFaces: (doc.info.fontFaces ?? []).map((f: any) => f.name ?? ''),
      borderFills: (doc.info.borderFills ?? []).map((bf: any) => ({
        backgroundColor: bf.backgroundColor ?? null,
      })),
      paraShapes: (doc.info.paragraphShapes ?? []).map((ps: any) => ({ align: ps.align ?? 0 })),
      binData: [], // hwp.js 폴백은 이미지 미지원 (알려진 충실도 격차)
    },
    sections: (doc.sections ?? []).map((s: any) => ({
      width: s.width,
      height: s.height,
      paddingLeft: s.paddingLeft,
      paddingRight: s.paddingRight,
      paddingTop: s.paddingTop,
      paddingBottom: s.paddingBottom,
      headerPadding: s.headerPadding ?? 0,
      footerPadding: s.footerPadding ?? 0,
      paragraphs: (s.content ?? []).map(digestParagraph),
    })),
  }
}
