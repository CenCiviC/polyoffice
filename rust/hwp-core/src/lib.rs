//! hwp-core — 한글·워드·오픈오피스 문서를 Narro 문서 모델(JSON 계약)로 파싱하는 코어.
//! 브라우저(WASM)·CLI·서버가 같은 크레이트를 쓴다.
//! .hwp 레코드 해독은 hwp.js(Apache-2.0, Han Lee and contributors)를 참고해 이식했다.

mod doc;
mod docx;
mod hwpx;
mod intern;
mod model;
mod odt;
mod parse;
mod reader;
mod record;
mod xml;
mod zipfs;

pub use doc::parse_doc_document;
pub use docx::parse_docx_document;
pub use hwpx::parse_hwpx_document;
pub use model::*;
pub use odt::parse_odt_document;
pub use parse::parse_document;

use wasm_bindgen::prelude::*;

/// 판별된 입력 포맷.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Format {
    Hwp,
    Hwpx,
    Docx,
    Odt,
    /// Word 97-2003 바이너리
    Doc,
}

impl Format {
    pub fn label(self) -> &'static str {
        match self {
            Format::Hwp => "hwp",
            Format::Hwpx => "hwpx",
            Format::Docx => "docx",
            Format::Odt => "odt",
            Format::Doc => "doc",
        }
    }
}

/// 확장자가 아니라 **내용물**로 포맷을 정한다. zip 계열은 컨테이너 안의
/// 표지 파일로, OLE 계열은 스트림 이름으로 구분한다.
pub fn sniff_format(data: &[u8]) -> Result<Format, String> {
    if data.starts_with(b"PK") {
        let mut zip = zipfs::open(data)?;
        if zipfs::has(&mut zip, "Contents/header.xml") {
            return Ok(Format::Hwpx);
        }
        if zipfs::has(&mut zip, "word/document.xml") {
            return Ok(Format::Docx);
        }
        if zipfs::has(&mut zip, "content.xml") {
            return Ok(Format::Odt);
        }
        return Err("알 수 없는 zip 문서 — hwpx/docx/odt가 아님".into());
    }
    if data.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        // CFB(OLE) 컨테이너: hwp는 FileHeader, Word 97-2003은 WordDocument 스트림을 갖는다
        let cursor = std::io::Cursor::new(data.to_vec());
        if let Ok(cfb) = cfb::CompoundFile::open(cursor) {
            if cfb.exists("/WordDocument") {
                return Ok(Format::Doc);
            }
        }
        return Ok(Format::Hwp);
    }
    Err("지원하지 않는 파일 형식 (hwp·hwpx·docx·odt)".into())
}

/// 포맷을 자동 판별해 알맞은 파서로 넘긴다.
pub fn parse_document_auto(data: &[u8]) -> Result<DocModel, String> {
    match sniff_format(data)? {
        Format::Hwp => parse_document(data),
        Format::Hwpx => parse_hwpx_document(data),
        Format::Docx => parse_docx_document(data),
        Format::Odt => parse_odt_document(data),
        Format::Doc => parse_doc_document(data),
    }
}

/// WASM 진입점: 문서 바이트 → 문서 모델 JSON 문자열 (포맷 자동 판별).
/// TS 쪽(src/lib/parser-wasm.ts)에서 JSON.parse해 DocModel로 쓴다.
#[wasm_bindgen]
pub fn parse_hwp_json(data: &[u8]) -> Result<String, JsError> {
    let model = parse_document_auto(data).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&model).map_err(|e| JsError::new(&e.to_string()))
}
