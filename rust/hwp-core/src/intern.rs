//! 서식 조합 → DocInfo 배열 인덱스 인터너.
//!
//! .hwp/.hwpx는 파일 자체가 "서식표 + 인덱스 참조" 구조라 그대로 옮기면 되지만,
//! docx·odt·doc은 서식이 문단/런에 흩뿌려져 있다. 세 리더 모두 해석한 서식을
//! 여기에 넣어 같은 계약(charShapeId·shapeIndex·borderFillId)으로 접는다.

use std::collections::HashMap;

use base64::Engine as _;

use crate::model::{BinData, BorderFill, CharShape, DocInfo, ParaMargins, ParaShape};

/// 글꼴 미지정. fontFaces 범위 밖이라 방출기가 font-family를 넣지 않는다.
pub const NO_FONT: u16 = u16::MAX;

#[derive(Default)]
pub struct Interner {
    pub info: DocInfo,
    fonts: HashMap<String, u16>,
    shapes: HashMap<(i32, [u8; 3], u32, u16), u32>,
    paras: HashMap<(u8, ParaMargins), u16>,
    fills: HashMap<[u8; 3], u16>,
    bins: HashMap<String, u16>,
}

impl Interner {
    pub fn font(&mut self, name: Option<&str>) -> u16 {
        match name.map(str::trim).filter(|n| !n.is_empty()) {
            Some(name) => match self.fonts.get(name) {
                Some(&id) => id,
                None => {
                    let id = self.info.font_faces.len() as u16;
                    self.info.font_faces.push(name.to_string());
                    self.fonts.insert(name.to_string(), id);
                    id
                }
            },
            None => NO_FONT,
        }
    }

    /// base_size는 1/100pt, attr은 .hwp CHAR_SHAPE 계약
    /// (bit0 기울임 · bit1 굵게 · bit2-3 밑줄)
    pub fn char_shape(&mut self, base_size: i32, color: [u8; 3], attr: u32, font_id: u16) -> u32 {
        let key = (base_size, color, attr, font_id);
        if let Some(&id) = self.shapes.get(&key) {
            return id;
        }
        let id = self.info.char_shapes.len() as u32;
        self.info.char_shapes.push(CharShape {
            base_size,
            ratio: 100,
            color,
            attr,
            font_id,
        });
        self.shapes.insert(key, id);
        id
    }

    /// 정렬만 다른 문단이 대부분이라 여백 없는 호출을 짧게 쓴다.
    pub fn para_shape(&mut self, align: u8) -> u16 {
        self.para_shape_m(align, ParaMargins::default())
    }

    pub fn para_shape_m(&mut self, align: u8, m: ParaMargins) -> u16 {
        let key = (align, m);
        if let Some(&id) = self.paras.get(&key) {
            return id;
        }
        let id = self.info.para_shapes.len() as u16;
        self.info.para_shapes.push(ParaShape {
            align,
            indent: m.indent,
            first_line: m.first_line,
            space_before: m.space_before,
            space_after: m.space_after,
        });
        self.paras.insert(key, id);
        id
    }

    pub fn fill(&mut self, color: [u8; 3]) -> u16 {
        if let Some(&id) = self.fills.get(&color) {
            return id;
        }
        let id = self.info.border_fills.len() as u16;
        self.info.border_fills.push(BorderFill {
            background_color: Some(color),
        });
        self.fills.insert(color, id);
        id
    }

    /// 같은 그림을 여러 번 참조해도 한 번만 싣는다. key는 패키지 내부 경로 등 식별자.
    pub fn bin_data(&mut self, key: &str, ext: &str, bytes: &[u8]) -> u16 {
        if let Some(&id) = self.bins.get(key) {
            return id;
        }
        let id = self.info.bin_data.len() as u16;
        self.info.bin_data.push(BinData {
            ext: ext.to_lowercase(),
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
        self.bins.insert(key.to_string(), id);
        id
    }
}
