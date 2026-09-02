//! DOCX(OOXML, ECMA-376) 파싱 — `word/document.xml`을 Narro 문서 모델로 매핑한다.
//! .hwp/.hwpx와 같은 DocModel 계약을 채우므로 방출기(TS)는 포맷을 구분하지 않는다.
//!
//! 서식은 "직접 지정(rPr) > 스타일 체인(pStyle/rStyle + basedOn) > docDefaults" 순으로
//! 해석해 CharShape로 인턴한다. OOXML은 스타일 참조가 흔해서 직접 지정만 읽으면
//! 대부분의 실제 문서가 서식 없는 맨 텍스트로 나온다.

use std::collections::HashMap;

use roxmltree::Document;

use crate::intern::Interner;
use crate::model::*;
use crate::xml::{attr, check_depth, child, children, descendant, hex_rgb, num, toggle, Xml};
use crate::zipfs::{self, Zip};

/// twip(1/1440in) → hwpunit(1/7200in)
const TWIP: u32 = 5;
/// EMU(914400/in) → hwpunit
const EMU_PER_HWPUNIT: u32 = 127;

// ---------------- 서식 ----------------

#[derive(Clone, Default, PartialEq)]
struct RunFmt {
    half_pt: Option<i32>,
    color: Option<[u8; 3]>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    font: Option<String>,
    /// w:vertAlign — 1 위첨자 · 2 아래첨자 (0/None은 보통)
    vert_align: Option<u8>,
}

impl RunFmt {
    /// other(더 구체적인 층)를 self 위에 덮어쓴다.
    fn overlay(&mut self, other: &RunFmt) {
        if other.half_pt.is_some() {
            self.half_pt = other.half_pt;
        }
        if other.color.is_some() {
            self.color = other.color;
        }
        if other.bold.is_some() {
            self.bold = other.bold;
        }
        if other.italic.is_some() {
            self.italic = other.italic;
        }
        if other.underline.is_some() {
            self.underline = other.underline;
        }
        if other.font.is_some() {
            self.font = other.font.clone();
        }
        if other.vert_align.is_some() {
            self.vert_align = other.vert_align;
        }
    }
}

fn read_rpr(rpr: Option<Xml>) -> RunFmt {
    let Some(rpr) = rpr else {
        return RunFmt::default();
    };
    let fonts = child(rpr, "rFonts");
    // 한국어 문서는 eastAsia가 본문 글꼴 — 없으면 라틴 글꼴로 대체
    let font = ["eastAsia", "ascii", "hAnsi"]
        .iter()
        .find_map(|k| fonts.and_then(|f| attr(f, k)))
        .map(str::to_string);
    RunFmt {
        half_pt: num::<i32>(child(rpr, "sz"), "val"),
        color: child(rpr, "color")
            .and_then(|c| attr(c, "val"))
            .and_then(hex_rgb),
        bold: toggle(Some(rpr), "b"),
        italic: toggle(Some(rpr), "i"),
        underline: child(rpr, "u").map(|u| !matches!(attr(u, "val"), Some("none"))),
        font,
        vert_align: child(rpr, "vertAlign")
            .and_then(|v| attr(v, "val"))
            .map(|v| match v {
                "superscript" => 1,
                "subscript" => 2,
                _ => 0,
            }),
    }
}

/// 문단 여백 — 스타일 체인에서 덮어쓸 수 있게 층마다 Option으로 들고 있는다.
#[derive(Clone, Copy, Default, PartialEq)]
struct MarginFmt {
    indent: Option<i32>,
    first_line: Option<i32>,
    before: Option<i32>,
    after: Option<i32>,
}

impl MarginFmt {
    fn overlay(&mut self, o: &MarginFmt) {
        if o.indent.is_some() {
            self.indent = o.indent;
        }
        if o.first_line.is_some() {
            self.first_line = o.first_line;
        }
        if o.before.is_some() {
            self.before = o.before;
        }
        if o.after.is_some() {
            self.after = o.after;
        }
    }

    fn to_margins(self) -> ParaMargins {
        ParaMargins {
            indent: self.indent.unwrap_or(0),
            first_line: self.first_line.unwrap_or(0),
            space_before: self.before.unwrap_or(0),
            space_after: self.after.unwrap_or(0),
        }
    }
}

/// w:ind(들여쓰기)·w:spacing(앞뒤 여백) → hwpunit.
/// `w:hanging`은 내어쓰기라 **부호를 뒤집어** first_line 음수로 담는다 — IR 계약이 그렇게 정의돼 있다.
fn read_margins(ppr: Option<Xml>) -> MarginFmt {
    let Some(ppr) = ppr else {
        return MarginFmt::default();
    };
    let twip = |v: i32| v * TWIP as i32;
    let ind = child(ppr, "ind");
    let spacing = child(ppr, "spacing");
    let hanging = ind.and_then(|i| num::<i32>(Some(i), "hanging"));
    MarginFmt {
        indent: ind.and_then(|i| num::<i32>(Some(i), "left")).map(twip),
        first_line: match hanging {
            Some(h) => Some(twip(-h)),
            None => ind
                .and_then(|i| num::<i32>(Some(i), "firstLine"))
                .map(twip),
        },
        before: spacing.and_then(|s| num::<i32>(Some(s), "before")).map(twip),
        after: spacing.and_then(|s| num::<i32>(Some(s), "after")).map(twip),
    }
}

/// w:jc → HWP align enum (0 양쪽 · 1 왼쪽 · 2 오른쪽 · 3 가운데 · 4 배분)
fn read_align(ppr: Option<Xml>) -> Option<u8> {
    match attr(child(ppr?, "jc")?, "val")? {
        "left" | "start" => Some(1),
        "right" | "end" => Some(2),
        "center" => Some(3),
        "distribute" => Some(4),
        _ => Some(0),
    }
}

#[derive(Clone, Default)]
struct StyleDef {
    based_on: Option<String>,
    run: RunFmt,
    align: Option<u8>,
    margins: MarginFmt,
}

/// basedOn 체인을 다 적용한 결과. 스타일 수는 수십 개인데 참조는 문단·런마다
/// 일어나므로, load() 때 한 번 계산해 두고 그 뒤에는 조회만 한다.
#[derive(Clone, Default)]
struct Resolved {
    run: RunFmt,
    align: Option<u8>,
    margins: MarginFmt,
}

#[derive(Default)]
struct Styles {
    defs: HashMap<String, StyleDef>,
    /// styleId → basedOn까지 적용한 결과 (load()에서 미리 채운다)
    resolved: HashMap<String, Resolved>,
    /// 이름이 없거나 모르는 스타일일 때 돌려줄 빈 결과
    empty: Resolved,
    default_run: RunFmt,
    default_align: Option<u8>,
    default_margins: MarginFmt,
    /// `w:default="1"`인 문단 스타일 — pStyle이 없는 문단이 물려받는다
    default_para_style: Option<String>,
}

impl Styles {
    fn load(doc: Option<&Document>) -> Styles {
        let mut out = Styles::default();
        let Some(doc) = doc else { return out };
        let root = doc.root_element();

        if let Some(dd) = child(root, "docDefaults") {
            out.default_run = read_rpr(child(dd, "rPrDefault").and_then(|d| child(d, "rPr")));
            out.default_align = read_align(child(dd, "pPrDefault").and_then(|d| child(d, "pPr")));
            out.default_margins = read_margins(child(dd, "pPrDefault").and_then(|d| child(d, "pPr")));
        }
        for st in children(root, "style") {
            let Some(id) = attr(st, "styleId") else {
                continue;
            };
            if attr(st, "default") == Some("1") && attr(st, "type") == Some("paragraph") {
                out.default_para_style = Some(id.to_string());
            }
            out.defs.insert(
                id.to_string(),
                StyleDef {
                    based_on: child(st, "basedOn")
                        .and_then(|b| attr(b, "val"))
                        .map(str::to_string),
                    run: read_rpr(child(st, "rPr")),
                    align: read_align(child(st, "pPr")),
                    margins: read_margins(child(st, "pPr")),
                },
            );
        }
        let ids: Vec<String> = out.defs.keys().cloned().collect();
        for id in ids {
            let r = out.walk(Some(&id), 0);
            out.resolved.insert(id, r);
        }
        out
    }

    /// basedOn 체인을 뿌리부터 적용한다. 순환 참조는 깊이로 끊는다. load()에서만 부른다.
    fn walk(&self, id: Option<&str>, depth: u8) -> Resolved {
        let Some(def) = id.and_then(|i| self.defs.get(i)) else {
            return Resolved::default();
        };
        if depth > 12 {
            return Resolved {
                run: def.run.clone(),
                align: def.align,
                margins: def.margins,
            };
        }
        let mut out = self.walk(def.based_on.as_deref(), depth + 1);
        out.run.overlay(&def.run);
        if def.align.is_some() {
            out.align = def.align;
        }
        out.margins.overlay(&def.margins);
        out
    }

    /// 미리 계산해 둔 결과를 빌려준다 (체인을 다시 걷지 않는다).
    fn resolve(&self, id: Option<&str>) -> &Resolved {
        id.and_then(|i| self.resolved.get(i)).unwrap_or(&self.empty)
    }
}

// ---------------- 본체 ----------------

struct Ctx<'z, 'd> {
    zip: &'z mut Zip<'d>,
    intern: Interner,
    /// r:id → 패키지 내부 경로 (그림 등 내부 파트)
    rels: HashMap<String, String>,
    /// r:id → 외부 주소. 하이퍼링크는 `TargetMode="External"`이라 위 지도에 안 들어간다.
    ext_rels: HashMap<String, String>,
    styles: Styles,
    numbering: Numbering,
    /// 표 안의 표 중첩 깊이 — WASM 스택이 얕아서 제한이 없으면 깊은 문서가 크래시한다
    depth: u8,
}

/// numbering.xml — numId·수준 → 글머리표인가.
/// 번호와 글머리표는 IR에서 `ol`/`ul`로 갈리므로 이 구분만 있으면 된다.
#[derive(Default)]
struct Numbering {
    bullets: HashMap<(u16, u8), bool>,
}

impl Numbering {
    fn load(doc: Option<&Document>) -> Self {
        let mut out = Self::default();
        let Some(d) = doc else { return out };
        let root = d.root_element();
        // abstractNumId → 수준별 글머리표 여부
        let mut abstracts: HashMap<&str, HashMap<u8, bool>> = HashMap::new();
        for an in children(root, "abstractNum") {
            let Some(id) = attr(an, "abstractNumId") else { continue };
            let mut levels = HashMap::new();
            for lvl in children(an, "lvl") {
                let n = num::<u8>(Some(lvl), "ilvl").unwrap_or(0);
                let fmt = child(lvl, "numFmt").and_then(|f| attr(f, "val")).unwrap_or("decimal");
                levels.insert(n, fmt == "bullet" || fmt == "none");
            }
            abstracts.insert(id, levels);
        }
        // num(인스턴스) → abstractNum
        for num_el in children(root, "num") {
            let Some(id) = num::<u16>(Some(num_el), "numId") else { continue };
            let Some(aid) = child(num_el, "abstractNumId").and_then(|a| attr(a, "val")) else {
                continue;
            };
            if let Some(levels) = abstracts.get(aid) {
                for (lvl, bullet) in levels {
                    out.bullets.insert((id, *lvl), *bullet);
                }
            }
        }
        out
    }

    fn is_bullet(&self, id: u16, level: u8) -> bool {
        self.bullets.get(&(id, level)).copied().unwrap_or(false)
    }
}

/// 실문서의 중첩은 서너 겹이면 충분하다. 넘어가면 더 파고들지 않고 잘라낸다.
const MAX_NESTING: u8 = 16;

pub fn parse_docx_document(data: &[u8]) -> Result<DocModel, String> {
    let mut zip = zipfs::open(data)?;
    let doc_xml = zipfs::text(&mut zip, "word/document.xml")?;
    let styles_xml = zipfs::text(&mut zip, "word/styles.xml").unwrap_or_default();
    let footnotes_xml = zipfs::text(&mut zip, "word/footnotes.xml").unwrap_or_default();
    let rels_xml = zipfs::text(&mut zip, "word/_rels/document.xml.rels").unwrap_or_default();
    let numbering_xml = zipfs::text(&mut zip, "word/numbering.xml").unwrap_or_default();

    check_depth(&doc_xml, "word/document.xml")?;
    let doc = Document::parse(&doc_xml).map_err(|e| format!("word/document.xml 파싱 실패: {e}"))?;
    let styles_doc = Document::parse(&styles_xml).ok();
    let footnotes_doc = Document::parse(&footnotes_xml).ok();
    let rels_doc = Document::parse(&rels_xml).ok();
    let numbering_doc = Document::parse(&numbering_xml).ok();

    let mut rels = HashMap::new();
    let mut ext_rels = HashMap::new();
    if let Some(rd) = rels_doc.as_ref() {
        for rel in rd.root_element().children().filter(|n| n.is_element()) {
            let (Some(id), Some(target)) = (attr(rel, "Id"), attr(rel, "Target")) else {
                continue;
            };
            if attr(rel, "TargetMode") == Some("External") {
                ext_rels.insert(id.to_string(), target.to_string());
                continue;
            }
            let path = if let Some(abs) = target.strip_prefix('/') {
                abs.to_string()
            } else {
                format!("word/{target}")
            };
            rels.insert(id.to_string(), path);
        }
    }

    let mut ctx = Ctx {
        zip: &mut zip,
        intern: Interner::default(),
        rels,
        ext_rels,
        styles: Styles::load(styles_doc.as_ref()),
        numbering: Numbering::load(numbering_doc.as_ref()),
        depth: 0,
    };

    // 각주 본문: w:id → 문단들. separator/continuationSeparator는 본문이 아니라 제외.
    let mut footnotes: HashMap<String, Xml> = HashMap::new();
    if let Some(fd) = footnotes_doc.as_ref() {
        for fnote in children(fd.root_element(), "footnote") {
            if matches!(
                attr(fnote, "type"),
                Some("separator") | Some("continuationSeparator")
            ) {
                continue;
            }
            if let Some(id) = attr(fnote, "id") {
                footnotes.insert(id.to_string(), fnote);
            }
        }
    }

    let body = child(doc.root_element(), "body").ok_or("w:body 없음")?;
    let mut section = Section::default();
    let sect_pr = child(body, "sectPr");
    read_sect_pr(sect_pr, &mut section);

    // 머리말·꼬리말은 별도 파트다 — sectPr의 관계 참조를 따라간다.
    // 본문보다 먼저 읽어야 문단 순서가 아니라 구역 속성으로 남는다.
    for (tag, root_name) in [("headerReference", "hdr"), ("footerReference", "ftr")] {
        let Some(rid) = sect_pr
            .and_then(|sp| children(sp, tag).find(|r| attr(*r, "type") != Some("first")))
            .and_then(|r| attr(r, "id"))
        else {
            continue;
        };
        let Some(path) = ctx.rels.get(rid).cloned() else { continue };
        let Ok(xml) = zipfs::text(ctx.zip, &path) else { continue };
        let Ok(part) = Document::parse(&xml) else { continue };
        if part.root_element().tag_name().name() != root_name {
            continue;
        }
        let paras = ctx.blocks(part.root_element(), &footnotes);
        if root_name == "hdr" {
            section.header = paras;
        } else {
            section.footer = paras;
        }
    }

    section.paragraphs = ctx.blocks(body, &footnotes);

    Ok(DocModel {
        version: "docx".into(),
        info: ctx.intern.info,
        sections: vec![section],
    })
}

/// 페이지 크기·여백. sectPr이 없거나 비어 있는 docx(변환기가 만든 파일 등)도 흔해서
/// A4 세로 + 1인치 여백을 기본값으로 둔다 — 0을 남기면 페이지가 접혀 렌더가 깨진다.
fn read_sect_pr(sect_pr: Option<Xml>, section: &mut Section) {
    let sz = sect_pr.and_then(|s| child(s, "pgSz"));
    section.width = num::<u32>(sz, "w").filter(|v| *v > 0).unwrap_or(11906) * TWIP;
    section.height = num::<u32>(sz, "h").filter(|v| *v > 0).unwrap_or(16838) * TWIP;

    let m = sect_pr.and_then(|s| child(s, "pgMar"));
    let at = |name: &str, default: u32| {
        num::<i64>(m, name)
            .filter(|v| *v >= 0)
            .map(|v| v as u32)
            .unwrap_or(default)
            * TWIP
    };
    section.padding_left = at("left", 1440);
    section.padding_right = at("right", 1440);
    section.padding_top = at("top", 1440);
    section.padding_bottom = at("bottom", 1440);
    section.header_padding = at("header", 720);
    section.footer_padding = at("footer", 720);
}

type Footnotes<'a> = HashMap<String, Xml<'a>>;

impl Ctx<'_, '_> {
    /// 블록 컨테이너(body·tc)의 자식들 → 문단 목록.
    /// 표는 자체 문단을 갖지 않으므로 빈 문단에 실어 보낸다(.hwp 경로와 같은 모양).
    fn blocks(&mut self, parent: Xml, fns: &Footnotes) -> Vec<Paragraph> {
        let mut out = Vec::new();
        for node in parent.children().filter(|n| n.is_element()) {
            match node.tag_name().name() {
                "p" => out.push(self.paragraph(node, fns)),
                "tbl" => {
                    let table = self.table(node, fns);
                    out.push(Paragraph {
                        shape_index: self.intern.para_shape(0),
                        tables: vec![table],
                        ..Default::default()
                    });
                }
                _ => {}
            }
        }
        out
    }

    fn paragraph(&mut self, p: Xml, fns: &Footnotes) -> Paragraph {
        let ppr = child(p, "pPr");
        // pStyle이 없으면 문서 기본 문단 스타일(w:default="1")을 쓴다 — Word의 동작
        let style_id = ppr
            .and_then(|pr| child(pr, "pStyle"))
            .and_then(|s| attr(s, "val"))
            .or(self.styles.default_para_style.as_deref());
        let style = self.styles.resolve(style_id);

        let align = read_align(ppr)
            .or(style.align)
            .or(self.styles.default_align)
            .unwrap_or(0);
        // 여백도 정렬과 같은 순서로 겹친다: docDefaults ← 문단 스타일 ← 직접 지정
        let mut margins = self.styles.default_margins;
        margins.overlay(&style.margins);
        margins.overlay(&read_margins(ppr));
        // 문단 머리 — 제목은 w:outlineLvl(또는 Heading 스타일), 목록은 w:numPr.
        // 둘 다 없으면 보통 문단이다.
        let head = read_head(ppr, style_id, &self.numbering);
        let mut para = Paragraph {
            shape_index: self.intern.para_shape_h(align, margins.to_margins(), head),
            ..Default::default()
        };

        // 문단 기본 서식 = docDefaults ← 문단 스타일
        let mut base = self.styles.default_run.clone();
        base.overlay(&style.run);
        self.runs_of(p, &base, &mut para, fns, None);
        para
    }

    /// w:r 및 이를 감싸는 w:hyperlink/w:smartTag/w:ins 등을 훑는다.
    /// `link`는 감싸고 있는 w:hyperlink에서 내려온다 (런 자신에는 주소가 없다).
    fn runs_of(
        &mut self,
        parent: Xml,
        base: &RunFmt,
        para: &mut Paragraph,
        fns: &Footnotes,
        link: Option<&str>,
    ) {
        for node in parent.children().filter(|n| n.is_element()) {
            match node.tag_name().name() {
                "r" => self.run(node, base, para, fns, link),
                "hyperlink" => {
                    // 외부 주소는 관계로, 문서 내 앵커는 w:anchor로 온다
                    let target = attr(node, "id")
                        .and_then(|id| self.ext_rels.get(id))
                        .cloned()
                        .or_else(|| attr(node, "anchor").map(|a| format!("#{a}")));
                    self.runs_of(node, base, para, fns, target.as_deref().or(link));
                }
                "smartTag" | "ins" | "sdt" | "sdtContent" | "bookmarkStart" => {
                    self.runs_of(node, base, para, fns, link)
                }
                // 쪽번호 필드 — 안에 든 글자는 Word가 마지막에 그려 둔 **결과**라 버린다.
                // 종류만 남기고 숫자는 렌더가 다시 센다(IR-SPEC 규칙 2).
                "fldSimple" => {
                    let instr = attr(node, "instr").unwrap_or("").to_ascii_uppercase();
                    let kind = if instr.contains("NUMPAGES") {
                        Some("pages")
                    } else if instr.contains("PAGE") {
                        Some("page")
                    } else {
                        None
                    };
                    match kind {
                        Some(k) => para.runs.push(Run {
                            char_shape_id: 0,
                            text: String::new(),
                            link: None,
                            field: Some(k),
                        }),
                        // 아는 필드가 아니면 안쪽 글자를 그대로 살린다
                        None => self.runs_of(node, base, para, fns, link),
                    }
                }
                _ => {}
            }
        }
    }

    fn run(
        &mut self,
        r: Xml,
        base: &RunFmt,
        para: &mut Paragraph,
        fns: &Footnotes,
        link: Option<&str>,
    ) {
        let rpr = child(r, "rPr");
        let mut fmt = base.clone();
        // 런 스타일(rStyle) → 직접 지정(rPr) 순으로 덮는다
        if let Some(id) = rpr
            .and_then(|p| child(p, "rStyle"))
            .and_then(|s| attr(s, "val"))
        {
            fmt.overlay(&self.styles.resolve(Some(id)).run);
        }
        fmt.overlay(&read_rpr(rpr));
        let shape = self.shape(&fmt);

        let mut text = String::new();
        for node in r.children().filter(|n| n.is_element()) {
            match node.tag_name().name() {
                "t" | "delText" => {
                    // 대부분 \r이 없다 — 있을 때만 새로 만든다
                    let raw = node.text().unwrap_or("");
                    match raw.contains('\r') {
                        true => text.push_str(&raw.replace('\r', "")),
                        false => text.push_str(raw),
                    }
                }
                "br" | "cr" => text.push('\n'),
                "tab" => text.push('\t'),
                "noBreakHyphen" => text.push('-'),
                "softHyphen" => {}
                "drawing" | "pict" | "object" => {
                    if let Some(img) = self.image(node) {
                        para.images.push(img);
                    }
                }
                "footnoteReference" | "endnoteReference" => {
                    if let Some(fnote) = attr(node, "id").and_then(|id| fns.get(id)).copied() {
                        let paragraphs = self.blocks(fnote, fns);
                        if !paragraphs.is_empty() {
                            para.footnotes.push(Footnote { paragraphs });
                        }
                    }
                }
                _ => {}
            }
        }

        if !text.is_empty() {
            // 링크가 다르면 합치면 안 된다 — 합치면 링크 경계가 사라진다
            match para.runs.last_mut() {
                Some(last) if last.char_shape_id == shape && last.link.as_deref() == link => {
                    last.text.push_str(&text)
                }
                _ => para.runs.push(Run {
                    char_shape_id: shape,
                    text,
                    link: link.map(str::to_string),
                    field: None,
                }),
            }
        }
    }

    /// 해석한 런 서식 → charShapeId
    fn shape(&mut self, fmt: &RunFmt) -> u32 {
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
        // w:sz는 하프포인트 — 1/100pt로 바꾼다. 미지정은 Word 기본 10pt.
        let base = fmt.half_pt.filter(|v| *v > 0).unwrap_or(20) * 50;
        self.intern
            .char_shape(base, fmt.color.unwrap_or([0, 0, 0]), attr, font_id)
    }

    fn image(&mut self, node: Xml) -> Option<Image> {
        // DrawingML은 a:blip/@r:embed, 구형 VML은 v:imagedata/@r:id
        let rid = descendant(node, "blip")
            .and_then(|b| attr(b, "embed"))
            .or_else(|| descendant(node, "imagedata").and_then(|i| attr(i, "id")))?;
        let path = self.rels.get(rid)?.clone();

        let bytes = zipfs::bytes(self.zip, &path).ok()?;
        let bin_data_id = self.intern.bin_data(&path, &zipfs::ext_of(&path), &bytes);

        let extent = descendant(node, "extent");
        let emu = |name: &str| num::<u64>(extent, name).unwrap_or(0) as u32 / EMU_PER_HWPUNIT;
        Some(Image {
            bin_data_id,
            width: emu("cx"),
            height: emu("cy"),
        })
    }

    fn table(&mut self, tbl: Xml, fns: &Footnotes) -> Table {
        if self.depth >= MAX_NESTING {
            return Table::default();
        }
        self.depth += 1;
        let out = self.table_inner(tbl, fns);
        self.depth -= 1;
        out
    }

    fn table_inner(&mut self, tbl: Xml, fns: &Footnotes) -> Table {
        // 표 기본 테두리 — 셀이 tcBorders로 덮지 않으면 이걸 쓴다
        let tbl_borders = child(tbl, "tblPr").and_then(|p| child(p, "tblBorders"));
        let grid: Vec<u32> = child(tbl, "tblGrid")
            .map(|g| {
                children(g, "gridCol")
                    .map(|c| num::<u32>(Some(c), "w").unwrap_or(0) * TWIP)
                    .collect()
            })
            .unwrap_or_default();

        let rows: Vec<Xml> = children(tbl, "tr").collect();
        let mut table = Table {
            row_count: rows.len() as u16,
            col_count: grid.len() as u16,
            rows: rows.iter().map(|_| Vec::new()).collect(),
            caption: Vec::new(),
        };

        // 표 기본 셀 여백 (Word 기본값은 좌우 108twip)
        let tbl_mar = child(tbl, "tblPr").and_then(|p| child(p, "tblCellMar"));
        let default_padding = cell_margin(tbl_mar, [108 * TWIP as u16, 108 * TWIP as u16, 0, 0]);

        // 세로 병합(vMerge): restart 셀을 기억해 두고 continue가 나올 때마다 rowSpan을 늘린다
        let mut anchors: HashMap<u16, (usize, usize)> = HashMap::new();

        for (ri, tr) in rows.iter().enumerate() {
            let mut gcol: u16 = 0;
            for tc in children(*tr, "tc") {
                let pr = child(tc, "tcPr");
                let col_span = pr
                    .and_then(|p| child(p, "gridSpan"))
                    .and_then(|g| num::<u16>(Some(g), "val"))
                    .unwrap_or(1)
                    .max(1);
                let vmerge = pr.and_then(|p| child(p, "vMerge"));
                let continues = vmerge.is_some_and(|v| attr(v, "val") != Some("restart"));

                if continues {
                    if let Some(&(ar, ai)) = anchors.get(&gcol) {
                        if let Some(anchor) = table.rows.get_mut(ar).and_then(|r| r.get_mut(ai)) {
                            anchor.row_span += 1;
                        }
                    }
                    gcol += col_span;
                    continue;
                }

                // 폭: tcW(dxa)가 우선, 없으면 tblGrid에서 걸치는 열들을 더한다
                let width = pr
                    .and_then(|p| child(p, "tcW"))
                    .filter(|w| attr(*w, "type") != Some("pct"))
                    .and_then(|w| num::<u32>(Some(w), "w"))
                    .filter(|w| *w > 0)
                    .map(|w| w * TWIP)
                    .unwrap_or_else(|| {
                        let from = gcol as usize;
                        let to = (from + col_span as usize).min(grid.len());
                        grid.get(from..to).map(|s| s.iter().sum()).unwrap_or(0)
                    });

                let background = pr
                    .and_then(|p| child(p, "shd"))
                    .and_then(|s| attr(s, "fill"))
                    .and_then(hex_rgb);
                // 테두리: 셀 지정(tcBorders)이 표 기본(tblBorders)을 덮는다. 네 변 중 대표 하나
                let border = Some(
                    ["top", "left", "bottom", "right"]
                        .iter()
                        .filter_map(|side| {
                            pr.and_then(|p| child(p, "tcBorders"))
                                .and_then(|b| child(b, side))
                                .or_else(|| tbl_borders.and_then(|b| child(b, side)))
                        })
                        .find_map(read_border),
                );
                let vert_align = pr
                    .and_then(|p| child(p, "vAlign"))
                    .and_then(|v| attr(v, "val"))
                    .map(|v| match v {
                        "top" => "top",
                        "bottom" => "bottom",
                        _ => "middle",
                    });

                let cell = Cell {
                    col: gcol,
                    row: ri as u16,
                    col_span,
                    row_span: 1,
                    width,
                    height: 0,
                    padding: cell_margin(pr.and_then(|p| child(p, "tcMar")), default_padding),
                    border_fill_id: Some(self.intern.fill_border(background, border)),
                    vert_align,
                    paragraphs: self.blocks(tc, fns),
                };
                table.rows[ri].push(cell);
                if vmerge.is_some() {
                    anchors.insert(gcol, (ri, table.rows[ri].len() - 1));
                }
                gcol += col_span;
            }
        }
        table
    }
}

/// `<w:top w:val w:sz w:color>` 한 변 → IR 어휘. sz는 1/8pt, `nil`/`none`이면 테두리 없음.
fn read_border(n: Xml) -> Option<Border> {
    let style = match attr(n, "val")? {
        "nil" | "none" => return None,
        "dashed" | "dashSmallGap" | "dotDash" | "dotDotDash" => "dashed",
        "dotted" => "dotted",
        v if v.starts_with("double") || v == "triple" => "double",
        _ => "solid",
    };
    let color = attr(n, "color").filter(|c| *c != "auto").and_then(hex_rgb);
    Some(Border {
        width_pt: num::<u32>(Some(n), "sz").unwrap_or(4) as f32 / 8.0,
        style,
        color: color.unwrap_or([0, 0, 0]),
    })
}

/// 문단 머리 — 제목은 `w:outlineLvl`(없으면 Heading 스타일 이름), 목록은 `w:numPr`.
/// 번호인지 글머리표인지는 numbering.xml의 numFmt가 안다.
fn read_head(ppr: Option<Xml>, style_id: Option<&str>, numbering: &Numbering) -> ParaHead {
    if let Some(lvl) = ppr
        .and_then(|pr| child(pr, "outlineLvl"))
        .and_then(|n| num::<u8>(Some(n), "val"))
        .or_else(|| {
            style_id
                .and_then(|s| s.strip_prefix("Heading"))
                .or_else(|| style_id.and_then(|s| s.strip_prefix("heading ")))
                .and_then(|n| n.parse::<u8>().ok())
                .map(|n| n.saturating_sub(1))
        })
    {
        return ParaHead { kind: HEAD_OUTLINE, level: lvl.min(9), id: 0 };
    }
    let Some(numpr) = ppr.and_then(|pr| child(pr, "numPr")) else {
        return ParaHead::default();
    };
    let level = child(numpr, "ilvl").and_then(|n| num::<u8>(Some(n), "val")).unwrap_or(0);
    let id = child(numpr, "numId").and_then(|n| num::<u16>(Some(n), "val")).unwrap_or(0);
    // numId 0은 "번호 없음"이라는 뜻이다 (Word 관례)
    if id == 0 {
        return ParaHead::default();
    }
    let bullet = numbering.is_bullet(id, level);
    ParaHead { kind: if bullet { HEAD_BULLET } else { HEAD_NUMBER }, level, id }
}

/// w:tcMar/w:tblCellMar → [left, right, top, bottom] (hwpunit)
fn cell_margin(node: Option<Xml>, default: [u16; 4]) -> [u16; 4] {
    let mut out = default;
    for (slot, name) in out.iter_mut().zip(["left", "right", "top", "bottom"]) {
        if let Some(v) = node
            .and_then(|n| child(n, name))
            .and_then(|e| num::<i64>(Some(e), "w"))
        {
            if v >= 0 {
                *slot = (v as u64 * TWIP as u64).min(u16::MAX as u64) as u16;
            }
        }
    }
    out
}
