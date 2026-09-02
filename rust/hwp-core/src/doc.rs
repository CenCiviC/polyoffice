//! DOC(Word 97-2003, MS-DOC) 파싱 — OLE 바이너리를 Narro 문서 모델로 매핑한다.
//!
//! .docx가 XML을 읽는 일이라면 .doc은 .hwp와 같은 부류의 바이트 해독이다. 구조:
//!
//! 1. `WordDocument` 스트림 맨 앞 FIB에 모든 것의 위치가 적혀 있다.
//! 2. 본문 텍스트는 **한 덩어리가 아니다.** 조각표(piece table, CLX)가
//!    "문자 위치(CP) 구간 → 파일 오프셋(FC)" 목록을 들고 있고, 조각마다
//!    cp1252 1바이트일 수도 UTF-16 2바이트일 수도 있다. 이걸 이어 붙여야 본문이 나온다.
//! 3. 서식은 FKP(512바이트 페이지) 배열에 FC 구간별로 흩어져 있다. 글자서식은 CHPX,
//!    문단서식은 PAPX. 각 서식은 sprm(2바이트 opcode + 피연산자) 목록이다.
//! 4. 표는 별도 구조가 아니라 **문단 속성**이다. 셀은 0x07로 끝나고, 행은
//!    sprmPFTtp가 켜진 문단으로 끝난다. 열 폭·병합은 sprmTDefTable 안에 있다.

use std::borrow::Cow;
use std::io::{Cursor, Read};

use crate::intern::Interner;
use crate::model::*;
use crate::reader::ByteReader;

/// twip(1/1440in) → hwpunit(1/7200in)
const TWIP: i32 = 5;

pub fn parse_doc_document(data: &[u8]) -> Result<DocModel, String> {
    let cursor = Cursor::new(data);
    let mut cfb = cfb::CompoundFile::open(cursor).map_err(|e| format!("CFB 열기 실패: {e}"))?;

    let wd = read_stream(&mut cfb, "/WordDocument")?;
    let fib = Fib::parse(&wd)?;
    let table = read_stream(&mut cfb, fib.table_stream)?;

    let pieces = Pieces::parse(&table, fib.fc_clx, fib.lcb_clx, fib.ccp_text)?;
    let doc = pieces.text(&wd);
    if doc.chars.is_empty() {
        return Err("본문 텍스트가 비어 있음 (조각표 해석 실패)".into());
    }

    let fonts = FontTable::parse(&table, fib.fc_sttbf_ffn, fib.lcb_sttbf_ffn);
    let chars_fmt = FormatRuns::chpx(&wd, &table, fib.fc_plcf_bte_chpx, fib.lcb_plcf_bte_chpx);
    let paras_fmt = FormatRuns::papx(&wd, &table, fib.fc_plcf_bte_papx, fib.lcb_plcf_bte_papx);

    let data_stream = read_stream(&mut cfb, "/Data").unwrap_or_default();
    let art = read_drawings(&[&wd, &data_stream], &table, &fib.fc_lcb_pairs);
    let mut builder = Builder {
        intern: Interner::default(),
        fonts,
        chars_fmt,
        paras_fmt,
        data: data_stream,
        art,
    };
    let paragraphs = builder.build(&doc);

    // .doc의 구역 설정(SEP)은 별도 PLC에 있어 아직 읽지 않는다 — A4 세로로 둔다
    let section = Section {
        width: 59528,
        height: 84188,
        padding_left: 7200,
        padding_right: 7200,
        padding_top: 7200,
        padding_bottom: 7200,
        header_padding: 3600,
        footer_padding: 3600,
        header: Vec::new(),
        footer: Vec::new(),
        paragraphs,
    };

    Ok(DocModel {
        version: format!("doc-{}", fib.n_fib),
        info: builder.intern.info,
        sections: vec![section],
    })
}

fn read_stream<F: Read + std::io::Seek>(
    cfb: &mut cfb::CompoundFile<F>,
    path: &str,
) -> Result<Vec<u8>, String> {
    let mut stream = cfb
        .open_stream(path)
        .map_err(|e| format!("{path} 스트림 없음: {e}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("{path} 읽기 실패: {e}"))?;
    Ok(buf)
}

// ---------------- FIB ----------------

struct Fib {
    n_fib: u16,
    table_stream: &'static str,
    ccp_text: u32,
    fc_clx: u32,
    lcb_clx: u32,
    fc_plcf_bte_chpx: u32,
    lcb_plcf_bte_chpx: u32,
    fc_plcf_bte_papx: u32,
    lcb_plcf_bte_papx: u32,
    fc_sttbf_ffn: u32,
    lcb_sttbf_ffn: u32,
    /// rgFcLcb 전체 — Office Drawing 저장소 위치를 이름 대신 내용으로 찾는 데 쓴다
    fc_lcb_pairs: Vec<(u32, u32)>,
}

impl Fib {
    fn parse(wd: &[u8]) -> Result<Fib, String> {
        if wd.len() < 160 {
            return Err("WordDocument 스트림이 너무 짧음".into());
        }
        // csw·cslw는 파일에서 읽은 개수라 그대로 오프셋으로 쓰면 안 된다 —
        // 무검사로 인덱싱하면 잘린 .doc 하나로 패닉하고, WASM에서는 모듈째 죽는다.
        let u16at = |o: usize| -> Result<u16, String> {
            wd.get(o..o + 2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .ok_or_else(|| format!("FIB가 잘려 있음 (offset {o})"))
        };
        if u16at(0)? != 0xA5EC {
            return Err(format!("Word 시그니처 아님 (0x{:04X})", u16at(0)?));
        }
        let n_fib = u16at(2)?;
        let flags = u16at(10)?;
        if flags & 0x0100 != 0 {
            return Err("암호화된 문서는 지원하지 않음".into());
        }
        // fWhichTblStm(bit 9): 0이면 0Table, 1이면 1Table이 유효한 테이블 스트림
        let table_stream = if flags & 0x0200 != 0 {
            "/1Table"
        } else {
            "/0Table"
        };

        // FibBase(32) → csw + rgW97 → cslw + rgLw97 → cbRgFcLcb + rgFcLcb
        let csw = u16at(32)? as usize;
        let cslw_off = 34 + csw * 2;
        let cslw = u16at(cslw_off)? as usize;
        let rg_lw = cslw_off + 2;
        let cb_rg_fc_lcb_off = rg_lw + cslw * 4;
        let rg_fc_lcb = cb_rg_fc_lcb_off + 2;
        let cb_rg_fc_lcb = u16at(cb_rg_fc_lcb_off)? as usize;

        if wd.len() < rg_fc_lcb + cb_rg_fc_lcb * 8 {
            return Err("FIB가 잘려 있음".into());
        }
        // 여기서부터는 위 길이 검사가 덮는 범위라 인덱싱해도 안전하다
        let u32at = |o: usize| u32::from_le_bytes([wd[o], wd[o + 1], wd[o + 2], wd[o + 3]]);
        // rgLw97[3] = ccpText (본문 문자 수). 정상 파일은 cslw=22지만 잘린 파일도 온다
        let ccp_text = if cslw >= 4 { u32at(rg_lw + 12) } else { 0 };
        // rgFcLcb97은 (fc, lcb) 8바이트 쌍 배열 — 인덱스는 MS-DOC 스펙 순서
        let pair = |i: usize| -> (u32, u32) {
            if i >= cb_rg_fc_lcb {
                return (0, 0);
            }
            let o = rg_fc_lcb + i * 8;
            (u32at(o), u32at(o + 4))
        };
        let (fc_plcf_bte_chpx, lcb_plcf_bte_chpx) = pair(12);
        let (fc_plcf_bte_papx, lcb_plcf_bte_papx) = pair(13);
        let (fc_sttbf_ffn, lcb_sttbf_ffn) = pair(15);
        let (fc_clx, lcb_clx) = pair(33);
        let fc_lcb_pairs = (0..cb_rg_fc_lcb).map(pair).collect();

        Ok(Fib {
            n_fib,
            table_stream,
            ccp_text,
            fc_clx,
            lcb_clx,
            fc_plcf_bte_chpx,
            lcb_plcf_bte_chpx,
            fc_plcf_bte_papx,
            lcb_plcf_bte_papx,
            fc_sttbf_ffn,
            lcb_sttbf_ffn,
            fc_lcb_pairs,
        })
    }
}

// ---------------- 조각표(piece table) ----------------

struct Piece {
    cp_start: u32,
    cp_end: u32,
    fc: u32,
    /// true면 cp1252 1바이트, false면 UTF-16LE 2바이트
    compressed: bool,
}

struct Pieces(Vec<Piece>);

/// 본문 문자 + 각 문자의 파일 오프셋(FC). 서식은 FC 구간으로 매겨져 있어서
/// 문자마다 FC를 들고 있어야 나중에 O(1)로 서식을 붙일 수 있다.
struct DocText {
    chars: Vec<char>,
    fcs: Vec<u32>,
}

impl Pieces {
    fn parse(table: &[u8], fc_clx: u32, lcb_clx: u32, ccp_text: u32) -> Result<Pieces, String> {
        let clx = table
            .get(fc_clx as usize..(fc_clx as usize).saturating_add(lcb_clx as usize))
            .ok_or("CLX 위치가 테이블 스트림 밖")?;

        // CLX = Prc* 다음에 Pcdt 하나. Prc(0x01)는 건너뛰고 Pcdt(0x02)를 찾는다.
        let mut i = 0usize;
        let pcdt = loop {
            match clx.get(i) {
                Some(0x01) => {
                    let cb = u16::from_le_bytes([
                        *clx.get(i + 1).ok_or("CLX 잘림")?,
                        *clx.get(i + 2).ok_or("CLX 잘림")?,
                    ]) as usize;
                    i += 3 + cb;
                }
                Some(0x02) => {
                    let lcb = u32::from_le_bytes([
                        *clx.get(i + 1).ok_or("CLX 잘림")?,
                        *clx.get(i + 2).ok_or("CLX 잘림")?,
                        *clx.get(i + 3).ok_or("CLX 잘림")?,
                        *clx.get(i + 4).ok_or("CLX 잘림")?,
                    ]) as usize;
                    break clx.get(i + 5..i + 5 + lcb).ok_or("PlcPcd 잘림")?;
                }
                _ => return Err("CLX에 조각표(Pcdt)가 없음".into()),
            }
        };

        // PlcPcd: CP 배열(n+1개, 4바이트) + PCD 배열(n개, 8바이트)
        let n = pcdt.len().saturating_sub(4) / 12;
        if n == 0 {
            return Err("조각표가 비어 있음".into());
        }
        let cp_at = |k: usize| u32::from_le_bytes(pcdt[k * 4..k * 4 + 4].try_into().unwrap());
        let pcd_off = (n + 1) * 4;

        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            let o = pcd_off + k * 8;
            // PCD: flags(2) + fc(4) + prm(2)
            let raw = u32::from_le_bytes(pcdt[o + 2..o + 6].try_into().unwrap());
            // fc의 bit30이 켜져 있으면 cp1252 1바이트 인코딩이고 실제 오프셋은 절반이다
            let compressed = raw & 0x4000_0000 != 0;
            let fc = if compressed {
                (raw & 0x3FFF_FFFF) / 2
            } else {
                raw & 0x3FFF_FFFF
            };
            let (cp_start, cp_end) = (cp_at(k), cp_at(k + 1));
            if cp_end <= cp_start {
                continue;
            }
            out.push(Piece {
                cp_start,
                cp_end: cp_end.min(ccp_text.max(cp_start)),
                fc,
                compressed,
            });
        }
        Ok(Pieces(out))
    }

    fn text(&self, wd: &[u8]) -> DocText {
        let mut chars = Vec::new();
        let mut fcs = Vec::new();
        for p in &self.0 {
            let count = (p.cp_end - p.cp_start) as usize;
            for k in 0..count {
                if p.compressed {
                    let off = p.fc as usize + k;
                    let Some(&b) = wd.get(off) else { break };
                    chars.push(cp1252(b));
                    fcs.push(off as u32);
                } else {
                    let off = p.fc as usize + k * 2;
                    let (Some(&lo), Some(&hi)) = (wd.get(off), wd.get(off + 1)) else {
                        break;
                    };
                    let code = u16::from_le_bytes([lo, hi]);
                    chars.push(char::from_u32(code as u32).unwrap_or('\u{FFFD}'));
                    fcs.push(off as u32);
                }
            }
        }
        DocText { chars, fcs }
    }
}

/// cp1252 상위 영역(0x80-0x9F)만 유니코드와 다르다.
fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž',
        '\u{8F}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}',
        'ž', 'Ÿ',
    ];
    match b {
        0x80..=0x9F => HIGH[(b - 0x80) as usize],
        _ => b as char,
    }
}

// ---------------- sprm ----------------

/// sprm 하나: opcode + 피연산자 슬라이스.
struct Sprm<'a> {
    opcode: u16,
    operand: &'a [u8],
}

/// grpprl(sprm 나열)을 훑는다. 피연산자 길이는 opcode 상위 3비트(spra)가 정한다.
fn sprms(grpprl: &[u8]) -> Vec<Sprm<'_>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 2 <= grpprl.len() {
        let opcode = u16::from_le_bytes([grpprl[i], grpprl[i + 1]]);
        i += 2;
        let spra = opcode >> 13;
        let len = match spra {
            0 | 1 => 1,
            2 | 4 | 5 => 2,
            3 => 4,
            7 => 3,
            _ => {
                // 가변 길이. sprmTDefTable 계열만 2바이트 길이, 나머지는 1바이트.
                if opcode == 0xD608 || opcode == 0xD606 {
                    if i + 2 > grpprl.len() {
                        break;
                    }
                    let n = u16::from_le_bytes([grpprl[i], grpprl[i + 1]]) as usize;
                    i += 2;
                    n.saturating_sub(2)
                } else {
                    let Some(&n) = grpprl.get(i) else { break };
                    i += 1;
                    n as usize
                }
            }
        };
        // 선언된 길이가 남은 바이트를 넘는 경우가 실제로 있다(특히 sprmTDefTable).
        // 통째로 버리면 표 정보를 잃으므로 있는 만큼만 넘긴다.
        let end = (i + len).min(grpprl.len());
        out.push(Sprm {
            opcode,
            operand: &grpprl[i..end],
        });
        if end < i + len {
            break;
        }
        i = end;
    }
    out
}

// ---------------- FKP로 흩어진 서식 ----------------

#[derive(Clone, Copy, Default)]
struct ChpFmt {
    bold: bool,
    italic: bool,
    underline: bool,
    half_pt: Option<i32>,
    color: Option<[u8; 3]>,
    font: Option<u16>,
    /// sprmCFSpec — 이 문자는 글자가 아니라 특수 개체(그림·필드 등)다
    special: bool,
    /// sprmCPicLocation — Data 스트림 안 그림 위치
    pic_offset: Option<u32>,
    /// sprmCIss — 0 보통 · 1 위첨자 · 2 아래첨자
    iss: u8,
}

#[derive(Clone, Default)]
struct PapFmt {
    align: u8,
    /// 들여쓰기 계열 (twip). sprmPDxaLeft1은 음수면 내어쓰기다.
    dxa_left: i32,
    dxa_left1: i32,
    dya_before: i32,
    dya_after: i32,
    in_table: bool,
    /// 행 종결 문단 (sprmPFTtp) — 여기서 표의 한 행이 끝난다
    ttp: bool,
    /// 행 종결 문단에 실려 오는 열 정의 (폭·병합)
    tap: Option<Tap>,
}

#[derive(Clone, Default)]
struct Tap {
    /// 열 경계 (twip) — 폭은 이웃 경계의 차
    edges: Vec<i32>,
    /// 열별 (가로병합 시작, 가로병합 이어짐, 세로병합 시작, 세로병합 이어짐)
    cells: Vec<TcFlags>,
}

/// TC80의 세로 병합 플래그. 가로 병합은 별도 플래그를 쓰지 않고
/// "폭이 넓은 셀"로 표현되기 때문에 열 경계 격자로 계산한다.
#[derive(Clone, Copy, Default)]
struct TcFlags {
    vert_restart: bool,
    vert_merge: bool,
}

/// FC 구간별 서식 목록. 시작 FC로 정렬해 두고 이분 탐색한다.
struct FormatRuns<T> {
    runs: Vec<(u32, T)>,
}

impl<T: Clone + Default> FormatRuns<T> {
    fn at(&self, fc: u32) -> T {
        match self.runs.binary_search_by_key(&fc, |(f, _)| *f) {
            Ok(i) => self.runs[i].1.clone(),
            Err(0) => T::default(),
            Err(i) => self.runs[i - 1].1.clone(),
        }
    }
}

/// PlcBte: FC 배열(n+1) + 페이지 번호 배열(n). 각 페이지는 WordDocument의 512바이트 FKP.
fn fkp_pages(table: &[u8], fc: u32, lcb: u32) -> Vec<u32> {
    let Some(plc) = table.get(fc as usize..(fc as usize).saturating_add(lcb as usize)) else {
        return Vec::new();
    };
    let n = plc.len().saturating_sub(4) / 8;
    (0..n)
        .filter_map(|k| {
            let o = (n + 1) * 4 + k * 4;
            let v = u32::from_le_bytes(plc.get(o..o + 4)?.try_into().ok()?);
            Some(v & 0x003F_FFFF)
        })
        .collect()
}

impl FormatRuns<ChpFmt> {
    fn chpx(wd: &[u8], table: &[u8], fc: u32, lcb: u32) -> FormatRuns<ChpFmt> {
        let mut runs = Vec::new();
        for pn in fkp_pages(table, fc, lcb) {
            let Some(fkp) = wd.get(pn as usize * 512..pn as usize * 512 + 512) else {
                continue;
            };
            let crun = fkp[511] as usize;
            if crun == 0 || 4 * (crun + 1) + crun > 511 {
                continue;
            }
            for i in 0..crun {
                let start = u32::from_le_bytes(fkp[i * 4..i * 4 + 4].try_into().unwrap());
                let word_off = fkp[4 * (crun + 1) + i] as usize * 2;
                let mut fmt = ChpFmt::default();
                if word_off != 0 {
                    if let Some(&cb) = fkp.get(word_off) {
                        if let Some(grpprl) = fkp.get(word_off + 1..word_off + 1 + cb as usize) {
                            apply_chp(&mut fmt, grpprl);
                        }
                    }
                }
                runs.push((start, fmt));
            }
        }
        runs.sort_by_key(|(f, _)| *f);
        runs.dedup_by_key(|(f, _)| *f);
        FormatRuns { runs }
    }
}

impl FormatRuns<PapFmt> {
    fn papx(wd: &[u8], table: &[u8], fc: u32, lcb: u32) -> FormatRuns<PapFmt> {
        let mut runs = Vec::new();
        for pn in fkp_pages(table, fc, lcb) {
            let Some(fkp) = wd.get(pn as usize * 512..pn as usize * 512 + 512) else {
                continue;
            };
            let crun = fkp[511] as usize;
            if crun == 0 || 4 * (crun + 1) + crun * 13 > 511 {
                continue;
            }
            for i in 0..crun {
                let start = u32::from_le_bytes(fkp[i * 4..i * 4 + 4].try_into().unwrap());
                // rgbx: 항목당 13바이트, 첫 바이트가 PAPX의 워드 오프셋
                let word_off = fkp[4 * (crun + 1) + i * 13] as usize * 2;
                let mut fmt = PapFmt::default();
                if word_off != 0 {
                    if let Some(&cb) = fkp.get(word_off) {
                        // cb가 0이면 다음 바이트가 진짜 길이(워드 단위)
                        let (body_off, body_len) = if cb == 0 {
                            (
                                word_off + 2,
                                fkp.get(word_off + 1).copied().unwrap_or(0) as usize * 2,
                            )
                        } else {
                            (word_off + 1, cb as usize * 2 - 1)
                        };
                        // PAPX 본문은 istd(2바이트) 다음이 grpprl
                        if let Some(grpprl) = fkp.get(body_off + 2..body_off + body_len) {
                            apply_pap(&mut fmt, grpprl);
                        }
                    }
                }
                runs.push((start, fmt));
            }
        }
        runs.sort_by_key(|(f, _)| *f);
        runs.dedup_by_key(|(f, _)| *f);
        FormatRuns { runs }
    }
}

/// Word 색상 인덱스(sprmCIco) 팔레트
const ICO: [[u8; 3]; 17] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 255],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [255, 255, 0],
    [255, 255, 255],
    [0, 0, 128],
    [0, 128, 128],
    [0, 128, 0],
    [128, 0, 128],
    [128, 0, 0],
    [128, 128, 0],
    [128, 128, 128],
    [192, 192, 192],
];

fn apply_chp(fmt: &mut ChpFmt, grpprl: &[u8]) {
    for s in sprms(grpprl) {
        let one = s.operand.first().copied().unwrap_or(0);
        match s.opcode {
            // 토글 속성: 0 끄기 · 1 켜기 · 128 상속 · 129 반전 (상속/반전은 켜짐으로 근사)
            0x0835 => fmt.bold = one != 0,
            0x0836 => fmt.italic = one != 0,
            0x2A3E => fmt.underline = one != 0,
            0x4A43 if s.operand.len() >= 2 => {
                fmt.half_pt = Some(u16::from_le_bytes([s.operand[0], s.operand[1]]) as i32)
            }
            0x2A42 => fmt.color = ICO.get(one as usize).copied(),
            0x6870 if s.operand.len() >= 4 => {
                fmt.color = Some([s.operand[0], s.operand[1], s.operand[2]])
            }
            0x4A4F..=0x4A51 if s.operand.len() >= 2 => {
                fmt.font = Some(u16::from_le_bytes([s.operand[0], s.operand[1]]))
            }
            0x0855 => fmt.special = one != 0,
            // sprmCIss: 0 보통 · 1 위첨자 · 2 아래첨자
            0x2A48 => fmt.iss = one,
            0x6A03 if s.operand.len() >= 4 => {
                fmt.pic_offset = Some(u32::from_le_bytes([
                    s.operand[0],
                    s.operand[1],
                    s.operand[2],
                    s.operand[3],
                ]))
            }
            _ => {}
        }
    }
}

fn apply_pap(fmt: &mut PapFmt, grpprl: &[u8]) {
    for s in sprms(grpprl) {
        let one = s.operand.first().copied().unwrap_or(0);
        match s.opcode {
            // sprmPJc: 0 왼쪽 · 1 가운데 · 2 오른쪽 · 3 양쪽 (HWP enum과 순서가 다르다)
            0x2403 | 0x2461 => {
                fmt.align = match one {
                    1 => 3,
                    2 => 2,
                    3 => 0,
                    _ => 1,
                }
            }
            // 들여쓰기·문단 간격 (전부 2바이트 twip)
            0x840F if s.operand.len() >= 2 => {
                fmt.dxa_left = i16::from_le_bytes([s.operand[0], s.operand[1]]) as i32
            }
            0x8411 if s.operand.len() >= 2 => {
                fmt.dxa_left1 = i16::from_le_bytes([s.operand[0], s.operand[1]]) as i32
            }
            0xA413 if s.operand.len() >= 2 => {
                fmt.dya_before = i16::from_le_bytes([s.operand[0], s.operand[1]]) as i32
            }
            0xA414 if s.operand.len() >= 2 => {
                fmt.dya_after = i16::from_le_bytes([s.operand[0], s.operand[1]]) as i32
            }
            0x2416 => fmt.in_table = one != 0,
            0x2417 => fmt.ttp = one != 0,
            0xD608 => fmt.tap = parse_tdef(s.operand),
            _ => {}
        }
    }
}

/// sprmTDefTable 피연산자: itcMac(1) + 열 경계 (itcMac+1)×i16 + TC80 itcMac×20바이트
fn parse_tdef(operand: &[u8]) -> Option<Tap> {
    let itc = *operand.first()? as usize;
    if itc == 0 {
        return None;
    }
    let mut edges = Vec::with_capacity(itc + 1);
    for k in 0..=itc {
        let o = 1 + k * 2;
        edges.push(i16::from_le_bytes(operand.get(o..o + 2)?.try_into().ok()?) as i32);
    }
    let tc_base = 1 + (itc + 1) * 2;
    let cells = (0..itc)
        .map(|k| {
            let o = tc_base + k * 20;
            let grf = operand
                .get(o..o + 2)
                .and_then(|b| b.try_into().ok())
                .map(u16::from_le_bytes)
                .unwrap_or(0);
            TcFlags {
                vert_restart: grf & 0x0040 != 0,
                vert_merge: grf & 0x0020 != 0,
            }
        })
        .collect();
    Some(Tap { edges, cells })
}

// ---------------- 그림 (PICF + Escher BLIP) ----------------

/// 그림 하나: 실제 바이트와 표시 크기(hwpunit).
/// 바이트는 대개 Data 스트림이나 저장소를 그대로 빌린다 — DIB→BMP 변환처럼
/// 정말 새로 만들어야 할 때만 Owned가 된다.
struct DocPicture<'a> {
    ext: &'static str,
    bytes: Cow<'a, [u8]>,
    width: u32,
    height: u32,
}

/// `Data` 스트림의 주어진 위치에서 그림을 꺼낸다.
///
/// 위치에는 PICF(그림 서술자)가 있고, 그 헤더 뒤부터가 Office Drawing(Escher)
/// 레코드 트리다. 트리를 훑어 실제 이미지가 담긴 BLIP 레코드를 찾는다.
fn read_picture<'a>(
    data: &'a [u8],
    off: u32,
    store: &'a [(&'static str, Vec<u8>)],
) -> Option<DocPicture<'a>> {
    let picf = data.get(off as usize..)?;
    let u16at =
        |o: usize| -> Option<u16> { Some(u16::from_le_bytes([*picf.get(o)?, *picf.get(o + 1)?])) };
    let lcb =
        u32::from_le_bytes([*picf.first()?, *picf.get(1)?, *picf.get(2)?, *picf.get(3)?]) as usize;
    let cb_header = u16at(4)? as usize;
    if cb_header < 8 || cb_header > picf.len() {
        return None;
    }
    // PICMID는 헤더 28바이트 뒤부터: 원본 크기(twip)와 배율(1/1000 %)
    let dxa_goal = u16at(28)? as u32;
    let dya_goal = u16at(30)? as u32;
    let mx = u16at(32).filter(|v| *v > 0).unwrap_or(1000) as u32;
    let my = u16at(34).filter(|v| *v > 0).unwrap_or(1000) as u32;

    let end = if lcb > cb_header && lcb <= picf.len() {
        lcb
    } else {
        picf.len()
    };
    let escher = picf.get(cb_header..end)?;
    // 바이트가 PICF 뒤에 바로 붙어 있으면 그것을, 아니면 번호(pib)로 저장소에서 꺼낸다
    let from_store = |i: usize| -> Option<(&'static str, Cow<'a, [u8]>)> {
        let (ext, bytes) = store.get(i)?;
        Some((ext, Cow::Borrowed(bytes.as_slice())))
    };
    let (ext, bytes) = find_blip(escher)
        .or_else(|| from_store((find_pib(escher)? as usize).checked_sub(1)?))
        // 번호도 없는데 저장소에 그림이 하나뿐이면 그것으로 본다
        .or_else(|| {
            if store.len() == 1 {
                from_store(0)
            } else {
                None
            }
        })?;

    Some(DocPicture {
        ext,
        bytes,
        width: dxa_goal * mx / 1000 * TWIP as u32,
        height: dya_goal * my / 1000 * TWIP as u32,
    })
}

/// 문서의 Office Drawing 정보 — 그림 저장소와 "도형 → 그림 번호" 지도.
#[derive(Default)]
struct Drawings {
    /// 1번부터 매겨지는 그림 목록 (pib가 이 번호를 가리킨다)
    blips: Vec<(&'static str, Vec<u8>)>,
    /// 도형 식별자(spid) → pib
    pib_of_spid: std::collections::HashMap<u32, u32>,
    /// 문자 위치(CP) → 도형 식별자. 떠 있는 그림은 0x08 앵커가 여기로 연결된다.
    spid_at_cp: std::collections::HashMap<u32, u32>,
}

/// Office Drawing 정보를 읽는다.
///
/// FIB의 어느 항목이 드로잉인지는 스펙 인덱스를 외우는 대신 **레코드 타입이
/// 0xF000인지 확인해서** 찾는다. 그림 바이트는 저장소(FBSE) 안에 박혀 있기도 하고,
/// `foDelay`로 WordDocument 스트림 위치만 가리키기도 한다.
fn read_drawings(delay: &[&[u8]], table: &[u8], pairs: &[(u32, u32)]) -> Drawings {
    let mut out = Drawings::default();

    let Some(art) = pairs.iter().find_map(|&(fc, lcb)| {
        let buf = table.get(fc as usize..(fc as usize).checked_add(lcb as usize)?)?;
        let head = buf.get(..8)?;
        let ver_inst = u16::from_le_bytes([head[0], head[1]]);
        let rec_type = u16::from_le_bytes([head[2], head[3]]);
        (ver_inst & 0x000F == 0x000F && rec_type == 0xF000).then_some(buf)
    }) else {
        return out;
    };

    // 저장소: DggContainer > BStoreContainer(0xF001) > FBSE(0xF007)*
    for (_, _, dgg) in records(art).into_iter().filter(|(t, _, _)| *t == 0xF000) {
        for (_, _, bstore) in records(dgg).into_iter().filter(|(t, _, _)| *t == 0xF001) {
            for (_, _, fbse) in records(bstore).into_iter().filter(|(t, _, _)| *t == 0xF007) {
                let (ext, bytes) = read_fbse(delay, fbse);
                out.blips.push((ext, bytes.into_owned()));
            }
        }
    }

    // 도형: SpContainer(0xF004)를 전부 모아 spid ↔ pib를 잇는다.
    // OfficeArtContent는 DggContainer 다음에 "1바이트 라벨 + DgContainer"가 이어지는데,
    // 그 1바이트 때문에 통째로 레코드 배열로 훑으면 정렬이 어긋난다.
    let mut stack: Vec<&[u8]> = art_containers(art);
    while let Some(cur) = stack.pop() {
        for (rec_type, _, body) in records(cur) {
            if rec_type == 0xF004 {
                let spid = records(body)
                    .into_iter()
                    .find(|(t, _, _)| *t == 0xF00A)
                    .and_then(|(_, _, fsp)| fsp.get(..4)?.try_into().ok().map(u32::from_le_bytes));
                if let (Some(spid), Some(pib)) = (spid, find_pib(body)) {
                    out.pib_of_spid.insert(spid, pib);
                }
            }
            if rec_type & 0xF000 == 0xF000 && !body.is_empty() {
                stack.push(body);
            }
        }
    }

    // 앵커: PLCFSPA는 CP 배열(n+1) + SPA(26바이트)×n. spid가 위에서 모은 것과
    // 맞아떨어지는 항목만 진짜 앵커 표로 인정한다.
    if !out.pib_of_spid.is_empty() {
        for &(fc, lcb) in pairs {
            let n = (lcb as usize).checked_sub(4).map(|v| v / 30).unwrap_or(0);
            if n == 0 || 4 * (n + 1) + 26 * n != lcb as usize {
                continue;
            }
            let Some(plc) = table.get(fc as usize..fc as usize + lcb as usize) else {
                continue;
            };
            let spa_base = (n + 1) * 4;
            let mut hits = Vec::new();
            for k in 0..n {
                let (Some(cp), Some(spid)) = (
                    plc.get(k * 4..k * 4 + 4)
                        .and_then(|b| b.try_into().ok())
                        .map(u32::from_le_bytes),
                    plc.get(spa_base + k * 26..spa_base + k * 26 + 4)
                        .and_then(|b| b.try_into().ok())
                        .map(u32::from_le_bytes),
                ) else {
                    break;
                };
                if !out.pib_of_spid.contains_key(&spid) {
                    hits.clear();
                    break;
                }
                hits.push((cp, spid));
            }
            if !hits.is_empty() {
                out.spid_at_cp.extend(hits);
                break;
            }
        }
    }
    out
}

/// OfficeArtContent를 최상위 컨테이너 본문 목록으로 쪼갠다.
/// 첫 컨테이너(DggContainer) 뒤부터는 각 컨테이너 앞에 1바이트 라벨이 붙는다.
fn art_containers(art: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut first = true;
    while i + 8 <= art.len() {
        if !first {
            i += 1; // dgglbl
            if i + 8 > art.len() {
                break;
            }
        }
        let len = u32::from_le_bytes(art[i + 4..i + 8].try_into().unwrap()) as usize;
        let end = (i + 8).saturating_add(len).min(art.len());
        if end <= i + 8 {
            break;
        }
        out.push(&art[i + 8..end]);
        i = end;
        first = false;
    }
    out
}

/// FBSE 하나 → 그림. 바이트가 안에 박혀 있으면 그걸 쓰고,
/// 없으면 foDelay가 가리키는 WordDocument 위치에서 읽는다.
fn read_fbse<'a>(delay: &[&'a [u8]], fbse: &'a [u8]) -> (&'static str, Cow<'a, [u8]>) {
    let cb_name = fbse.get(33).copied().unwrap_or(0) as usize;
    if let Some(found) = fbse
        .get(36 + cb_name..)
        .map(records)
        .and_then(|rs| rs.into_iter().find_map(|(t, i, b)| blip_image(t, i, b)))
    {
        return found;
    }
    // 바깥에 있으면 foDelay가 가리키는 위치 — 스트림이 WordDocument일 수도 Data일 수도 있다
    let fo_delay = fbse
        .get(28..32)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_le_bytes)
        .unwrap_or(0) as usize;
    delay
        .iter()
        .filter_map(|s| s.get(fo_delay..))
        .find_map(|s| {
            records(s)
                .into_iter()
                .find_map(|(t, i, b)| blip_image(t, i, b))
        })
        .unwrap_or_default()
}

/// 한 레벨의 Escher 레코드들 → (타입, instance, 본문)
fn records(buf: &[u8]) -> Vec<(u16, u16, &[u8])> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 8 <= buf.len() {
        let ver_inst = u16::from_le_bytes([buf[i], buf[i + 1]]);
        let rec_type = u16::from_le_bytes([buf[i + 2], buf[i + 3]]);
        let len = u32::from_le_bytes([buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]]) as usize;
        if ver_inst == 0 && rec_type == 0 && len == 0 {
            break; // 패딩
        }
        let end = (i + 8).saturating_add(len).min(buf.len());
        out.push((rec_type, ver_inst >> 4, &buf[i + 8..end]));
        // `i + 8 + len`으로 더하면 wasm32(usize 32비트)에서 len이 크면 wrapping해
        // 같은 레코드를 무한히 다시 읽는다. 이미 잘라 둔 end로 넘긴다.
        i = end;
    }
    out
}

/// 도형 속성(OfficeArtFOPT)에서 그림 번호(pib, 속성 0x0104)를 읽는다.
fn find_pib(buf: &[u8]) -> Option<u32> {
    let mut stack = vec![buf];
    while let Some(cur) = stack.pop() {
        for (rec_type, inst, body) in records(cur) {
            if rec_type == 0xF00B {
                // 속성 배열: (opid u16, value u32) × inst
                for k in 0..inst as usize {
                    let o = k * 6;
                    let (Some(opid), Some(val)) = (
                        body.get(o..o + 2)
                            .and_then(|b| b.try_into().ok())
                            .map(u16::from_le_bytes),
                        body.get(o + 2..o + 6)
                            .and_then(|b| b.try_into().ok())
                            .map(u32::from_le_bytes),
                    ) else {
                        break;
                    };
                    if opid & 0x3FFF == 0x0104 {
                        return Some(val);
                    }
                }
            } else if rec_type & 0xF000 == 0xF000 && !body.is_empty() {
                stack.push(body);
            }
        }
    }
    None
}

/// Escher 레코드 트리에서 첫 BLIP을 찾는다.
/// 레코드 헤더 8바이트: verAndInstance(2) + type(2) + length(4).
/// ver이 0xF면 컨테이너라 본문이 다시 레코드 목록이다.
fn find_blip(buf: &[u8]) -> Option<(&'static str, Cow<'_, [u8]>)> {
    // 재귀 대신 스택 — Escher 중첩은 얕지만 WASM 스택을 건드릴 이유가 없다
    let mut stack = vec![buf];
    while let Some(cur) = stack.pop() {
        let mut i = 0usize;
        while i + 8 <= cur.len() {
            let ver_inst = u16::from_le_bytes([cur[i], cur[i + 1]]);
            let rec_type = u16::from_le_bytes([cur[i + 2], cur[i + 3]]);
            let len = u32::from_le_bytes([cur[i + 4], cur[i + 5], cur[i + 6], cur[i + 7]]) as usize;
            let body_end = (i + 8).saturating_add(len).min(cur.len());
            let body = &cur[i + 8..body_end];

            if ver_inst & 0x000F == 0x000F {
                stack.push(body);
            } else if rec_type == 0xF007 {
                // FBSE는 컨테이너가 아니지만 그림 바이트를 품고 있다
                let cb_name = body.get(33).copied().unwrap_or(0) as usize;
                if let Some(rest) = body.get(36 + cb_name..) {
                    stack.push(rest);
                }
            } else if let Some(found) = blip_image(rec_type, ver_inst >> 4, body) {
                return Some(found);
            }
            if len == 0 && ver_inst == 0 && rec_type == 0 {
                break; // 패딩 구간 — 더 볼 것 없다
            }
            if body_end <= i {
                break; // 진행이 없으면 무한 루프다
            }
            i = body_end;
        }
    }
    None
}

/// BLIP 레코드 본문 → (확장자, 이미지 바이트).
/// 앞에 16바이트 UID가 1개 또는 2개 붙는데, instance가 홀수면 2개다.
fn blip_image(rec_type: u16, instance: u16, body: &[u8]) -> Option<(&'static str, Cow<'_, [u8]>)> {
    let ext = match rec_type {
        0xF01D | 0xF02A => "jpg",
        0xF01E => "png",
        0xF01F => "dib",
        0xF029 => "tif",
        // 메타파일은 deflate로 눌려 있고 브라우저가 그리지도 못한다 —
        // 바이트 없이 확장자만 넘겨 방출기가 자리표시로 강등하게 한다
        0xF01A => return Some(("emf", Cow::Borrowed(&[]))),
        0xF01B => return Some(("wmf", Cow::Borrowed(&[]))),
        0xF01C => return Some(("pict", Cow::Borrowed(&[]))),
        _ => return None,
    };
    let skip = 16 * (1 + (instance & 1) as usize) + 1; // UID들 + tag 1바이트
    let raw = body.get(skip..)?;
    if raw.is_empty() {
        return None;
    }
    if ext == "dib" {
        // DIB는 BMP 파일 헤더(14바이트)가 없는 알맹이 — 붙여 줘야 브라우저가 그린다
        return Some(("bmp", Cow::Owned(dib_to_bmp(raw)?)));
    }
    Some((ext, Cow::Borrowed(raw)))
}

/// BITMAPINFOHEADER부터 시작하는 DIB에 BMP 파일 헤더를 씌운다.
fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    let u32at =
        |o: usize| -> Option<u32> { Some(u32::from_le_bytes(dib.get(o..o + 4)?.try_into().ok()?)) };
    let header_size = u32at(0)?;
    let bit_count = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?) as u32;
    let clr_used = u32at(32)?;
    let palette = if clr_used > 0 {
        clr_used
    } else if bit_count <= 8 {
        1u32 << bit_count
    } else {
        0
    };
    let pixel_offset = 14 + header_size + palette * 4;
    let file_size = 14u32.saturating_add(dib.len() as u32);

    let mut out = Vec::with_capacity(dib.len() + 14);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&pixel_offset.to_le_bytes());
    out.extend_from_slice(dib);
    Some(out)
}

// ---------------- 글꼴 이름표 ----------------

struct FontTable(Vec<String>);

impl FontTable {
    fn parse(table: &[u8], fc: u32, lcb: u32) -> FontTable {
        let mut out = Vec::new();
        let Some(stt) = table.get(fc as usize..(fc as usize).saturating_add(lcb as usize)) else {
            return FontTable(out);
        };
        // SttbfFfn: cData(2) + cbExtra(2) + [cchData(1) + FFN] ×cData
        let mut r = ByteReader::new(stt);
        let count = r.u16().unwrap_or(0);
        let _extra = r.u16();
        for _ in 0..count {
            let Ok(cch) = r.u8() else { break };
            let Ok(ffn) = r.vec(cch as usize) else { break };
            // FFN 앞부분 39바이트는 굵기·판오스 등 고정 필드, 그 뒤가 UTF-16 이름
            let name = ffn
                .get(39..)
                .map(|rest| {
                    let units: Vec<u16> = rest
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .take_while(|&u| u != 0)
                        .collect();
                    String::from_utf16_lossy(&units)
                })
                .unwrap_or_default();
            out.push(name);
        }
        FontTable(out)
    }

    fn name(&self, ftc: Option<u16>) -> Option<&str> {
        let n = self.0.get(ftc? as usize)?;
        (!n.is_empty()).then_some(n.as_str())
    }
}

// ---------------- 문단·표 조립 ----------------

/// 문단 하나로 끊긴 조각. `.doc`은 문단 끝(0x0D)과 셀 끝(0x07)이 둘 다 구분자다.
struct Unit {
    /// 0x07로 끝났다 = 셀 경계
    ends_cell: bool,
    pap: PapFmt,
    runs: Vec<Run>,
    images: Vec<Image>,
}

struct Builder {
    intern: Interner,
    fonts: FontTable,
    chars_fmt: FormatRuns<ChpFmt>,
    paras_fmt: FormatRuns<PapFmt>,
    /// `Data` 스트림 — PICF(그림 서술자)가 여기 있다
    data: Vec<u8>,
    /// Office Drawing — 그림 저장소와 도형/앵커 지도
    art: Drawings,
}

impl Builder {
    fn build(&mut self, doc: &DocText) -> Vec<Paragraph> {
        let units = self.split_units(doc);

        let mut out: Vec<Paragraph> = Vec::new();
        let mut row_cells: Vec<Vec<Paragraph>> = Vec::new();
        let mut cell_paras: Vec<Paragraph> = Vec::new();
        let mut rows: Vec<(Vec<Vec<Paragraph>>, Option<Tap>)> = Vec::new();

        for u in units {
            if u.pap.ttp {
                // 행 종결 — 남은 셀을 닫고 행을 확정한다
                if !cell_paras.is_empty() {
                    row_cells.push(std::mem::take(&mut cell_paras));
                }
                if !row_cells.is_empty() {
                    rows.push((std::mem::take(&mut row_cells), u.pap.tap));
                }
                continue;
            }

            // 표에서 빠져나왔으면 모아둔 행들을 표 하나로 낸다
            if !u.pap.in_table && !rows.is_empty() {
                let table = self.assemble(std::mem::take(&mut rows));
                out.push(Paragraph {
                    shape_index: self.intern.para_shape(0),
                    tables: vec![table],
                    ..Default::default()
                });
            }

            let para = Paragraph {
                shape_index: self.intern.para_shape_m(
                    u.pap.align,
                    ParaMargins {
                        indent: u.pap.dxa_left * TWIP,
                        first_line: u.pap.dxa_left1 * TWIP,
                        space_before: u.pap.dya_before * TWIP,
                        space_after: u.pap.dya_after * TWIP,
                    },
                ),
                runs: u.runs,
                images: u.images,
                ..Default::default()
            };
            if u.pap.in_table {
                cell_paras.push(para);
                if u.ends_cell {
                    row_cells.push(std::mem::take(&mut cell_paras));
                }
            } else {
                out.push(para);
            }
        }

        if !cell_paras.is_empty() {
            row_cells.push(cell_paras);
        }
        if !row_cells.is_empty() {
            rows.push((row_cells, None));
        }
        if !rows.is_empty() {
            let table = self.assemble(rows);
            out.push(Paragraph {
                shape_index: self.intern.para_shape(0),
                tables: vec![table],
                ..Default::default()
            });
        }
        out
    }

    /// 문자열을 문단/셀 단위로 끊으면서 글자서식이 같은 구간을 run으로 묶는다.
    fn split_units(&mut self, doc: &DocText) -> Vec<Unit> {
        let mut units = Vec::new();
        let mut cur = Unit {
            ends_cell: false,
            pap: PapFmt::default(),
            runs: Vec::new(),
            images: Vec::new(),
        };
        let mut pending: Option<(u32, String)> = None; // (charShapeId, 모으는 중인 텍스트)

        let flush_run = |pending: &mut Option<(u32, String)>, runs: &mut Vec<Run>| {
            if let Some((id, text)) = pending.take() {
                if !text.is_empty() {
                    runs.push(Run {
                        char_shape_id: id,
                        text,
                        link: None,
                        field: None,
                    });
                }
            }
        };

        // 필드(예: HYPERLINK)는 0x13 지시부 0x14 표시부 0x15 구조다.
        // 지시부는 사용자에게 보이지 않는 코드라 버려야 한다.
        let mut in_field_code = false;

        for (i, &ch) in doc.chars.iter().enumerate() {
            let fc = doc.fcs[i];
            match ch {
                '\u{0013}' => {
                    in_field_code = true;
                    continue;
                }
                '\u{0014}' | '\u{0015}' => {
                    in_field_code = false;
                    continue;
                }
                _ if in_field_code => continue,
                '\r' | '\u{0007}' => {
                    flush_run(&mut pending, &mut cur.runs);
                    cur.ends_cell = ch == '\u{0007}';
                    cur.pap = self.paras_fmt.at(fc);
                    units.push(std::mem::replace(
                        &mut cur,
                        Unit {
                            ends_cell: false,
                            pap: PapFmt::default(),
                            runs: Vec::new(),
                            images: Vec::new(),
                        },
                    ));
                }
                // 줄바꿈·쪽나눔
                '\u{000B}' | '\u{000C}' => {
                    push_char(&mut pending, '\n', self.shape_at(fc), &mut cur.runs)
                }
                // 인라인 그림 앵커 — 이 문자의 CHPX가 Data 스트림 안 그림 위치를 들고 있다
                '\u{0001}' => {
                    if let Some(img) = self.picture(fc) {
                        flush_run(&mut pending, &mut cur.runs);
                        cur.images.push(img);
                    }
                }
                // 떠 있는 도형 앵커 — 문자 위치(CP)로 도형을 찾아 그림을 꺼낸다
                '\u{0008}' => {
                    if let Some(img) = self.floating_picture(i as u32) {
                        flush_run(&mut pending, &mut cur.runs);
                        cur.images.push(img);
                    }
                }
                // 각주 참조·주석 표시 등 — 글자가 아니다
                '\u{0000}' | '\u{0002}'..='\u{0006}' | '\u{000E}'..='\u{001F}' => {}
                '\t' => push_char(&mut pending, '\t', self.shape_at(fc), &mut cur.runs),
                _ => {
                    let shape = self.shape_at(fc);
                    push_char(&mut pending, ch, shape, &mut cur.runs);
                }
            }
        }
        flush_run(&mut pending, &mut cur.runs);
        if !cur.runs.is_empty() || !cur.images.is_empty() {
            units.push(cur);
        }
        units
    }

    /// 그림 앵커 문자의 CHPX → Data 스트림에서 실제 이미지를 꺼내 모델에 싣는다.
    fn picture(&mut self, fc: u32) -> Option<Image> {
        let chp = self.chars_fmt.at(fc);
        if !chp.special {
            return None;
        }
        let off = chp.pic_offset?;
        let pic = read_picture(&self.data, off, &self.art.blips)?;
        // self.data·self.art는 빌리고 self.intern만 mut로 잡는다 (필드가 서로 겹치지 않는다)
        let bin_data_id = self
            .intern
            .bin_data(&format!("pic@{off}"), pic.ext, &pic.bytes);
        Some(Image {
            bin_data_id,
            width: pic.width,
            height: pic.height,
        })
    }

    /// 떠 있는 도형(0x08 앵커) → 저장소의 그림
    fn floating_picture(&mut self, cp: u32) -> Option<Image> {
        let spid = *self.art.spid_at_cp.get(&cp)?;
        let pib = *self.art.pib_of_spid.get(&spid)? as usize;
        let (ext, bytes) = self.art.blips.get(pib.checked_sub(1)?)?;
        if ext.is_empty() {
            return None;
        }
        let bin_data_id = self.intern.bin_data(&format!("blip{pib}"), ext, bytes);
        // 떠 있는 도형은 표시 크기가 도형 속성에 있는데, 원본 비율대로 두면
        // 방출기가 max-width로 페이지 안에 맞춰 준다
        Some(Image {
            bin_data_id,
            width: 0,
            height: 0,
        })
    }

    fn shape_at(&mut self, fc: u32) -> u32 {
        let c = self.chars_fmt.at(fc);
        let mut attr = 0u32;
        if c.italic {
            attr |= 0b01;
        }
        if c.bold {
            attr |= 0b10;
        }
        if c.underline {
            attr |= 1 << 2;
        }
        match c.iss {
            1 => attr |= ATTR_SUPER,
            2 => attr |= ATTR_SUB,
            _ => {}
        }
        let font_id = self.intern.font(self.fonts.name(c.font));
        // sprmCHps는 하프포인트 — 1/100pt로 바꾼다. 미지정은 Word 기본 10pt.
        let base = c.half_pt.filter(|v| *v > 0).unwrap_or(20) * 50;
        self.intern
            .char_shape(base, c.color.unwrap_or([0, 0, 0]), attr, font_id)
    }

    /// .doc은 행마다 열 구성이 다를 수 있다(가로 병합이 "폭이 넓은 셀"로 표현된다).
    /// HTML 표는 격자라서, 모든 행의 열 경계를 합쳐 공통 격자를 만들고
    /// 각 셀이 몇 칸을 덮는지 colSpan으로 환산해야 칸이 맞는다.
    fn assemble(&mut self, rows: Vec<(Vec<Vec<Paragraph>>, Option<Tap>)>) -> Table {
        let mut grid: Vec<i32> = rows
            .iter()
            .filter_map(|(_, t)| t.as_ref())
            .flat_map(|t| t.edges.iter().copied())
            .collect();
        grid.sort_unstable();
        grid.dedup();

        let col_count = if grid.len() >= 2 {
            (grid.len() - 1) as u16
        } else {
            rows.iter().map(|(c, _)| c.len()).max().unwrap_or(0) as u16
        };

        let mut table = Table {
            row_count: rows.len() as u16,
            col_count,
            rows: rows.iter().map(|_| Vec::new()).collect(),
            caption: Vec::new(),
        };
        // 세로 병합: vert_restart 셀을 기억했다가 vert_merge가 이어질 때 rowSpan을 늘린다
        let mut anchors: std::collections::HashMap<u16, (usize, usize)> = Default::default();

        for (ri, (cells, tap)) in rows.into_iter().enumerate() {
            // 셀 수와 열 경계 수가 맞을 때만 격자에 맞춘다 (어긋나면 순서대로 배치)
            let edges = tap
                .as_ref()
                .map(|t| t.edges.as_slice())
                .filter(|e| e.len() == cells.len() + 1);
            for (ci, paragraphs) in cells.into_iter().enumerate() {
                let flags = tap
                    .as_ref()
                    .and_then(|t| t.cells.get(ci))
                    .copied()
                    .unwrap_or_default();

                let (col, col_span, width) = match edges {
                    Some(e) => {
                        let (a, b) = (e[ci], e[ci + 1]);
                        let start = grid.partition_point(|&g| g < a) as u16;
                        let end = grid.partition_point(|&g| g < b) as u16;
                        (
                            start,
                            end.saturating_sub(start).max(1),
                            ((b - a).max(0) * TWIP) as u32,
                        )
                    }
                    None => (ci as u16, 1, 0),
                };

                if flags.vert_merge && !flags.vert_restart {
                    if let Some(&(ar, ai)) = anchors.get(&col) {
                        if let Some(anchor) = table.rows.get_mut(ar).and_then(|r| r.get_mut(ai)) {
                            anchor.row_span += 1;
                        }
                    }
                    continue;
                }

                table.rows[ri].push(Cell {
                    col,
                    row: ri as u16,
                    col_span,
                    row_span: 1,
                    width,
                    height: 0,
                    padding: [108 * TWIP as u16, 108 * TWIP as u16, 0, 0],
                    border_fill_id: None,
                    vert_align: None,
                    paragraphs,
                });
                if flags.vert_restart {
                    anchors.insert(col, (ri, table.rows[ri].len() - 1));
                }
            }
        }
        table
    }
}

fn push_char(pending: &mut Option<(u32, String)>, ch: char, shape: u32, runs: &mut Vec<Run>) {
    match pending {
        Some((id, text)) if *id == shape => text.push(ch),
        Some(_) => {
            if let Some((id, text)) = pending.take() {
                if !text.is_empty() {
                    runs.push(Run {
                        char_shape_id: id,
                        text,
                        link: None,
                        field: None,
                    });
                }
            }
            *pending = Some((shape, ch.to_string()));
        }
        None => *pending = Some((shape, ch.to_string())),
    }
}

#[cfg(test)]
mod tests {
    /// 잘린 FIB(csw가 스트림 밖을 가리킴)로 패닉하지 않고 오류를 돌려준다
    #[test]
    fn truncated_fib_errors_instead_of_panicking() {
        let mut wd = vec![0u8; 200];
        wd[0] = 0xEC;
        wd[1] = 0xA5;
        wd[32] = 0xFF; // csw = 0xFFFF → cslw 오프셋이 131104
        wd[33] = 0xFF;
        assert!(super::Fib::parse(&wd).is_err());
    }
}
