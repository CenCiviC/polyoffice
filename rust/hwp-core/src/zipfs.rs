//! zip 컨테이너 포맷(hwpx·docx·odt) 공용 읽기 헬퍼.

use std::io::{Cursor, Read};

pub type Zip<'a> = zip::ZipArchive<Cursor<&'a [u8]>>;

pub fn open(data: &[u8]) -> Result<Zip<'_>, String> {
    zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("zip 열기 실패: {e}"))
}

pub fn bytes(zip: &mut Zip, name: &str) -> Result<Vec<u8>, String> {
    let mut file = zip.by_name(name).map_err(|e| format!("{name} 없음: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("{name} 읽기 실패: {e}"))?;
    Ok(buf)
}

pub fn text(zip: &mut Zip, name: &str) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&bytes(zip, name)?).into_owned())
}

pub fn has(zip: &mut Zip, name: &str) -> bool {
    zip.by_name(name).is_ok()
}

/// 확장자 → 문서 모델의 BinData.ext (소문자, 점 없음)
pub fn ext_of(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_lowercase()
}
