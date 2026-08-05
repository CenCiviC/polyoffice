//! HWP 5.x 파싱 본체. 레코드 해독 로직은 hwp.js(Apache-2.0, Han Lee)의 이식이며,
//! 문자모양 위치(shape pointer)는 스펙대로 wchar 단위로 해석해 runs로 다이제스트한다.

use std::io::{Cursor, Read};

use crate::model::*;
use crate::reader::{bits, rgb, ByteReader};
use crate::record::{parse_tree, Record};

// DocInfo tag IDs (HWPTAG_BEGIN = 0x10)
const TAG_DOCUMENT_PROPERTIES: u16 = 0x10;
const TAG_BIN_DATA: u16 = 0x10 + 2;
const TAG_FACE_NAME: u16 = 0x10 + 3;
const TAG_BORDER_FILL: u16 = 0x10 + 4;
const TAG_CHAR_SHAPE: u16 = 0x10 + 5;
const TAG_PARA_SHAPE: u16 = 0x10 + 9;
const TAG_SHAPE_COMPONENT_PICTURE: u16 = 0x10 + 69;

// Section tag IDs
const TAG_PARA_HEADER: u16 = 0x10 + 50;
const TAG_PARA_TEXT: u16 = 0x10 + 51;
const TAG_PARA_CHAR_SHAPE: u16 = 0x10 + 52;
const TAG_CTRL_HEADER: u16 = 0x10 + 55;
const TAG_LIST_HEADER: u16 = 0x10 + 56;
const TAG_PAGE_DEF: u16 = 0x10 + 57;
const TAG_TABLE: u16 = 0x10 + 61;

const CTRL_TABLE: u32 = ctrl_id(b"tbl ");
const CTRL_GSO: u32 = ctrl_id(b"gso ");
const CTRL_FOOTNOTE: u32 = ctrl_id(b"fn  ");
const CTRL_ENDNOTE: u32 = ctrl_id(b"en  ");

const fn ctrl_id(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
}

pub fn parse_document(data: &[u8]) -> Result<DocModel, String> {
    let cursor = Cursor::new(data.to_vec());
    let mut cfb = cfb::CompoundFile::open(cursor).map_err(|e| format!("CFB 열기 실패: {e}"))?;

    // FileHeader: 256바이트, 시그니처 + 버전 + 속성 플래그
    let header = read_stream(&mut cfb, "/FileHeader")?;
    if header.len() != 256 {
        return Err(format!("FileHeader는 256바이트여야 함 (실제 {})", header.len()));
    }
    let signature = String::from_utf8_lossy(&header[0..17]);
    if signature != "HWP Document File" {
        return Err(format!("HWP 시그니처 아님: {signature:?}"));
    }
    let version = format!("{}.{}.{}.{}", header[35], header[34], header[33], header[32]);
    let props = u32::from_le_bytes([header[36], header[37], header[38], header[39]]);
    let compressed = props & 1 != 0;
    if props & 0b10 != 0 {
        return Err("암호화된 문서는 지원하지 않음".into());
    }

    let doc_info_raw = maybe_inflate(read_stream(&mut cfb, "/DocInfo")?, compressed)?;
    let (mut info, section_count, bin_refs) = parse_doc_info(&doc_info_raw)?;

    // BinData 스토리지에서 임베디드 바이너리 로드 (이미지 등)
    use base64::Engine as _;
    for (id, ext) in bin_refs {
        let path = format!("/BinData/BIN{id:04X}.{ext}");
        let raw = read_stream(&mut cfb, &path).unwrap_or_default();
        // 압축 여부는 항목마다 다를 수 있어 해제 실패 시 원본 사용
        let bytes = maybe_inflate(raw.clone(), true).unwrap_or(raw);
        info.bin_data.push(BinData {
            ext: ext.to_lowercase(),
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }

    let mut sections = Vec::new();
    for i in 0..section_count {
        let raw = maybe_inflate(read_stream(&mut cfb, &format!("/BodyText/Section{i}"))?, compressed)?;
        sections.push(parse_section(&raw)?);
    }

    Ok(DocModel { version, info, sections })
}

fn read_stream<F: Read + std::io::Seek + std::io::Write>(
    cfb: &mut cfb::CompoundFile<F>,
    path: &str,
) -> Result<Vec<u8>, String> {
    let mut stream = cfb.open_stream(path).map_err(|e| format!("{path} 없음: {e}"))?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| format!("{path} 읽기 실패: {e}"))?;
    Ok(buf)
}

fn maybe_inflate(data: Vec<u8>, compressed: bool) -> Result<Vec<u8>, String> {
    if !compressed {
        return Ok(data);
    }
    let mut out = Vec::new();
    flate2::read::DeflateDecoder::new(&data[..])
        .read_to_end(&mut out)
        .map_err(|e| format!("zlib 해제 실패: {e}"))?;
    Ok(out)
}

// ---------------- DocInfo ----------------

type BinRef = (u16, String); // (스토리지 id, 확장자)

fn parse_doc_info(data: &[u8]) -> Result<(DocInfo, u16, Vec<BinRef>), String> {
    let records = parse_tree(data)?;
    let mut info = DocInfo::default();
    let mut section_count: u16 = 1;
    let mut bin_refs = Vec::new();
    visit_doc_info(&records, &mut info, &mut section_count, &mut bin_refs)?;
    Ok((info, section_count, bin_refs))
}

fn visit_doc_info(
    records: &[Record],
    info: &mut DocInfo,
    section_count: &mut u16,
    bin_refs: &mut Vec<BinRef>,
) -> Result<(), String> {
    for rec in records {
        match rec.tag {
            TAG_DOCUMENT_PROPERTIES => {
                let mut r = ByteReader::new(&rec.data);
                *section_count = r.u16()?;
            }
            TAG_CHAR_SHAPE => {
                let mut r = ByteReader::new(&rec.data);
                let mut font_ids = [0u16; 7];
                for f in font_ids.iter_mut() {
                    *f = r.u16()?;
                }
                r.skip(7)?; // 장평(fontScale)
                r.skip(7)?; // 자간(fontSpacing)
                let mut ratios = [0u8; 7];
                for x in ratios.iter_mut() {
                    *x = r.u8()?;
                }
                r.skip(7)?; // 오프셋(fontLocation)
                let base_size = r.i32()?;
                let attr = r.u32()?;
                r.skip(2)?; // 그림자 간격 x/y
                let color = rgb(r.u32()?);
                // 이후: underLineColor, shadeColor, shadowColor, (fontBackgroundId, strikeColor) — 미사용
                info.char_shapes.push(CharShape {
                    base_size,
                    ratio: ratios[0],
                    color,
                    attr,
                    font_id: font_ids[0],
                });
            }
            TAG_BIN_DATA => {
                let mut r = ByteReader::new(&rec.data);
                let _attr = r.u16()?;
                // 임베딩 타입: id + 확장자. (링크 타입은 payload가 달라 실패해도 무시)
                if let (Ok(id), Ok(ext)) = (r.u16(), r.string()) {
                    bin_refs.push((id, ext));
                }
            }
            TAG_FACE_NAME => {
                let mut r = ByteReader::new(&rec.data);
                let _attr = r.u8()?;
                let name = r.string()?;
                info.font_faces.push(name);
            }
            TAG_BORDER_FILL => {
                let mut r = ByteReader::new(&rec.data);
                r.u16()?; // attribute
                for _ in 0..4 {
                    r.u8()?; // border type
                    r.u8()?; // border width
                    r.u32()?; // border color
                }
                r.skip(6)?; // diagonal type/width/color
                let fill_type = r.u32()?;
                let background_color = if fill_type == 1 { Some(rgb(r.u32()?)) } else { None };
                info.border_fills.push(BorderFill { background_color });
            }
            TAG_PARA_SHAPE => {
                let mut r = ByteReader::new(&rec.data);
                let attr = r.u32()?;
                info.para_shapes.push(ParaShape {
                    align: bits(attr, 2, 4) as u8,
                });
            }
            _ => {}
        }
        visit_doc_info(&rec.children, info, section_count, bin_refs)?;
    }
    Ok(())
}

// ---------------- BodyText ----------------

/// PARA_TEXT의 문자 하나. pos = wchar 단위 위치 (제어문자 확장형은 8칸 차지)
enum CharItem {
    Text(char),
    LineBreak,
    Tab,
    /// 표·개체 앵커 등 확장 컨트롤 (11 = 표/개체)
    Extended(u16),
}

struct RawParagraph {
    shape_index: u16,
    chars: Vec<(u32, CharItem)>,
    shape_pointers: Vec<(u32, u32)>, // (wchar pos, charShapeId)
    tables: Vec<Table>,
    images: Vec<Image>,
    footnotes: Vec<Footnote>,
}

fn parse_section(data: &[u8]) -> Result<Section, String> {
    let records = parse_tree(data)?;
    let mut section = Section::default();
    for rec in &records {
        if rec.tag == TAG_PARA_HEADER {
            let para = parse_paragraph(rec, &mut section)?;
            section.paragraphs.push(digest(para));
        }
    }
    Ok(section)
}

fn parse_paragraph(rec: &Record, section: &mut Section) -> Result<RawParagraph, String> {
    let mut r = ByteReader::new(&rec.data);
    r.skip(8)?; // text len(u32) + control mask(u32)
    let shape_index = r.u16()?;

    let mut para = RawParagraph {
        shape_index,
        chars: Vec::new(),
        shape_pointers: Vec::new(),
        tables: Vec::new(),
        images: Vec::new(),
        footnotes: Vec::new(),
    };

    for child in &rec.children {
        match child.tag {
            TAG_PARA_TEXT => parse_para_text(&child.data, &mut para)?,
            TAG_PARA_CHAR_SHAPE => {
                let mut cr = ByteReader::new(&child.data);
                while !cr.is_eof() {
                    let pos = cr.u32()?;
                    let id = cr.u32()?;
                    para.shape_pointers.push((pos, id));
                }
            }
            TAG_CTRL_HEADER => parse_ctrl(child, &mut para, section)?,
            _ => {}
        }
    }
    Ok(para)
}

fn parse_para_text(data: &[u8], para: &mut RawParagraph) -> Result<(), String> {
    let mut r = ByteReader::new(data);
    let mut wpos: u32 = 0;
    let total = data.len();
    let mut read = 0usize;

    while read < total {
        let code = r.u16()?;
        match code {
            // 1칸 제어문자
            0 => {
                wpos += 1;
                read += 2;
            }
            10 | 13 => {
                para.chars.push((wpos, CharItem::LineBreak));
                wpos += 1;
                read += 2;
            }
            // 인라인 컨트롤 (8칸): 4-9 · 19-20. 9 = 탭
            4..=9 | 19 | 20 => {
                if code == 9 {
                    para.chars.push((wpos, CharItem::Tab));
                }
                r.skip(14)?;
                wpos += 8;
                read += 16;
            }
            // 확장 컨트롤 (8칸): 표·개체·각주 등
            1..=3 | 11 | 12 | 14..=18 | 21..=23 => {
                para.chars.push((wpos, CharItem::Extended(code)));
                r.skip(14)?;
                wpos += 8;
                read += 16;
            }
            _ => {
                let ch = match code {
                    // 한컴 PUA: "한글" 제품명의 "한" 로고 글리프 — 한컴 폰트 밖에서는
                    // 두부(⊠)로 렌더되므로 텍스트로 정규화
                    0xF53A => '한',
                    _ => char::from_u32(code as u32).unwrap_or('\u{FFFD}'),
                };
                para.chars.push((wpos, CharItem::Text(ch)));
                wpos += 1;
                read += 2;
            }
        }
    }
    Ok(())
}

fn parse_ctrl(rec: &Record, para: &mut RawParagraph, section: &mut Section) -> Result<(), String> {
    let mut r = ByteReader::new(&rec.data);
    let ctrl = r.u32()?;

    if ctrl == CTRL_TABLE {
        let table = parse_table_ctrl(rec, section)?;
        para.tables.push(table);
        return Ok(());
    }

    if ctrl == CTRL_GSO {
        // 공통 개체 헤더: attr, vOffset, hOffset, width, height (hwpunit)
        let _attr = r.u32()?;
        let _voff = r.u32()?;
        let _hoff = r.u32()?;
        let width = r.u32().unwrap_or(0);
        let height = r.u32().unwrap_or(0);
        if let Some(pic) = find_tag(rec, TAG_SHAPE_COMPONENT_PICTURE) {
            let mut pr = ByteReader::new(&pic.data);
            // hwp.js visitPicture와 동일: 4*17+3 바이트 스킵 후 binID(u16, 1-based)
            if pr.skip(4 * 17 + 3).is_ok() {
                if let Ok(bin_ref) = pr.u16() {
                    if bin_ref > 0 {
                        para.images.push(Image {
                            bin_data_id: bin_ref - 1,
                            width,
                            height,
                        });
                    }
                }
            }
        }
        return Ok(());
    }

    if ctrl == CTRL_FOOTNOTE || ctrl == CTRL_ENDNOTE {
        // 각주/미주: LIST_HEADER 뒤에 내용 문단들이 형제 레코드로 이어진다 (표 셀과 동일 패턴)
        let mut children = rec.children.iter().peekable();
        let mut fn_paras = Vec::new();
        while let Some(child) = children.next() {
            if child.tag != TAG_LIST_HEADER {
                continue;
            }
            let mut lr = ByteReader::new(&child.data);
            let para_count = if child.data.len() == 30 { lr.u16()? as u32 } else { lr.u32()? };
            for _ in 0..para_count {
                match children.peek() {
                    Some(p) if p.tag == TAG_PARA_HEADER => {
                        let p = children.next().unwrap();
                        let raw = parse_paragraph(p, section)?;
                        fn_paras.push(digest(raw));
                    }
                    _ => break,
                }
            }
        }
        if !fn_paras.is_empty() {
            para.footnotes.push(Footnote { paragraphs: fn_paras });
        }
        return Ok(());
    }

    // 표/개체가 아닌 컨트롤(구역정의 secd, 단 정의 cold 등): PAGE_DEF만 흡수
    for child in &rec.children {
        if child.tag == TAG_PAGE_DEF {
            let mut pr = ByteReader::new(&child.data);
            section.width = pr.u32()?;
            section.height = pr.u32()?;
            section.padding_left = pr.u32()?;
            section.padding_right = pr.u32()?;
            section.padding_top = pr.u32()?;
            section.padding_bottom = pr.u32()?;
            section.header_padding = pr.u32()?;
            section.footer_padding = pr.u32()?;
        }
    }
    Ok(())
}

fn find_tag<'a>(rec: &'a Record, tag: u16) -> Option<&'a Record> {
    for child in &rec.children {
        if child.tag == tag {
            return Some(child);
        }
        if let Some(found) = find_tag(child, tag) {
            return Some(found);
        }
    }
    None
}

fn parse_table_ctrl(rec: &Record, section: &mut Section) -> Result<Table, String> {
    let mut table = Table::default();
    let mut children = rec.children.iter().peekable();

    while let Some(child) = children.next() {
        match child.tag {
            TAG_TABLE => {
                let mut r = ByteReader::new(&child.data);
                r.u32()?; // table attribute
                table.row_count = r.u16()?;
                table.col_count = r.u16()?;
                table.rows = (0..table.row_count).map(|_| Vec::new()).collect();
                // cellSpacing(2) + inline margin(8) + rowSize(2×rows) + borderFillID — 미사용
            }
            TAG_LIST_HEADER => {
                let mut r = ByteReader::new(&child.data);
                // NOTE(hwp.js): 문서 스펙은 i16이지만 실제로는 대부분 i32
                let para_count = if child.data.len() == 30 {
                    r.u16()? as u32
                } else {
                    r.u32()?
                };
                r.u32()?; // list attribute

                // 셀/캡션 문단들은 LIST_HEADER의 "형제" 레코드로 이어진다
                let mut cell_paras = Vec::new();
                for _ in 0..para_count {
                    match children.peek() {
                        Some(p) if p.tag == TAG_PARA_HEADER => {
                            let p = children.next().unwrap();
                            let raw = parse_paragraph(p, section)?;
                            cell_paras.push(digest(raw));
                        }
                        _ => break,
                    }
                }

                // 캡션 LIST_HEADER는 셀 필드(col/row/span/size ≥ 24바이트)가 없다
                if child.data.len() < 8 + 24 {
                    table.caption.extend(cell_paras);
                    continue;
                }

                let col = r.u16()?;
                let row = r.u16()?;
                let col_span = r.u16()?;
                let row_span = r.u16()?;
                let width = r.u32()?;
                let height = r.u32()?;
                let padding = [r.u16()?, r.u16()?, r.u16()?, r.u16()?];
                let border_fill_id = if !r.is_eof() {
                    let v = r.u16()?;
                    if v > 0 { Some(v - 1) } else { None }
                } else {
                    None
                };

                let cell = Cell {
                    col,
                    row,
                    col_span,
                    row_span,
                    width,
                    height,
                    padding,
                    border_fill_id,
                    paragraphs: cell_paras,
                };
                if let Some(r) = table.rows.get_mut(row as usize) {
                    r.push(cell);
                }
            }
            _ => {}
        }
    }
    Ok(table)
}

/// chars + shape_pointers → 같은 글자모양 구간(run)으로 다이제스트
fn digest(raw: RawParagraph) -> Paragraph {
    let mut runs: Vec<Run> = Vec::new();
    let mut pointers = raw.shape_pointers.clone();
    pointers.sort_by_key(|p| p.0);

    let shape_at = |wpos: u32| -> u32 {
        let mut id = pointers.first().map(|p| p.1).unwrap_or(0);
        for &(pos, sid) in &pointers {
            if pos <= wpos {
                id = sid;
            } else {
                break;
            }
        }
        id
    };

    for (wpos, item) in &raw.chars {
        let piece = match item {
            CharItem::Text(c) => c.to_string(),
            CharItem::LineBreak => "\n".to_string(),
            CharItem::Tab => "\t".to_string(),
            CharItem::Extended(_) => continue,
        };
        let shape = shape_at(*wpos);
        match runs.last_mut() {
            Some(last) if last.char_shape_id == shape => last.text.push_str(&piece),
            _ => runs.push(Run {
                char_shape_id: shape,
                text: piece,
            }),
        }
    }

    Paragraph {
        shape_index: raw.shape_index,
        runs,
        tables: raw.tables,
        images: raw.images,
        footnotes: raw.footnotes,
    }
}
