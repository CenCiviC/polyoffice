//! ODT(OpenDocument Text, ODF 1.3) 파싱 — `content.xml`을 PolyOffice 문서 모델로 매핑한다.
//! .hwp/.hwpx/.docx와 같은 DocModel 계약을 채운다.
//!
//! ODF는 서식을 전부 이름 붙은 스타일로 빼고 본문은 `text:style-name`으로 참조만 한다.
//! 그래서 content.xml의 자동 스타일과 styles.xml의 명명 스타일을 한 표로 합친 뒤
//! `parent-style-name` 체인을 따라 해석한다.

use std::collections::HashMap;

use roxmltree::Document;

use crate::intern::Interner;
use crate::model::*;
use crate::xml::{attr, check_depth, child, children, descendant, hex_rgb, Xml};
use crate::zipfs::{self, Zip};

/// CSS 길이 문자열("2.54cm", "12pt") → hwpunit(1/7200in). 퍼센트 등 상대 단위는 None.
/// 부호를 살리는 길이 파서 — `fo:text-indent`는 내어쓰기에서 음수로 온다.
/// `length`는 크기 전용이라 음수를 버리므로 그대로 쓸 수 없다.
fn signed_length(s: &str) -> Option<i32> {
    let t = s.trim();
    let (neg, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t),
    };
    let v = length(body)? as i32;
    Some(if neg { -v } else { v })
}

fn length(s: &str) -> Option<u32> {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic() || c == '%')?;
    let (value, unit) = s.split_at(split);
    let v: f64 = value.trim().parse().ok()?;
    let inches = match unit.trim() {
        "in" => v,
        "cm" => v / 2.54,
        "mm" => v / 25.4,
        "pt" => v / 72.0,
        "pc" => v / 6.0,
        "px" => v / 96.0,
        _ => return None,
    };
    if inches < 0.0 {
        return None;
    }
    Some((inches * 7200.0).round() as u32)
}

// ---------------- 서식 ----------------

#[derive(Clone, Default, PartialEq)]
struct TextFmt {
    size_hwp: Option<i32>,
    color: Option<[u8; 3]>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    font: Option<String>,
    /// style:text-position — 1 위첨자 · 2 아래첨자
    vert_align: Option<u8>,
}

impl TextFmt {
    fn overlay(&mut self, o: &TextFmt) {
        if o.size_hwp.is_some() {
            self.size_hwp = o.size_hwp;
        }
        if o.color.is_some() {
            self.color = o.color;
        }
        if o.bold.is_some() {
            self.bold = o.bold;
        }
        if o.italic.is_some() {
            self.italic = o.italic;
        }
        if o.underline.is_some() {
            self.underline = o.underline;
        }
        if o.font.is_some() {
            self.font = o.font.clone();
        }
        if o.vert_align.is_some() {
            self.vert_align = o.vert_align;
        }
    }
}

#[derive(Clone, Default)]
struct StyleDef {
    parent: Option<String>,
    text: TextFmt,
    align: Option<u8>,
    /// [왼쪽 들여쓰기, 첫 줄, 앞 여백, 뒤 여백] (hwpunit). 첫 줄은 음수 가능.
    margins: [Option<i32>; 4],
    background: Option<[u8; 3]>,
    /// 셀 테두리 — `Some(None)`이 "테두리 없음"이다 (미지정과 구별한다)
    border: Option<Option<Border>>,
    vert_align: Option<&'static str>,
    padding: [Option<u16>; 4],
    column_width: Option<u32>,
}

fn read_style(st: Xml) -> StyleDef {
    let tp = child(st, "text-properties");
    let pp = child(st, "paragraph-properties");
    let cp = child(st, "table-cell-properties");
    let colp = child(st, "table-column-properties");

    // fo:font-size는 pt 외에 %도 오는데, 상대값은 해석하지 않고 상속에 맡긴다.
    // 1/100pt와 hwpunit(1/7200in)은 같은 크기라 변환 없이 그대로 쓴다.
    let size_hwp = tp
        .and_then(|n| attr(n, "font-size"))
        .and_then(length)
        .map(|hwp| hwp as i32);

    let align = pp
        .and_then(|n| attr(n, "text-align"))
        .and_then(|v| match v {
            "start" | "left" => Some(1),
            "end" | "right" => Some(2),
            "center" => Some(3),
            "justify" => Some(0),
            _ => None,
        });

    let mut padding = [None; 4];
    if let Some(cp) = cp {
        let all = attr(cp, "padding").and_then(length);
        for (slot, name) in padding.iter_mut().zip([
            "padding-left",
            "padding-right",
            "padding-top",
            "padding-bottom",
        ]) {
            *slot = attr(cp, name)
                .and_then(length)
                .or(all)
                .map(|v| v.min(u16::MAX as u32) as u16);
        }
    }

    let margins = [
        pp.and_then(|n| attr(n, "margin-left")).and_then(signed_length),
        pp.and_then(|n| attr(n, "text-indent")).and_then(signed_length),
        pp.and_then(|n| attr(n, "margin-top")).and_then(signed_length),
        pp.and_then(|n| attr(n, "margin-bottom"))
            .and_then(signed_length),
    ];

    StyleDef {
        parent: attr(st, "parent-style-name").map(str::to_string),
        text: TextFmt {
            size_hwp,
            color: tp.and_then(|n| attr(n, "color")).and_then(hex_rgb),
            bold: tp
                .and_then(|n| attr(n, "font-weight"))
                .map(|v| v == "bold" || v.parse::<u32>().is_ok_and(|w| w >= 600)),
            italic: tp
                .and_then(|n| attr(n, "font-style"))
                .map(|v| v == "italic" || v == "oblique"),
            underline: tp
                .and_then(|n| attr(n, "text-underline-style"))
                .map(|v| v != "none"),
            font: tp
                .and_then(|n| attr(n, "font-name").or_else(|| attr(n, "font-family")))
                .map(|f| f.trim_matches('\'').to_string()),
            vert_align: tp.and_then(|n| attr(n, "text-position")).map(|v| {
                // "super 58%" · "sub 58%" · "33% 58%" · "-33% 58%" 모두 온다
                let first = v.split_whitespace().next().unwrap_or("");
                if first.starts_with("super") {
                    1
                } else if first.starts_with("sub") {
                    2
                } else {
                    match first.trim_end_matches('%').parse::<f64>() {
                        Ok(p) if p > 0.0 => 1,
                        Ok(p) if p < 0.0 => 2,
                        _ => 0,
                    }
                }
            }),
        },
        align,
        margins,
        background: cp
            .and_then(|n| attr(n, "background-color"))
            .and_then(hex_rgb),
        // fo:border는 CSS와 문법이 같다 — "2pt dashed #c2352b" 또는 "none"
        border: cp.and_then(|n| attr(n, "border")).map(read_border),
        vert_align: cp
            .and_then(|n| attr(n, "vertical-align"))
            .and_then(|v| match v {
                "top" => Some("top"),
                "middle" => Some("middle"),
                "bottom" => Some("bottom"),
                _ => None,
            }),
        padding,
        column_width: colp.and_then(|n| attr(n, "column-width")).and_then(length),
    }
}

/// `fo:border` 값 → IR 어휘. CSS 축약과 같은 문법이라 순서가 자유롭다.
fn read_border(v: &str) -> Option<Border> {
    let lower = v.to_ascii_lowercase();
    if lower.trim().is_empty() || lower.contains("none") || lower.contains("hidden") {
        return None;
    }
    let style = ["dashed", "dotted", "double"]
        .into_iter()
        .find(|k| lower.contains(k))
        .unwrap_or("solid");
    // 길이는 색(#rrggbb) 안의 숫자를 피해 따로 찾는다
    let width_pt = lower
        .split_whitespace()
        .filter(|t| !t.starts_with('#'))
        .find_map(length)
        .map(|hwp| hwp as f32 / 100.0)
        .unwrap_or(0.75);
    let color = lower
        .split_whitespace()
        .find(|t| t.starts_with('#'))
        .and_then(hex_rgb)
        .unwrap_or([0, 0, 0]);
    Some(Border {
        width_pt,
        style,
        color,
    })
}

#[derive(Default)]
struct Styles {
    defs: HashMap<String, StyleDef>,
    /// style-name → parent 체인까지 적용한 결과. 참조는 문단·span·셀·열마다 일어나는데
    /// 정의는 수십 개뿐이라 bake()에서 한 번 계산해 두고 그 뒤엔 조회만 한다.
    resolved: HashMap<String, StyleDef>,
    /// 이름이 없거나 모르는 스타일일 때 돌려줄 빈 정의
    empty: StyleDef,
    default_text: TextFmt,
}

impl Styles {
    fn collect(&mut self, doc: &Document) {
        for container in doc
            .root_element()
            .children()
            .filter(|n| matches!(n.tag_name().name(), "automatic-styles" | "styles"))
        {
            for st in children(container, "style") {
                if let Some(name) = attr(st, "style-name").or_else(|| attr(st, "name")) {
                    self.defs.insert(name.to_string(), read_style(st));
                }
            }
            // <style:default-style style:family="paragraph"> — 문서 전체 기본 서식
            for st in children(container, "default-style") {
                if attr(st, "family") == Some("paragraph") {
                    self.default_text.overlay(&read_style(st).text);
                }
            }
        }
    }

    /// 정의를 다 모은 뒤 한 번 부른다 — 이 뒤로 resolve()는 조회만 한다.
    fn bake(&mut self) {
        let names: Vec<String> = self.defs.keys().cloned().collect();
        for name in names {
            let r = self.walk(Some(&name), 0);
            self.resolved.insert(name, r);
        }
    }

    /// 미리 계산해 둔 결과를 빌려준다 (parent 체인을 다시 걷지 않는다).
    fn resolve(&self, name: Option<&str>) -> &StyleDef {
        name.and_then(|n| self.resolved.get(n)).unwrap_or(&self.empty)
    }

    fn walk(&self, name: Option<&str>, depth: u8) -> StyleDef {
        let Some(def) = name.and_then(|n| self.defs.get(n)) else {
            return StyleDef::default();
        };
        if depth > 12 {
            return def.clone();
        }
        let mut out = self.walk(def.parent.as_deref(), depth + 1);
        out.text.overlay(&def.text);
        if def.align.is_some() {
            out.align = def.align;
        }
        for (slot, v) in out.margins.iter_mut().zip(def.margins) {
            if v.is_some() {
                *slot = v;
            }
        }
        if def.background.is_some() {
            out.background = def.background;
        }
        if def.border.is_some() {
            out.border = def.border;
        }
        if def.vert_align.is_some() {
            out.vert_align = def.vert_align;
        }
        for (slot, v) in out.padding.iter_mut().zip(def.padding) {
            if v.is_some() {
                *slot = v;
            }
        }
        if def.column_width.is_some() {
            out.column_width = def.column_width;
        }
        out
    }
}

// ---------------- 본체 ----------------

struct Ctx<'z, 'd> {
    zip: &'z mut Zip<'d>,
    intern: Interner,
    styles: Styles,
    /// 목록 스타일 이름 → 수준별 "번호인가"
    list_styles: HashMap<String, Vec<bool>>,
    /// 지금 몇 겹 목록 안인가 (0이면 목록 밖). ODF는 중첩이 곧 수준이다
    list_level: u8,
    /// 수준마다 번호인지 글머리표인지
    list_ordered: Vec<bool>,
    /// 목록 인스턴스 일련번호 — 다른 목록끼리 번호가 이어지지 않게 한다
    list_seq: u16,
    /// 지금 목록이 쓰는 스타일 이름 (중첩된 목록은 이걸 물려받는다)
    list_style_name: Option<String>,
    /// 표 중첩 깊이 — WASM 스택이 얕아서 제한이 없으면 깊은 문서가 크래시한다
    depth: u8,
}

const MAX_NESTING: u8 = 16;

/// 브라우저가 실제로 그릴 수 있는 이미지 확장자.
/// ODF의 draw:frame은 같은 그림을 여러 포맷으로 담고 "그릴 수 있는 첫 번째를 쓰라"고 한다
/// — 앞자리에 eps·x-svm 같은 벡터 대체본이 오는 경우가 흔하다.
fn renderable(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
}

pub fn parse_odt_document(data: &[u8]) -> Result<DocModel, String> {
    let mut zip = zipfs::open(data)?;
    let content_xml = zipfs::text(&mut zip, "content.xml")?;
    let styles_xml = zipfs::text(&mut zip, "styles.xml").unwrap_or_default();

    check_depth(&content_xml, "content.xml")?;
    let content =
        Document::parse(&content_xml).map_err(|e| format!("content.xml 파싱 실패: {e}"))?;
    let styles_doc = check_depth(&styles_xml, "styles.xml")
        .ok()
        .and_then(|_| Document::parse(&styles_xml).ok());

    let mut styles = Styles::default();
    if let Some(sd) = styles_doc.as_ref() {
        styles.collect(sd);
    }
    styles.collect(&content);
    styles.bake();

    let mut section = Section::default();
    read_page_layout(styles_doc.as_ref(), &mut section);

    // 목록 스타일 — 첫 수준이 number면 번호, bullet이면 글머리표.
    // 본문(content.xml)과 styles.xml 둘 다에 있을 수 있다.
    // 목록 스타일 — 수준마다 번호인지 글머리표인지. 정의는 `style:name`으로 이름이 붙고
    // 본문의 `text:style-name`이 그걸 가리킨다(이름이 다른 속성이라 헷갈리기 쉽다).
    let mut list_styles: HashMap<String, Vec<bool>> = HashMap::new();
    for doc in [Some(&content), styles_doc.as_ref()].into_iter().flatten() {
        for ls in doc.root_element().descendants().filter(|n| n.tag_name().name() == "list-style") {
            let Some(name) = attr(ls, "name") else { continue };
            let mut levels = Vec::new();
            for lvl in ls.children().filter(|n| n.is_element()) {
                levels.push(lvl.tag_name().name() == "list-level-style-number");
            }
            list_styles.insert(name.to_string(), levels);
        }
    }

    let mut ctx = Ctx {
        zip: &mut zip,
        intern: Interner::default(),
        styles,
        list_styles,
        list_level: 0,
        list_ordered: Vec::new(),
        list_seq: 0,
        list_style_name: None,
        depth: 0,
    };

    let text_body = child(content.root_element(), "body")
        .and_then(|b| child(b, "text"))
        .ok_or("office:text 없음")?;
    // 머리말·꼬리말은 styles.xml의 master-page에 산다 — 본문 흐름 밖이다
    if let Some(sd) = styles_doc.as_ref() {
        if let Some(master) = sd
            .root_element()
            .descendants()
            .find(|n| n.tag_name().name() == "master-page")
        {
            for (tag, is_header) in [("header", true), ("footer", false)] {
                let Some(band) = child(master, tag) else { continue };
                let paras = ctx.blocks(band);
                if is_header {
                    section.header = paras;
                } else {
                    section.footer = paras;
                }
            }
        }
    }

    section.paragraphs = ctx.blocks(text_body);

    Ok(DocModel {
        version: "odt".into(),
        info: ctx.intern.info,
        sections: vec![section],
    })
}

/// styles.xml의 첫 페이지 레이아웃. 없으면 A4 세로 + 1인치 여백.
fn read_page_layout(styles_doc: Option<&Document>, section: &mut Section) {
    let props = styles_doc.and_then(|d| descendant(d.root_element(), "page-layout-properties"));
    let at = |name: &str, default: u32| {
        props
            .and_then(|p| attr(p, name))
            .and_then(length)
            .unwrap_or(default)
    };
    section.width = at("page-width", 59528);
    section.height = at("page-height", 84188);
    section.padding_left = at("margin-left", 7200);
    section.padding_right = at("margin-right", 7200);
    section.padding_top = at("margin-top", 7200);
    section.padding_bottom = at("margin-bottom", 7200);
}

impl Ctx<'_, '_> {
    fn blocks(&mut self, parent: Xml) -> Vec<Paragraph> {
        let mut out = Vec::new();
        for node in parent.children().filter(|n| n.is_element()) {
            match node.tag_name().name() {
                "p" | "h" => out.push(self.paragraph(node)),
                "table" => {
                    let table = self.table(node);
                    out.push(Paragraph {
                        shape_index: self.intern.para_shape(0),
                        tables: vec![table],
                        ..Default::default()
                    });
                }
                // 목록: 항목 안의 문단들을 그대로 펼친다 (개요 번호는 미지원)
                // 목록은 중첩으로 수준을 표현한다 — 깊이를 세어 문단에 실어 준다
                "list" => {
                    if self.list_level == 0 {
                        self.list_seq += 1;
                        self.list_style_name = None;
                    }
                    let ordered = self.is_ordered(node, self.list_level);
                    self.list_level += 1;
                    self.list_ordered.push(ordered);
                    out.extend(self.blocks(node));
                    self.list_ordered.pop();
                    self.list_level -= 1;
                }
                "list-item" | "list-header" | "section" => out.extend(self.blocks(node)),
                // 페이지·프레임에 앵커된 그림은 문단 밖에 놓인다 — 빈 문단에 실어 살린다
                "frame" => {
                    if let Some(img) = self.image(node) {
                        out.push(Paragraph {
                            shape_index: self.intern.para_shape(0),
                            images: vec![img],
                            ..Default::default()
                        });
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// 이 수준이 번호인가. 중첩된 `text:list`에는 style-name이 없고 바깥 스타일의
    /// 해당 수준 정의를 그대로 따른다 — 그래서 이름을 들고 다니며 수준으로 찾는다.
    fn is_ordered(&mut self, list: Xml, level: u8) -> bool {
        if let Some(name) = attr(list, "style-name") {
            self.list_style_name = Some(name.to_string());
        }
        self.list_style_name
            .as_deref()
            .and_then(|n| self.list_styles.get(n))
            .and_then(|levels| levels.get(level as usize).or_else(|| levels.last()))
            .copied()
            .unwrap_or(true)
    }

    fn paragraph(&mut self, p: Xml) -> Paragraph {
        let style = self.styles.resolve(attr(p, "style-name"));
        let mut fmt = self.styles.default_text.clone();
        fmt.overlay(&style.text);

        let m = style.margins;
        // 문단 머리 — text:h는 제목(개요), 목록 안의 문단은 목록 항목.
        // 목록 수준은 XML 중첩 깊이가 곧 수준이다(ODF는 속성으로 안 적는다).
        let head = if p.tag_name().name() == "h" {
            ParaHead {
                kind: HEAD_OUTLINE,
                level: attr(p, "outline-level")
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(1)
                    .saturating_sub(1),
                id: 0,
            }
        } else if self.list_level > 0 {
            ParaHead {
                kind: if *self.list_ordered.last().unwrap_or(&true) { HEAD_NUMBER } else { HEAD_BULLET },
                level: self.list_level - 1,
                // 목록마다 다른 id여야 번호가 새로 시작한다 — 여는 순간 붙인 일련번호를 쓴다
                id: self.list_seq,
            }
        } else {
            ParaHead::default()
        };
        let mut para = Paragraph {
            shape_index: self.intern.para_shape_h(
                style.align.unwrap_or(0),
                ParaMargins {
                    indent: m[0].unwrap_or(0),
                    first_line: m[1].unwrap_or(0),
                    space_before: m[2].unwrap_or(0),
                    space_after: m[3].unwrap_or(0),
                },
                head,
            ),
            ..Default::default()
        };
        self.inline(p, &fmt, &mut para, None);
        para
    }

    /// text:p 하위의 혼합 콘텐츠 — 텍스트 노드 + span/s/tab/line-break/frame
    fn inline(&mut self, node: Xml, fmt: &TextFmt, para: &mut Paragraph, link: Option<&str>) {
        for c in node.children() {
            if c.is_text() {
                self.push_text(c.text().unwrap_or(""), fmt, para, link);
                continue;
            }
            match c.tag_name().name() {
                "span" => {
                    let mut inner = fmt.clone();
                    inner.overlay(&self.styles.resolve(attr(c, "style-name")).text);
                    self.inline(c, &inner, para, link);
                }
                "a" => {
                    // text:a의 주소는 xlink:href
                    let href = attr(c, "href").map(str::to_string);
                    self.inline(c, fmt, para, href.as_deref().or(link));
                }
                "bookmark-ref" | "reference-ref" => self.inline(c, fmt, para, link),
                // 쪽번호 — 안의 글자는 마지막에 그려 둔 결과라 버리고 종류만 남긴다
                "page-number" | "page-count" => para.runs.push(Run {
                    char_shape_id: 0,
                    text: String::new(),
                    link: None,
                    field: Some(if node.tag_name().name() == "page-count" { "pages" } else { "page" }),
                }),
                "s" => {
                    let n: usize = attr(c, "c").and_then(|v| v.parse().ok()).unwrap_or(1);
                    self.push_text(&" ".repeat(n.min(256)), fmt, para, link);
                }
                "tab" => self.push_text("\t", fmt, para, link),
                "line-break" => self.push_text("\n", fmt, para, link),
                "frame" => {
                    if let Some(img) = self.image(c) {
                        para.images.push(img);
                    }
                }
                "note" => {
                    let paragraphs = child(c, "note-body")
                        .map(|b| self.blocks(b))
                        .unwrap_or_default();
                    if !paragraphs.is_empty() {
                        para.footnotes.push(Footnote { paragraphs });
                    }
                }
                // 페이지 번호·날짜 같은 필드는 표시 문자열을 그대로 쓴다
                _ => self.inline(c, fmt, para, link),
            }
        }
    }

    fn push_text(&mut self, text: &str, fmt: &TextFmt, para: &mut Paragraph, link: Option<&str>) {
        if text.is_empty() {
            return;
        }
        let shape = self.shape(fmt);
        // 링크가 다르면 합치지 않는다 — 합치면 링크 경계가 사라진다
        match para.runs.last_mut() {
            Some(last) if last.char_shape_id == shape && last.link.as_deref() == link => {
                last.text.push_str(text)
            }
            _ => para.runs.push(Run {
                char_shape_id: shape,
                text: text.to_string(),
                link: link.map(str::to_string),
                field: None,
            }),
        }
    }

    /// 해석한 텍스트 서식 → charShapeId
    fn shape(&mut self, fmt: &TextFmt) -> u32 {
        let font_id = self.intern.font(fmt.font.as_deref());
        let mut attr = 0u32;
        if fmt.italic == Some(true) {
            attr |= 0b01;
        }
        if fmt.bold == Some(true) {
            attr |= 0b10;
        }
        if fmt.underline == Some(true) {
            attr |= 1 << 2;
        }
        match fmt.vert_align {
            Some(1) => attr |= ATTR_SUPER,
            Some(2) => attr |= ATTR_SUB,
            _ => {}
        }
        // 1/100pt와 hwpunit은 같은 크기라 length()의 결과를 그대로 쓴다. 기본 10pt.
        let base = fmt.size_hwp.filter(|v| *v > 0).unwrap_or(1000);
        self.intern
            .char_shape(base, fmt.color.unwrap_or([0, 0, 0]), attr, font_id)
    }

    fn image(&mut self, frame: Xml) -> Option<Image> {
        // 대체본이 여러 개면 그릴 수 있는 것을 고른다 (없으면 첫 번째)
        let hrefs: Vec<&str> = children(frame, "image")
            .filter_map(|i| attr(i, "href"))
            .collect();
        let href = hrefs
            .iter()
            .find(|h| renderable(&zipfs::ext_of(h)))
            .or(hrefs.first())?;
        let path = href.trim_start_matches("./").to_string();
        let bytes = zipfs::bytes(self.zip, &path).ok()?;
        let bin_data_id = self.intern.bin_data(&path, &zipfs::ext_of(&path), &bytes);
        Some(Image {
            bin_data_id,
            width: attr(frame, "width").and_then(length).unwrap_or(0),
            height: attr(frame, "height").and_then(length).unwrap_or(0),
        })
    }

    fn table(&mut self, tbl: Xml) -> Table {
        if self.depth >= MAX_NESTING {
            return Table::default();
        }
        self.depth += 1;
        let out = self.table_inner(tbl);
        self.depth -= 1;
        out
    }

    fn table_inner(&mut self, tbl: Xml) -> Table {
        // 열 폭: table:table-column(+ number-columns-repeated)
        let mut widths: Vec<u32> = Vec::new();
        for col in children(tbl, "table-column") {
            let w = self
                .styles
                .resolve(attr(col, "style-name"))
                .column_width
                .unwrap_or(0);
            let repeat: usize = attr(col, "number-columns-repeated")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            widths.extend(std::iter::repeat_n(w, repeat.min(512)));
        }

        let rows: Vec<Xml> = children(tbl, "table-row").collect();
        let mut table = Table {
            row_count: rows.len() as u16,
            col_count: widths.len() as u16,
            rows: rows.iter().map(|_| Vec::new()).collect(),
            caption: Vec::new(),
        };

        for (ri, tr) in rows.iter().enumerate() {
            let mut gcol: u16 = 0;
            for tc in tr.children().filter(|n| n.is_element()) {
                let name = tc.tag_name().name();
                if name == "covered-table-cell" {
                    // 병합에 먹힌 자리 — 앞선 셀의 span이 이미 덮는다
                    gcol += 1;
                    continue;
                }
                if name != "table-cell" {
                    continue;
                }
                let span = |n: &str| -> u16 {
                    attr(tc, n).and_then(|v| v.parse().ok()).unwrap_or(1).max(1)
                };
                let col_span = span("number-columns-spanned");
                let style = self.styles.resolve(attr(tc, "style-name"));
                let from = gcol as usize;
                let to = (from + col_span as usize).min(widths.len());

                table.rows[ri].push(Cell {
                    col: gcol,
                    row: ri as u16,
                    col_span,
                    row_span: span("number-rows-spanned"),
                    width: widths.get(from..to).map(|s| s.iter().sum()).unwrap_or(0),
                    height: 0,
                    padding: [
                        style.padding[0].unwrap_or(0),
                        style.padding[1].unwrap_or(0),
                        style.padding[2].unwrap_or(0),
                        style.padding[3].unwrap_or(0),
                    ],
                    border_fill_id: Some(self.intern.fill_border(style.background, style.border)),
                    vert_align: style.vert_align,
                    paragraphs: self.blocks(tc),
                });
                gcol += col_span;
            }
        }
        table
    }
}
