//! 문서 모델 — 파서(Rust/JS)와 변환기(TS) 사이의 JSON 계약.
//! TS 쪽 대응 타입: src/lib/model.ts. 두 파일은 항상 함께 변경한다.
use serde::Serialize;

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocModel {
    pub version: String,
    pub info: DocInfo,
    pub sections: Vec<Section>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub char_shapes: Vec<CharShape>,
    pub font_faces: Vec<String>,
    pub border_fills: Vec<BorderFill>,
    pub para_shapes: Vec<ParaShape>,
    /// 임베디드 바이너리 (이미지 등). Image.bin_data_id가 이 배열 인덱스를 참조.
    pub bin_data: Vec<BinData>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BinData {
    pub ext: String,
    /// base64
    pub data: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CharShape {
    /// 1/100 pt (예: 1000 = 10pt)
    pub base_size: i32,
    /// 언어별 장평 중 한글(첫 번째) 값, %
    pub ratio: u8,
    pub color: [u8; 3],
    /// **.hwp CHAR_SHAPE 속성 u32를 그대로 쓰는 계약** — .hwp 리더는 원시 값을 통과시키고,
    /// 나머지 넷은 해석한 결과를 같은 비트에 채운다.
    /// bit0 기울임 · bit1 진하게 · bit2-3 밑줄(1=아래, 3=위) · bit4-7 밑줄모양 ·
    /// bit8-9 외곽선 · bit10-11 그림자 · bit12 양각 · bit13 음각 · bit14 위첨자 · bit15 아래첨자
    pub attr: u32,
    pub font_id: u16,
}

/// CharShape.attr 비트 — 리더 다섯이 같은 이름을 쓴다.
pub const ATTR_ITALIC: u32 = 1 << 0;
pub const ATTR_BOLD: u32 = 1 << 1;
/// bit4-7은 .hwp의 **밑줄 모양**이라 첨자에 쓰면 안 된다 — HWP가 정한 자리는 14/15다.
pub const ATTR_SUPER: u32 = 1 << 14;
pub const ATTR_SUB: u32 = 1 << 15;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BorderFill {
    pub background_color: Option<[u8; 3]>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ParaShape {
    /// 0 양쪽 · 1 왼쪽 · 2 오른쪽 · 3 가운데 (HWP align enum)
    pub align: u8,
    /// 왼쪽 들여쓰기 (hwpunit)
    pub indent: i32,
    /// 첫 줄 들여쓰기 (hwpunit) — **음수면 내어쓰기**
    pub first_line: i32,
    /// 문단 앞 여백 (hwpunit)
    pub space_before: i32,
    /// 문단 뒤 여백 (hwpunit)
    pub space_after: i32,
}

/// 문단 여백 묶음 (hwpunit). 인터너 키로도 쓰이므로 Hash/Eq를 갖는다.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, Debug)]
pub struct ParaMargins {
    pub indent: i32,
    pub first_line: i32,
    pub space_before: i32,
    pub space_after: i32,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub width: u32,
    pub height: u32,
    pub padding_left: u32,
    pub padding_right: u32,
    pub padding_top: u32,
    pub padding_bottom: u32,
    pub header_padding: u32,
    pub footer_padding: u32,
    pub paragraphs: Vec<Paragraph>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub shape_index: u16,
    /// 같은 글자모양이 연속되는 텍스트 구간. '\n' = 줄바꿈, '\t' = 탭.
    pub runs: Vec<Run>,
    pub tables: Vec<Table>,
    pub images: Vec<Image>,
    pub footnotes: Vec<Footnote>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Footnote {
    pub paragraphs: Vec<Paragraph>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    /// DocInfo.bin_data 인덱스 (0-based)
    pub bin_data_id: u16,
    /// hwpunit
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub char_shape_id: u32,
    pub text: String,
    /// 하이퍼링크 대상. 없으면 직렬화에서 빠진다 (기존 JSON과 모양을 유지하려고).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub row_count: u16,
    pub col_count: u16,
    pub rows: Vec<Vec<Cell>>,
    /// 표 캡션 문단들 (LIST_HEADER가 셀 필드 없이 오는 경우)
    pub caption: Vec<Paragraph>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub col: u16,
    pub row: u16,
    pub col_span: u16,
    pub row_span: u16,
    /// hwpunit (1/7200 in)
    pub width: u32,
    pub height: u32,
    pub padding: [u16; 4],
    /// DocInfo.border_fills 인덱스 (0-based)
    pub border_fill_id: Option<u16>,
    pub paragraphs: Vec<Paragraph>,
}
