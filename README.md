# hwp→html

한글(.hwp 5.x) 문서를 **브라우저 안에서** HTML로 변환하는 실험. 파일이 서버로 올라가지 않고
전부 클라이언트에서 파싱된다.

**파서는 자체 Rust 크레이트(`rust/hwp-core`) → WASM이 기본**이고, 실패 시
[hwp.js](https://github.com/hahnlee/hwp.js)(Apache-2.0)로 폴백한다. 두 파서는 같은
문서 모델 JSON 계약(`src/lib/model.ts` ↔ `rust/hwp-core/src/model.rs`)을 채우며,
`bun run compare`가 구조 동일성을 회귀 검증한다. Rust 파서는 hwp.js가 PARA_CHAR_SHAPE의
첫 쌍만 읽는 버그를 고쳐 run 스타일 충실도가 더 높다 (예: 양식 안내문의 빨간 기울임 보존).

"Word/한글 문서의 중간통로를 HTML로 만들 수 있는가"라는 가설 검증:
**hwp → html (읽기)** ✓ · **브라우저 편집** ✓ · **html → hwpx (쓰기)** ✓ — 사이클 완성.

**편집**: 미리보기의 모든 문단이 contentEditable — 클릭해서 바로 수정. 편집 결과는
`normalizeIR()`(편집기가 만든 div→p, 편집 속성 제거, 새 블록 data-id 부여)를 거쳐
.html/.hwpx 저장에 반영된다. `bun run edit-sim`이 이 경로를 헤드리스로 검증한다.

변환 결과물은 임의 HTML이 아니라 **Document IR**(HTML 기반 중간언어, [docs/IR-SPEC.md](docs/IR-SPEC.md))
계약을 따른다. LLM 생성·편집기·백엔드(hwpx/docx)가 전부 이 어휘로 수렴하는 컴파일러 구조.

## 디자인 시스템

UI 크롬은 **hwp2html Design System**("고요한 정밀함 / Quiet Precision, Linear-refined" —
DearDent EMR DS 이식)을 따른다. **UI를 만들거나 고치기 전에
`.claude/skills/hwp2html-design-system/SKILL.md`를 먼저 읽을 것.** 토큰 구현체는
`src/index.css`(3-tier: primitives → semantic aliases → components), 브랜드 자산은
`public/icons/`(narro 로고). 변환된 문서 콘텐츠(doc-section 내부)는 DS 적용 대상이 아니다
— 원본 충실도 우선.

## 실행

```bash
bun install
bun run dev            # http://localhost:5173 — .hwp 드래그&드롭
bun run build          # 프로덕션 번들 (dist/)

# CLI 변환 (브라우저와 동일한 코드 경로)
bun run convert <input.hwp> [output.html]
bun run validate <input.hwp>   # 변환 결과가 IR 계약을 지키는지 검사
bun run tohwpx <input.hwp> [output.hwpx]   # hwp → IR → hwpx 왕복 E2E + 검증
bun run compare <input.hwp>    # Rust WASM vs hwp.js 파서 골든 비교
bun run wasm:build             # Rust 파서 재빌드 (rust/hwp-core 수정 후)
cd rust/hwp-core && cargo test # Rust 파서 유닛/통합 테스트
```

## 현재 지원 범위

**쓰기(IR → hwpx)**: `src/lib/html2hwpx.ts` — 템플릿+주입 방식. `public/blank.hwpx`
([pypandoc-hwpx](https://github.com/msjang/pypandoc-hwpx), MIT)를 템플릿으로 section0.xml
본문을 생성해 교체하고 header.xml에 charPr/paraPr/borderFill만 추가 등록한다.
문단·글자스타일(크기/색/굵기/기울임/밑줄)·정렬·중첩 표·셀 병합/크기/배경 지원.
브라우저에서는 ".hwpx 다운로드" 버튼. **한글/한컴독스에서 여는 실기기 검증은 아직 안 됨.**

**읽기(hwp → IR)**:

- 문단 텍스트 + 글자 스타일 (크기·색·굵기·기울임·밑줄, 폰트 패밀리)
- 문단 정렬 (양쪽/왼쪽/오른쪽/가운데)
- 표: 중첩 표, colspan/rowspan, 셀 크기(pt), 셀 배경색, 패딩
- 페이지 크기/여백 (hwpunit 1/7200in → in 변환)
- 결과물: standalone HTML (인라인 스타일, 외부 의존 없음)

## 아직 안 되는 것

- 이미지(BinData) — hwp.js 모델에는 있으므로 다음 단계로 추출 가능
- hwpx (zip/XML 포맷 — 별도 파서 경로 필요, 오히려 더 쉬움)
- 각주/미주, 머리말/꼬리말, 개요 번호, 글머리표
- 도형/글상자 등 개체

## 구조

```
docs/IR-SPEC.md       # Document IR 스펙 — 어휘·백엔드 매핑·검증 규칙 (계약의 진실원)
rust/hwp-core/        # Rust 파서 크레이트: .hwp → 문서 모델 JSON (cdylib+rlib, wasm-pack)
src/lib/model.ts      # 문서 모델 계약 (Rust model.rs와 1:1 — 항상 함께 변경)
src/lib/parser-wasm.ts# WASM 파서 로더 (브라우저 url / CLI bytes 초기화)
src/lib/parser-js.ts  # hwp.js 폴백 — 같은 문서 모델로 정규화
src/lib/ir.ts         # 스펙의 실행 가능한 형태: IR_VERSION + validateIR() 린터
src/lib/hwp2html.ts   # 방출기: 문서 모델 → IR HTML { body, standalone, stats }
src/lib/html2hwpx.ts  # 쓰기: IR HTML → hwpx (템플릿+주입, fflate)
public/blank.hwpx     # hwpx 템플릿 (pypandoc-hwpx, MIT)
src/App.tsx           # 드롭존 → 미리보기(iframe srcDoc) / 소스 보기 / 복사·다운로드
scripts/convert.ts    # CLI — 같은 변환기를 bun에서 실행 (E2E 검증용)
scripts/validate.ts   # CLI — 변환 결과의 IR 계약 검증 (CI 게이트용)
scripts/tohwpx.ts     # CLI — hwp→IR→hwpx 왕복 + XML/텍스트/zip 규칙 검증
scripts/probe*.ts     # hwp.js 파싱 탐색용 스크립트
```
