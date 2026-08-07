/**
 * 페이지 설정 — 용지·방향·여백을 `doc-section`에서 읽고 쓴다.
 *
 * 이 값들은 이미 IR 어휘 안에 있다(`doc-section`의 width·min-height·padding). 리더가 채우고
 * 세 백엔드가 모두 쓰는데 편집 수단만 없었다. 그래서 여기서 하는 일은 어휘 추가가 아니라
 * **기존 어휘를 사람이 만질 수 있게 하는 것**뿐이다.
 *
 * 길이 표기는 방출기(narro.ts)와 같은 `in` 소수 3자리로 고정한다 — 편집기가 새 표기를
 * 파이프라인에 흘려 넣으면 왕복 diff가 그것만으로 더러워진다.
 */

import { readPadding, toPt } from './ir-model'

/** 용지 규격 (mm) — 세로 기준 */
export const PAPERS = {
  a4: { label: 'A4', w: 210, h: 297 },
  b5: { label: 'B5', w: 182, h: 257 },
  letter: { label: 'Letter', w: 215.9, h: 279.4 },
} as const

export type PaperKey = keyof typeof PAPERS

export const MM_PER_IN = 25.4

/**
 * 용지 판별 허용 오차(mm). 실문서는 용지 크기가 딱 떨어지지 않는다 —
 * hwpunit(1/7200in)에서 mm로 오는 동안 소수점이 밀리고, 관공서 문서 중에는
 * A4에 1mm 안팎으로 어긋난 것이 흔하다.
 */
export const PAPER_TOL = 3

export interface PageGeom {
  /**
   * 실제 용지 크기(mm). **진실원은 이쪽이다** — 규격표가 아니라.
   * 규격에 없는 크기의 원본이 흔해서(변환 과정에서 소수점이 밀린 관공서 문서 등),
   * 프리셋 이름만 들고 있으면 A4가 아닌 문서를 A4라고 표시하게 된다.
   */
  size: { w: number; h: number }
  /** 위 크기가 규격표의 어느 것과 맞는지 — 없으면 null(사용자 지정) */
  paper: PaperKey | null
  landscape: boolean
  /** 여백 (mm) — [상, 우, 하, 좌] */
  margins: [number, number, number, number]
}

export const DEFAULT_GEOM: PageGeom = {
  size: { w: PAPERS.a4.w, h: PAPERS.a4.h },
  paper: 'a4',
  landscape: false,
  margins: [20, 20, 20, 20],
}

/** 규격 + 방향 → PageGeom의 크기 부분 */
export function fromPaper(paper: PaperKey, landscape: boolean): Pick<PageGeom, 'size' | 'paper' | 'landscape'> {
  const p = PAPERS[paper]
  return { size: landscape ? { w: p.h, h: p.w } : { w: p.w, h: p.h }, paper, landscape }
}

const round1 = (v: number) => Math.round(v * 10) / 10

/** pt → mm */
const ptToMm = (pt: number) => (pt / 72) * MM_PER_IN

/**
 * 현재 문서의 페이지 설정을 읽는다 (첫 구역 기준).
 *
 * **인라인 style을 읽지, getComputedStyle을 쓰지 않는다.** 두 가지 이유다:
 * 계산된 값에는 뷰어 BASE_CSS가 섞여 들어와 IR에 실제로 적힌 값과 달라질 수 있고,
 * 쓰기 백엔드 세 곳은 전부 `readIr`을 통해 **인라인 style을 `toPt`로** 읽는다.
 * 같은 파서를 써야 다이얼로그가 보여주는 값과 저장될 값이 어긋나지 않는다.
 *
 * 용지는 폭·높이를 규격표와 대조해 맞춰 본다. 어느 것과도 안 맞으면(임의 크기 원본) 기본값을
 * 돌려주되 **문서는 건드리지 않는다** — 사용자가 적용을 누르기 전까지 원본 크기가 유지된다.
 */
export function readGeom(sec: Element | null): PageGeom {
  if (!sec) return DEFAULT_GEOM
  const css = (sec as HTMLElement).style
  const w = round1(ptToMm(toPt(css.width || null) ?? 0))
  const h = round1(ptToMm(toPt(css.minHeight || css.height || null) ?? 0))
  if (!(w > 0 && h > 0)) return DEFAULT_GEOM

  let paper: PaperKey | null = null
  for (const [key, p] of Object.entries(PAPERS) as [PaperKey, (typeof PAPERS)[PaperKey]][]) {
    const portrait = Math.abs(w - p.w) < PAPER_TOL && Math.abs(h - p.h) < PAPER_TOL
    const landscape = Math.abs(w - p.h) < PAPER_TOL && Math.abs(h - p.w) < PAPER_TOL
    if (portrait || landscape) {
      paper = key
      break
    }
  }
  const pad = readPadding(sec) // 백엔드가 구역·셀 여백을 읽는 것과 같은 헬퍼
  return {
    size: { w, h },
    paper,
    landscape: w > h,
    margins: pad.map((p) => round1(ptToMm(p))) as [number, number, number, number],
  }
}

/** 용지 실제 크기(mm) */
export function paperSize(g: PageGeom): { w: number; h: number } {
  return g.size
}

/** 화면에 보여줄 용지 이름 — 규격 밖이면 크기를 그대로 읽어 준다 */
export function paperLabel(g: PageGeom): string {
  return g.paper ? PAPERS[g.paper].label : `${g.size.w}×${g.size.h}mm`
}

/**
 * 페이지 설정을 문서의 모든 구역에 쓴다.
 *
 * 페이지네이션이 만든 사본 구역(`data-pg`)은 원본을 cloneNode로 물려받으므로 전부에 같은 값을
 * 쓴 뒤 다시 나누면 정리된다 — 원본만 골라 쓰면 다시 나누기 전까지 화면이 어긋나 보인다.
 */
export function writeGeom(sections: Iterable<HTMLElement>, g: PageGeom): void {
  const { w, h } = g.size
  const inch = (v: number) => `${(v / MM_PER_IN).toFixed(3)}in`
  const [t, r, b, l] = g.margins
  for (const sec of sections) {
    sec.style.width = inch(w)
    sec.style.minHeight = inch(h)
    sec.style.padding = `${inch(t)} ${inch(r)} ${inch(b)} ${inch(l)}`
  }
}
