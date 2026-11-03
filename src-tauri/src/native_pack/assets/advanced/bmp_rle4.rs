//! BI_RLE4, implemented from Microsoft's Bitmap Compression and BMP headers:
//! https://learn.microsoft.com/en-us/windows/win32/gdi/bitmap-compression
//! Positive height, bottom-up rows; absolute packets are word aligned.
use super::super::image::ensure_image_320x240;

pub(super) fn is_conformant(bytes: &[u8]) -> bool {
    bytes.len() >= 118
        && bytes.starts_with(b"BM")
        && bytes[10..14] == 118u32.to_le_bytes()
        && bytes[14..18] == 40u32.to_le_bytes()
        && bytes[18..22] == 320i32.to_le_bytes()
        && bytes[22..26] == 240i32.to_le_bytes()
        && bytes[26..28] == 1u16.to_le_bytes()
        && bytes[28..30] == 4u16.to_le_bytes()
        && bytes[30..34] == 2u32.to_le_bytes()
        && matches!(
            u32::from_le_bytes(bytes[46..50].try_into().unwrap()),
            0 | 16
        )
        && bytes[54..118]
            .chunks_exact(4)
            .all(|c| c[0] == c[1] && c[1] == c[2])
        && image::load_from_memory(bytes).is_ok_and(|i| i.width() == 320 && i.height() == 240)
}

pub(super) fn encode_320x240(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let resized = ensure_image_320x240(bytes, "conteuse")?;
    let mut rgba = image::load_from_memory(resized.as_deref().unwrap_or(bytes))
        .map_err(|e| e.to_string())?
        .to_rgba8();
    for pixel in rgba.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel[3] = 255;
    }
    let image = image::DynamicImage::ImageRgba8(rgba).to_luma8();
    encode_gray(&image)
}

/// Minimum squared luminance error for at most sixteen contiguous histogram
/// intervals. Empty levels carry no weight; equal costs choose the first split.
fn quantize(image: &image::GrayImage) -> ([u8; 16], Vec<u8>) {
    let mut histogram = [0u64; 256];
    for &v in image.as_raw() {
        histogram[v as usize] += 1;
    }
    let levels: Vec<_> = (0..256).filter(|&v| histogram[v] > 0).collect();
    let n = levels.len();
    let k = n.min(16);
    let mut sums = vec![[0u64; 3]; n + 1];
    for (i, &v) in levels.iter().enumerate() {
        let w = histogram[v];
        sums[i + 1] = [
            sums[i][0] + w,
            sums[i][1] + w * v as u64,
            sums[i][2] + w * (v * v) as u64,
        ];
    }
    let cost = |a: usize, b: usize| {
        let w = (sums[b][0] - sums[a][0]) as f64;
        let s = (sums[b][1] - sums[a][1]) as f64;
        let mean = (s / w).round();
        (sums[b][2] - sums[a][2]) as f64 - 2.0 * mean * s + mean * mean * w
    };
    let mut dp = vec![vec![f64::INFINITY; n + 1]; k + 1];
    let mut split = vec![vec![0; n + 1]; k + 1];
    dp[0][0] = 0.0;
    for c in 1..=k {
        for b in c..=n {
            for a in c - 1..b {
                let value = dp[c - 1][a] + cost(a, b);
                if value < dp[c][b] {
                    dp[c][b] = value;
                    split[c][b] = a;
                }
            }
        }
    }
    let mut palette = [0; 16];
    let mut lookup = [0u8; 256];
    let mut b = n;
    for c in (1..=k).rev() {
        let a = split[c][b];
        let w = sums[b][0] - sums[a][0];
        palette[c - 1] = ((sums[b][1] - sums[a][1] + w / 2) / w) as u8;
        for &v in &levels[a..b] {
            lookup[v] = (c - 1) as u8;
        }
        b = a;
    }
    let last = palette[k - 1];
    palette[k..].fill(last);
    (
        palette,
        image.as_raw().iter().map(|&v| lookup[v as usize]).collect(),
    )
}

/// Shortest legal stream for this row (encoded alternating pairs or absolute
/// packets). Encoded packets also handle the one/two pixel tails unambiguously.
fn row_stream(row: &[u8], out: &mut Vec<u8>) {
    let n = row.len();
    let mut costs = vec![usize::MAX; n + 1];
    let mut choices = vec![(0, false); n];
    costs[n] = 0;
    for x in (0..n).rev() {
        let mut alternating = true;
        for len in 1..=255.min(n - x) {
            alternating &= row[x + len - 1] == row[x + (len - 1) % 2];
            if alternating && 2 + costs[x + len] < costs[x] {
                costs[x] = 2 + costs[x + len];
                choices[x] = (len, false);
            }
            let absolute = 2 + len.div_ceil(2).div_ceil(2) * 2;
            if len >= 3 && absolute + costs[x + len] <= costs[x] {
                costs[x] = absolute + costs[x + len];
                choices[x] = (len, true);
            }
        }
    }
    let mut x = 0;
    while x < n {
        let (len, absolute) = choices[x];
        if absolute {
            out.extend([0, len as u8]);
            for pair in row[x..x + len].chunks(2) {
                out.push(pair[0] << 4 | pair.get(1).copied().unwrap_or(0));
            }
            if len.div_ceil(2) % 2 != 0 {
                out.push(0);
            }
        } else {
            out.extend([
                len as u8,
                row[x] << 4 | row.get(x + 1).copied().unwrap_or(row[x]),
            ]);
        }
        x += len;
    }
    out.extend([0, 0]);
}

fn encode_gray(image: &image::GrayImage) -> Result<Vec<u8>, String> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("empty bitmap".into());
    }
    let (palette, pixels) = quantize(image);
    let mut stream = Vec::new();
    for row in pixels.chunks_exact(width as usize).rev() {
        row_stream(row, &mut stream);
    }
    stream.extend([0, 1]);
    let mut bmp = vec![0; 118];
    bmp[..2].copy_from_slice(b"BM");
    for (offset, value) in [
        (2, 118 + stream.len() as u32),
        (10, 118),
        (14, 40),
        (18, width),
        (22, height),
        (30, 2),
        (34, stream.len() as u32),
        (46, 16),
    ] {
        bmp[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
    bmp[28..30].copy_from_slice(&4u16.to_le_bytes());
    for (i, &gray) in palette.iter().enumerate() {
        bmp[54 + i * 4..57 + i * 4].fill(gray);
    }
    bmp.extend(stream);
    // Independent decoder verifies dimensions, grayscale colour count, row
    // order and every reconstructed pixel before the executor publishes it.
    let decoded = image::load_from_memory(&bmp)
        .map_err(|e| e.to_string())?
        .to_rgb8();
    let colors: std::collections::HashSet<_> = decoded.pixels().map(|p| p.0).collect();
    if decoded.dimensions() != (width, height)
        || colors.len() > 16
        || decoded
            .pixels()
            .zip(&pixels)
            .any(|(p, &i)| p.0 != [palette[i as usize]; 3])
    {
        return Err("BMP RLE4 round-trip mismatch".into());
    }
    Ok(bmp)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transparent_image_is_composited_on_white_and_offset_is_required() {
        let rgba = image::RgbaImage::from_pixel(320, 240, image::Rgba([0, 0, 0, 0]));
        let mut png = std::io::Cursor::new(Vec::new());
        rgba.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let mut bmp = encode_320x240(png.get_ref()).unwrap();
        assert!(is_conformant(&bmp));
        assert!(image::load_from_memory(&bmp)
            .unwrap()
            .to_luma8()
            .pixels()
            .all(|p| p[0] == 255));
        bmp.insert(118, 0);
        bmp[10..14].copy_from_slice(&119u32.to_le_bytes());
        assert!(!is_conformant(&bmp));
    }

    #[test]
    fn rle4_roundtrip_patterns_odd_pixels_and_single_pixel_rows() {
        for (w, h) in [(320, 240), (1, 7), (7, 3), (255, 1), (257, 3)] {
            for pattern in 0..5 {
                let image = image::GrayImage::from_fn(w, h, |x, y| {
                    image::Luma([match pattern {
                        0 => 83,
                        1 => (x * 255 / w) as u8,
                        2 => {
                            if (x + y) % 2 == 0 {
                                0
                            } else {
                                255
                            }
                        }
                        3 => {
                            if x == w / 2 {
                                255
                            } else {
                                0
                            }
                        }
                        _ => ((x * 37 + y * 73) % 256) as u8,
                    }])
                });
                let bmp = encode_gray(&image).unwrap();
                // Absolute packets for a whole row give this universal bound.
                let packets = (w as usize).div_ceil(255);
                assert!(bmp.len() <= 118 + h as usize * (w as usize / 2 + 6 * packets + 2) + 2);
                let decoded = image::load_from_memory(&bmp).unwrap().to_luma8();
                if pattern != 1 && pattern != 4 {
                    assert_eq!(decoded, image);
                }
                if pattern == 0 {
                    assert_eq!(bmp[54], 83);
                }
            }
        }
    }
    #[test]
    fn rle4_palette_adapts_exactly_to_sixteen_irregular_levels() {
        let levels = [
            3, 7, 12, 18, 25, 33, 42, 52, 63, 75, 88, 102, 117, 133, 150, 168,
        ];
        let image = image::GrayImage::from_fn(16, 3, |x, _| image::Luma([levels[x as usize]]));
        let bmp = encode_gray(&image).unwrap();
        assert_eq!(image::load_from_memory(&bmp).unwrap().to_luma8(), image);
        assert_eq!(
            bmp[54..118]
                .chunks_exact(4)
                .map(|c| c[0])
                .collect::<Vec<_>>(),
            levels
        );
    }
    #[test]
    fn rle4_quantization_merges_the_lowest_error_pair() {
        // Seventeen occupied levels, one extra adjacent pair: the optimum
        // merges 1 and 2, with integer representative 2 and squared error 1.
        let mut levels = vec![1, 2];
        levels.extend((1..16).map(|n| n * 16));
        let image = image::GrayImage::from_raw(17, 1, levels.clone()).unwrap();
        let (palette, indices) = quantize(&image);
        let error: i32 = levels
            .iter()
            .zip(indices)
            .map(|(&v, i)| (i32::from(v) - i32::from(palette[i as usize])).pow(2))
            .sum();
        assert_eq!(error, 1);
    }
    #[test]
    fn rle4_absolute_word_padding_and_bottom_up_order() {
        let mut out = Vec::new();
        row_stream(&[1, 2, 3, 4, 5], &mut out);
        assert_eq!(out, [0, 5, 0x12, 0x34, 0x50, 0, 0, 0]);
        let image = image::GrayImage::from_fn(9, 3, |x, y| image::Luma([(x + y * 9) as u8]));
        assert!(encode_gray(&image).is_ok());
    }
}
