//! hwp-core — HWP 5.x 바이너리를 hwp2html 문서 모델(JSON 계약)로 파싱하는 코어.
//! 브라우저(WASM)·CLI·서버가 같은 크레이트를 쓴다.
//! 레코드 해독은 hwp.js(Apache-2.0, Han Lee and contributors)를 참고해 이식했다.

mod model;
mod parse;
mod reader;
mod record;

pub use model::*;
pub use parse::parse_document;

use wasm_bindgen::prelude::*;

/// WASM 진입점: HWP 바이트 → 문서 모델 JSON 문자열.
/// TS 쪽(src/lib/parser-wasm.ts)에서 JSON.parse해 DocModel로 쓴다.
#[wasm_bindgen]
pub fn parse_hwp_json(data: &[u8]) -> Result<String, JsError> {
    let model = parse_document(data).map_err(|e| JsError::new(&e))?;
    serde_json::to_string(&model).map_err(|e| JsError::new(&e.to_string()))
}
