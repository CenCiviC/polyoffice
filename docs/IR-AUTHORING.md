# IR 작성 가이드 (생성하는 쪽을 위한 요약)

[IR-SPEC.md](IR-SPEC.md)가 **설계 문서**라면 이건 **작성 설명서**다. MCP 도구
`narro_guide`가 이 파일을 그대로 돌려준다. 문서를 새로 만들려면 이 어휘로 HTML을
쓴 다음 `narro_write`에 넘기면 된다 — hwpx·docx·odt가 나오고, 로컬 편집기 링크가 온다.

## 뼈대

```html
<doc-section class="hwp-page" data-ir="0.2.0"
  style="width:8.268in;min-height:11.693in;padding:1.000in 1.000in 1.000in 1.000in">
  <p><span style="font-size:10.5pt">본문 첫 문단.</span></p>
</doc-section>
```

- 루트는 **`doc-section` 하나**(여러 개면 여러 구역). `data-ir`은 루트에만.
- A4 세로 = `8.268in × 11.693in`. 가로면 두 값을 바꾼다. 여백은 `padding` 네 값(위 오른 아래 왼).
- `data-id`는 **안 붙여도 된다** — `p·h1~h6·li·table`에는 저장 직전 `b1`, `b2`… 가 자동 부여된다.
  이미 있는 문서를 고칠 때는 기존 `data-id`를 **바꾸지 말 것**(블록 주소가 바뀐다).

## 쓸 수 있는 요소

| 블록 | 쓰임 |
|---|---|
| `<p>` | 문단. 빈 문단(`<p></p>`)은 빈 줄 |
| `<h1>`–`<h6>` | 제목. `data-num="outline"`을 붙이면 `1. 가. 1) 가) (1) (가)`로 **번호가 자동으로 붙는다** — 번호를 직접 쓰지 말 것 |
| `<ul>` `<ol>` `<li>` | 목록. 중첩 가능(`li` 안에 `ul`/`ol`). 세 포맷 모두 진짜 목록으로 나가므로 **기호·번호를 직접 쓰지 말 것** |
| `<table>` `<tr>` `<td>` | 표. 중첩 가능. `td`에 `colspan`·`rowspan`, style로 `border`·`vertical-align`·`background` |
| `<doc-pagebreak>` | 강제 페이지 나눔 |
| `<doc-header>` `<doc-footer>` | 머리말·꼬리말. **`doc-section` 직계**로 두면 페이지마다 그려진다 |
| `<doc-field data-kind="page">` | 쪽번호. `pages`는 전체 쪽수(**hwpx에서는 안 나온다** — docx·odt만) |
| `<doc-footnote id="fn1">` | 각주 내용. 섹션 끝에 두고 본문에서 `<sup><a data-fn-ref="fn1"></a></sup>`로 가리킨다 — **`<a>`는 비워 둘 것**(번호는 자동) |

| 인라인 | 쓰임 |
|---|---|
| `<span style="…">` | 글자 스타일. 스타일 없는 맨 텍스트도 허용 |
| `<br>` | 문단 안 줄바꿈 |
| `<sup>` `<sub>` | 위·아래첨자 |
| `<a href="…">` | 링크. `https:`·`mailto:`·문서 내 `#b7`만. **hwpx에서는 주소가 버려지고 글자만 남는다** — 주소가 중요하면 docx·odt로 |
| `<img src="data:image/png;base64,…" style="width:200pt">` | 그림. data URI만 |

**이 목록에 없는 요소는 계약 위반**이라 저장이 거부된다 (`<div>`, `<b>`, `<strong>`은
자동으로 `<p>`·`<span>`으로 고쳐지니 써도 되지만, 처음부터 IR로 쓰는 편이 낫다).

## 쓸 수 있는 style 속성

`font-size`(pt) · `color`(rgb 또는 #hex) · `font-family` · `font-weight`(bold) ·
`font-style`(italic) · `text-decoration`(underline·line-through) · `text-align`
(left·center·right·justify) · `line-height`(배수) · `background`(형광펜·셀 배경) ·
`width` `height` `min-height` `padding` · `border`(td — `2pt dashed #c2352b` 또는 `none`) ·
`vertical-align`(td — top·middle·bottom) · `margin-left`(들여쓰기) ·
`text-indent`(첫 줄, **음수면 내어쓰기**) · `margin-top` `margin-bottom`(문단 앞뒤)

목록 밖 속성은 **조용히 버려진다**. 그림자·테두리·둥근 모서리 같은 건 문서 포맷에
갈 곳이 없어서 애초에 어휘에 없다.

## 관례

- 본문 `10.5pt`, 줄간격 `1.6`이 한글 문서 기본값에 가깝다. `font-family`를 생략하면
  문서 기본 글꼴(Noto Sans KR)이 쓰이고, **쓴 글자만 서브셋해서 파일에 심긴다**
  (받는 사람 컴퓨터에 글꼴이 없어도 같게 보인다).
- 문단 여백은 `margin-top`/`margin-bottom`(pt)으로. 빈 `<p>`를 여러 개 쌓지 말 것.
- 목록 항목에 `1.`·`•`를 직접 쓰지 말 것 — 번호와 기호는 저장할 때 붙는다. 들여쓰기도
  수준마다 알아서 잡히니 `margin-left`를 줄 필요가 없다.
- 제목 번호도 마찬가지다. `<h2>2. 세부 일정</h2>`이 아니라
  `<h2 data-num="outline">세부 일정</h2>` — 번호는 문서 전체에서 자동으로 매겨진다.
  번호를 원하지 않는 제목(표지·부칙 등)은 `data-num`을 빼면 된다.
- 색은 `rgb(94, 106, 210)`·`#5e6ad2` 둘 다 된다.
- 표 헤더 행은 `<td style="background:#f1f3f5"><span style="font-weight:bold">` 식으로.
  `<th>`는 어휘에 없다.

## 예시 — 공문서 한 장

```html
<doc-section class="hwp-page" data-ir="0.2.0"
  style="width:8.268in;min-height:11.693in;padding:1.000in 1.000in 1.000in 1.000in">

  <doc-footer><p style="text-align:center">
    <span style="font-size:9.0pt">- <doc-field data-kind="page"></doc-field> -</span>
  </p></doc-footer>

  <p style="text-align:center;margin-bottom:18pt">
    <span style="font-size:20.0pt;font-weight:bold">2026년 사업 추진 계획</span>
  </p>

  <h2 data-num="outline"><span style="font-size:14.0pt;font-weight:bold;color:rgb(94, 106, 210)">추진 배경</span></h2>
  <p style="line-height:1.6;text-indent:11pt">
    <span style="font-size:10.5pt">지난해 시범 운영 결과를 반영하여 </span>
    <span style="font-size:10.5pt;font-weight:bold">전 부서로 확대</span>
    <span style="font-size:10.5pt">한다.</span>
  </p>

  <h2 data-num="outline"><span style="font-size:14.0pt;font-weight:bold;color:rgb(94, 106, 210)">세부 일정</span></h2>
  <table style="width:100%">
    <tr>
      <td style="width:30%;background:#f1f3f5;padding:6pt"><span style="font-weight:bold">단계</span></td>
      <td style="background:#f1f3f5;padding:6pt"><span style="font-weight:bold">기간</span></td>
    </tr>
    <tr>
      <td style="padding:6pt"><span style="font-size:10.5pt">준비</span></td>
      <td style="padding:6pt"><span style="font-size:10.5pt">1~2월</span></td>
    </tr>
  </table>

  <h2 data-num="outline"><span style="font-size:14.0pt;font-weight:bold;color:rgb(94, 106, 210)">준비 사항</span></h2>
  <ol>
    <li><span style="font-size:10.5pt">부서별 담당자 지정</span>
      <ul>
        <li><span style="font-size:10.5pt">지정 결과는 총무과로 회신</span></li>
      </ul>
    </li>
    <li><span style="font-size:10.5pt">기존 양식 회수</span></li>
  </ol>

  <p style="margin-top:18pt">
    <span style="font-size:10.5pt">자세한 내용은 </span>
    <a href="https://example.go.kr/notice"><span style="font-size:10.5pt">공지사항</span></a>
    <span style="font-size:10.5pt">을 참고한다.</span>
  </p>
</doc-section>
```

## 아직 안 되는 것

단 나누기 ·
목차 · 수식 · 도형/글상자 · 명명 스타일(제목1 정의). 남은 순서는
[TODO.md](TODO.md)에 있다.

## 기존 문서 고치기

`narro_read`가 `.hwp`·`.doc`·`.hwpx`·`.docx`·`.odt`를 이 어휘의 HTML로 돌려준다.
받은 HTML에서 **고칠 블록만 바꿔** 다시 `narro_write`에 넘기면 된다. `data-id`는
그대로 두는 게 원칙이다.
