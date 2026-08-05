//! HWP 레코드 스트림 → 트리. 헤더 u32 = tagID(10b) | level(10b) | size(12b, 0xFFF면 확장).

use crate::reader::ByteReader;

pub struct Record {
    pub tag: u16,
    pub data: Vec<u8>,
    pub children: Vec<Record>,
}

pub fn parse_tree(data: &[u8]) -> Result<Vec<Record>, String> {
    let mut reader = ByteReader::new(data);
    let mut flat: Vec<(u16, u16, Vec<u8>)> = Vec::new();

    while !reader.is_eof() {
        let header = reader.u32()?;
        let tag = (header & 0x3FF) as u16;
        let level = ((header >> 10) & 0x3FF) as u16;
        let mut size = (header >> 20) & 0xFFF;
        if size == 0xFFF {
            size = reader.u32()?;
        }
        let payload = reader.vec(size as usize)?;
        flat.push((tag, level, payload));
    }

    let mut idx = 0;
    Ok(build_level(&mut flat, &mut idx, 0))
}

fn build_level(flat: &mut Vec<(u16, u16, Vec<u8>)>, idx: &mut usize, level: u16) -> Vec<Record> {
    let mut out = Vec::new();
    while *idx < flat.len() {
        let (tag, lv, _) = &flat[*idx];
        let (tag, lv) = (*tag, *lv);
        if lv < level {
            break;
        }
        if lv > level {
            // 부모 없는 깊은 레코드(비정상) — 마지막 노드에 붙이지 않고 현재 레벨로 승격 처리
            // 정상 파일에서는 발생하지 않는다.
        }
        let data = std::mem::take(&mut flat[*idx].2);
        *idx += 1;
        let children = build_level(flat, idx, level + 1);
        out.push(Record { tag, data, children });
    }
    out
}
