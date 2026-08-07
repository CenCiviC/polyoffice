/**
 * 표 조작 UI — 워드처럼 표를 클릭하면 핸들이 뜨고, 경계를 끌어 크기를 바꾼다.
 *
 * 두 가지를 지킨다.
 *  - UI 요소는 문서가 아니다: 전부 data-ui를 달아 두고 내보낼 때 걷어낸다(stripUi).
 *  - 크기 변경도 ⌘Z로 되돌아간다: 끌기가 끝나면 원래 표로 되돌린 뒤
 *    execCommand('insertHTML')로 새 표를 넣어, 글자 편집과 같은 기록에 쌓는다.
 */

const UI_ATTR = 'data-ui'
const MIN_PT = 12

/** 내보내기 전에 UI 요소를 걷어낸다 */
export function stripUi(root: Element): void {
  for (const el of Array.from(root.querySelectorAll(`[${UI_ATTR}]`))) el.remove()
  for (const el of Array.from(root.querySelectorAll('[data-ui-selected]'))) el.removeAttribute('data-ui-selected')
}

export const TABLE_UI_CSS = `
  doc-section.hwp-page { position: relative; }
  [data-ui] { position: absolute; z-index: 20; user-select: none; }
  [data-ui="handle"] {
    width: 13px; height: 13px; margin: -16px 0 0 -16px;
    border: 1px solid #5e6ad2; background: #fff; border-radius: 2px; cursor: move;
    box-shadow: 0 1px 2px rgba(0,0,0,.2);
  }
  [data-ui="handle"]::after {
    content: ""; position: absolute; inset: 3px;
    background:
      linear-gradient(#5e6ad2,#5e6ad2) center/100% 1px no-repeat,
      linear-gradient(#5e6ad2,#5e6ad2) center/1px 100% no-repeat;
  }
  [data-ui="col"] { width: 7px; cursor: col-resize; }
  [data-ui="row"] { height: 7px; cursor: row-resize; }
  [data-ui="col"]:hover, [data-ui="row"]:hover, [data-ui].dragging { background: rgba(94,106,210,.35); }
  [data-ui="size"] {
    width: 11px; height: 11px; margin: -2px 0 0 -2px; cursor: nwse-resize;
    border: 1px solid #5e6ad2; background: #fff; border-radius: 2px;
  }
  [data-ui="drop"] { height: 3px; background: #5e6ad2; border-radius: 2px; pointer-events: none; }
  table[data-ui-selected] { outline: 2px solid rgba(94,106,210,.6); outline-offset: 1px; }
  table[data-ui-moving] { opacity: .45; }
`

const pt = (v: string | null): number => {
  const m = /(-?[\d.]+)/.exec(v ?? '')
  return m ? parseFloat(m[1]) : 0
}

/**
 * 병합을 펼친 열 격자.
 * 첫 행만 보면 안 된다 — 첫 행이 "3칸 병합 머리글"이면 열이 하나로 보여서
 * 열 경계가 아예 안 생긴다. 모든 행을 훑어 열마다 폭을 채운다.
 */
function columnGrid(table: HTMLTableElement) {
  const rows = Array.from(table.querySelectorAll('tr')).filter((r) => r.closest('table') === table)
  const widths: number[] = []
  /** [행][열] → 그 열에서 시작하고 colspan이 1인 셀 (열 폭을 실제로 결정하는 셀) */
  const owners: HTMLTableCellElement[][] = []
  const taken = new Set<string>()

  rows.forEach((row, r) => {
    let c = 0
    for (const cell of Array.from(row.cells)) {
      while (taken.has(`${r},${c}`)) c++
      const cs = cell.colSpan || 1
      const rs = cell.rowSpan || 1
      for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) taken.add(`${rr},${cc}`)
      const per = (pt(cell.style.width) || 60) / cs
      for (let k = 0; k < cs; k++) if (!widths[c + k]) widths[c + k] = per
      if (cs === 1) (owners[c] ??= []).push(cell)
      c += cs
    }
  })

  const cols = widths.map((w) => w || 60)
  const bounds: number[] = []
  let acc = 0
  for (const w of cols) {
    acc += w
    bounds.push(acc)
  }
  return { cols, bounds, owners, totalPt: acc || 1 }
}

export interface TableUiHooks {
  /** 표 하나를 새 HTML로 교체 — 실행취소 기록에 남는다 */
  commit(table: HTMLTableElement, originalHtml: string, nextHtml: string): void
  /** 연속한 블록 묶음을 새 HTML로 교체 (표 이동) — 실행취소 한 칸 */
  replaceRange(blocks: HTMLElement[], nextHtml: string): void
  changed(): void
}

export function mountTableUI(doc: Document, hooks: TableUiHooks): () => void {
  let active: HTMLTableElement | null = null
  const nodes: HTMLElement[] = []

  const clear = () => {
    for (const n of nodes) n.remove()
    nodes.length = 0
    doc.querySelectorAll('table[data-ui-selected]').forEach((t) => t.removeAttribute('data-ui-selected'))
  }

  const mk = (kind: string, style: Partial<CSSStyleDeclaration>) => {
    const el = doc.createElement('div')
    el.setAttribute(UI_ATTR, kind)
    el.setAttribute('contenteditable', 'false')
    Object.assign(el.style, style)
    nodes.push(el)
    return el
  }

  /** 표 크기 조정 끌기 */
  const startDrag = (
    e: PointerEvent,
    el: HTMLElement,
    table: HTMLTableElement,
    apply: (dx: number, dy: number) => void,
  ) => {
    e.preventDefault()
    const originalHtml = table.outerHTML
    const start = { x: e.clientX, y: e.clientY }
    el.classList.add('dragging')
    const move = (ev: PointerEvent) => apply(ev.clientX - start.x, ev.clientY - start.y)
    const up = () => {
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', up)
      el.classList.remove('dragging')
      const next = table.outerHTML
      if (next !== originalHtml) hooks.commit(table, originalHtml, next)
      else draw(active)
    }
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', up)
  }

  const draw = (table: HTMLTableElement | null) => {
    clear()
    active = table
    if (!table) return
    const section = table.closest('doc-section')
    if (!section) return
    table.setAttribute('data-ui-selected', '')
    const left = table.offsetLeft
    const top = table.offsetTop
    const w = table.offsetWidth
    const h = table.offsetHeight
    // pt → px 배율 (표 폭 기준). 셀 폭은 pt로 저장되므로 끌기 픽셀을 pt로 되돌린다.
    const grid = columnGrid(table)
    const pxPerPt = w / grid.totalPt

    // 1) 좌상단 핸들 — 누르면 표 선택, 끌면 다른 위치로 이동
    const handle = mk('handle', { left: `${left}px`, top: `${top}px` })
    handle.title = '표 선택 · 끌어서 이동'
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      const sel = doc.getSelection()
      const r0 = doc.createRange()
      r0.selectNode(table)
      sel?.removeAllRanges()
      sel?.addRange(r0)

      const blocks = () => Array.from(section.children).filter((c) => !c.hasAttribute(UI_ATTR)) as HTMLElement[]
      const startY = e.clientY
      let moving = false
      /**
       * 놓을 자리 — 포인터가 가리키는 블록의 위/아래 경계.
       * 문단 한가운데에 끼워 넣으면 문장이 갈라지고 빈 줄이 생긴다.
       * 문단은 문서 포맷에서 하나의 단위이므로 쪼개지 않고 경계에만 붙인다.
       */
      let drop: { ref: HTMLElement | null } | null = null
      const line = mk('drop', { left: `${left}px`, width: `${w}px`, display: 'none' })
      section.appendChild(line)
      const secRect = section.getBoundingClientRect()
      const zoom = secRect.height / (section as HTMLElement).offsetHeight || 1

      const move = (ev: PointerEvent) => {
        if (!moving && Math.abs(ev.clientY - startY) < 5) return
        moving = true
        table.setAttribute('data-ui-moving', '')
        const list = blocks()
        // 포인터가 놓인 블록을 찾고, 그 블록의 위/아래 중 가까운 경계를 고른다
        let ref: HTMLElement | null = null
        for (const el of list) {
          const r = el.getBoundingClientRect()
          if (ev.clientY < r.bottom) {
            ref = ev.clientY < r.top + r.height / 2 ? el : (list[list.indexOf(el) + 1] ?? null)
            break
          }
        }
        drop = { ref }
        const y = ref
          ? ref.getBoundingClientRect().top - secRect.top
          : (list.at(-1)?.getBoundingClientRect().bottom ?? secRect.top) - secRect.top
        line.style.display = 'block'
        line.style.top = `${y / zoom - 2}px`
      }

      const up = () => {
        doc.removeEventListener('pointermove', move)
        doc.removeEventListener('pointerup', up)
        line.remove()
        table.removeAttribute('data-ui-moving')
        if (!moving || !drop) return draw(table)

        const list = blocks()
        const from = list.indexOf(table)
        let to = drop.ref ? list.indexOf(drop.ref) : list.length
        if (to > from) to -= 1
        if (from < 0 || to < 0 || to === from) return draw(table)

        // 옮기는 구간만 한 번에 갈아끼워야 ⌘Z 한 번으로 되돌아간다
        const lo = Math.min(from, to)
        const hi = Math.max(from, to)
        const slice = list.slice(lo, hi + 1)
        const reordered = slice.filter((el) => el !== table)
        reordered.splice(to - lo, 0, table)
        hooks.replaceRange(slice, reordered.map((el) => el.outerHTML).join(''))
      }

      doc.addEventListener('pointermove', move)
      doc.addEventListener('pointerup', up)
    })
    section.appendChild(handle)

    // 1-b) 우하단 핸들 — 표 전체 크기 조절 (열 폭을 비례로 늘리고 줄인다)
    const sizer = mk('size', { left: `${left + w}px`, top: `${top + h}px` })
    sizer.title = '표 크기 조절'
    const baseCells = Array.from(table.querySelectorAll('tr')).map((r) =>
      Array.from(r.cells).map((c) => ({ w: pt(c.style.width) || 60, h: pt(c.style.height) || 20 })),
    )
    sizer.addEventListener('pointerdown', (e) =>
      startDrag(e, sizer, table, (dpx, dpy) => {
        const sx = Math.max(0.2, (w + dpx) / w)
        const sy = Math.max(0.2, (h + dpy) / h)
        Array.from(table.querySelectorAll('tr')).forEach((r, ri) => {
          Array.from(r.cells).forEach((c, ci) => {
            const base = baseCells[ri]?.[ci]
            if (!base) return
            c.style.width = `${Math.max(MIN_PT, base.w * sx).toFixed(1)}pt`
            c.style.height = `${Math.max(MIN_PT, base.h * sy).toFixed(1)}pt`
          })
        })
      }),
    )
    section.appendChild(sizer)

    // 2) 열 경계 — 끌면 좌우 열 폭을 주고받는다 (병합된 셀은 건드리지 않는다)
    grid.bounds.slice(0, -1).forEach((rightPt, index) => {
      const bar = mk('col', { left: `${left + rightPt * pxPerPt - 3}px`, top: `${top}px`, height: `${h}px` })
      bar.title = '열 너비 조정'
      const leftCells = grid.owners[index] ?? []
      const rightCells = grid.owners[index + 1] ?? []
      const startW = grid.cols[index]
      const nextW = grid.cols[index + 1]
      bar.addEventListener('pointerdown', (e) =>
        startDrag(e, bar, table, (dpx) => {
          const d = Math.max(MIN_PT - startW, Math.min(nextW - MIN_PT, dpx / pxPerPt))
          for (const c of leftCells) c.style.width = `${(startW + d).toFixed(1)}pt`
          for (const c of rightCells) c.style.width = `${(nextW - d).toFixed(1)}pt`
        }),
      )
      section.appendChild(bar)
    })

    // 3) 행 경계 — 끌면 그 행 높이가 바뀐다
    let accY = top
    Array.from(table.querySelectorAll('tr')).forEach((row) => {
      accY += (row as HTMLElement).offsetHeight
      const bar = mk('row', { left: `${left}px`, top: `${accY - 3}px`, width: `${w}px` })
      bar.title = '행 높이 조정'
      const startH = pt((row.cells[0] as HTMLElement | undefined)?.style.height ?? '') || (row as HTMLElement).offsetHeight / pxPerPt
      bar.addEventListener('pointerdown', (e) =>
        startDrag(e, bar, table, (_dx, dpy) => {
          const next = Math.max(MIN_PT, startH + dpy / pxPerPt)
          for (const cell of Array.from(row.cells)) cell.style.height = `${next.toFixed(1)}pt`
        }),
      )
      section.appendChild(bar)
    })
  }

  const onClick = (e: Event) => {
    const el = e.target as Element | null
    if (el?.closest?.(`[${UI_ATTR}]`)) return
    draw((el?.closest?.('doc-section table') as HTMLTableElement) ?? null)
  }
  doc.addEventListener('click', onClick, true)
  const onScrollOrResize = () => active && draw(active)
  doc.defaultView?.addEventListener('resize', onScrollOrResize)

  return () => {
    doc.removeEventListener('click', onClick, true)
    doc.defaultView?.removeEventListener('resize', onScrollOrResize)
    clear()
  }
}
