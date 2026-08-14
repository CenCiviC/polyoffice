# Document IR Spec v0.2.0

HTML 기반 문서 중간표현(IR). 모든 프론트엔드(LLM 생성, hwp/hwpx 가져오기, 편집기)는
이 어휘로 수렴하고, 모든 백엔드(hwpx, docx, PDF/print)는 이 어휘에서 출발한다.

```
LLM 생성 ─┐                       ┌─→ hwpx (OWPML)
hwp 가져오기 ─┼─→ canonical IR(HTML) ─┼─→ docx (OOXML)
편집기 ────┘                       └─→ PDF (print CSS)
```

## 설계 규칙 (불변)

1. **입장 조건** — IR에 들어오는 모든 요소는 hwpx·docx 두 백엔드 매핑(불완전하면 강등
   규칙까지)이 이 문서에 정의되어야 한다. 매핑 없는 요소 추가 금지.
2. **진실원은 의미, 렌더는 파생** — 수식의 진실원은 LaTeX, 개요번호의 진실원은 스킴 참조.
   렌더 결과(MathML, "1.2.3" 텍스트)는 파생물이며 저장하지 않는다.
   개요 스킴의 진실원은 `ir-model.ts`의 `OUTLINE_SCHEME` 하나이고, 뷰어 CSS counter와
   백엔드 셋의 numbering 정의가 **모두 그 배열에서 생성된다** — 갈라지면 화면 번호와
   저장된 번호가 달라진다. `bun run outline-sim`이 어긋남을 잡는다.
3. **스펙 = 계약 = 린터** — 이 문서의 어휘·규칙은 `src/lib/ir.ts`의 `validateIR()`와 항상
   일치해야 한다. 스펙 변경 없는 린터 변경 금지, 그 역도 금지.
4. **IR 밖의 것은 불투명 보존** — 가져온 문서에서 IR로 표현 못 하는 요소는 변환하지 않고
   원본 XML 참조로 보존한다(보존-패치 아키텍처, 2단계에서 구현).

## 버전

- 루트 `<doc-section data-ir="0.2.0">`에 스펙 버전을 박는다 (`IR_VERSION`이 진실원).
- 어휘 추가 = minor, 기존 어휘의 의미 변경 = major (기존 문서 마이그레이션 필요).

---

## 어휘

상태: ✅ RW(hwp→IR 읽기 + IR→hwpx 쓰기 구현) / ✅ READ(읽기만) / 🔜 SLOT(자리만 정의, 미구현).

### 블록 요소

| 요소 | 의미 | 상태 |
|---|---|---|
| `<doc-section>` | 구역 = 페이지 설정 단위. 속성: `data-ir`(루트만), style(`width·min-height·padding`). WRITE는 템플릿 secPr 이식(자체 페이지 설정 생성은 v0.3) | ✅ RW |
| `<p>` | 문단. style: `text-align` | ✅ RW |
| `<h1>`–`<h6>` | 개요 수준 문단. 속성 `data-num`= 개요 번호 **스킴 이름**(지금은 `outline` 하나). 붙으면 세 포맷 모두 번호가 붙는다. WRITE는 크기·굵기도 강등(h1=16pt…) | ✅ 편집+WRITE |
| `<ul>` `<ol>` `<li>` | 목록. `li`는 `data-id` 필수 블록. 중첩 허용(`li` 안에 `ul`/`ol`). WRITE는 세 포맷 모두 **진짜 numbering** — 문서 전역 정의 테이블 + 문단 바인딩. 표시는 뷰어(브라우저 기본)와 같게 `ol`=십진수, `ul`=`•`→`◦`→`▪` | ✅ 편집+WRITE |
| `<table>` | 표. 중첩 허용. 자식은 `<tr>`(또는 투명 래퍼 `<tbody>`)만, `<tr>`의 자식은 `<td>`만. `<tbody>`는 HTML 파서가 자동 삽입하므로 속성 없는 투명 래퍼로 허용 — 직렬화 시에는 생략 | ✅ RW |
| `<td>` | 셀. 속성: `colspan` `rowspan`, style: `width·height·padding·background·**border**·**vertical-align**`. 블록(`p`…)을 담아도 되고 인라인 내용을 바로 담아도 된다(**암묵 문단**으로 읽힌다) | ✅ RW(테두리·정렬은 WRITE만) |
| `<doc-footnote>` | 각주 내용. 속성: `id`(필수). 본문 `data-fn-ref`와 1:1 쌍. READ=fn/en 컨트롤 → 섹션 끝 블록(번호는 CSS counter 파생), WRITE=참조 지점의 `hp:footNote`+autoNum | ✅ RW |
| `<doc-textbox>` | 글상자. 속성: `data-anchor`(`page`\|`para`), `data-wrap`(`square`\|`none`), style: `width·float` | 🔜 |
| `<doc-eq>` | 수식(블록). 속성: `data-latex`(필수, 진실원) | 🔜 |
| `<doc-pagebreak>` | 강제 페이지 나눔. WRITE = 다음 `hp:p`의 `pageBreak="1"` | ✅ 편집+WRITE |
| `<doc-header>` / `<doc-footer>` | 머리말/꼬리말. `<doc-section>` 직계 자식으로만. 본문 흐름 밖이고 **페이지마다** 그려진다(조판이 복제하고 저장 전에 걷는다) | ✅ WRITE |

### 인라인 요소

| 요소 | 의미 | 상태 |
|---|---|---|
| `<span>` | 글자 스타일 런. style: `font-size·color·font-family·font-style·font-weight·text-decoration` (font-family WRITE는 v0.3 — 현재 기본 폰트로 강등) | ✅ RW |
| `<br>` | 줄바꿈 (문단 내) | ✅ RW |
| `<img>` | 이미지. 속성: `src`(data-URI) `alt`, style: `width·height`(pt). READ=BinData→base64, WRITE=zip `BinData/imgN.ext`+`hp:pic`. 브라우저 미지원 포맷(wmf/emf)은 자리표시 텍스트 강등 | ✅ RW |
| `<sup>` `<sub>` | 위첨자·아래첨자. 속성 없음 | ✅ 편집+WRITE |
| `<doc-field>` | 계산 필드. 속성 `data-kind`(`page`\|`pages`). **머리말·꼬리말 안에만.** 값은 저장하지 않는다 — 화면은 조판이, 파일은 각 포맷의 필드가 센다 | ✅ WRITE |
| `<a href>` | 하이퍼링크. `http(s):`·`mailto:` 또는 문서 내 앵커 `#b<n>`. `href`와 `data-fn-ref` 동시 지정 금지 | ✅ 편집+WRITE(docx·odt) / hwpx 강등 |
| `<sup><a data-fn-ref="…">` | 각주 참조. `doc-footnote`의 `id`를 가리킴. **`<a>`는 비어 있다** — 번호는 뷰어 counter와 각 포맷의 각주 기능이 센다 | ✅ RW |

### 블록 주소 체계

- 콘텐츠 블록(`p`, `h1–h6`, `table`, `doc-*` 중 블록)은 **`data-id` 필수, 문서 내 유일**.
- 형식: `b<순번>` (예: `b1`, `b2`). 가져오기/생성 시 부여, 편집 중 불변.
- 용도: LLM 패치 편집의 타깃 지정("`b7` 블록만 교체"), 보존-패치 시 원본 XML 노드 매핑 키.

### 스타일 어휘 (인라인 style 허용 속성)

`font-size`(pt) · `color`(rgb()) · `font-family`(WRITE 시 hwpx fontfaces 7개 언어그룹에 등록) ·
`font-style` · `font-weight` · `text-decoration`(underline·line-through) · `text-align` ·
`line-height`(비율 → paraPr lineSpacing PERCENT×100) · `width`(pt|in) · `height`(pt) · `min-height`(in) ·
`padding`(pt) · `background`(span=형광펜→charPr shadeColor, td=셀 배경→borderFill) · `float`(textbox만) ·
`border`(td — `<굵기> <종류> <색>` 축약, `none` 가능. 종류는 solid·dashed·dotted·double) ·
`vertical-align`(td — top·middle·bottom) ·
`margin-left`(pt, 문단 들여쓰기) · `text-indent`(pt, 첫 줄 — **음수면 내어쓰기**) ·
`margin-top`·`margin-bottom`(pt, 문단 앞뒤 여백)

목록 항목의 들여쓰기는 IR에 적지 않는다 — **번호는 파생물**(규칙 2)이고 그 자리도 마찬가지라,
수준마다 뷰어 CSS와 같은 `24pt`(`LIST_INDENT_PT`)를 백엔드가 계산한다. `li`에 `margin-left`를
직접 쓰면 그쪽이 이긴다(단 odt는 ODF가 목록 수준 정의를 우선하므로 무시된다).

**셀의 인라인 내용은 암묵 문단이 된다.** `<td>글자</td>`처럼 `<p>` 없이 넣어도 브라우저는
익명 블록으로 그리므로, 리더도 문단 하나로 읽는다(`readBlocks`의 `flush`). 정렬·여백은
컨테이너에서 가져온다. 예전에는 세 백엔드가 이 내용을 **통째로 버렸다**.

**소스의 개행은 글자가 아니다.** 예쁘게 들여쓴 IR의 개행+들여쓰기는 브라우저가 안 보여주므로
백엔드도 버린다(`displayText`) — 문단 처음·끝과 블록 자식(`ul`·`ol`·`table`) 옆의 공백은 삭제,
그 밖의 개행은 공백 하나. 탭·연속 공백은 리더가 실어 오는 값이라 건드리지 않는다.

문단 여백 4종은 `p`·`h1–h6`·`li`에만 쓴다. `margin-top`/`margin-bottom`이 생기면서
제목 여백의 진실원이 `ir-model.ts`의 `HEADING_SPACE` 상수에서 **IR로 올라왔다** —
상수는 방출기의 기본값으로만 남고, 백엔드는 IR에 적힌 값만 본다.

이 목록 밖의 CSS 속성은 계약 위반. 렌더 전용 스타일(그림자, 페이지 배경 등)은 인라인이
아니라 뷰어의 BASE_CSS가 담당한다.

### 정규화 (canonical form)

왕복 안정성과 LLM 패치 diff를 위해 직렬화는 한 가지 형태로 고정:

1. 색은 `rgb(r, g, b)`, 길이는 소수 1자리 + 단위(`8.5pt`), 폰트 크기는 pt.
2. 검정(`rgb(0, 0, 0)`)은 생략 (기본값 생략 원칙).
3. 빈 `<span>` 금지, 동일 스타일 인접 span은 병합.
4. style 속성 순서는 방출기가 결정한 고정 순서 (임의 재배열 금지).

---

## 백엔드 매핑 테이블

단위 환산: 1pt = 100 hwpunit(길이) / hwpx 글자 크기 = pt×100 / docx 글자 크기 = pt×2(half-point),
길이는 twip(pt×20) 또는 EMU.

신뢰도: ● 확정(구현/문헌 확인) ◐ 유력(golden file에서 확정 필요) ○ 조사 필요

| IR | hwpx (OWPML) | docx (OOXML) | 강등 규칙 |
|---|---|---|---|
| `doc-section` | `<hs:sec>` + secPr (템플릿 첫 run에서 이식, pagePr 59530×84190=A4) ● | `<w:sectPr>` (pgSz/pgMar) ● | — |
| `p` + `text-align` | `<hp:p paraPrIDRef>` + paraPr `<hh:align horizontal>` (LEFT=id 0 재사용, CENTER/RIGHT는 복제 등록) ● | `<w:p><w:pPr><w:jc>` ● | — |
| `span` 스타일 | `<hp:run charPrIDRef>` + `<hh:charPr height=pt×100 textColor>` + `<hh:bold/>` `<hh:italic/>` `<hh:underline type=BOTTOM>` ● | `<w:r><w:rPr>` (sz/color/b/i/u/rFonts) ● | — |
| `br` | `<hp:t>` 안의 `<hp:lineBreak/>` ● | `<w:br/>` ● | — |
| `h1–h6` + `data-num` | 개요 numbering 등록 + paraPr `<hh:heading type="OUTLINE" idRef level>` ● | 개요 abstractNum(`multiLevelType=multilevel`, 한글 수준은 `numFmt=ganada`) + `<w:numPr>` ● | — |
| `ul`/`ol`/`li` | `<hh:numbering id>` + `<hh:paraHead level numFormat>`(`^n.`), 문단은 paraPr의 `<hh:heading type="NUMBER" idRef level>` — 실물 한글 문서에서 확정 ● | `numbering.xml`의 `<w:abstractNum>`+`<w:num>`, 문단은 `<w:numPr><w:ilvl><w:numId>` ● | 글머리표는 `hh:bullets` 대신 번호 서식 문자열에 문자만 적는다(`hh:bullets`는 실물 미확인) |
| `table/td` | 래퍼 `<hp:p>`의 run 안 `<hp:tbl rowCnt colCnt>` + `<hp:tc>`(subList/cellAddr/cellSpan/cellSz=pt×100) — colAddr은 rowspan 점유 시뮬레이션으로 계산 ● | `<w:tbl>/<w:tr>/<w:tc>` + gridSpan/vMerge ● | — |
| `td` 배경 | borderFill 등록(`<hc:winBrush faceColor>`) + IDRef ● | `<w:shd w:fill>` ● | — |
| `td` 테두리 | 같은 borderFill의 4변(`<hh:leftBorder type width color>`) — 종류 SOLID·DASH·DOT·DOUBLE_SLIM·NONE과 굵기 mm 값은 실물 hwpx에서 확인 ● | 셀마다 `<w:tcBorders>` (`w:sz`는 1/8pt, 없으면 `w:val="nil"`) ● | 굵기는 한글이 고르는 이산값(0.1·0.12·0.15…mm)으로 스냅 |
| `td` 세로 정렬 | `<hp:subList vertAlign="TOP\|CENTER\|BOTTOM">` ● | `<w:vAlign>` (middle→center) ● | — |
| `doc-footnote` | 각주 컨트롤 `<hp:footNote>` + `<hp:autoNum>` (참조 지점에 내용 인라인) ● | `<w:footnoteReference>` + footnotes.xml(구분선 -1·0 포함) ● / odt는 참조 지점의 `<text:note>` ● | — |
| `doc-textbox` | 글상자 개체 (drawText 계열) ○ | `<wps:txbx><w:txbxContent>` ◐ | float div→인라인 표 1×1 |
| `doc-eq` | `<hp:equation script>` — **한글 수식 스크립트** (LaTeX→변환기 자작 필요) ○ | `<m:oMath>` (OMML) — MathML→OMML 공식 XSLT 존재 ● | LaTeX 원문 텍스트로 강등 |
| `doc-pagebreak` | 문단 pageBreak 속성 ◐ | `<w:br w:type="page">` ● | — |
| `doc-header/footer` | 첫 문단 run의 `<hp:ctrl><hp:header\|footer id applyPageType>` + `hp:subList` — 실물 한글 문서에서 확정 ● | header1.xml·footer1.xml + `<w:headerReference>` ● / odt는 master-page의 `<style:header>` ● | — |
| `doc-field page` | `<hp:autoNum num="1" numType="PAGE">` + `autoNumFormat` — 실물 확정 ● | `<w:fldSimple w:instr=" PAGE ">` ● / odt `<text:page-number>` ● | — |
| `doc-field pages` | **강등** — 전체 쪽수의 numType을 실물로 못 봤다. 추측해서 쓰지 않는다 | `NUMPAGES` ● / odt `<text:page-count>` ● | hwpx에서는 아무것도 안 나온다 |
| `img` | `<hp:pic>` + BinData zip 항목 + manifest ◐ | `<w:drawing>` + media/ + rels ● | — |
| `sup` / `sub` | `<hh:supscript/>` / `<hh:subscript/>` — charPr의 무속성 자식 (실물 샘플 + hwpxlib CharPr 확인) ● | `<w:vertAlign w:val="superscript\|subscript">` ● | — |
| `a[href]` | `<hp:fieldBegin type="HYPERLINK">`…`<hp:fieldEnd/>` — 타입명은 hwpxlib `FieldType.HYPERLINK`로 확정됐으나 **`hp:stringParam name="Command"`의 문자열 문법이 미확인** ◐ | `<w:hyperlink r:id>` + document.xml.rels 관계 ● | **hwpx는 현재 강등**: 링크 텍스트만 남기고 주소를 버린다(밑줄·파랑 없이 원래 서식 유지). 주소를 지키려면 docx·odt로 저장 |
| `margin-left` / `text-indent` | paraPr `<hh:margin>`의 `<hc:left>` / `<hc:intent>` (HWPUNIT=pt×100, 실물 확인) ● | `<w:ind w:left>` / 양수 `w:firstLine`·음수 `w:hanging` (twip=pt×20) ● | — |
| `margin-top` / `margin-bottom` | paraPr `<hh:margin>`의 `<hc:prev>` / `<hc:next>` ● | `<w:spacing w:before>` / `<w:after>` ● | — |
| `sup>a[data-fn-ref]` | footNote 컨트롤이 참조 겸함 ◐ | footnoteReference가 참조 겸함 ● | 위첨자 숫자로 강등 |

> ◐/○ 항목은 백엔드 구현 착수 전에 golden file(한글에서 해당 기능 하나만 넣고 hwpx 저장)
> 로 요소명·구조를 확정하고 이 표를 ●로 갱신한다. **표가 ●가 되기 전에 코드 작성 금지.**

---

## 검증 규칙 (`validateIR`)

1. `element-allowed` — 어휘 표에 없는 태그 금지.
2. `attr-allowed` — 요소별 허용 속성 외 금지 (`data-id`, `style`은 공통 허용).
3. `style-allowed` — 스타일 어휘 밖 CSS 속성 금지.
4. `block-id` — 콘텐츠 블록의 `data-id` 존재 + 유일성.
5. `structure` — `table>(tbody?)>tr>td` 구조, `p` 안에 블록 요소 금지, `doc-section` 중첩
   금지, `doc-header/footer`는 `doc-section` 직계.
6. `footnote-pair` — 모든 `data-fn-ref` ↔ `doc-footnote[id]` 1:1 대응.
7. `eq-truth` — `doc-eq`는 `data-latex` 필수.
8. `link-target` — `a[href]`는 `http:`·`https:`·`mailto:` 또는 문서 내 앵커 `#b<n>`만.
   그 밖의 스킴(`javascript:`·`data:` 등) 금지. `href`와 `data-fn-ref` 동시 지정 금지
   (하이퍼링크와 각주 참조는 다른 것이다).

## 로드맵

> 어휘 단위 로드맵은 아래, **작업 순서와 선행 조건은 [TODO.md](TODO.md)** 를 본다.

- **v0.1**: READ 어휘(문단·런·표·구역) + 린터. hwp→IR이 린터 통과. ✅
- **v0.1.x**: WRITE 백엔드 hwpx — 템플릿+주입(blank.hwpx, MIT/pypandoc-hwpx),
  hwp→IR→hwpx 왕복 E2E(`bun run tohwpx`) 통과. 이후 docx·odt 백엔드와 `img` READ/WRITE,
  font-family 매핑까지. ✅ (한글·한컴독스 실기기 열기 검증은 아직)
- **v0.2.0 (현재)**: 인라인 어휘 `a[href]`·`sup`/`sub`, 문단 여백 어휘 4종
  (`margin-left`·`text-indent`·`margin-top`·`margin-bottom`). 셋 다 편집기 UI + 쓰기 3종.
  **읽기**: 다섯 리더가 첨자·문단 여백을 채운다. 하이퍼링크는 docx·odt·hwpx만
  (hwp·doc은 필드 구조라 미구현). 리더별 상태는 README "현재 지원 범위" 표를 본다.
  **남은 것**: hwpx 하이퍼링크 **쓰기** — 한글에서 링크 하나만 넣고 저장한 golden file로
  `Command` 문자열 문법을 확정해야 강등을 걷어낼 수 있다.
- **v0.3 (진행 중)**: 목록 numbering ✅ · 개요 번호 ✅ — 둘 다 전역 정의 테이블 + 문단
  바인딩으로 간다(`"• "` 텍스트 강등 제거, 중첩 수준 지원). 개요 스킴은 한글 공문서 관행
  `1. → 가. → 1) → 가) → (1) → (가)`. 표 셀 테두리·세로 정렬 ✅. 각주 쓰기 3종 + 삽입 UI ✅.
- **v0.4**: 머리말/꼬리말 + `doc-field`(쪽번호) ✅ — hwpx 매핑은 실물 한글 문서에서 확정했다.
  남은 것은 전체 쪽수(`pages`)의 hwpx numType과 **읽기**(리더가 머리말·꼬리말 영역을
  아직 안 본다).
- **v0.5+**: 수식(LaTeX→한글수식 변환기)·글상자·단(열)·목차. 보존-패치 아키텍처.
