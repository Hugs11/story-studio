//! Header-only durations. No decoder, subprocess or audio-sized allocation.
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};

/// Also bounds cancellation while a parser skips an ID3 picture or ZIP data.
pub(crate) struct CancellableRead<'a, R> {
    pub(crate) reader: R,
    pub(crate) cancel: &'a AtomicBool,
}
impl<R: Read> Read for CancellableRead<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::other("cancelled"));
        }
        self.reader.read(buffer)
    }
}
fn le32(b: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(..4)?.try_into().ok()?))
}
fn be32(b: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(..4)?.try_into().ok()?))
}
fn skip(r: &mut impl Read, n: u64) -> Option<()> {
    (io::copy(&mut r.take(n), &mut io::sink()).ok()? == n).then_some(())
}
pub(crate) fn seekable<R: Read + Seek>(mut r: R, size: u64, cancel: &AtomicBool) -> Option<f64> {
    let mut head = [0; 12];
    if size >= 12 {
        r.read_exact(&mut head).ok()?;
        r.seek(SeekFrom::Start(0)).ok()?;
    }
    // MP4 and Matroska jump over their audio boxes: `moov` may follow `mdat`.
    if let Some(kind) = container(&head) {
        if size > super::archive_limits::ARCHIVE_MAX_FILE_BYTES {
            return None;
        }
        let walker = Walker {
            r,
            pos: 0,
            size,
            jump: Some(seek_to::<R>),
            cancel,
        };
        return plausible(walk(walker, kind));
    }
    let mut tail = [0; 128];
    if size >= 128 {
        r.seek(SeekFrom::End(-128)).ok()?;
        r.read_exact(&mut tail).ok()?;
        r.seek(SeekFrom::Start(0)).ok()?;
    }
    duration(r, size, Some(&tail), cancel)
}
/// A single sound longer than a day is a corrupt or hostile header, not audio.
const MAX_SOUND_SECONDS: f64 = 24.0 * 60.0 * 60.0;
/// `tail` lets a stored ZIP entry/file avoid reading the intervening audio.
/// Deflated entries and solid archive streams advance with bounded memory.
/// The declared `size` bounds every read: a decompressed stream longer than
/// its declaration is never followed, and an oversized declaration is refused.
pub(crate) fn duration(
    r: impl Read,
    size: u64,
    tail: Option<&[u8]>,
    cancel: &AtomicBool,
) -> Option<f64> {
    if size > super::archive_limits::ARCHIVE_MAX_FILE_BYTES {
        return None;
    }
    plausible(header_duration(r.take(size), size, tail, cancel))
}
fn plausible(seconds: Option<f64>) -> Option<f64> {
    seconds.filter(|s| s.is_finite() && *s >= 0.0 && *s <= MAX_SOUND_SECONDS)
}
fn header_duration(
    r: impl Read,
    size: u64,
    tail: Option<&[u8]>,
    cancel: &AtomicBool,
) -> Option<f64> {
    let mut r = CancellableRead { reader: r, cancel };
    let mut head = [0; 12];
    r.read_exact(&mut head).ok()?;
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    if head.starts_with(b"OggS") {
        return ogg(io::Cursor::new(head).chain(r), cancel);
    }
    if head.starts_with(b"RIFF") && &head[8..12] == b"WAVE" {
        let mut rate = None;
        loop {
            let mut chunk = [0; 8];
            r.read_exact(&mut chunk).ok()?;
            let n = le32(&chunk[4..])? as u64;
            if &chunk[..4] == b"fmt " {
                if n < 16 {
                    return None;
                }
                let mut fmt = [0; 16];
                r.read_exact(&mut fmt).ok()?;
                rate = le32(&fmt[8..]).filter(|v| *v > 0);
                skip(&mut r, n - 16 + n % 2)?;
            } else if &chunk[..4] == b"data" {
                return Some(n as f64 / rate? as f64);
            } else {
                skip(&mut r, n + n % 2)?;
            }
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
        }
    }
    if let Some(kind) = container(&head) {
        // A stream cannot jump: an `mdat` or a Cluster before the duration
        // would have to be read whole, so the duration stays unknown.
        let walker = Walker {
            r: io::Cursor::new(head).chain(r),
            pos: 0,
            size,
            jump: None,
            cancel,
        };
        return walk(walker, kind);
    }
    let mut offset = 0u64;
    let mut prefix = head.to_vec();
    if head.starts_with(b"ID3") {
        if head[6..10].iter().any(|b| b & 128 != 0) {
            return None;
        }
        offset = 10
            + head[6..10].iter().fold(0u64, |n, b| (n << 7) | *b as u64)
            + if head[5] & 16 != 0 { 10 } else { 0 };
        if offset > size {
            return None;
        }
        if offset < 12 {
            prefix = head[offset as usize..].to_vec();
        } else {
            skip(&mut r, offset - 12)?;
            prefix.clear();
        }
    }
    let wanted = (size.checked_sub(offset)? as usize).min(512);
    if wanted < 4 || wanted < prefix.len() {
        return None;
    }
    let have = prefix.len();
    prefix.resize(wanted, 0);
    r.read_exact(&mut prefix[have..]).ok()?;
    if prefix.starts_with(b"fLaC") {
        return flac(&prefix);
    }
    let h = be32(&prefix)?;
    if h & 0xffe00000 != 0xffe00000 || (h >> 17) & 3 != 1 {
        return None;
    }
    let version = (h >> 19) & 3;
    if version == 1 {
        return None;
    }
    let sr = [44100, 48000, 32000]
        .get(((h >> 10) & 3) as usize)
        .copied()?
        / match version {
            3 => 1,
            2 => 2,
            _ => 4,
        };
    let samples = if version == 3 { 1152 } else { 576 };
    let side = if version == 3 {
        if (h >> 6) & 3 == 3 {
            17
        } else {
            32
        }
    } else if (h >> 6) & 3 == 3 {
        9
    } else {
        17
    };
    let x = 4 + if h & (1 << 16) == 0 { 2 } else { 0 } + side;
    if let Some(tag) = prefix.get(x..x + 4) {
        if tag == b"Xing" || tag == b"Info" {
            if be32(prefix.get(x + 4..)?)? & 1 == 0 {
                return None;
            }
            return Some(be32(prefix.get(x + 8..)?)? as f64 * samples as f64 / sr as f64);
        }
    }
    if prefix.get(36..40) == Some(b"VBRI") {
        return Some(be32(prefix.get(50..)?)? as f64 * samples as f64 / sr as f64);
    }
    let rates = if version == 3 {
        [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ]
    } else {
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    let rate = *rates.get(((h >> 12) & 15) as usize)?;
    if rate == 0 {
        return None;
    }
    let tag = if let Some(tail) = tail {
        tail.starts_with(b"TAG")
    } else {
        let mut last = prefix[prefix.len().saturating_sub(128)..].to_vec();
        let mut buf = [0; 65536];
        loop {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let n = r.read(&mut buf).ok()?;
            if n == 0 {
                break;
            }
            if n >= 128 {
                last.clear();
                last.extend_from_slice(&buf[n - 128..n]);
            } else {
                last.extend_from_slice(&buf[..n]);
                if last.len() > 128 {
                    last.drain(..last.len() - 128);
                }
            }
        }
        last.starts_with(b"TAG")
    };
    let bytes = size.checked_sub(offset + if tag { 128 } else { 0 })?;
    Some(bytes as f64 * 8.0 / (rate as f64 * 1000.0))
}
fn ogg(mut r: impl Read, cancel: &AtomicBool) -> Option<f64> {
    let mut frequency = None;
    let mut serial = None;
    let mut last = None;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        let mut h = [0; 27];
        match r.read(&mut h[..1]).ok()? {
            0 => break,
            _ => r.read_exact(&mut h[1..]).ok()?,
        }
        if &h[..4] != b"OggS" || h[4] != 0 {
            return None;
        }
        let s = le32(&h[14..])?;
        if serial.is_some_and(|old| old != s) {
            return None;
        }
        serial = Some(s);
        let mut lacing = vec![0; h[26] as usize];
        r.read_exact(&mut lacing).ok()?;
        let n: usize = lacing.iter().map(|n| *n as usize).sum();
        let mut body = vec![0; n];
        r.read_exact(&mut body).ok()?;
        if frequency.is_none() {
            if !body.starts_with(b"\x01vorbis") {
                return None;
            }
            frequency = le32(body.get(12..)?).filter(|v| *v > 0);
        }
        let granule = u64::from_le_bytes(h[6..14].try_into().ok()?);
        if granule != u64::MAX {
            last = Some(granule);
        }
        if h[5] & 4 != 0 {
            return Some(last? as f64 / frequency? as f64);
        }
    }
    None
}

/// STREAMINFO is always the first metadata block, right after `fLaC`.
fn flac(p: &[u8]) -> Option<f64> {
    let block = p.get(4..42)?;
    if block[0] & 0x7f != 0 || u32::from_be_bytes([0, block[1], block[2], block[3]]) < 34 {
        return None;
    }
    // Sample rate (20 bits), channels (3), bits per sample (5), samples (36).
    let x = u64::from_be_bytes(block[14..22].try_into().ok()?);
    let (rate, samples) = (x >> 44, x & ((1 << 36) - 1));
    // A total of 0 means "unknown" in STREAMINFO.
    (rate > 0 && samples > 0).then(|| samples as f64 / rate as f64)
}

#[derive(Clone, Copy)]
enum Container {
    Mp4,
    Matroska,
}
fn container(head: &[u8; 12]) -> Option<Container> {
    if &head[4..8] == b"ftyp" {
        Some(Container::Mp4)
    } else if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Some(Container::Matroska)
    } else {
        None
    }
}
fn walk<R: Read>(mut w: Walker<'_, R>, kind: Container) -> Option<f64> {
    match kind {
        Container::Mp4 => mp4(&mut w),
        Container::Matroska => matroska(&mut w),
    }
}
/// Bounds the boxes or elements a hostile file can make the walker visit.
const MAX_ELEMENTS: usize = 4096;
fn seek_to<R: Seek>(r: &mut R, to: u64) -> Option<()> {
    (r.seek(SeekFrom::Start(to)).ok()? == to).then_some(())
}
/// Box and element walker: every read stays below the declared `size`.
struct Walker<'a, R> {
    r: R,
    pos: u64,
    size: u64,
    /// `None` for a stream, which advances by reading.
    jump: Option<fn(&mut R, u64) -> Option<()>>,
    cancel: &'a AtomicBool,
}
impl<R: Read> Walker<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> Option<()> {
        let end = self.pos.checked_add(buffer.len() as u64)?;
        if end > self.size || self.cancel.load(Ordering::Relaxed) {
            return None;
        }
        self.r.read_exact(buffer).ok()?;
        self.pos = end;
        Some(())
    }
    fn byte(&mut self) -> Option<u8> {
        let mut b = [0];
        self.read(&mut b)?;
        Some(b[0])
    }
    /// `bulky` marks audio payloads: a stream gives up instead of reading them.
    fn advance(&mut self, to: u64, bulky: bool) -> Option<()> {
        if to < self.pos || to > self.size || self.cancel.load(Ordering::Relaxed) {
            return None;
        }
        match self.jump {
            Some(jump) => jump(&mut self.r, to)?,
            None if bulky => return None,
            None => skip(&mut self.r, to - self.pos)?,
        }
        self.pos = to;
        Some(())
    }
}
/// `moov` → `mvhd`: duration / timescale (versions 0 and 1).
fn mp4<R: Read>(w: &mut Walker<'_, R>) -> Option<f64> {
    let mut end = w.size;
    let mut inside = false;
    for _ in 0..MAX_ELEMENTS {
        let start = w.pos;
        let mut h = [0; 8];
        w.read(&mut h)?;
        let length = match be32(&h)? {
            0 => end - start,
            1 => {
                let mut l = [0; 8];
                w.read(&mut l)?;
                u64::from_be_bytes(l)
            }
            n => n as u64,
        };
        let box_end = start.checked_add(length)?;
        if box_end < w.pos || box_end > end {
            return None;
        }
        match (&h[4..8], inside) {
            (b"moov", false) => {
                inside = true;
                end = box_end;
            }
            (b"mvhd", true) => {
                // version, flags, creation and modification times, timescale, duration
                let version = w.byte()?;
                let (scale, duration) = if version == 0 {
                    let mut b = [0; 19];
                    w.read(&mut b)?;
                    let d = be32(&b[15..])?;
                    (be32(&b[11..])?, (d != u32::MAX).then_some(d as u64)?)
                } else if version == 1 {
                    let mut b = [0; 31];
                    w.read(&mut b)?;
                    let d = u64::from_be_bytes(b[23..31].try_into().ok()?);
                    (be32(&b[19..])?, (d != u64::MAX).then_some(d)?)
                } else {
                    return None;
                };
                // Fragmented files declare 0: the duration is in the fragments.
                return (scale > 0 && duration > 0).then(|| duration as f64 / scale as f64);
            }
            (kind, _) => w.advance(box_end, !inside && kind == b"mdat")?,
        }
    }
    None
}
/// EBML variable-size integer. An ID keeps its length marker; a size whose
/// value bits are all ones is "unknown" (`None`).
fn vint<R: Read>(w: &mut Walker<'_, R>, id: bool) -> Option<Option<u64>> {
    let first = w.byte()?;
    let len = first.leading_zeros() + 1;
    if len > if id { 4 } else { 8 } {
        return None;
    }
    let mask = 0xffu8.checked_shr(len).unwrap_or(0);
    let mut value = if id { first } else { first & mask } as u64;
    let mut ones = first & mask == mask;
    for _ in 1..len {
        let b = w.byte()?;
        value = (value << 8) | b as u64;
        ones &= b == 0xff;
    }
    Some((id || !ones).then_some(value))
}
const SEGMENT: u64 = 0x1853_8067;
const INFO: u64 = 0x1549_a966;
const CLUSTER: u64 = 0x1f43_b675;
const TIMECODE_SCALE: u64 = 0x2a_d7b1;
const DURATION: u64 = 0x4489;
/// EBML → Segment → Info: Duration × TimecodeScale (default 1 ms) in ns.
fn matroska<R: Read>(w: &mut Walker<'_, R>) -> Option<f64> {
    let mut end = w.size;
    let mut segment = false;
    for _ in 0..MAX_ELEMENTS {
        if w.pos >= end {
            return None;
        }
        let id = vint(w, true)??;
        let size = vint(w, false)?;
        if id == SEGMENT && !segment {
            segment = true;
            // A live recording may leave the Segment size unknown.
            if let Some(size) = size {
                end = end.min(w.pos.checked_add(size)?);
            }
            continue;
        }
        let body_end = w.pos.checked_add(size?)?;
        if body_end > end {
            return None;
        }
        if id == INFO && segment {
            let mut info = vec![0; usize::try_from(size?).ok().filter(|n| *n <= 65536)?];
            w.read(&mut info)?;
            return info_duration(info, w.cancel);
        }
        w.advance(body_end, id == CLUSTER)?;
    }
    None
}
fn info_duration(info: Vec<u8>, cancel: &AtomicBool) -> Option<f64> {
    let size = info.len() as u64;
    let mut w = Walker {
        r: io::Cursor::new(info),
        pos: 0,
        size,
        jump: None,
        cancel,
    };
    let (mut scale, mut duration) = (1_000_000u64, None);
    while w.pos < size {
        let id = vint(&mut w, true)??;
        let mut data = vec![0; usize::try_from(vint(&mut w, false)??).ok()?];
        w.read(&mut data)?;
        match id {
            TIMECODE_SCALE if (1..=8).contains(&data.len()) => {
                scale = data.iter().fold(0, |n, b| (n << 8) | *b as u64);
            }
            DURATION => {
                duration = Some(match data.len() {
                    4 => f32::from_be_bytes(data[..].try_into().ok()?) as f64,
                    8 => f64::from_be_bytes(data[..].try_into().ok()?),
                    _ => return None,
                });
            }
            _ => {}
        }
    }
    let seconds = duration? * scale as f64 / 1e9;
    (scale > 0 && seconds > 0.0).then_some(seconds)
}

/// FS encryption affects only the first 512 bytes. Keep the original stream
/// seekable so MP3 tails and Ogg endings can be read without an audio-sized copy.
pub(crate) struct FsAudio<R> {
    reader: R,
    prefix: Vec<u8>,
    position: u64,
}
impl<R: Read + Seek> FsAudio<R> {
    pub(crate) fn new(
        mut reader: R,
        variant: super::fs_pack_reader::FsPackVariant,
        size: u64,
    ) -> io::Result<Self> {
        let mut prefix = vec![0; (size as usize).min(512)];
        reader.read_exact(&mut prefix)?;
        let prefix = super::fs_pack_reader::decode_fs_pack_asset(variant, &prefix);
        reader.seek(SeekFrom::Start(0))?;
        Ok(Self {
            reader,
            prefix,
            position: 0,
        })
    }
}
impl<R: Read + Seek> Read for FsAudio<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position < self.prefix.len() as u64 {
            let at = self.position as usize;
            let n = buf.len().min(self.prefix.len() - at);
            buf[..n].copy_from_slice(&self.prefix[at..at + n]);
            self.position += n as u64;
            self.reader.seek(SeekFrom::Start(self.position))?;
            Ok(n)
        } else {
            let n = self.reader.read(buf)?;
            self.position += n as u64;
            Ok(n)
        }
    }
}
impl<R: Read + Seek> Seek for FsAudio<R> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        self.position = self.reader.seek(from)?;
        Ok(self.position)
    }
}
pub(crate) fn fs_stream(
    mut reader: impl Read,
    variant: super::fs_pack_reader::FsPackVariant,
    size: u64,
    cancel: &AtomicBool,
) -> Option<f64> {
    let mut prefix = vec![0; (size as usize).min(512)];
    reader.read_exact(&mut prefix).ok()?;
    let prefix = super::fs_pack_reader::decode_fs_pack_asset(variant, &prefix);
    duration(io::Cursor::new(prefix).chain(reader), size, None, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn measure(b: Vec<u8>) -> Option<f64> {
        let size = b.len() as u64;
        seekable(io::Cursor::new(b), size, &AtomicBool::new(false))
    }
    #[test]
    fn mp3_cbr_removes_id3v1() {
        let mut b = vec![0; 16000];
        b[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        b.extend_from_slice(b"TAG");
        b.resize(16128, 0);
        assert_eq!(measure(b), Some(1.0));
    }
    #[test]
    fn mp3_xing_after_large_id3_picture() {
        let n = 200_000usize;
        let mut b = vec![0; n + 10 + 512];
        b[..6].copy_from_slice(b"ID3\x04\x00\x00");
        for i in 0..4 {
            b[9 - i] = ((n >> (i * 7)) & 127) as u8;
        }
        let p = &mut b[n + 10..];
        p[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        p[36..40].copy_from_slice(b"Xing");
        p[40..44].copy_from_slice(&1u32.to_be_bytes());
        p[44..48].copy_from_slice(&100u32.to_be_bytes());
        assert_eq!(measure(b), Some(115200.0 / 44100.0));
    }
    #[test]
    fn wav_chunks() {
        let mut b = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        b.extend(16u32.to_le_bytes());
        let mut fmt = [0; 16];
        fmt[8..12].copy_from_slice(&8000u32.to_le_bytes());
        b.extend(fmt);
        b.extend(b"data");
        b.extend(16000u32.to_le_bytes());
        assert_eq!(measure(b), Some(2.0));
    }
    #[test]
    fn ogg_final_granule() {
        fn page(body: &[u8], flags: u8, g: u64) -> Vec<u8> {
            let mut b = vec![0; 28];
            b[..4].copy_from_slice(b"OggS");
            b[5] = flags;
            b[6..14].copy_from_slice(&g.to_le_bytes());
            b[26] = 1;
            b[27] = body.len() as u8;
            b.extend(body);
            b
        }
        let mut v = vec![0; 30];
        v[..7].copy_from_slice(b"\x01vorbis");
        v[12..16].copy_from_slice(&48000u32.to_le_bytes());
        let mut b = page(&v, 2, 0);
        b.extend(page(&[], 4, 96000));
        assert_eq!(measure(b), Some(2.0));
    }
    #[test]
    fn unreadable_is_unknown() {
        assert_eq!(measure(vec![0; 512]), None);
    }
    #[test]
    fn mp3_vbri_and_fs_encrypted_prefix_match_plain() {
        let mut b = vec![0; 16000];
        b[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        b[36..40].copy_from_slice(b"VBRI");
        b[50..54].copy_from_slice(&100u32.to_be_bytes());
        let expected = 100.0 * 1152.0 / 44100.0;
        assert_eq!(measure(b.clone()), Some(expected));
        let encrypted = crate::support::fs_pack_reader::fs_fixtures::encipher_common_key(&b);
        let size = encrypted.len() as u64;
        let reader = FsAudio::new(
            io::Cursor::new(encrypted.clone()),
            super::super::fs_pack_reader::FsPackVariant::Encrypted,
            size,
        )
        .unwrap();
        assert_eq!(
            seekable(reader, size, &AtomicBool::new(false)),
            Some(expected)
        );
        assert_eq!(
            fs_stream(
                io::Cursor::new(encrypted),
                super::super::fs_pack_reader::FsPackVariant::Encrypted,
                size,
                &AtomicBool::new(false)
            ),
            Some(expected)
        );
    }
    #[test]
    fn stored_audio_reads_headers_and_tail_only() {
        use std::cell::Cell;
        struct Count<'a> {
            inner: io::Cursor<Vec<u8>>,
            read: &'a Cell<usize>,
        }
        impl Read for Count<'_> {
            fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
                let n = self.inner.read(b)?;
                self.read.set(self.read.get() + n);
                Ok(n)
            }
        }
        impl Seek for Count<'_> {
            fn seek(&mut self, s: SeekFrom) -> io::Result<u64> {
                self.inner.seek(s)
            }
        }
        let n = Cell::new(0);
        let mut b = vec![0; 1_600_000];
        b[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        assert_eq!(
            seekable(
                Count {
                    inner: io::Cursor::new(b),
                    read: &n
                },
                1_600_000,
                &AtomicBool::new(false)
            ),
            Some(100.0)
        );
        assert!(n.get() < 1024);
    }
    #[test]
    fn declared_size_bounds_the_stream_without_panicking() {
        let cancel = AtomicBool::new(false);
        let mut long = vec![0; 100_000];
        long[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0]);
        // A deflated entry may decompress past its declared size.
        for size in 0..12 {
            assert_eq!(
                duration(io::Cursor::new(long.clone()), size, None, &cancel),
                None
            );
        }
        struct Count<'a>(io::Cursor<Vec<u8>>, &'a std::cell::Cell<usize>);
        impl Read for Count<'_> {
            fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
                let n = self.0.read(b)?;
                self.1.set(self.1.get() + n);
                Ok(n)
            }
        }
        let read = std::cell::Cell::new(0);
        assert_eq!(
            duration(Count(io::Cursor::new(long), &read), 16000, None, &cancel),
            Some(1.0)
        );
        assert_eq!(read.get(), 16000, "never reads past the declaration");
        let oversized = super::super::archive_limits::ARCHIVE_MAX_FILE_BYTES + 1;
        assert_eq!(
            duration(io::Cursor::new(vec![0xff; 64]), oversized, None, &cancel),
            None
        );
    }
    #[test]
    fn implausible_header_durations_are_unknown() {
        let mut b = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        b.extend(16u32.to_le_bytes());
        let mut fmt = [0; 16];
        fmt[8..12].copy_from_slice(&1u32.to_le_bytes());
        b.extend(fmt);
        b.extend(b"data");
        b.extend(u32::MAX.to_le_bytes());
        assert_eq!(measure(b), None);
    }
    fn stream(b: &[u8]) -> Option<f64> {
        duration(b, b.len() as u64, None, &AtomicBool::new(false))
    }
    /// Every shortened copy is unknown, by both paths, and never panics.
    fn truncations_are_unknown(b: &[u8]) {
        for n in 0..b.len() {
            assert_eq!(measure(b[..n].to_vec()), None, "seekable, {n} bytes");
            assert_eq!(stream(&b[..n]), None, "stream, {n} bytes");
        }
    }
    fn flac_file(rate: u64, samples: u64) -> Vec<u8> {
        let mut b = b"fLaC\x80\x00\x00\x22".to_vec();
        let mut info = [0u8; 34];
        let packed = (rate << 44) | (1 << 41) | (15 << 36) | samples;
        info[10..18].copy_from_slice(&packed.to_be_bytes());
        b.extend(info);
        b.extend([0xff, 0xf8, 0, 0]);
        b.resize(4096, 0);
        b
    }
    #[test]
    fn flac_streaminfo() {
        assert_eq!(measure(flac_file(44100, 88200)), Some(2.0));
        assert_eq!(stream(&flac_file(48000, 24000)), Some(0.5));
        let mut tagged = b"ID3\x04\x00\x00\x00\x00\x07\x68".to_vec();
        tagged.resize(10 + 1000, 0);
        tagged.extend(flac_file(8000, 8000 * 3));
        assert_eq!(measure(tagged.clone()), Some(3.0));
        assert_eq!(stream(&tagged), Some(3.0));
        assert_eq!(measure(flac_file(44100, 0)), None, "0 samples: unknown");
        truncations_are_unknown(&flac_file(44100, 88200)[..42]);
    }
    fn atom(kind: &[u8], body: &[u8]) -> Vec<u8> {
        let mut b = (8 + body.len() as u32).to_be_bytes().to_vec();
        b.extend(kind);
        b.extend(body);
        b
    }
    fn mvhd(version: u8, scale: u32, duration: u64) -> Vec<u8> {
        let mut b = vec![version, 0, 0, 0];
        let times = if version == 0 { 8 } else { 16 };
        b.resize(4 + times, 7);
        b.extend(scale.to_be_bytes());
        if version == 0 {
            b.extend((duration as u32).to_be_bytes());
        } else {
            b.extend(duration.to_be_bytes());
        }
        b.resize(b.len() + 80, 0);
        atom(b"mvhd", &b)
    }
    fn m4a(mvhd: Vec<u8>, moov_first: bool) -> Vec<u8> {
        let mut b = atom(b"ftyp", b"M4A \0\0\x02\0M4A isom");
        let mut moov = atom(b"udta", &[0; 20]);
        moov.extend(mvhd);
        let moov = atom(b"moov", &moov);
        let mdat = atom(b"mdat", &vec![0; 200_000]);
        if moov_first {
            b.extend(moov);
            b.extend(mdat);
        } else {
            b.extend(atom(b"free", &[0; 8]));
            b.extend(mdat);
            b.extend(moov);
        }
        b
    }
    #[test]
    fn m4a_mvhd_v0_v1_before_and_after_mdat() {
        for moov_first in [true, false] {
            let v0 = m4a(mvhd(0, 44100, 44100 * 5), moov_first);
            assert_eq!(measure(v0.clone()), Some(5.0), "v0 {moov_first}");
            let v1 = m4a(mvhd(1, 1000, 2500), moov_first);
            assert_eq!(measure(v1.clone()), Some(2.5), "v1 {moov_first}");
            // A stream reaches a final `moov` only through the whole `mdat`.
            let expected = |s| moov_first.then_some(s);
            assert_eq!(stream(&v0), expected(5.0));
            assert_eq!(stream(&v1), expected(2.5));
        }
        assert_eq!(measure(m4a(mvhd(0, 1000, 0), true)), None, "fragmented");
        assert_eq!(measure(m4a(mvhd(0, 0, 1000), true)), None);
        assert_eq!(measure(m4a(mvhd(1, 1000, u64::MAX), true)), None);
        // 64-bit box size before the final `moov`.
        let mut big = atom(b"ftyp", b"M4A \0\0\0\0");
        big.extend(1u32.to_be_bytes());
        big.extend(b"mdat");
        big.extend(1016u64.to_be_bytes());
        big.resize(big.len() + 1000, 0);
        big.extend(atom(b"moov", &mvhd(0, 10, 30)));
        assert_eq!(measure(big), Some(3.0));
        truncations_are_unknown(&m4a(mvhd(1, 1000, 2500), false));
    }
    #[test]
    fn mp4_reads_headers_only_when_seekable() {
        struct Count(io::Cursor<Vec<u8>>, std::rc::Rc<std::cell::Cell<usize>>);
        impl Read for Count {
            fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
                let n = self.0.read(b)?;
                self.1.set(self.1.get() + n);
                Ok(n)
            }
        }
        impl Seek for Count {
            fn seek(&mut self, s: SeekFrom) -> io::Result<u64> {
                self.0.seek(s)
            }
        }
        let b = m4a(mvhd(0, 1000, 4000), false);
        let size = b.len() as u64;
        let read = std::rc::Rc::new(std::cell::Cell::new(0));
        let reader = Count(io::Cursor::new(b), read.clone());
        assert_eq!(seekable(reader, size, &AtomicBool::new(false)), Some(4.0));
        assert!(read.get() < 1024, "{} bytes read", read.get());
        let cancelled = AtomicBool::new(true);
        let b = m4a(mvhd(0, 1000, 4000), true);
        assert_eq!(
            seekable(io::Cursor::new(&b), b.len() as u64, &cancelled),
            None
        );
    }
    fn element(id: &[u8], body: &[u8]) -> Vec<u8> {
        let mut b = id.to_vec();
        b.push(1);
        b.extend(&(body.len() as u64).to_be_bytes()[1..]);
        b.extend(body);
        b
    }
    fn webm(info: &[u8], info_first: bool) -> Vec<u8> {
        let mut b = element(
            &[0x1a, 0x45, 0xdf, 0xa3],
            &[0x42, 0x82, 0x84, b'w', b'e', b'b', b'm'],
        );
        let info = element(&[0x15, 0x49, 0xa9, 0x66], info);
        let cluster = element(&[0x1f, 0x43, 0xb6, 0x75], &vec![0; 100_000]);
        let mut segment = element(&[0xec], &[0; 4]);
        if info_first {
            segment.extend(info);
            segment.extend(cluster);
        } else {
            segment.extend(cluster);
            segment.extend(info);
        }
        b.extend([
            0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        ]);
        b.extend(segment);
        b
    }
    #[test]
    fn webm_info_duration() {
        let f32_ms = [&[0x44, 0x89, 0x84][..], &1500f32.to_be_bytes()].concat();
        assert_eq!(measure(webm(&f32_ms, true)), Some(1.5), "default scale");
        assert_eq!(stream(&webm(&f32_ms, true)), Some(1.5));
        let scaled = [
            &[0x2a, 0xd7, 0xb1, 0x83, 0x01, 0x86, 0xa0][..],
            &[0x44, 0x89, 0x88],
            &30000f64.to_be_bytes(),
        ]
        .concat();
        assert_eq!(measure(webm(&scaled, true)), Some(3.0), "100 µs ticks");
        assert_eq!(
            measure(webm(&scaled, false)),
            Some(3.0),
            "Info after a Cluster"
        );
        assert_eq!(
            stream(&webm(&scaled, false)),
            None,
            "a stream never reads a Cluster"
        );
        let scale_only = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
        assert_eq!(measure(webm(&scale_only, true)), None, "no Duration");
        truncations_are_unknown(&webm(&scaled, false));
    }
    #[test]
    fn empty_id3v2_tag_keeps_the_start_of_the_frame() {
        let mut b = b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec();
        b.extend_from_slice(&[0xff, 0xfb, 0x90, 0]);
        b.resize(16010, 0);
        assert_eq!(measure(b), Some(1.0));
    }
}
