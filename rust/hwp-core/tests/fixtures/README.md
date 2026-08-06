# 테스트 픽스처 출처

파서 회귀 테스트가 쓰는 문서들. 값을 알고 있어야 단언할 수 있으므로,
직접 만든 것과 남의 코퍼스에서 가져온 것을 구분해 둔다.

| 파일 | 출처 | 라이선스 | 무엇을 잡는가 |
|---|---|---|---|
| `BlogForm_BookReview.hwp` | 프로젝트 자체 | — | .hwp 레코드·중첩 표·빨간 기울임 글자모양 |
| `moef_press_release.hwpx` | 재정경제부 보도자료 (공개 자료) | 공공누리 | hwpx 구역·표 병합·이미지·페이지 설정 |
| `sample_word97.doc` | [Apache POI](https://github.com/apache/poi) `test-data/document/SampleDoc.doc` | Apache-2.0 | .doc 조각표·글꼴 이름표·크기/색 |
| `word97_table_merges.doc` | Apache POI `test-data/document/table-merges.doc` | Apache-2.0 | .doc 표에서 열 경계 격자 → colSpan 환산 |
| `word97_pictures.doc` | Apache POI `test-data/document/pictures_escher.doc` | Apache-2.0 | .doc 떠 있는 도형 → Escher BLIP 추출 |
| `sample.docx` · `sample.odt` | 이 저장소에서 생성 | — | docx/odt 스타일 상속·병합·셀 배경 |

`sample.docx`·`sample.odt`는 손으로 값을 정해 만든 최소 문서다. 재생성:

```bash
python3 scripts/make-office-fixtures.py rust/hwp-core/tests/fixtures
```

Apache POI 코퍼스에서 가져온 세 파일은 Apache License 2.0 아래 배포된다
(원본 저작권: The Apache Software Foundation).
