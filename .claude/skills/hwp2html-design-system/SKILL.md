---
name: hwp2html-design-system
description: >
  hwp2html 디자인 시스템 — 이 프로젝트의 모든 UI(앱바, 서식 툴바, 캔버스, 빈 상태, 버튼,
  입력, 배지 등)를 만들거나 고칠 때의 단일 진실원. DearDent EMR 디자인 시스템("고요한 정밀함
  / Quiet Precision, Linear-refined")을 이식한 것. 아이덴티티 키워드, Hard Laws, 색/타이포/
  간격 토큰, role→token 해석 레이어를 담는다. UI용 CSS를 쓰기 전에 반드시 먼저 읽는다.
---

# hwp2html Design System

**개념: 고요한 정밀함 / Quiet Precision, Linear-refined** — "UI가 아니라 문서를 보게 한다."
크롬은 뒤로 물러나고 문서 콘텐츠가 주인공. 조용함은 **타이포그래피로** 만들지,
무게(weight)나 박스로 만들지 않는다. (DearDent EMR DS에서 이식 — 원본:
`~/Desktop/programming/deardent/.claude/skills/deardent-design-system/SKILL.md`)

**적용 경계**: 이 시스템은 **앱 크롬**(앱바·툴바·캔버스·빈 상태·버튼)에만 적용한다.
`doc-section` 내부(변환된 문서 콘텐츠)는 **원본 충실도가 우선** — DS로 덮지 않는다.

모든 결정은 4개 키워드 중 하나에 봉사해야 한다. 아니면 임의적인 것 — 재고하라.
1. **Calm(차분함)** — 90% 무채색. 색은 의미가 있을 때만. flat 낮은 elevation. 화면당 primary 1개.
2. **Precision(정밀함)** — tabular numerals. 4px 그리드. 1px hairline 보더. 토큰만 사용, ad-hoc 값 금지.
3. **Legibility(명료함)** — 위계는 타이포(크기+자간+색)로, 박스/보더/**weight**로 하지 않는다. 상태는 색+모양 이중 인코딩.
4. **Swiftness(민첩함)** — 키보드 우선. 모션은 기능적일 때만 120–320ms ease-out. prefers-reduced-motion 존중.

## Hard Laws (코드리뷰 체크리스트로 사용)
1. 의미 있을 때만 색 사용 — 장식용 색/그라데이션 금지.
2. 화면당 primary 버튼 1개(이 앱에서는 **.hwpx 저장**); 나머지는 secondary/ghost.
3. 모든 색/간격은 토큰에서 — ad-hoc hex 금지.
4. 숫자(통계·크기·번호)는 **tabular figures** (`font-variant-numeric: tabular-nums`).
5. 모든 간격/크기는 **4px 그리드**.
6. 구분선/보더는 **1px hairline** — 컨트롤도 `line`(neutral-200). `line-strong`(neutral-300)은 진짜 강조된 인터랙티브 외곽선에만.
7. 위계는 **타이포(크기+자간+색)**로 — 보더/배경/weight가 아니라. 박스를 추가하기 전에 weight를 한 단계 내려 보라.
8. 상태는 **이중 인코딩**(색 + 점/아이콘 모양) — 색만으로 표현 금지.
9. 본문 폰트 하나: **Pretendard** (fallback: Apple SD Gothic Neo → 맑은 고딕).
10. 모션은 기능적일 때만, **120–320ms ease-out** `cubic-bezier(0.22,1,0.36,1)`.
11. 자주 쓰는 동작에 키보드 단축키 (⌘B/I/U/Z 등 편집기 표준 유지).

## Tokens (`src/index.css`의 CSS 변수가 구현체 — 이 문서와 항상 동기화)

### Brand — Linear Indigo (narro 로고와 동일 계열), 절제해서 사용
**PRIMARY ACTION = brand-600 `#5E6AD2`**, hover = brand-700 `#4F5ABF`.
크롬(툴바·탭·선택 상태)은 **무채색 유지** — 액센트는 진짜 CTA(.hwpx 저장), 포커스 링,
진짜 강조에만. `brand-50 #F4F5FC · 100 #E8EAF9 · 600 #5E6AD2 · 700 #4F5ABF`.

### Neutral — cool slate
`0 #FFFFFF · 50 #F8F9FB · 100 #F2F4F7 · 150 #ECEEF2 · 200 #E4E7EC · 300 #D0D5DD ·
400 #98A2B3 · 500 #667085 · 600 #475467 · 700 #344054 · 800 #1D2939 · 900 #101828`

### Semantic aliases (컴포넌트는 이것만 사용 — raw neutral-N 금지)
| alias | = primitive | 용도 |
|---|---|---|
| `bg` | neutral-100 | 캔버스(문서 뒤 배경) |
| `surface` | neutral-0 | 앱바/툴바/카드 표면 |
| `sunken` | neutral-100 | 함몰 영역 / 입력 트랙 |
| `ink` | neutral-900 | 주 텍스트 |
| `ink-soft` | neutral-600 | 보조 텍스트 |
| `ink-muted` | neutral-500 | 비활성/placeholder/메타 |
| `line` | neutral-200 | 구분선, 컨트롤 외곽선 |
| `line-strong` | neutral-300 | 강조된 인터랙티브 외곽선 |
| `primary` | brand-600 (hover 700) | primary 액션 전용 |

### Semantic state (각각 `-soft` 배경 틴트 보유)
`success #16A34A/#EAF7EF · warning #D97706/#FCF3E5 · danger #DC2626/#FDEDED · info #2563EB/#EBF2FE`

### Radius / Spacing / Elevation / Motion
- radius: xs=4 sm=6 **md=8(컨트롤)** **lg=12(컨테이너/플로팅)** pill=999
- spacing(4pt): 4,8,12,16,20,24,32,40,48,64
- elevation(soft): xs(카드) sm(버튼/입력) md(팝오버/메뉴/토스트) lg(다이얼로그+스크림 neutral-900 @40%)
- motion: ease-out `cubic-bezier(0.22,1,0.36,1)`, 120(fast)/200(base)/320(slow)ms
- focus ring = **3px brand-600 @32% alpha**

## Type system — named styles (크기/굵기 직접 지정 금지, 이름으로 선택)
| style | size/weight/lh | 용도 |
|---|---|---|
| display | 40/700/1.15 | 빈 상태 히어로 |
| title-1 | 30/700 | 화면 제목 |
| heading | 20/600 | 패널/섹션 제목 |
| subheading | 17/600 | 카드 제목 |
| body | 14/400/1.6 | 본문 |
| **ui** | 13/500/1.45 | 기본 UI 텍스트 (가장 많이 사용) |
| **ui-emph** | 13/600 | 클릭 가능한 텍스트: 링크/탭/메뉴 |
| label | 12/600 | 폼 라벨 |
| caption | 12/500 | 보조 캡션 |
| micro | 11/600 | 메타/타임스탬프/배지 |
| micro-caps | 11/700 +0.08em uppercase | eyebrow, 패널 헤더 라벨 |

색은 별개: named style + `ink`/`ink-soft`/`ink-muted` 조합.
**weight 규칙**: 버튼 라벨 = **500** · 인라인 클릭 텍스트(링크/탭) = 600 · 정적 UI = 500 · 본문 = 400.

## Role → Token (이 앱의 역할 매핑)
- **앱바/서식 툴바** = `surface` + 아래 1px `line`. 그림자 없음(flat). 높이: 앱바 48, 툴바 40.
- **컨트롤 높이**: 버튼/셀렉트 기본 **32**(h-8) / sm 28 · radius **md(8)** · 외곽선 `line` hairline · flat.
- **툴바 아이콘 버튼**: 28×28, ghost(테두리 없음), hover `sunken`, active `brand-50`+brand 텍스트. 아이콘 16px currentColor.
- **primary 버튼**(.hwpx 저장): brand-600 배경, 흰 텍스트, radius 8. 화면당 1개.
- **캔버스** = `bg`. 문서 페이지는 원본 스타일 그대로(경계는 페이지 그림자 sm).
- **빈 상태** = **flat, 박스 금지**(Law 7) — display/heading 타이포 + ink-muted 보조문 + 로고 아이콘 40px.
- **배지/칩**(편집됨 등) = pill, soft 배경 + 진한 동색 텍스트 + 6px 점(이중 인코딩).
- **원형/아이콘 크기**: 점 6 · 인라인 아이콘 16 · 마커 24–32 · 빈상태 아이콘 32–48 · 아이콘↔텍스트 간격 8.
- **에러 배너** = danger-soft 배경 + danger 텍스트 + md radius, elevation 없음.

## 브랜드 자산
- 앱 로고: `public/icons/narro-logo-*.png`, `narro_logo.svg` (narro 프로젝트에서 이식).
  로고 인디고가 brand-600과 동일 계열 — 로고 옆 워드마크는 ink, 무게 700, 자간 -0.02em.
- 파비콘: `/icons/narro-logo-32.png`.

## 적용 절차 (화면 통일할 때)
1. 각 요소의 역할 식별 → 위 Role→Token에서 토큰 찾기.
2. raw 색 → semantic alias로, raw 폰트 크기 → named style로 교체.
3. 숫자에 tabular nums, 상태에 이중 인코딩 추가.
4. Hard Laws 체크리스트로 검증.
