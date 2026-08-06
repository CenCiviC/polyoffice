//! 네임스페이스에 둔감한 roxmltree 헬퍼.
//! OOXML(`w:val`)·ODF(`fo:font-size`)는 속성까지 접두사가 붙어서 roxmltree의
//! `attribute("val")`(네임스페이스 없는 속성만 매칭)로는 잡히지 않는다.
//! 이 모듈은 전부 **로컬 이름**으로만 비교한다.

use roxmltree::Node;

pub type Xml<'a> = Node<'a, 'a>;

pub fn attr<'a>(node: Xml<'a>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|a| a.name() == name)
        .map(|a| a.value())
}

/// 접두사 없는 로컬 이름이 같은 첫 자식.
pub fn child<'a>(node: Xml<'a>, name: &str) -> Option<Xml<'a>> {
    node.children().find(|n| n.tag_name().name() == name)
}

pub fn children<'a, 'n: 'a>(node: Xml<'n>, name: &'a str) -> impl Iterator<Item = Xml<'n>> + 'a {
    node.children().filter(move |n| n.tag_name().name() == name)
}

/// 자손 전체에서 로컬 이름이 같은 첫 노드.
pub fn descendant<'a>(node: Xml<'a>, name: &str) -> Option<Xml<'a>> {
    node.descendants().find(|n| n.tag_name().name() == name)
}

/// `<w:b/>` 처럼 존재만으로 참이지만 `w:val="0"`으로 끌 수 있는 토글 속성.
pub fn toggle(node: Option<Xml>, name: &str) -> Option<bool> {
    let el = child(node?, name)?;
    Some(!matches!(
        attr(el, "val"),
        Some("0") | Some("false") | Some("off")
    ))
}

pub fn num<T: std::str::FromStr>(node: Option<Xml>, name: &str) -> Option<T> {
    attr(node?, name)?.trim().parse().ok()
}

/// 실문서의 요소 중첩은 수십 단이면 충분하다. 표 30겹까지 여유를 두고 자른다.
pub const MAX_XML_DEPTH: usize = 256;

/// roxmltree는 중첩이 깊으면 파싱 도중 **스택을 넘겨 프로세스째 죽는다**
/// (WASM에서는 앱 전체가 내려간다). 파서에 넘기기 전에 바이트만 훑어 깊이를 재고,
/// 넘치면 크래시 대신 오류를 돌려준다.
pub fn check_depth(xml: &str, what: &str) -> Result<(), String> {
    let b = xml.as_bytes();
    let (mut i, mut depth, mut max) = (0usize, 0i64, 0i64);

    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        // 선언·주석·CDATA·DOCTYPE은 깊이에 세지 않고 통째로 건너뛴다
        let skip_to = |pat: &[u8], from: usize| -> usize {
            b[from..]
                .windows(pat.len())
                .position(|w| w == pat)
                .map(|p| from + p + pat.len())
                .unwrap_or(b.len())
        };
        if b[i..].starts_with(b"<!--") {
            i = skip_to(b"-->", i + 4);
            continue;
        }
        if b[i..].starts_with(b"<![CDATA[") {
            i = skip_to(b"]]>", i + 9);
            continue;
        }
        if b[i..].starts_with(b"<?") || b[i..].starts_with(b"<!") {
            i = skip_to(b">", i + 2);
            continue;
        }

        let closing = b.get(i + 1) == Some(&b'/');
        // 태그 끝을 찾되, 속성값 안의 '>'는 무시한다
        let mut j = i + 1;
        let mut quote = 0u8;
        while j < b.len() {
            match b[j] {
                q @ (b'"' | b'\'') if quote == 0 => quote = q,
                q if q == quote => quote = 0,
                b'>' if quote == 0 => break,
                _ => {}
            }
            j += 1;
        }
        let self_closing = j > i && b[j - 1] == b'/';

        if closing {
            depth -= 1;
        } else if !self_closing {
            depth += 1;
            max = max.max(depth);
            if max > MAX_XML_DEPTH as i64 {
                return Err(format!(
                    "{what}: XML 중첩이 {MAX_XML_DEPTH}단을 넘습니다 — \
                     정상 문서가 아니거나 표가 지나치게 겹쳐 있습니다"
                ));
            }
        }
        i = j + 1;
    }
    Ok(())
}

/// `#RRGGBB` · `RRGGBB` → [r, g, b]. `auto`/`none`은 None.
pub fn hex_rgb(s: &str) -> Option<[u8; 3]> {
    let hex = s.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, (v & 0xff) as u8])
}
