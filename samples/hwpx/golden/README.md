# 골든 파일 — 한글이 직접 저장한 hwpx

여기 있는 파일은 **한글 2018(HOffice100)이 자기 손으로 저장한 것**이다. 우리가 만든 게 아니다.
COM 자동화(`HWPFrame.HwpObject`)로 기능을 하나씩만 넣고 `SaveAs(..., "HWPX")` 시켰다.

hwpx 매핑을 추측으로 채우지 않기 위한 근거다 — 규격 문서가 애매하거나 없는 자리에서
"한글은 실제로 이렇게 쓴다"를 보여준다. `bun run golden-sim`이 우리 출력이 이 파일들과
같은 어휘를 쓰는지 대조한다.

| 파일 | 넣은 것 | 여기서 확정한 것 |
|---|---|---|
| `golden-hyperlink.hwpx` | 글자 하나에 하이퍼링크 | `hp:fieldBegin type="HYPERLINK"`의 파라미터 여섯 개 — `Command`·`Path`에 주소를 그대로, `Category=HWPHYPERLINK_TYPE_HWP`, `TargetType=HWPHYPERLINK_TARGET_BOOKMARK`, `DocOpenType=HWPHYPERLINK_JUMP_CURRENTTAB` |
| `golden-footnote.hwpx` | 각주 하나 | 각주 번호(`hp:autoNum numType="FOOTNOTE"`)는 `hp:subList` **안**, 각주 첫 문단의 run에 있다. 밖에 두면 한글이 번호를 안 그린다 |
| `golden-color.hwpx` | 글자색을 `RGBColor(255,0,0)`(순수 빨강)으로 | **hwpx 색은 `#RRGGBB`가 아니라 `#BBGGRR`다** — 빨강이 `textColor="#0000FF"`로 저장된다. `.hwp` 바이너리의 COLORREF와 같은 순서. 또 "없음"을 `#FFFFFFFF`로 적는다(한글 11+는 `none`으로 적는데 한글 2018은 그걸 검정으로 읽는다) |

## 다시 만들려면

한글이 깔린 Windows에서 COM으로 만든다. 액션 ID는 파라미터셋 이름과 짝이 맞아야 찾아진다
(`HParameterSet`을 `Get-Member`로 훑고 `HAction.GetDefault(액션, 셋.HSet)`이 `True`를 주는 조합).
확인된 것: 하이퍼링크 = `InsertHyperlink` + `HHyperLink`, 각주 = `HAction.Run("InsertFootnote")`,
글자모양 = `CharShape` + `HCharShape`.

**주의**: `Hyperlink`(소문자 l) 같은 일부 액션은 대화상자를 띄워 스크립트가 멈춘다.
`GetDefault`로 먼저 확인하고 `Execute`가 `True`를 주는 것만 쓴다.
