# polyoffice-mcp

한글(`.hwp`/`.hwpx`)·Word(`.doc`/`.docx`)·오픈오피스(`.odt`) 문서를 **읽고, 고치고, 쓰는** MCP 서버.

문서는 이 컴퓨터에서만 처리된다 — 어디로도 올라가지 않는다.

```bash
claude mcp add polyoffice -- npx -y polyoffice-mcp
```

Claude Desktop·Cursor 등은 설정에 이렇게 넣는다:

```json
{
  "mcpServers": {
    "polyoffice": { "command": "npx", "args": ["-y", "polyoffice-mcp"] }
  }
}
```

**Node 20+ 하나면 된다.** 파서(WebAssembly)·글꼴·편집기를 전부 동봉하고 런타임 의존성이 없다.
한글이나 Word가 깔려 있을 필요도 없다.

## 도구

| 도구 | 하는 일 |
|---|---|
| `polyoffice_guide` | 문서를 쓸 때 쓰는 IR 어휘 설명서. **문서를 만들기 전에 먼저 부른다** |
| `polyoffice_write` | IR HTML 한 장 → `.hwpx`·`.docx`·`.odt` + 편집기 링크 |
| `polyoffice_read` | 기존 문서 → IR HTML. 고쳐서 다시 `polyoffice_write`에 넣으면 편집이 된다 |
| `polyoffice_open` | 문서를 편집기로 열고, 사람이 고친 결과를 **원본이 있던 폴더로 되쓴다** |
| `polyoffice_viewer` | 편집기 서버 상태·시작·정지 |

## 포맷

| | `.hwp` | `.doc` | `.hwpx` | `.docx` | `.odt` |
|---|:--:|:--:|:--:|:--:|:--:|
| 읽기 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 쓰기 | ✗ | ✗ | ✓ | ✓ | ✓ |

`.hwp`와 `.doc`은 OLE 바이너리 직렬화라 읽기만 된다 — 열어서 고친 뒤 `.hwpx`나 `.docx`로
저장된다. 읽기 5 × 쓰기 3이 모두 조합되므로 `doc → odt`, `hwp → docx` 같은 변환이 성립한다.

지원: 문단·제목(개요 자동 번호)·목록·표(병합·셀 테두리·배경)·그림·각주·머리말/꼬리말·
쪽번호·하이퍼링크·글자 서식. 쓴 글자만 서브셋한 글꼴이 파일에 심기므로 받는 사람 컴퓨터에
글꼴이 없어도 같게 보인다.

## 사람이 직접 고치기

`polyoffice_open`은 로컬 편집기를 띄우고 **저장 토큰이 실린 링크**를 돌려준다.
사람이 브라우저에서 고치고 저장하면 원본이 있던 폴더에 떨어진다.

문서 내용이 대화로 오가지 않는 게 요점이다 — `polyoffice_read`는 문서 전체를 컨텍스트로
가져오지만, 사람이 손으로 고칠 것이면 `polyoffice_open`이 맞다.

## 만든 문서가 어디 있나

`~/.polyoffice/scratch/` 에 놓인다. `polyoffice_write`의 `out_dir`로 다른 곳을 지정할 수 있다.

---

소스·이슈: <https://github.com/CenCiviC/polyoffice> · Apache-2.0

`.hwp` 레코드 해독은 [hwp.js](https://github.com/hahnlee/hwp.js)(Apache-2.0, Han Lee)를 참고해 이식했다.
번들 글꼴 Noto Sans KR은 SIL OFL 1.1 (© 2014-2021 Adobe).
