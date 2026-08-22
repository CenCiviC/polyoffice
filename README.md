# Narro

한글(.hwp/.hwpx)과 Word·오픈오피스(.doc/.docx/.odt) 문서를 **브라우저 안에서** HTML로
변환하는 실험. 파일이 서버로 올라가지 않고 전부 클라이언트에서 파싱된다.

**파서는 자체 Rust 크레이트(`rust/hwp-core`) → WASM.** 다섯 포맷이 모두 같은
문서 모델 JSON 계약(`src/lib/model.ts` ↔ `rust/hwp-core/src/model.rs`)을 채우기 때문에
방출기·편집기·hwpx 쓰기는 입력 포맷을 전혀 모른다. 새 포맷 지원 = 리더 하나 추가.

| 포맷 | 컨테이너 | 리더 |
|---|---|---|
| `.hwp` 5.x | OLE(CFB) + 압축 바이너리 레코드 | `parse.rs` (실패 시 [hwp.js](https://github.com/hahnlee/hwp.js) 폴백) |
| `.doc` 97-2003 | OLE(CFB) + 조각표·FKP·Escher | `doc.rs` |
| `.hwpx` | zip + OWPML XML (KS X 6101) | `hwpx.rs` |
| `.docx` | zip + OOXML (ECMA-376) | `docx.rs` |
| `.odt` | zip + ODF XML | `odt.rs` |

포맷은 확장자가 아니라 **내용물**로 판별한다(`sniff_format`) — zip 안의 표지 파일,
OLE 안의 스트림 이름. Rust 파서는 hwp.js가 PARA_CHAR_SHAPE의 첫 쌍만 읽는 버그를 고쳐
run 스타일 충실도가 더 높다 (예: 양식 안내문의 빨간 기울임 보존).

"Word/한글 문서의 중간통로를 HTML로 만들 수 있는가"라는 가설 검증:
**읽기 5종** ✓ · **브라우저 편집** ✓ · **쓰기 3종** ✓ — 사이클 완성.

| | hwp | doc | hwpx | docx | odt |
|---|:--:|:--:|:--:|:--:|:--:|
| 읽기 → IR | ✓ | ✓ | ✓ | ✓ | ✓ |
| IR → 쓰기 | ✗ | ✗ | ✓ | ✓ | ✓ |
| 개요·목록·셀테두리·머리말 **읽기** | ✓ | ✗ | ✓ | ✓ | ✓ |

**쓰기만 되고 읽기가 없으면 열 때마다 서식이 깎인다.** 그래서 어휘를 늘릴 때마다 리더도
같이 채운다 — `bun run reread-sim`이 IR → 파일 → **다시 IR**을 세 포맷에서 전수 대조한다.

`.hwp` 바이너리도 문단 머리(개요·번호·글머리표)·셀 테두리·머리말/꼬리말·쪽번호를 읽는다.
비트 위치와 표(테두리 굵기 16단계 · 종류 0=없음/1=실선/2=파선/3=점선/8=이중선, 컨트롤 id
`head`·`foot`·`atno`)는 추측이 아니라 **동작하는 파서([hwp.js](https://github.com/hahnlee/hwp.js), Apache-2.0)가
쓰는 값**을 근거로 삼았다. `.doc`만 남았는데 이 레포에 검증할 샘플이 없어 손대지 않았다.

읽기 5 × 쓰기 3이 전부 조합되므로 **doc → odt, hwp → docx** 같은 변환이 모두 성립한다.
`.hwp`/`.doc` 쓰기는 OLE 바이너리 직렬화라 이 범위 밖 — 필요하면 hwpx/docx로 저장한 뒤
한글/Word에서 다시 저장하면 된다. `bun run matrix`가 이 표를 왕복으로 증명한다.

**편집**: 미리보기의 모든 문단이 contentEditable — 클릭해서 바로 수정. 편집 결과는
`normalizeIR()`(편집기가 만든 div→p, 편집 속성 제거, 새 블록 data-id 부여)를 거쳐
.html/.hwpx 저장에 반영된다. `bun run edit-sim`이 이 경로를 헤드리스로 검증한다.

**페이지 설정**(용지·방향·여백)은 새 어휘가 아니라 **이미 있는 어휘를 만질 수 있게 한 것**이다
— `doc-section`의 width·min-height·padding은 리더가 채우고 세 백엔드가 모두 쓰는데 편집 수단만
없었다. 값은 뷰어 CSS가 섞이는 `getComputedStyle`이 아니라 **백엔드와 같은 파서**(`toPt`·
`readPadding`)로 인라인 style에서 읽는다 — 다이얼로그가 보여주는 값과 저장될 값을 같게 하려고.
규격에 없는 크기는 A4라고 우기지 않고 크기를 그대로 표시한다(`139.7×180.3mm`).
`bun run page-sim`이 왕복을 검증한다.

변환 결과물은 임의 HTML이 아니라 **Document IR**(HTML 기반 중간언어, [docs/IR-SPEC.md](docs/IR-SPEC.md))
계약을 따른다. LLM 생성·편집기·백엔드(hwpx/docx)가 전부 이 어휘로 수렴하는 컴파일러 구조.

## 디자인 시스템

UI 크롬은 **Narro Design System**("고요한 정밀함 / Quiet Precision, Linear-refined" —
DearDent EMR DS 이식)을 따른다. **UI를 만들거나 고치기 전에
`.claude/skills/narro-design-system/SKILL.md`를 먼저 읽을 것.** 토큰 구현체는
`src/index.css`(3-tier: primitives → semantic aliases → components), 브랜드 자산은
`public/icons/`(narro 로고). 변환된 문서 콘텐츠(doc-section 내부)는 DS 적용 대상이 아니다
— 원본 충실도 우선.

## 실행

```bash
bun install
bun run dev            # http://localhost:5173 — 문서 드래그&드롭
                       #   ?doc=<url> 로 링크에서 바로 열기 (다른 오리진이면 CORS 필요)
bun run build          # 프로덕션 번들 (dist/)

# CLI 변환 (브라우저와 동일한 코드 경로 — 다섯 포맷 모두)
bun run convert <input> [output.html]
bun run validate <input>            # 변환 결과가 IR 계약을 지키는지 검사
bun run tohwpx <input> [out.hwpx]   # 입력 → IR → hwpx 왕복 E2E + 검증
bun run export <ir.html> [out-dir]  # 반대 방향 — 손으로 쓴 IR HTML → hwpx·docx·odt (+미리보기)
bun run matrix [out-dir]            # SOT 한 장 → 전 포맷 쓰기 → 되읽기 왕복 대조
bun run page-sim                    # 페이지 설정 읽기·쓰기 왕복 + 백엔드 도달 검증
bun run vocab-sim                   # IR v0.2 어휘(링크·첨자·문단여백) 계약 + 쓰기 3종 검증
bun run list-sim                    # 목록 numbering — 정의 테이블·중첩 수준·번호 재시작 검증
bun run outline-sim                 # 개요 번호 — 스킴 진실원(뷰어 CSS ↔ 백엔드 3종) 일치 검증
bun run cell-sim                    # 표 셀 테두리·세로 정렬 — 셀마다 다른 서식이 3종에 도달하는지
bun run footnote-sim                # 각주 — 내용 보존 + 번호를 저장하지 않는지 (3종)
bun run hf-sim                      # 머리말·꼬리말·쪽번호 — 본문 밖 유지 + 조판 사본 걷기
bun run reread-sim                  # 읽기 대칭 — IR → 파일 → 다시 IR (세 포맷 전수 대조)
bun run golden-sim                  # 한글이 저장한 골든과 대조 — 색·링크·각주 번호 어휘
bun run samples-sim                 # samples/ir 전수 — 어떤 문서에나 성립해야 하는 불변식
bun run mcp                         # MCP 서버 (stdio) — 프롬프트에서 문서 만들기
bun run mcp-sim                     # MCP 왕복 검증 (도구 5종 + dev 서버 + 편집기 링크)
bun run shots [문서] [출력]          # 진짜 Chrome에 편집기를 띄워 화면 캡처 (dev 서버 먼저)
bun run compare <input.hwp>         # Rust WASM vs hwp.js 파서 골든 비교
bun run wasm:build                  # Rust 파서 재빌드 (rust/hwp-core 수정 후)
cd rust/hwp-core && cargo test      # Rust 파서 유닛/통합 테스트

# docx/odt 회귀 픽스처 재생성 (서식 값을 아는 최소 문서)
python3 scripts/make-office-fixtures.py rust/hwp-core/tests/fixtures
```

## MCP — 프롬프트에서 문서 만들기

`mcp/server.ts`는 이 변환기를 **MCP 도구**로 내보낸다. "이 내용으로 한글 문서 만들어줘"
한 마디로 .hwpx·.docx·.odt가 생기고, 브라우저에 편집기가 뜬다.

전부 이 컴퓨터 안에서 돈다 — 문서도 뷰어(로컬 vite dev 서버)도 로컬이라
"파일이 서버로 안 올라간다"는 전제가 그대로다.

| 도구 | 하는 일 |
|---|---|
| `narro_guide` | IR 어휘 설명서([IR-AUTHORING.md](docs/IR-AUTHORING.md))를 돌려준다. 문서를 쓰기 전에 먼저 부른다 |
| `narro_write` | IR HTML → hwpx·docx·odt + 편집기 링크. 만든 파일을 곧바로 되읽어 텍스트를 대조한다 |
| `narro_read` | 기존 hwp·doc·hwpx·docx·odt → IR HTML. 고쳐서 다시 `narro_write`에 넣으면 편집 |
| `narro_open` | 이미 있는 문서를 편집기로 열기 |
| `narro_viewer` | 로컬 dev 서버 상태·시작·정지 |

**어려운 건 파일 만들기가 아니라 IR 어휘로 정확히 쓰는 일**이라, 설명서를 툴 description에
욱여넣는 대신 `narro_guide`라는 도구로 분리했다. 스키마는 가볍게 유지되고, 필요할 때만
컨텍스트를 쓴다.

`narro_write`가 어휘를 벗어난 HTML을 받으면 파일을 만들지 않고 **위반 목록을 오류로**
돌려준다(`validateIR`의 규칙 이름·경로 그대로). 부르는 쪽이 고쳐서 다시 부르면 된다.

### 붙이기

Claude Code는 레포의 `.mcp.json`을 그대로 읽는다 — 프로젝트를 열고 승인하면 끝.
다른 클라이언트(Claude Desktop·Cursor)는 설정에 이렇게 넣는다:

```json
{
  "mcpServers": {
    "narro": { "command": "bun", "args": ["run", "/절대경로/hwp2html/mcp/server.ts"] }
  }
}
```

### 뷰어

`narro_write`는 결과를 `public/scratch/<이름>/`에 놓고 `localhost:5173/?doc=/scratch/…`를
돌려준다. dev 서버가 이미 떠 있으면 붙고, 없으면 띄운다(우리가 띄운 것만 우리가 끈다).
`public/` 밑에 두는 이유는 `App.tsx`의 `?doc=`이 `fetch`라 `file://`로는 안 열리고
http 오리진이 필요하기 때문이다. `out_dir`을 주면 원하는 폴더에 사본도 남긴다.

## 현재 지원 범위

**쓰기(IR → hwpx · docx · odt)**: 세 백엔드가 같은 IR을 받아 각자의 패키지를 만든다.
DOM 해석은 `src/lib/ir-model.ts`가 한 번만 하고(중립 문서 트리), 백엔드는 옮기기만 한다.

- `html2hwpx.ts` — `public/blank.hwpx`([pypandoc-hwpx](https://github.com/msjang/pypandoc-hwpx), MIT)를
  템플릿으로 section0.xml을 교체하고 header.xml에 charPr/paraPr/borderFill을 추가 등록
- `html2docx.ts` — OOXML 패키지를 통째로 생성 (필요한 부품이 적어 템플릿이 필요 없다)
- `html2odt.ts` — ODF. 서식을 인라인으로 못 쓰기 때문에 자동 스타일로 모아 등록한다

공통 지원: 문단 정렬 · 글자스타일(크기/색/굵기/기울임/밑줄/취소선/글꼴/**위·아래첨자**) ·
**문단 여백**(들여쓰기·첫 줄·앞뒤) · **하이퍼링크**(세 포맷 전부) · **목록**(번호·글머리표, 중첩) ·
**개요 번호**(제목에 `1. 가. 1)`) ·
표(가로·세로 병합, 열 폭, **셀 배경·테두리·세로 정렬**) · **각주** ·
**머리말·꼬리말·쪽번호** · 그림(바이트 그대로).
앱에서는 `.hwpx 저장` 버튼과 `docx`·`odt` 보조 버튼.

**목록은 진짜 목록으로 나간다.** 예전에는 `"• "`/`"1. "`를 본문 글자로 박아서, 한글·Word에서
목록처럼 보이기만 하고 항목을 추가해도 기호가 안 붙었다. 지금은 세 포맷 모두 문서 전역
numbering 정의(docx `numbering.xml` · odt `text:list-style` · hwpx `hh:numbering`)를 만들고
문단을 거기 묶는다. 목록마다 정의를 새로 만드는데, 세 포맷 다 **정의 단위로 번호를 세기**
때문에 공유하면 둘째 목록이 1이 아니라 이어서 센다. hwpx 쪽 문법(`heading type="NUMBER"`,
`paraHead`의 `^n` 치환)은 추측이 아니라 **한글이 저장한 실물 hwpx에서 확정**했다.

**개요 번호**도 같은 인프라 위에 있다. 제목에 `data-num="outline"`이 붙으면 한글 공문서 관행
`1. → 가. → 1) → 가) → (1) → (가)`으로 번호가 붙는다. 번호 자체는 **어디에도 저장하지 않는다**
— 화면은 뷰어 CSS counter가, 파일은 각 포맷의 numbering 정의가 센다. 둘이 갈라지지 않도록
스킴의 진실원은 `ir-model.ts`의 `OUTLINE_SCHEME` 배열 하나이고, 뷰어 CSS도 그 배열에서
생성된다(`bun run outline-sim`이 어긋남을 잡는다).

**각주와 머리말·꼬리말**도 같은 원칙이다. 각주 참조의 `<a>`는 비어 있고, 쪽번호는
`<doc-field data-kind="page">`라는 **종류만** 담는다 — 숫자는 화면에서는 조판이,
파일에서는 각 포맷의 필드(hwpx `hp:autoNum` · docx `PAGE` · odt `text:page-number`)가 센다.
머리말·꼬리말은 조판이 페이지마다 복제해 그리고 저장 직전 `unpaginate`가 걷어낸다 —
안 걷으면 저장물에 페이지 수만큼 중복된다.

hwpx의 각주·머리말·꼬리말·쪽번호 매핑도 **실물 한글 문서에서 확정**했다. 전체 쪽수만
`numType` 값을 못 봐서 강등 상태다(docx·odt로 저장하면 나온다).

**docx·odt는 LibreOffice로 열어 확인했다** — 개요 번호 `1. 가. 나. 2.`, 목록 번호 재시작,
각주 구분선, 머리말·꼬리말, 쪽번호 `1 / 1`, 셀 테두리·정렬이 전부 뷰어 화면과 같게 나온다.
한글(2018)로도 직접 열어 확인했다 — 아래 '골든 파일'을 본다.

**골든 파일 — 한글에게 직접 물어본 것들.** hwpx 규격이 애매한 자리는 추측하지 않고,
한글 COM 자동화로 **기능을 하나씩만 넣은 문서를 한글이 직접 저장하게 해서** 확정했다
(`samples/hwpx/golden/`, 대조는 `bun run golden-sim`). 이렇게 세 가지가 풀렸다.

- **하이퍼링크 강등 제거** — `hp:fieldBegin type="HYPERLINK"`의 파라미터 여섯 개를 확정했다.
  이제 hwpx도 주소를 지킨다(`Command`·`Path`에 그대로).
- **색은 `#RRGGBB`가 아니라 `#BBGGRR`다** — 한글에게 순수 빨강을 지정시켰더니
  `textColor="#0000FF"`로 저장했다. `.hwp` 바이너리의 COLORREF와 같은 순서인데 hwpx만
  RGB로 쓰고 있었다. 쓰기·읽기가 **둘 다** 틀려서 자체 왕복 검증으로는 안 잡히던 종류다.
- **각주 번호의 자리** — `hp:autoNum`은 각주 `subList` **안**, 첫 문단의 run에 있어야 한다.
  밖에 두면 한글이 번호를 아예 안 그린다(내용만 나온다).

'없음' 센티넬도 같이 바꿨다 — 한글 11+는 `none`으로 적지만 **한글 2018은 그걸 검정으로 읽어
본문이 새까맣게 칠해진다**. 두 버전 모두 읽는 옛 표기 `#FFFFFFFF`를 쓴다.

**실기기 검증**: 우리 리더끼리의 왕복 말고, 남이 만든 구현으로도 확인했다.

| 검증자 | docx | odt | hwpx |
|---|:--:|:--:|:--:|
| LibreOffice 26.2 (열어서 PDF 렌더) | ✓ | ✓ | — (LibreOffice에 한글 포맷 필터 없음) |
| pandoc 3.9 (독립 리더) | ✓ | ✓ | — |
| **Microsoft Word 2016** (열어서 조판 확인) | ✓ | — | — |
| [hwpxlib](https://github.com/neolord0/hwpxlib) (HWPX 레퍼런스 구현) | — | — | ✓ |
| **한글 2018** (열어서 조판 확인) | — | — | ✓ |

실문서(관공서 hwp 1,716문단·55표)를 docx·odt로 내보내 LibreOffice에서 정상 렌더까지 확인.
**한글(2018)로 직접 열어 조판까지 확인했다** — 개요 번호·목록·표(테두리·세로정렬·병합)·각주·머리말/꼬리말·쪽번호·문단 여백·첨자가 화면과 같다.
처음엔 한글 2018의 렌더러가 망가진 줄 알았는데 **오진이었다** — 아래 '골든 파일'이 원인을 갈랐다.

이 표는 **표·서식·그림까지의 기존 기능** 기준이다. v0.2에서 더한 링크·첨자·문단 여백은
아직 외부 구현으로 확인하지 못했다 — 지금 이 머신에 LibreOffice도 pandoc도 없다.
화면 쪽은 `bun run shots`로 실제 Chrome에 띄워 눈으로 확인한다.

**읽기(hwp·doc·hwpx·docx·odt → IR)** — 다섯 리더가 공통으로 채우는 것:

- 문단 텍스트 + 글자 스타일 (크기·색·굵기·기울임·밑줄, 폰트 패밀리)
- 문단 정렬 (양쪽/왼쪽/오른쪽/가운데) · **문단 여백**(들여쓰기·첫 줄·앞뒤)
- **위/아래첨자** · **하이퍼링크**(포맷별로 다름 — 아래 표)
- 표: 중첩 표, colspan/rowspan, 셀 크기(pt), 셀 배경색, 패딩
- 이미지 → data URI, 각주/미주
- 페이지 크기/여백 (모든 길이를 hwpunit 1/7200in으로 정규화)
- 결과물: standalone HTML (인라인 스타일, 외부 의존 없음)

리더별 새 어휘 상태:

| | hwp | doc | hwpx | docx | odt |
|---|:--:|:--:|:--:|:--:|:--:|
| 첨자 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 문단 여백 | ✓ | ◐ | ✓ | ✓ | ✓ |
| 하이퍼링크 | ✗ | ✗ | ✓ | ✓ | ✓ |

`.doc` 여백은 sprm 해석을 넣었지만 **테스트 코퍼스에 들여쓰기가 있는 문단이 없어
0x840F/0x8411이 실제로 발화하지 않았다** — 확인된 건 문단 뒤 여백뿐이라 ◐다
(`doc_paragraph_margins_are_sane`가 쓰레기 값만 막는다).
hwpx 하이퍼링크는 이제 읽기·쓰기 둘 다 된다 — `Command` 문법을 골든 파일로 확정했다.
`.hwp`·`.doc`의 하이퍼링크는 필드 구조라 아직 안 읽는다.

`.hwp`의 attr 비트는 **HWP CHAR_SHAPE 계약 그대로** 쓴다(원시 u32 통과). 첨자를 bit4/5에
두면 HWP의 **밑줄 모양(bit4-7)과 충돌**하므로 HWP가 정한 bit14/15를 쓴다.

포맷별로 다른 점:

- **단위 환산** — hwp/hwpx는 hwpunit, doc/docx는 twip(×5)과 EMU(÷127), odt는 CSS 길이 문자열(`2.54cm`).
- **본문 찾기** — 다른 넷은 본문이 한 덩어리지만 `.doc`은 **조각표(piece table)** 가
  "문자 위치 → 파일 오프셋" 목록을 들고 있고, 조각마다 cp1252 1바이트일 수도 UTF-16
  2바이트일 수도 있다. 이걸 이어 붙여야 본문이 나온다.
- **서식 해석** — hwp/hwpx는 ID로 미리 정의된 표를 참조하지만, docx/odt는 스타일 상속
  체인(`basedOn`/`parent-style-name`)을 풀어야 해서 리더가 해석한 뒤 CharShape로 인턴한다.
  docx는 "직접 지정 > 런 스타일 > 문단 스타일 > 기본 스타일 > docDefaults" 순.
- **세로 병합** — hwpx/odt는 셀이 span 개수를 직접 갖지만, docx는 `vMerge` restart/continue
  표시라서 리더가 continue 셀을 세어 rowSpan으로 접는다.
- **표 구조** — `.doc`은 표가 별도 구조가 아니라 **문단 속성**이다. 셀은 `0x07`로 끝나고
  행은 `sprmPFTtp`가 켜진 문단으로 끝난다. 행마다 열 구성이 달라서(가로 병합이
  "폭 넓은 셀"로 표현된다) 모든 행의 열 경계를 합쳐 공통 격자를 만든 뒤 colSpan으로 환산한다.
- **그림** — `.doc`은 본문에 앵커 문자만 두고 실제 바이트는 Office Drawing(Escher)에 있다.
  인라인 그림은 `0x01` → PICF → FBSE 안의 BLIP, 떠 있는 그림은 `0x08` → 도형 번호(spid)
  → 그림 번호(pib) → 저장소의 BLIP. 저장소가 바이트 대신 `foDelay`(다른 스트림의 위치)만
  갖고 있는 경우도 있어 WordDocument·Data 양쪽을 뒤진다. DIB는 BMP 헤더를 씌워 넘긴다.
- **글상자** — hwpx만 지원(drawText를 시각적 등가물인 1×1 표로 강등).

검증: hwpx 샘플 4종(재정경제부 보도자료)은 내장 미리보기 텍스트(`Preview/PrvText.txt`)
대비 본문 텍스트 100% 일치. docx/odt는 서식 값을 아는 최소 픽스처로 크기·색·굵기·정렬·
병합·배경을 단언하고, `.doc`은 Apache POI 테스트 코퍼스의 실문서로 글꼴·크기·색·표 병합을
검증한다(`rust/hwp-core/tests/office_test.rs`). 같은 문서를 `.doc`과 `.docx`로 저장한
`SampleDoc`은 두 리더가 **문자 수까지 같은 결과**를 낸다.

## 아직 안 되는 것

**남은 일과 순서는 [docs/TODO.md](docs/TODO.md)에 정리해 뒀다** — 다음에 무엇을,
어떤 순서로, 무엇이 선행 조건인지. 아래는 현재 시점의 제약 목록이다.

- `.hwp`·`.doc`의 하이퍼링크 읽기 (필드 구조 — 위 표 참조)
- 내어쓰기가 왼쪽 들여쓰기보다 큰 문단은 첫 줄이 본문 밖으로 나가므로 방출기가 잘라낸다
  (실문서에 `left=0`인데 `intent=-168pt`인 목록 문단이 있다 — 번호를 한글 엔진이 붙이는 경우)
- 도형 개체 (선/사각형 등 — 글상자 텍스트는 hwpx에서만 건짐)
- `.doc`의 구역 설정(A4 세로로 고정)·셀 배경 · 중첩 표는 한 겹으로 펼쳐진다
- `.doc`의 메타파일 그림(WMF·EMF) — deflate로 눌려 있고 브라우저가 못 그려서 자리표시로 강등
- `.doc`의 열 폭 — PAPX가 512바이트 FKP에 안 들어가면 잘려서 자동 폭으로 렌더된다
- docx의 다중 구역(sectPr) — 마지막 구역의 페이지 설정만 쓴다
- XML 중첩 256단 초과 문서는 거절한다 (파서가 스택을 넘겨 죽는 것을 막는 안전장치)
- `.hwp`·`.doc`로 내보내기 (OLE 바이너리 직렬화 — hwpx/docx로 저장 후 한글·Word에서 재저장으로 대체)

## 구조

```
docs/IR-SPEC.md       # Document IR 스펙 — 어휘·백엔드 매핑·검증 규칙 (계약의 진실원)
docs/TODO.md          # 남은 일과 순서 — 다음에 뭘 할지는 여기부터 본다
docs/GDOCS-FEATURES.md# 구글 문서 기능 전수 인벤토리 (기준선 분석)
rust/hwp-core/        # Rust 파서 크레이트 → 문서 모델 JSON (cdylib+rlib, wasm-pack)
  src/lib.rs          #   sniff_format(): 내용물로 포맷 판별 → 알맞은 리더로 분배
  src/parse.rs        #   .hwp — OLE + 바이너리 레코드
  src/doc.rs          #   .doc — OLE + 조각표/FKP (Word 97-2003)
  src/hwpx.rs         #   .hwpx — zip + OWPML
  src/docx.rs         #   .docx — zip + OOXML (스타일 체인 해석 + vMerge 접기)
  src/odt.rs          #   .odt — zip + ODF
  src/xml.rs          #   네임스페이스 무시 XML 헬퍼 (w:val·fo:font-size 대응)
  src/zipfs.rs        #   zip 컨테이너 공용 읽기
  src/intern.rs       #   서식 조합 → DocInfo 인덱스 인터너 (doc/docx/odt 공용)
src/lib/model.ts      # 문서 모델 계약 (Rust model.rs와 1:1 — 항상 함께 변경)
src/lib/parser-wasm.ts# WASM 파서 로더 (브라우저 url / CLI bytes 초기화)
src/lib/parser-js.ts  # hwp.js 폴백 — 같은 문서 모델로 정규화
src/lib/ir.ts         # 스펙의 실행 가능한 형태: IR_VERSION + validateIR() 린터
src/lib/narro.ts      # 방출기: 문서 모델 → IR HTML { body, standalone, stats }
src/lib/ir-model.ts   # IR HTML → 중립 문서 트리 (쓰기 백엔드 공용)
src/lib/html2hwpx.ts  # 쓰기: IR HTML → hwpx (템플릿+주입, fflate)
src/lib/html2docx.ts  # 쓰기: IR → docx (OOXML 패키지 생성)
src/lib/html2odt.ts   # 쓰기: IR → odt (ODF, 자동 스타일 수집)
src/lib/page-setup.ts # 페이지 설정 — doc-section의 용지·방향·여백 읽기/쓰기 (진실원은 mm 크기)
public/blank.hwpx     # hwpx 템플릿 (pypandoc-hwpx, MIT)
src/App.tsx           # 드롭존 → 미리보기(iframe srcDoc) / 소스 보기 / 복사·다운로드
scripts/convert.ts    # CLI — 같은 변환기를 bun에서 실행 (E2E 검증용)
scripts/validate.ts   # CLI — 변환 결과의 IR 계약 검증 (CI 게이트용)
scripts/tohwpx.ts     # CLI — hwp→IR→hwpx 왕복 + XML/텍스트/zip 규칙 검증
scripts/doc-core.ts   # IR HTML ↔ 문서 바이트 — CLI와 MCP 서버가 공유하는 코어 (경로·출력 없음)
scripts/export.ts     # CLI — 손으로 쓴 IR HTML → hwpx·docx·odt (린터 게이트 + 되읽기 대조)
scripts/matrix.ts     # CLI — SOT 한 장으로 전 포맷 쓰기·되읽기 대조 (변환 매트릭스)
scripts/page-setup-sim.ts # CLI — 페이지 설정 왕복 + 규격 밖 용지 처리 검증
scripts/vocab-sim.ts  # CLI — IR v0.2 어휘(링크·첨자·문단여백) 계약 + 쓰기 3종 검증
scripts/list-sim.ts   # CLI — 목록 numbering 계약 + 쓰기 3종 (정의 테이블·중첩·번호 재시작)
scripts/outline-sim.ts # CLI — 개요 번호 계약 + 스킴 진실원 일치(뷰어 CSS ↔ 백엔드 3종)
scripts/cell-sim.ts   # CLI — 표 셀 테두리·세로 정렬이 셀마다 3종에 도달하는지
scripts/footnote-sim.ts # CLI — 각주 내용 보존 + 번호 비저장 (쓰기 3종)
scripts/headerfooter-sim.ts # CLI — 머리말·꼬리말·쪽번호 (본문 밖 유지 + 조판 사본 걷기)
scripts/reread-sim.ts # CLI — 읽기 대칭 (IR → 파일 → 다시 IR, 세 포맷)
scripts/shots.ts      # CLI — 설치된 Chrome으로 편집기 화면 캡처 (눈으로 보는 검증)
scripts/mcp-sim.ts    # CLI — 진짜 MCP 클라이언트로 서버 왕복 (도구 5종 + 편집기 링크)
mcp/server.ts         # MCP(stdio) — narro_guide·write·read·open·viewer
mcp/viewer.ts         # 로컬 dev 서버 찾기/띄우기 + public/scratch 발행
docs/IR-AUTHORING.md  # 생성하는 쪽을 위한 IR 작성 설명서 (narro_guide가 그대로 돌려준다)
scripts/probe*.ts     # hwp.js 파싱 탐색용 스크립트
```
