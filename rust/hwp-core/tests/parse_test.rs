#[test]
fn parses_fixture_document() {
    let data = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/BlogForm_BookReview.hwp"
    ))
    .expect("fixture 읽기 실패");

    let model = hwp_core::parse_document(&data).expect("파싱 실패");

    assert_eq!(model.version, "5.0.4.0");
    assert_eq!(model.sections.len(), 1);
    assert_eq!(model.info.char_shapes.len(), 10);
    assert_eq!(model.info.font_faces.len(), 14); // 2종 × 7개 언어 그룹

    // 본문: 최상위 문단 1개에 표 2개(4x1, 1x2), 중첩 표 7x2
    let paras = &model.sections[0].paragraphs;
    assert_eq!(paras.len(), 1);
    assert_eq!(paras[0].tables.len(), 2);
    assert_eq!(paras[0].tables[0].row_count, 4);

    let json = serde_json::to_string(&model).unwrap();
    for text in ["프롤로그", "지은이", "평점", "독서 시작 일자"] {
        assert!(json.contains(text), "본문에 {text:?} 누락");
    }

    // 안내문 스타일: 빨간 기울임 (hwp.js가 놓치던 charShape 전체-쌍 해석 검증)
    let red_italic = model
        .info
        .char_shapes
        .iter()
        .any(|cs| cs.color == [255, 0, 0] && cs.attr & 1 != 0);
    assert!(red_italic, "빨간 기울임 charShape가 있어야 함");
}

#[test]
fn rejects_non_hwp() {
    assert!(hwp_core::parse_document(&[0u8; 64]).is_err());
}

/// 제어문자가 본문 텍스트로 새어 나오면 안 된다.
/// XML에 그대로 실리면 결과 docx/odt/hwpx가 통째로 안 열린다
/// (실제로 .hwp의 "묶음 빈칸" 0x1F가 새어 나와 LibreOffice가 문서를 거부했다).
#[test]
fn no_control_chars_leak_into_text() {
    for name in [
        "BlogForm_BookReview.hwp",
        "sample_word97.doc",
        "word97_table_merges.doc",
        "moef_press_release.hwpx",
    ] {
        let data = std::fs::read(format!(
            "{}/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let model = hwp_core::parse_document_auto(&data).unwrap();

        fn walk(paras: &[hwp_core::Paragraph], name: &str) {
            for p in paras {
                for r in &p.runs {
                    for ch in r.text.chars() {
                        let c = ch as u32;
                        let allowed = c == 0x09 || c == 0x0A || c == 0x0D;
                        assert!(
                            c >= 0x20 || allowed,
                            "{name}: 제어문자 U+{c:04X}가 텍스트에 남음 — {:?}",
                            r.text.chars().take(40).collect::<String>()
                        );
                    }
                }
                for t in &p.tables {
                    for row in &t.rows {
                        for cell in row {
                            walk(&cell.paragraphs, name);
                        }
                    }
                }
                for fnote in &p.footnotes {
                    walk(&fnote.paragraphs, name);
                }
            }
        }
        for s in &model.sections {
            walk(&s.paragraphs, name);
        }
    }
}
