#[test]
fn parses_hwpx_fixture() {
    let data = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/moef_press_release.hwpx"
    ))
    .expect("fixture 읽기 실패");

    let model = hwp_core::parse_hwpx_document(&data).expect("파싱 실패");

    assert_eq!(model.version, "hwpx-1.4");
    assert_eq!(model.sections.len(), 1);
    assert_eq!(model.info.char_shapes.len(), 25);
    assert_eq!(model.info.font_faces.len(), 6);
    assert_eq!(model.info.bin_data.len(), 5);

    // 페이지: A4 세로 (hwpunit, 1/7200in)
    let sec = &model.sections[0];
    assert_eq!(sec.width, 59528);
    assert_eq!(sec.height, 84188);
    assert!(sec.padding_left > 0 && sec.header_padding > 0);

    // 문단 여백: 이 실문서(재정경제부 보도자료)에는 내어쓰기 문단모양이 9개 있다.
    // (header.xml에는 hc:intent가 18번 나오지만 hp:switch/hp:default 두 갈래에 같은 값이
    //  두 번 적혀 있어서다 — 리더는 첫 갈래만 읽는다.)
    // 값이 음수라 부호를 흘리면 조용히 반대로 들여쓰기가 된다 — 그래서 부호까지 단언한다.
    let hanging: Vec<i32> = model
        .info
        .para_shapes
        .iter()
        .map(|p| p.first_line)
        .filter(|v| *v != 0)
        .collect();
    assert_eq!(hanging.len(), 9, "내어쓰기 문단모양 개수");
    assert!(
        hanging.iter().all(|v| *v < 0),
        "내어쓰기는 전부 음수여야 한다: {hanging:?}"
    );
    assert!(
        hanging.contains(&-16800),
        "가장 큰 내어쓰기(-16800 hwpunit = -168pt) 누락: {hanging:?}"
    );

    let json = serde_json::to_string(&model).unwrap();
    for text in ["2026년 세제개편안", "세제발전심의위원회", "보도시점"] {
        assert!(json.contains(text), "본문에 {text:?} 누락");
    }

    // 표: 셀이 borderFill 인덱스와 cellSz를 갖고 배치된다
    let table = model.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| &p.tables)
        .next()
        .expect("표가 있어야 함");
    assert!(table.row_count > 0 && table.col_count > 0);
    let cell = &table.rows[0][0];
    assert!(cell.width > 0);

    // 이미지: binData 인덱스가 실제 배열 범위를 가리킨다
    fn any_image(paras: &[hwp_core::Paragraph]) -> Option<&hwp_core::Image> {
        for p in paras {
            if let Some(img) = p.images.first() {
                return Some(img);
            }
            for t in &p.tables {
                for row in &t.rows {
                    for c in row {
                        if let Some(img) = any_image(&c.paragraphs) {
                            return Some(img);
                        }
                    }
                }
            }
        }
        None
    }
    let img = any_image(&model.sections[0].paragraphs).expect("이미지가 있어야 함");
    assert!((img.bin_data_id as usize) < model.info.bin_data.len());
    assert!(img.width > 0);
}

#[test]
fn auto_detects_format() {
    let hwpx = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/moef_press_release.hwpx"
    ))
    .unwrap();
    let hwp = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/BlogForm_BookReview.hwp"
    ))
    .unwrap();

    assert_eq!(
        hwp_core::parse_document_auto(&hwpx).unwrap().version,
        "hwpx-1.4"
    );
    assert_eq!(
        hwp_core::parse_document_auto(&hwp).unwrap().version,
        "5.0.4.0"
    );
    assert!(hwp_core::parse_document_auto(&[0u8; 64]).is_err());
}
