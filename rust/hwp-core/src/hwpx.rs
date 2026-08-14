//! HWPX(OWPML, KS X 6101) 파싱 — zip 안의 XML을 Narro 문서 모델로 매핑한다.
//! .hwp(parse.rs)와 같은 DocModel JSON 계약을 채우므로 방출기(TS)는 포맷을 구분하지 않는다.
//!
//! OWPML의 ID 참조(charPrIDRef 등)는 임의 문자열 id라서, 등장 순서대로 배열에 넣고
//! id → 배열 인덱스 맵으로 해석한다 (.hwp의 0-based 인덱스 계약과 동일해짐).

use std::collections::HashMap;
use std::io::{Cursor, Read};

use base64::Engine as _;
use roxmltree::{Document, Node};

use crate::model::*;

#[derive(Default)]
struct IdMaps {
    fonts: HashMap<String, u16>,
    char_shapes: HashMap<String, u32>,
    para_shapes: HashMap<String, u16>,
    border_fills: HashMap<String, u16>,
    bin_data: HashMap<String, u16>,
}

pub fn parse_hwpx_document(data: &[u8]) -> Result<DocModel, String> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("hwpx(zip) 열기 실패: {e}"))?;

    let header_xml = read_zip_string(&mut zip, "Contents/header.xml")?;
    crate::xml::check_depth(&header_xml, "header.xml")?;
    let header_doc =
        Document::parse(&header_xml).map_err(|e| format!("header.xml 파싱 실패: {e}"))?;

    let mut ids = IdMaps::default();
    let mut info = parse_header(&header_doc, &mut ids);

    // 임베디드 바이너리: content.hpf 매니페스트의 BinData 항목을 등장 순서대로 적재
    if let Ok(hpf) = read_zip_string(&mut zip, "Contents/content.hpf") {
        if let Ok(doc) = Document::parse(&hpf) {
            let items: Vec<(String, String)> = doc
                .descendants()
                .filter(|n| n.tag_name().name() == "item")
                .filter_map(|n| {
                    let id = n.attribute("id")?;
                    let href = n.attribute("href")?;
                    href.starts_with("BinData/")
                        .then(|| (id.to_string(), href.to_string()))
                })
                .collect();
            for (id, href) in items {
                let Ok(bytes) = read_zip_bytes(&mut zip, &href) else {
                    continue;
                };
                let ext = href.rsplit('.').next().unwrap_or("").to_lowercase();
                ids.bin_data.insert(id, info.bin_data.len() as u16);
                info.bin_data.push(BinData {
                    ext,
                    data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                });
            }
        }
    }

    // 매니페스트에 빠진 그림 줍기 — zip에 파일만 넣고 등록을 빠뜨린 생성기가 있다.
    // 파일 이름(확장자 제외)이 곧 binaryItemIDRef다.
    let orphans: Vec<String> = zip
        .file_names()
        .filter(|n| n.starts_with("BinData/") && n.len() > "BinData/".len())
        .map(str::to_string)
        .filter(|n| {
            let stem = n["BinData/".len()..]
                .rsplit_once('.')
                .map(|(s, _)| s)
                .unwrap_or("");
            !stem.is_empty() && !ids.bin_data.contains_key(stem)
        })
        .collect();
    for path in orphans {
        let Ok(bytes) = read_zip_bytes(&mut zip, &path) else {
            continue;
        };
        let stem = path["BinData/".len()..]
            .rsplit_once('.')
            .map(|(s, _)| s.to_string())
            .unwrap_or_default();
        let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
        ids.bin_data.insert(stem, info.bin_data.len() as u16);
        info.bin_data.push(BinData {
            ext,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }

    let version = header_doc
        .root_element()
        .attribute("version")
        .map(|v| format!("hwpx-{v}"))
        .unwrap_or_else(|| "hwpx".into());

    let sec_cnt: usize = header_doc
        .root_element()
        .attribute("secCnt")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);

    let mut sections = Vec::new();
    for i in 0..sec_cnt.max(1) {
        let path = format!("Contents/section{i}.xml");
        let xml = read_zip_string(&mut zip, &path)?;
        crate::xml::check_depth(&xml, &path)?;
        let doc = Document::parse(&xml).map_err(|e| format!("{path} 파싱 실패: {e}"))?;
        sections.push(parse_section(&doc, &ids));
    }

    Ok(DocModel {
        version,
        info,
        sections,
    })
}

fn read_zip_bytes<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut file = zip.by_name(name).map_err(|e| format!("{name} 없음: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("{name} 읽기 실패: {e}"))?;
    Ok(buf)
}

fn read_zip_string<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&read_zip_bytes(zip, name)?).into_owned())
}

// ---------------- header.xml → DocInfo ----------------

fn parse_header(doc: &Document, ids: &mut IdMaps) -> DocInfo {
    let mut info = DocInfo::default();
    let root = doc.root_element();

    // 폰트: 한글 그룹(첫 fontface) 기준 — charPr의 fontRef hangul이 이 그룹의 id를 참조
    if let Some(faces) = root
        .descendants()
        .find(|n| n.tag_name().name() == "fontface" && n.attribute("lang") == Some("HANGUL"))
        .or_else(|| {
            root.descendants()
                .find(|n| n.tag_name().name() == "fontface")
        })
    {
        for font in faces.children().filter(|n| n.tag_name().name() == "font") {
            if let Some(face) = font.attribute("face") {
                if let Some(id) = font.attribute("id") {
                    ids.fonts
                        .insert(id.to_string(), info.font_faces.len() as u16);
                }
                info.font_faces.push(face.to_string());
            }
        }
    }

    for bf in root
        .descendants()
        .filter(|n| n.tag_name().name() == "borderFill")
    {
        if let Some(id) = bf.attribute("id") {
            ids.border_fills
                .insert(id.to_string(), info.border_fills.len() as u16);
        }
        let background_color = bf
            .descendants()
            .find(|n| n.tag_name().name() == "winBrush")
            .and_then(|n| n.attribute("faceColor"))
            .and_then(hex_rgb);
        info.border_fills.push(BorderFill { background_color });
    }

    for cp in root
        .descendants()
        .filter(|n| n.tag_name().name() == "charPr")
    {
        if let Some(id) = cp.attribute("id") {
            ids.char_shapes
                .insert(id.to_string(), info.char_shapes.len() as u32);
        }
        let child = |name: &str| cp.children().find(|n| n.tag_name().name() == name);
        // attr 비트는 .hwp CHAR_SHAPE와 동일 계약: bit0 italic · bit1 bold · bit2-3 underline
        let mut attr = 0u32;
        if child("italic").is_some() {
            attr |= 0b01;
        }
        if child("bold").is_some() {
            attr |= 0b10;
        }
        match child("underline").and_then(|n| n.attribute("type")) {
            Some("BOTTOM") | Some("CENTER") => attr |= 1 << 2,
            Some("TOP") => attr |= 3 << 2,
            _ => {}
        }
        // 첨자는 charPr의 무속성 자식이다 (실물 hwpx + hwpxlib CharPr로 확인)
        if child("supscript").is_some() {
            attr |= ATTR_SUPER;
        }
        if child("subscript").is_some() {
            attr |= ATTR_SUB;
        }
        info.char_shapes.push(CharShape {
            base_size: cp
                .attribute("height")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1000),
            ratio: child("ratio")
                .and_then(|n| n.attribute("hangul"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(100),
            color: cp
                .attribute("textColor")
                .and_then(hex_rgb)
                .unwrap_or([0, 0, 0]),
            attr,
            font_id: child("fontRef")
                .and_then(|n| n.attribute("hangul"))
                .and_then(|id| ids.fonts.get(id).copied())
                .unwrap_or(0),
        });
    }

    for pp in root
        .descendants()
        .filter(|n| n.tag_name().name() == "paraPr")
    {
        if let Some(id) = pp.attribute("id") {
            ids.para_shapes
                .insert(id.to_string(), info.para_shapes.len() as u16);
        }
        // HWP align enum: 0 양쪽 · 1 왼쪽 · 2 오른쪽 · 3 가운데 · 4 배분 · 5 나눔
        let align = match pp
            .children()
            .find(|n| n.tag_name().name() == "align")
            .and_then(|n| n.attribute("horizontal"))
        {
            Some("LEFT") => 1,
            Some("RIGHT") => 2,
            Some("CENTER") => 3,
            Some("DISTRIBUTE") => 4,
            Some("DISTRIBUTE_SPACE") => 5,
            _ => 0,
        };
        // 여백은 <hh:margin>의 자식들. 값은 이미 HWPUNIT이라 변환이 없다.
        //
        // 주의: paraPr은 <hp:switch><hp:case required-namespace="…HwpUnitChar">…</hp:case>
        // <hp:default>…</hp:default></hp:switch> 로 **같은 여백을 두 벌** 담고 있고 값이 다르다
        // (실물에서 intent가 case -8400 / default -16800). SVG의 switch와 같은 규칙이라
        // 그 네임스페이스(글자 단위)를 구현한 리더만 case를 쓰고, 나머지는 default를 쓴다.
        // 우리는 글자 단위를 구현하지 않으므로 **case 안에 있는 margin은 건너뛴다.**
        let margin = pp
            .descendants()
            .filter(|n| n.tag_name().name() == "margin")
            .find(|n| !n.ancestors().any(|a| a.tag_name().name() == "case"))
            .or_else(|| {
                pp.descendants()
                    .find(|n| n.tag_name().name() == "margin")
            });
        let margin_of = |name: &str| -> i32 {
            margin
                .and_then(|m| m.children().find(|n| n.tag_name().name() == name))
                .and_then(|n| n.attribute("value"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
        };
        info.para_shapes.push(ParaShape {
            align,
            indent: margin_of("left"),
            first_line: margin_of("intent"),
            space_before: margin_of("prev"),
            space_after: margin_of("next"),
        });
    }

    info
}

/// HYPERLINK 필드에서 주소를 꺼낸다 — **최선노력**.
///
/// 타입명은 hwpxlib `FieldType::HYPERLINK`로 확정됐지만
/// `<hp:stringParam name="Command">`의 문자열 문법(구분자·필드 수)은 확인된 문서가 없다.
/// 실물 샘플의 CROSSREF가 `대상;6;2;0;0;` 꼴인 것으로 미루어 첫 조각이 대상이라고 보고 자른다.
///
/// 틀려도 안전한 이유: 읽기라서 잘못 뽑으면 링크가 안 생길 뿐이고, 방출기가 `isSafeHref`로
/// 한 번 더 거르므로 이상한 값이 IR에 들어가지 않는다. (쓰기는 파일이 안 열릴 수 있어 강등했다.)
fn hyperlink_target(field: Node) -> Option<String> {
    let cmd = field
        .descendants()
        .filter(|n| n.tag_name().name() == "stringParam")
        .find(|n| n.attribute("name") == Some("Command"))
        .and_then(|n| n.text())?;
    let first = cmd.split(';').next()?.trim();
    if first.is_empty() {
        return None;
    }
    Some(first.to_string())
}

fn hex_rgb(s: &str) -> Option<[u8; 3]> {
    let hex = s.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, (v & 0xff) as u8])
}

// ---------------- section{i}.xml → Section ----------------

fn parse_section(doc: &Document, ids: &IdMaps) -> Section {
    let mut section = Section::default();
    let paragraphs: Vec<Paragraph> = doc
        .root_element()
        .children()
        .filter(|n| n.tag_name().name() == "p")
        .map(|p| parse_paragraph(p, &mut section, ids))
        .collect();
    section.paragraphs = paragraphs;
    section
}

fn parse_paragraph(p: Node, section: &mut Section, ids: &IdMaps) -> Paragraph {
    let mut para = Paragraph {
        shape_index: p
            .attribute("paraPrIDRef")
            .and_then(|id| ids.para_shapes.get(id).copied())
            .unwrap_or(0),
        ..Default::default()
    };

    // 하이퍼링크는 필드다: <hp:ctrl><hp:fieldBegin type="HYPERLINK">가 열고
    // <hp:fieldEnd/>가 닫으며, 그 사이의 런들이 링크 안쪽이다.
    let mut link: Option<String> = None;

    for run in p.children().filter(|n| n.tag_name().name() == "run") {
        let shape_id = run
            .attribute("charPrIDRef")
            .and_then(|id| ids.char_shapes.get(id).copied())
            .unwrap_or(0);
        let mut text = String::new();

        for child in run.children().filter(|n| n.is_element()) {
            match child.tag_name().name() {
                "t" => collect_text(child, &mut text),
                "tbl" => para.tables.push(parse_table(child, section, ids)),
                "pic" => {
                    if let Some(img) = parse_pic(child, ids) {
                        para.images.push(img);
                    }
                }
                "footNote" | "endNote" => {
                    let fn_paras = sublist_paragraphs(child, section, ids);
                    if !fn_paras.is_empty() {
                        para.footnotes.push(Footnote {
                            paragraphs: fn_paras,
                        });
                    }
                }
                "secPr" => absorb_sec_pr(child, section),
                "ctrl" => {
                    for c in child.children().filter(|n| n.is_element()) {
                        match c.tag_name().name() {
                            "fieldBegin" if c.attribute("type") == Some("HYPERLINK") => {
                                link = hyperlink_target(c)
                            }
                            "fieldEnd" => link = None,
                            // 각주는 컨트롤이다 — run 직계로도 오지만 <hp:ctrl>로 감싸 오는 쪽이
                            // 실제로 더 흔하다(우리 쓰기 백엔드도 그 형태다). 여기서 안 받으면
                            // hwpx로 저장한 각주가 다시 열 때 통째로 사라진다.
                            "footNote" | "endNote" => {
                                let fn_paras = sublist_paragraphs(c, section, ids);
                                if !fn_paras.is_empty() {
                                    para.footnotes.push(Footnote {
                                        paragraphs: fn_paras,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "linesegarray" => {}
                // rect·container 등 그리기 개체: 내부 그림을 건지고,
                // 글상자(drawText)는 시각적 등가물인 1×1 표로 강등해 본문에 남긴다
                _ => {
                    let inside_draw_text = |n: &Node| {
                        n.ancestors()
                            .take_while(|a| a.id() != child.id())
                            .any(|a| a.tag_name().name() == "drawText")
                    };
                    for pic in child
                        .descendants()
                        .filter(|n| n.tag_name().name() == "pic" && !inside_draw_text(n))
                    {
                        if let Some(img) = parse_pic(pic, ids) {
                            para.images.push(img);
                        }
                    }
                    for dt in child
                        .descendants()
                        .filter(|n| n.tag_name().name() == "drawText")
                    {
                        let box_paras = sublist_paragraphs(dt, section, ids);
                        if box_paras.is_empty() {
                            continue;
                        }
                        let sz = child.children().find(|n| n.tag_name().name() == "sz");
                        para.tables.push(Table {
                            row_count: 1,
                            col_count: 1,
                            rows: vec![vec![Cell {
                                col: 0,
                                row: 0,
                                col_span: 1,
                                row_span: 1,
                                width: dim(sz, "width").unwrap_or(0),
                                height: dim(sz, "height").unwrap_or(0),
                                padding: [141, 141, 141, 141],
                                border_fill_id: None,
                                paragraphs: box_paras,
                            }]],
                            caption: Vec::new(),
                        });
                    }
                }
            }
        }

        if !text.is_empty() {
            // 같은 글자모양이 이어지면 병합 (.hwp digest와 동일한 run 형태 유지)
            match para.runs.last_mut() {
                Some(last)
                    if last.char_shape_id == shape_id && last.link.as_deref() == link.as_deref() =>
                {
                    last.text.push_str(&text)
                }
                _ => para.runs.push(Run {
                    char_shape_id: shape_id,
                    text,
                    link: link.clone(),
                }),
            }
        }
    }
    para
}

/// hp:t의 혼합 콘텐츠: 텍스트 + lineBreak/tab 등 인라인 마크업
fn collect_text(t: Node, out: &mut String) {
    for child in t.children() {
        if child.is_text() {
            out.push_str(child.text().unwrap_or(""));
            continue;
        }
        match child.tag_name().name() {
            "lineBreak" => out.push('\n'),
            "tab" => out.push('\t'),
            "fwSpace" | "nbSpace" => out.push(' '),
            _ => {}
        }
    }
}

fn absorb_sec_pr(sec_pr: Node, section: &mut Section) {
    let Some(page_pr) = sec_pr.children().find(|n| n.tag_name().name() == "pagePr") else {
        return;
    };
    let attr_u32 = |n: Option<Node>, name: &str| dim(n, name).unwrap_or(0);
    section.width = attr_u32(Some(page_pr), "width");
    section.height = attr_u32(Some(page_pr), "height");
    let margin = page_pr.children().find(|n| n.tag_name().name() == "margin");
    if margin.is_some() {
        section.padding_left = attr_u32(margin, "left");
        section.padding_right = attr_u32(margin, "right");
        section.padding_top = attr_u32(margin, "top");
        section.padding_bottom = attr_u32(margin, "bottom");
        section.header_padding = attr_u32(margin, "header");
        section.footer_padding = attr_u32(margin, "footer");
    }
}

fn parse_pic(pic: Node, ids: &IdMaps) -> Option<Image> {
    let bin_data_id = pic
        .descendants()
        .find(|n| n.tag_name().name() == "img")
        .and_then(|n| n.attribute("binaryItemIDRef"))
        .and_then(|id| ids.bin_data.get(id).copied())?;
    let cur_sz = pic.children().find(|n| n.tag_name().name() == "curSz");
    Some(Image {
        bin_data_id,
        width: dim(cur_sz, "width").unwrap_or(0),
        height: dim(cur_sz, "height").unwrap_or(0),
    })
}

/// footNote/endNote/caption 등: hp:subList 아래 문단들
fn sublist_paragraphs(node: Node, section: &mut Section, ids: &IdMaps) -> Vec<Paragraph> {
    node.children()
        .filter(|n| n.tag_name().name() == "subList")
        .flat_map(|sl| {
            sl.children()
                .filter(|n| n.tag_name().name() == "p")
                .collect::<Vec<_>>()
        })
        .map(|p| parse_paragraph(p, section, ids))
        .collect()
}

fn parse_table(tbl: Node, section: &mut Section, ids: &IdMaps) -> Table {
    let mut table = Table {
        row_count: dim(Some(tbl), "rowCnt").unwrap_or(0) as u16,
        col_count: dim(Some(tbl), "colCnt").unwrap_or(0) as u16,
        ..Default::default()
    };
    table.rows = (0..table.row_count).map(|_| Vec::new()).collect();

    for caption in tbl.children().filter(|n| n.tag_name().name() == "caption") {
        table
            .caption
            .extend(sublist_paragraphs(caption, section, ids));
    }

    // 표 기본 안쪽 여백 — 셀이 여백을 "미지정"으로 두면 이 값을 상속한다
    let in_margin = tbl.children().find(|n| n.tag_name().name() == "inMargin");
    let default_padding = margin_of(in_margin, [0, 0, 0, 0]);

    for tr in tbl.children().filter(|n| n.tag_name().name() == "tr") {
        for tc in tr.children().filter(|n| n.tag_name().name() == "tc") {
            let child = |name: &str| tc.children().find(|n| n.tag_name().name() == name);
            let addr = child("cellAddr");
            let span = child("cellSpan");
            let sz = child("cellSz");

            let row = dim(addr, "rowAddr").unwrap_or(0) as u16;
            let cell = Cell {
                col: dim(addr, "colAddr").unwrap_or(0) as u16,
                row,
                col_span: dim(span, "colSpan").unwrap_or(1) as u16,
                row_span: dim(span, "rowSpan").unwrap_or(1) as u16,
                width: dim(sz, "width").unwrap_or(0),
                height: dim(sz, "height").unwrap_or(0),
                padding: margin_of(child("cellMargin"), default_padding),
                border_fill_id: tc
                    .attribute("borderFillIDRef")
                    .and_then(|id| ids.border_fills.get(id).copied()),
                paragraphs: sublist_paragraphs(tc, section, ids),
            };
            if let Some(r) = table.rows.get_mut(row as usize) {
                r.push(cell);
            }
        }
    }
    table
}

/// 여백 요소(inMargin·cellMargin) → .hwp LIST_HEADER와 같은 순서 [left, right, top, bottom].
/// 미지정 변은 default의 같은 자리 값을 물려받는다.
fn margin_of(node: Option<Node>, default: [u16; 4]) -> [u16; 4] {
    let mut out = default;
    for (slot, name) in out.iter_mut().zip(["left", "right", "top", "bottom"]) {
        if let Some(v) = dim(node, name) {
            *slot = v.min(u16::MAX as u32) as u16;
        }
    }
    out
}

/// OWPML 치수/개수 속성. 한글은 "미지정"을 -1로 쓰는데 부호 없는 32비트
/// (4294967295)로 직렬화되기도 한다 — 둘 다 None으로 접어 호출부가 기본값을 쓰게 한다.
fn dim(node: Option<Node>, name: &str) -> Option<u32> {
    let raw: i64 = node?.attribute(name)?.trim().parse().ok()?;
    (0..u32::MAX as i64).contains(&raw).then_some(raw as u32)
}
