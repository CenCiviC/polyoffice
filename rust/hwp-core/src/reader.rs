//! 리틀엔디언 바이트 리더 — hwp.js ByteReader의 이식.

pub struct ByteReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> ByteReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.data.len() {
            return Err(format!(
                "buffer underrun: need {} bytes at offset {} of {}",
                n,
                self.pos,
                self.data.len()
            ));
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    pub fn i8(&mut self) -> Result<i8, String> {
        Ok(self.take(1)?[0] as i8)
    }

    pub fn u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i32(&mut self) -> Result<i32, String> {
        let b = self.take(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn skip(&mut self, n: usize) -> Result<(), String> {
        self.take(n).map(|_| ())
    }

    pub fn vec(&mut self, n: usize) -> Result<Vec<u8>, String> {
        self.take(n).map(|s| s.to_vec())
    }

    /// UTF-16LE 문자열: u16 길이 + 길이×u16
    pub fn string(&mut self) -> Result<String, String> {
        let len = self.u16()? as usize;
        let mut units = Vec::with_capacity(len);
        for _ in 0..len {
            units.push(self.u16()?);
        }
        Ok(String::from_utf16_lossy(&units))
    }

    pub fn is_eof(&self) -> bool {
        self.pos >= self.data.len()
    }
}

/// COLORREF(0x00BBGGRR) → [r, g, b]
pub fn rgb(color_ref: u32) -> [u8; 3] {
    [
        (color_ref & 0xff) as u8,
        ((color_ref >> 8) & 0xff) as u8,
        ((color_ref >> 16) & 0xff) as u8,
    ]
}

pub fn bits(value: u32, start: u32, end: u32) -> u32 {
    (value >> start) & ((1 << (end - start + 1)) - 1)
}
