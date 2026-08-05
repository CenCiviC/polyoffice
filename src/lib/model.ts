/**
 * 문서 모델 — 파서(Rust WASM / hwp.js)와 변환기 사이의 JSON 계약.
 * Rust 쪽 대응 타입: rust/hwp-core/src/model.rs. 두 파일은 항상 함께 변경한다.
 */

export interface DocModel {
  version: string
  info: DocInfoModel
  sections: SectionModel[]
}

export interface DocInfoModel {
  charShapes: CharShapeModel[]
  fontFaces: string[]
  borderFills: BorderFillModel[]
  paraShapes: ParaShapeModel[]
  /** 임베디드 바이너리 (이미지 등) — ImageModel.binDataId가 인덱스 참조 */
  binData?: BinDataModel[]
}

export interface BinDataModel {
  ext: string
  /** base64 */
  data: string
}

export interface CharShapeModel {
  /** 1/100 pt (1000 = 10pt) */
  baseSize: number
  /** 장평 % */
  ratio: number
  color: [number, number, number]
  /** bit0 italic · bit1 bold · bit2-3 underline(1=밑줄, 3=윗줄) */
  attr: number
  fontId: number
}

export interface BorderFillModel {
  backgroundColor: [number, number, number] | null
}

export interface ParaShapeModel {
  /** 0 양쪽 · 1 왼쪽 · 2 오른쪽 · 3 가운데 */
  align: number
}

export interface SectionModel {
  width: number
  height: number
  paddingLeft: number
  paddingRight: number
  paddingTop: number
  paddingBottom: number
  headerPadding: number
  footerPadding: number
  paragraphs: ParagraphModel[]
}

export interface ParagraphModel {
  shapeIndex: number
  runs: RunModel[]
  tables: TableModel[]
  images?: ImageModel[]
  footnotes?: FootnoteModel[]
}

export interface FootnoteModel {
  paragraphs: ParagraphModel[]
}

export interface ImageModel {
  binDataId: number
  /** hwpunit */
  width: number
  height: number
}

export interface RunModel {
  charShapeId: number
  /** '\n' = 줄바꿈, '\t' = 탭 */
  text: string
}

export interface TableModel {
  rowCount: number
  colCount: number
  rows: CellModel[][]
  /** 표 캡션 문단들 (없으면 빈 배열 — hwp.js 폴백은 캡션 미지원) */
  caption?: ParagraphModel[]
}

export interface CellModel {
  col: number
  row: number
  colSpan: number
  rowSpan: number
  /** hwpunit (1/7200 in) */
  width: number
  height: number
  padding: [number, number, number, number]
  borderFillId: number | null
  paragraphs: ParagraphModel[]
}
