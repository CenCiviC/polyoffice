// 네이티브 검증용: cargo run --example dump -- <file.hwp>
fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "tests/fixtures/BlogForm_BookReview.hwp".into());
    let data = std::fs::read(&path).expect("파일 읽기 실패");
    match hwp_core::parse_document(&data) {
        Ok(model) => println!("{}", serde_json::to_string_pretty(&model).unwrap()),
        Err(e) => {
            eprintln!("파싱 실패: {e}");
            std::process::exit(1);
        }
    }
}
