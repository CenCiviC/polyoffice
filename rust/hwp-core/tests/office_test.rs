//! docx·odt 리더 회귀 테스트.
//! 픽스처는 서식 값을 알고 만든 문서라 숫자를 그대로 단언할 수 있다.
//! 재생성: `python3 scripts/make-office-fixtures.py rust/hwp-core/tests/fixtures`
//! 담긴 것: A4, 스타일 체인으로 상속한 가운데 14pt, 빨강 굵게 12pt, 기울임+밑줄,
//! 2칸 가로 병합 + 배경 #D9E2F3, 2행 세로 병합.

use hwp_core::{DocModel, Format};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap_or_else(|e| panic!("{name} 읽기 실패: {e}"))
}

/// 문서 전체 텍스트 (표 셀 포함)
fn all_text(model: &DocModel) -> String {
    fn walk(paras: &[hwp_core::Paragraph], out: &mut String) {
        for p in paras {
            for r in &p.runs {
                out.push_str(&r.text);
            }
            for t in &p.tables {
                for row in &t.rows {
                    for c in row {
                        walk(&c.paragraphs, out);
                    }
                }
            }
            out.push('\n');
        }
    }
    let mut out = String::new();
    for s in &model.sections {
        walk(&s.paragraphs, &mut out);
    }
    out
}

/// 두 리더가 같은 내용의 문서에서 같은 결론에 도달하는지 본다.
fn assert_common_shape(model: &DocModel, label: &str) {
    // A4 세로 (오차 몇 hwpunit은 단위 환산 반올림)
    let sec = &model.sections[0];
    assert!(
        (sec.width as i64 - 59528).abs() < 20,
        "{label}: 페이지 폭이 A4가 아님 ({})",
        sec.width
    );
    assert!(
        (sec.height as i64 - 84188).abs() < 20,
        "{label}: 페이지 높이"
    );
    assert!(sec.padding_left > 0 && sec.padding_top > 0, "{label}: 여백");

    let text = all_text(model);
    for want in [
        "상속받은 14pt 가운데",
        "빨간 굵게 12pt",
        "기울임밑줄",
        "탭 뒤",
        "두 칸 병합 머리글",
        "세로 병합",
        "오른쪽 아래",
    ] {
        assert!(text.contains(want), "{label}: {want:?} 누락\n{text}");
    }
    // 줄바꿈·탭이 문자로 보존된다
    assert!(text.contains("\n\t탭 뒤"), "{label}: 줄바꿈/탭 보존 실패");

    // 첫 문단: 스타일 체인으로 받은 14pt + 가운데 정렬
    let first = &model.sections[0].paragraphs[0];
    assert_eq!(
        model.info.para_shapes[first.shape_index as usize].align, 3,
        "{label}: 가운데 정렬"
    );
    let cs = &model.info.char_shapes[first.runs[0].char_shape_id as usize];
    assert_eq!(cs.base_size, 1400, "{label}: 상속받은 글자 크기");
    assert_eq!(
        model
            .info
            .font_faces
            .get(cs.font_id as usize)
            .map(|s| s.as_str()),
        Some("맑은 고딕"),
        "{label}: 상속받은 글꼴"
    );

    // 둘째 문단: 빨강+굵게, 그리고 기울임+밑줄
    let second = &model.sections[0].paragraphs[1];
    let red = &model.info.char_shapes[second.runs[0].char_shape_id as usize];
    assert_eq!(red.color, [192, 0, 0], "{label}: 글자색");
    assert_eq!(red.base_size, 1200, "{label}: 직접 지정 크기");
    assert_eq!(red.attr & 0b10, 0b10, "{label}: 굵게 비트");
    let em = &model.info.char_shapes[second.runs[1].char_shape_id as usize];
    assert_eq!(em.attr & 0b01, 0b01, "{label}: 기울임 비트");
    assert_eq!((em.attr >> 2) & 0b11, 1, "{label}: 밑줄 비트");

    // 표: 3행 2열, 가로 병합 + 배경, 세로 병합
    let table = model.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| &p.tables)
        .next()
        .unwrap_or_else(|| panic!("{label}: 표 없음"));
    assert_eq!(table.row_count, 3, "{label}: 행 수");
    assert_eq!(table.col_count, 2, "{label}: 열 수");

    let header = &table.rows[0][0];
    assert_eq!(header.col_span, 2, "{label}: 가로 병합");
    let fill = header
        .border_fill_id
        .and_then(|id| model.info.border_fills.get(id as usize))
        .and_then(|b| b.background_color);
    assert_eq!(fill, Some([217, 226, 243]), "{label}: 셀 배경색");
    assert_eq!(header.width, 28800, "{label}: 병합 셀 폭(두 열 합)");

    let merged = &table.rows[1][0];
    assert_eq!(merged.row_span, 2, "{label}: 세로 병합");
    // 세로 병합에 먹힌 자리는 셀을 만들지 않는다 — 마지막 행은 오른쪽 한 칸뿐
    assert_eq!(table.rows[2].len(), 1, "{label}: 병합에 먹힌 셀 제거");
}

#[test]
fn parses_docx() {
    let model = hwp_core::parse_docx_document(&fixture("sample.docx")).expect("docx 파싱 실패");
    assert_eq!(model.version, "docx");
    assert_common_shape(&model, "docx");
    assert_inline_vocab(&model, "docx");

    // 문서 내 앵커는 #이름으로 온다 (외부 관계가 아니라 w:anchor)
    let anchor = model.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| p.runs.iter())
        .find(|r| r.text.contains("앵커링크"))
        .expect("앵커링크 런 없음");
    assert_eq!(anchor.link.as_deref(), Some("#b7"));
}

#[test]
fn parses_odt() {
    let model = hwp_core::parse_odt_document(&fixture("sample.odt")).expect("odt 파싱 실패");
    assert_eq!(model.version, "odt");
    assert_common_shape(&model, "odt");
    assert_inline_vocab(&model, "odt");
}

/// docx·odt가 같은 값을 내야 하는 것: 링크·첨자·문단 여백.
/// 픽스처는 서식 값을 우리가 정한 것이라 숫자를 그대로 단언할 수 있다
/// (들여쓰기 20pt=2000hwpunit · 첫 줄 13pt=1300 · 내어쓰기 -15pt=-1500 · 앞 5pt=500 · 뒤 3pt=300).
fn assert_inline_vocab(model: &hwp_core::DocModel, who: &str) {
    let runs: Vec<&hwp_core::Run> = model.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| p.runs.iter())
        .collect();

    // 하이퍼링크 — 주소가 런에 붙어야 한다
    let linked = runs
        .iter()
        .find(|r| r.text.contains("링크된글자"))
        .unwrap_or_else(|| panic!("{who}: '링크된글자' 런 없음"));
    assert_eq!(
        linked.link.as_deref(),
        Some("https://www.mois.go.kr/manual"),
        "{who}: 링크 주소"
    );

    // 링크 없는 런과 합쳐지면 안 된다
    assert_eq!(linked.text, "링크된글자", "{who}: 링크 경계가 뭉개졌다");
    let plain = runs
        .iter()
        .find(|r| r.text.contains("보통글자"))
        .unwrap_or_else(|| panic!("{who}: '보통글자' 런 없음"));
    assert_eq!(plain.link, None, "{who}: 링크 아닌 런에 주소가 붙었다");

    // 위/아래첨자 — CharShape.attr 비트
    let attr_of = |r: &hwp_core::Run| model.info.char_shapes[r.char_shape_id as usize].attr;
    let supers: Vec<_> = runs.iter().filter(|r| attr_of(r) & hwp_core::ATTR_SUPER != 0).collect();
    let subs: Vec<_> = runs.iter().filter(|r| attr_of(r) & hwp_core::ATTR_SUB != 0).collect();
    assert_eq!(supers.len(), 1, "{who}: 위첨자 런 개수");
    assert_eq!(subs.len(), 1, "{who}: 아래첨자 런 개수");
    assert_eq!(supers[0].text, "2", "{who}: 위첨자 내용");
    assert_eq!(subs[0].text, "2", "{who}: 아래첨자 내용");

    // 문단 여백 — 들여쓰기 문단과 내어쓰기 문단
    let shapes = &model.info.para_shapes;
    let shape_of = |needle: &str| {
        let p = model.sections[0]
            .paragraphs
            .iter()
            .find(|p| p.runs.iter().any(|r| r.text.contains(needle)))
            .unwrap_or_else(|| panic!("{who}: {needle:?} 문단 없음"));
        &shapes[p.shape_index as usize]
    };
    let indented = shape_of("링크된글자");
    assert_eq!(indented.indent, 2000, "{who}: 왼쪽 들여쓰기");
    assert_eq!(indented.first_line, 1300, "{who}: 첫 줄 들여쓰기");
    assert_eq!(indented.space_before, 500, "{who}: 문단 앞 여백");
    assert_eq!(indented.space_after, 300, "{who}: 문단 뒤 여백");

    let hanging = shape_of("면적 1,200m");
    assert_eq!(hanging.indent, 3000, "{who}: 내어쓰기 문단 왼쪽");
    assert_eq!(
        hanging.first_line, -1500,
        "{who}: 내어쓰기는 first_line 음수 (부호가 뒤집히면 안 된다)"
    );
}

/// Word 97 실문서(Apache POI 테스트 코퍼스). 조각표·CHPX·PAPX가 다 걸린다.
#[test]
fn parses_doc_word97() {
    let model = hwp_core::parse_doc_document(&fixture("sample_word97.doc")).expect("doc 파싱 실패");
    assert!(model.version.starts_with("doc-"), "{}", model.version);

    let text = all_text(&model);
    for want in [
        "I am a test document",
        "This is page 1",
        "Arial Black in 16 point",
    ] {
        assert!(text.contains(want), "{want:?} 누락\n{text}");
    }

    // "Arial Black in 16 point ... also in blue" — 글꼴·크기·색이 실제로 붙어야 한다
    assert!(
        model.info.font_faces.iter().any(|f| f == "Arial Black"),
        "글꼴 이름표 해석 실패: {:?}",
        model.info.font_faces
    );
    assert!(
        model.info.char_shapes.iter().any(|c| c.base_size == 1600),
        "16pt 글자모양 없음"
    );
    assert!(
        model
            .info
            .char_shapes
            .iter()
            .any(|c| c.color[2] > c.color[0]),
        "파란 글자색 없음"
    );
}

/// 가로 병합이 "폭 넓은 셀"로 표현된 표 — 열 경계를 합쳐 colSpan으로 환산해야 칸이 맞는다.
#[test]
fn doc_table_merges_become_colspan() {
    let model =
        hwp_core::parse_doc_document(&fixture("word97_table_merges.doc")).expect("doc 파싱 실패");
    let table = model.sections[0]
        .paragraphs
        .iter()
        .flat_map(|p| &p.tables)
        .next()
        .expect("표 없음");

    // 행마다 셀 수가 달라도 열 격자는 하나로 모인다
    assert!(table.col_count >= 4, "열 격자 {}", table.col_count);
    let spanning = table
        .rows
        .iter()
        .flatten()
        .filter(|c| c.col_span > 1)
        .count();
    assert!(spanning >= 2, "가로 병합이 colSpan으로 환산되지 않음");

    // 각 행이 덮는 칸 수의 합은 열 개수를 넘지 않는다 (격자 밖으로 새지 않음)
    for (ri, row) in table.rows.iter().enumerate() {
        let covered: u16 = row.iter().map(|c| c.col_span).sum();
        assert!(
            covered <= table.col_count,
            "{ri}행이 격자를 넘음 ({covered} > {})",
            table.col_count
        );
    }
}

#[test]
fn sniffs_every_container() {
    let cases = [
        ("sample.docx", Format::Docx),
        ("sample.odt", Format::Odt),
        ("sample_word97.doc", Format::Doc),
        ("moef_press_release.hwpx", Format::Hwpx),
        ("BlogForm_BookReview.hwp", Format::Hwp),
    ];
    for (name, want) in cases {
        let data = fixture(name);
        assert_eq!(hwp_core::sniff_format(&data).unwrap(), want, "{name} 판별");
        // 자동 경로로도 같은 문서가 나온다
        assert!(
            !hwp_core::parse_document_auto(&data)
                .unwrap()
                .sections
                .is_empty(),
            "{name} 자동 파싱"
        );
    }
    assert!(
        hwp_core::sniff_format(&[0u8; 64]).is_err(),
        "쓰레기 입력 거부"
    );
}

/// zip이지만 우리가 아는 표지 파일이 없으면 명확히 거절한다 (조용히 빈 문서를 만들지 않는다)
#[test]
fn rejects_unknown_zip() {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        use std::io::Write as _;
        zip.start_file("hello.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"not a document").unwrap();
        zip.finish().unwrap();
    }
    assert!(hwp_core::sniff_format(&buf).is_err());
}

/// 중첩이 지나치게 깊은 문서는 **크래시 대신 오류**로 끝나야 한다.
/// roxmltree가 파싱 도중 스택을 넘기면 WASM에서는 앱 전체가 내려간다.
#[test]
fn deep_nesting_errors_instead_of_crashing() {
    let mut xml = String::from(
        r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
    );
    for _ in 0..2000 {
        xml.push_str("<w:tbl><w:tr><w:tc>");
    }
    xml.push_str("<w:p><w:r><w:t>deep</w:t></w:r></w:p>");
    for _ in 0..2000 {
        xml.push_str("</w:tc></w:tr></w:tbl>");
    }
    xml.push_str("</w:body></w:document>");

    let mut buf = Vec::new();
    {
        use std::io::Write as _;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("word/document.xml", opts).unwrap();
        zip.write_all(xml.as_bytes()).unwrap();
        zip.finish().unwrap();
    }

    let err = hwp_core::parse_document_auto(&buf).expect_err("깊은 중첩은 거절해야 함");
    assert!(
        err.contains("중첩"),
        "오류 메시지가 원인을 알려야 함: {err}"
    );
}

/// .doc 그림: 바이트가 Office Drawing 저장소에 있고 본문은 앵커만 갖는다.
/// 앵커(0x08) → 도형(spid) → 그림 번호(pib) → BLIP 사슬이 다 이어져야 나온다.
#[test]
fn doc_extracts_pictures() {
    let model =
        hwp_core::parse_doc_document(&fixture("word97_pictures.doc")).expect("doc 파싱 실패");

    assert_eq!(model.info.bin_data.len(), 2, "그림 2개를 찾아야 함");
    for bin in &model.info.bin_data {
        assert_eq!(bin.ext, "png");
        // base64 문자열 길이로 원본 크기를 가늠 — 빈 껍데기가 아니어야 한다
        assert!(bin.data.len() > 10_000, "그림 바이트가 비었음");
    }

    // PNG 시그니처까지 확인 (엉뚱한 바이트를 담지 않았는지)
    use base64::Engine as _;
    let first = base64::engine::general_purpose::STANDARD
        .decode(&model.info.bin_data[0].data)
        .expect("base64 디코드");
    assert_eq!(&first[..8], b"\x89PNG\r\n\x1a\n", "PNG 헤더가 아님");

    // 본문 문단에 실제로 배치돼야 한다 (저장소에서 꺼내기만 하면 소용없다)
    let placed: usize = model.sections[0]
        .paragraphs
        .iter()
        .map(|p| p.images.len())
        .sum();
    assert_eq!(placed, 2, "그림이 문단에 배치되지 않음");
}

/// .doc의 문단 여백 sprm(0x840F/0x8411/0xA413/0xA414)과 첨자(sprmCIss) 회귀 가드.
///
/// **정직하게 적어 둔다**: 이 코퍼스에는 들여쓰기가 있는 문단이 없어서 0x840F/0x8411은
/// 실제로 발화하지 않는다. 확인된 것은 `word97_pictures.doc`의 문단 뒤 여백 7.5pt 하나뿐이다.
/// 그래서 여기서 지키는 것은 "맞는 값이 나온다"가 아니라 **"쓰레기 값이 안 나온다"** 다 —
/// opcode나 피연산자 길이를 잘못 잡으면 수치가 터무니없이 커지므로 그걸 잡는다.
#[test]
fn doc_paragraph_margins_are_sane() {
    // 실문서 여백이 한 변에 100pt(=10000 hwpunit)를 넘는 일은 사실상 없다
    const SANE: i32 = 10_000;
    let mut seen_nonzero = false;

    for name in [
        "sample_word97.doc",
        "word97_table_merges.doc",
        "word97_pictures.doc",
    ] {
        let model = hwp_core::parse_doc_document(&fixture(name)).expect("doc 파싱 실패");
        for (i, p) in model.info.para_shapes.iter().enumerate() {
            for (what, v) in [
                ("indent", p.indent),
                ("first_line", p.first_line),
                ("space_before", p.space_before),
                ("space_after", p.space_after),
            ] {
                assert!(
                    v.abs() <= SANE,
                    "{name} paraShape[{i}].{what} = {v} — sprm 해석이 어긋났다"
                );
                if v != 0 {
                    seen_nonzero = true;
                }
            }
        }
    }

    // 최소 한 값은 실제로 읽혀야 한다 (전부 0이면 sprm을 아예 못 읽고 있다는 뜻)
    assert!(seen_nonzero, "여백 sprm이 하나도 안 읽혔다");
}
