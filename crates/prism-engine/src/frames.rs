//! The size of the frames a container holds, read without decoding them.
//!
//! Two formats state an image's size twice. A GIF has a logical screen and
//! then one descriptor per frame; an extended WebP has a `VP8X` canvas and
//! then a bitstream — or one per `ANMF` frame — whose own header states its
//! size. `image` reports the first number and its decoders allocate from the
//! second: a "1x1" GIF whose frame is 3000x3000 is read into a 36 MB buffer,
//! and a "1x1" WebP canvas in front of a 4000x4000 `VP8 ` chunk is decoded in
//! full before the two are compared. The pixel ceiling has to see the second
//! number, so it is read here — a walk over the chunk and block headers,
//! proportional to the file and allocating nothing.

use crate::error::EngineError;

fn unreadable(format: &str, why: &str) -> EngineError {
    EngineError::Unreadable(format!("{format}: {why}"))
}

/// What the frames of a GIF declare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GifFrames {
    /// The first frame's size: the one `image` decodes.
    pub first: Option<(u32, u32)>,
    /// The largest frame of the file, in pixels.
    pub largest: u64,
}

/// Walk a GIF's blocks for every image descriptor.
///
/// A file cut short after its first frame is not refused here: `image` reads
/// only that frame, and the decoder reports the truncation itself if it
/// matters. A block this walk does not know is refused, as the decoder would.
pub fn gif(bytes: &[u8]) -> Result<GifFrames, EngineError> {
    // Header (6) and logical screen descriptor (7). GIF89a, section 18.
    let packed = *bytes
        .get(10)
        .ok_or_else(|| unreadable("GIF", "truncated header"))?;
    let mut position = 13 + colour_table(packed);
    let mut frames = GifFrames {
        first: None,
        largest: 0,
    };
    while let Some(&introducer) = bytes.get(position) {
        match introducer {
            // Image descriptor: separator, left, top, width, height, packed.
            0x2C => {
                let Some(descriptor) = bytes.get(position..position + 10) else {
                    break;
                };
                let width = u32::from(u16::from_le_bytes([descriptor[5], descriptor[6]]));
                let height = u32::from(u16::from_le_bytes([descriptor[7], descriptor[8]]));
                frames.first.get_or_insert((width, height));
                frames.largest = frames.largest.max(u64::from(width) * u64::from(height));
                // Local colour table, then the LZW minimum code size, then
                // the data sub-blocks.
                position += 10 + colour_table(descriptor[9]) + 1;
                position = skip_sub_blocks(bytes, position);
            }
            // Extension: introducer, label, then sub-blocks.
            0x21 => position = skip_sub_blocks(bytes, position + 2),
            // Trailer.
            0x3B => break,
            _ => return Err(unreadable("GIF", "unknown block")),
        }
    }
    Ok(frames)
}

/// Bytes of the colour table a packed field announces.
fn colour_table(packed: u8) -> usize {
    if packed & 0x80 == 0 {
        0
    } else {
        3 << ((packed & 0x07) + 1)
    }
}

/// The position after a run of data sub-blocks — or past the end when the
/// file stops inside them, which ends the walk.
fn skip_sub_blocks(bytes: &[u8], mut position: usize) -> usize {
    while let Some(&length) = bytes.get(position) {
        position += 1;
        if length == 0 {
            return position;
        }
        position += usize::from(length);
    }
    usize::MAX
}

/// Check that every bitstream of an extended WebP has the size its frame
/// declares.
///
/// `canvas` is what the `VP8X` chunk declares, as `image` reported it. A
/// still image's `VP8 ` or `VP8L` chunk must be exactly that size, and an
/// animation frame's bitstream exactly its `ANMF` rectangle: the decoder
/// refuses any other size too, but only after decoding the bitstream into
/// buffers sized from it. A simple file — no `VP8X` — has one size, and
/// nothing to check.
pub fn webp(bytes: &[u8], canvas: (u32, u32)) -> Result<(), EngineError> {
    if bytes.get(12..16) != Some(b"VP8X".as_slice()) {
        return Ok(());
    }
    let declared = bytes
        .get(4..8)
        .map(|size| u32::from_le_bytes([size[0], size[1], size[2], size[3]]))
        .ok_or_else(|| unreadable("WebP", "truncated header"))?;
    let end = usize::try_from(declared)
        .ok()
        .and_then(|size| size.checked_add(8))
        .map_or(bytes.len(), |end| end.min(bytes.len()));
    for (fourcc, payload) in chunks(&bytes[..end], 12) {
        match fourcc {
            b"VP8 " | b"VP8L" => same_size(fourcc, payload, canvas)?,
            b"ANMF" => {
                let header = payload
                    .get(..16)
                    .ok_or_else(|| unreadable("WebP", "truncated animation frame"))?;
                let frame = (u24(&header[6..9]) + 1, u24(&header[9..12]) + 1);
                for (inner, data) in chunks(payload, 16) {
                    if matches!(inner, b"VP8 " | b"VP8L") {
                        same_size(inner, data, frame)?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// RIFF chunks from `start`: each FourCC and its payload, as much of it as
/// the file holds. Stops at the first header that does not fit.
fn chunks(bytes: &[u8], start: usize) -> impl Iterator<Item = (&[u8; 4], &[u8])> {
    let mut position = start;
    std::iter::from_fn(move || {
        let header = bytes.get(position..position.checked_add(8)?)?;
        let fourcc: &[u8; 4] = header[..4].try_into().ok()?;
        let size = usize::try_from(u32::from_le_bytes([
            header[4], header[5], header[6], header[7],
        ]))
        .ok()?;
        let body = position + 8;
        let payload = &bytes[body..body.saturating_add(size).min(bytes.len())];
        // Payloads are padded to an even length.
        position = body.saturating_add(size).saturating_add(size & 1);
        Some((fourcc, payload))
    })
}

fn u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | u32::from(bytes[1]) << 8 | u32::from(bytes[2]) << 16
}

/// Refuse a bitstream whose own header states a size other than `expected`.
fn same_size(fourcc: &[u8; 4], payload: &[u8], expected: (u32, u32)) -> Result<(), EngineError> {
    let found = if fourcc == b"VP8 " {
        vp8_size(payload)?
    } else {
        vp8l_size(payload)?
    };
    if found != expected {
        return Err(unreadable(
            "WebP",
            &format!(
                "a {}x{} bitstream inside a {}x{} frame",
                found.0, found.1, expected.0, expected.1
            ),
        ));
    }
    Ok(())
}

/// RFC 6386, 9.1: a key frame's tag, start code and 14-bit dimensions.
fn vp8_size(payload: &[u8]) -> Result<(u32, u32), EngineError> {
    let header = payload
        .get(..10)
        .ok_or_else(|| unreadable("WebP", "truncated VP8 frame header"))?;
    if header[0] & 1 != 0 || header[3..6] != [0x9d, 0x01, 0x2a] {
        return Err(unreadable("WebP", "VP8 bitstream without a key frame"));
    }
    let width = u16::from_le_bytes([header[6], header[7]]) & 0x3FFF;
    let height = u16::from_le_bytes([header[8], header[9]]) & 0x3FFF;
    Ok((u32::from(width), u32::from(height)))
}

/// RFC 9649, 3.2: signature, then 14-bit width and height minus one.
fn vp8l_size(payload: &[u8]) -> Result<(u32, u32), EngineError> {
    let header = payload
        .get(..5)
        .filter(|header| header[0] == 0x2F)
        .ok_or_else(|| unreadable("WebP", "VP8L bitstream without its signature"))?;
    let bits = u32::from_le_bytes([header[1], header[2], header[3], header[4]]);
    Ok(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A GIF89a with a 1x1 screen, no colour tables, and the given frames.
    fn gif_with(frames: &[(u16, u16)]) -> Vec<u8> {
        let mut out = b"GIF89a".to_vec();
        out.extend_from_slice(&[1, 0, 1, 0, 0, 0, 0]);
        // A graphic control extension, to be skipped.
        out.extend_from_slice(&[0x21, 0xF9, 4, 0, 0, 0, 0, 0]);
        for (width, height) in frames {
            out.push(0x2C);
            out.extend_from_slice(&[0, 0, 0, 0]);
            out.extend_from_slice(&width.to_le_bytes());
            out.extend_from_slice(&height.to_le_bytes());
            out.extend_from_slice(&[0, 2, 1, 0x44, 0]);
        }
        out.push(0x3B);
        out
    }

    #[test]
    fn reads_every_gif_frame() {
        let frames = gif(&gif_with(&[(3, 2), (4000, 3000), (10, 10)])).expect("walks");
        assert_eq!(frames.first, Some((3, 2)));
        assert_eq!(frames.largest, 12_000_000);
    }

    #[test]
    fn a_truncated_gif_keeps_what_it_read() {
        let mut bytes = gif_with(&[(5, 5)]);
        bytes.truncate(bytes.len() - 3);
        assert_eq!(gif(&bytes).expect("walks").first, Some((5, 5)));
        assert_eq!(gif(&bytes[..10]).expect_err("refuses").code(), "UNREADABLE");
    }

    #[test]
    fn an_unknown_gif_block_is_unreadable() {
        let mut bytes = gif_with(&[]);
        bytes.insert(bytes.len() - 1, 0x99);
        assert_eq!(gif(&bytes).expect_err("refuses").code(), "UNREADABLE");
    }

    fn chunk(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = fourcc.to_vec();
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn vp8(width: u16, height: u16) -> Vec<u8> {
        let mut payload = vec![0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a];
        payload.extend_from_slice(&width.to_le_bytes());
        payload.extend_from_slice(&height.to_le_bytes());
        chunk(b"VP8 ", &payload)
    }

    fn vp8l(width: u32, height: u32) -> Vec<u8> {
        let bits = (width - 1) | (height - 1) << 14;
        let mut payload = vec![0x2F];
        payload.extend_from_slice(&bits.to_le_bytes());
        chunk(b"VP8L", &payload)
    }

    fn extended(body: &[u8]) -> Vec<u8> {
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&((4 + 18 + body.len()) as u32).to_le_bytes());
        out.extend_from_slice(b"WEBP");
        out.extend_from_slice(&chunk(b"VP8X", &[0; 10]));
        out.extend_from_slice(body);
        out
    }

    fn anmf(width: u32, height: u32, bitstream: &[u8]) -> Vec<u8> {
        let mut payload = vec![0; 6];
        payload.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        payload.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        payload.extend_from_slice(&[0; 4]);
        payload.extend_from_slice(bitstream);
        chunk(b"ANMF", &payload)
    }

    #[test]
    fn a_still_bitstream_must_match_the_canvas() {
        assert!(webp(&extended(&vp8(1, 1)), (1, 1)).is_ok());
        assert!(webp(&extended(&vp8l(7, 3)), (7, 3)).is_ok());
        let error = webp(&extended(&vp8(4000, 4000)), (1, 1)).expect_err("refuses");
        assert_eq!(error.code(), "UNREADABLE");
        assert!(error.to_string().contains("4000x4000"), "{error}");
        let error = webp(&extended(&vp8l(4000, 4000)), (1, 1)).expect_err("refuses");
        assert_eq!(error.code(), "UNREADABLE");
    }

    #[test]
    fn an_animation_frame_must_match_its_rectangle() {
        let good = extended(&anmf(2, 2, &vp8(2, 2)));
        assert!(webp(&good, (4, 4)).is_ok());
        let mut alpha_then_lie = chunk(b"ALPH", &[0; 3]);
        alpha_then_lie.extend_from_slice(&vp8(3000, 3000));
        let lying = extended(&anmf(2, 2, &alpha_then_lie));
        assert_eq!(
            webp(&lying, (4, 4)).expect_err("refuses").code(),
            "UNREADABLE"
        );
    }

    #[test]
    fn a_simple_webp_has_nothing_to_check() {
        let mut simple = b"RIFF\0\0\0\0WEBP".to_vec();
        simple.extend_from_slice(&vp8(9, 9));
        assert!(webp(&simple, (9, 9)).is_ok());
    }

    #[test]
    fn a_vp8_chunk_without_a_key_frame_is_unreadable() {
        let mut payload = vp8(1, 1);
        payload[8] |= 1;
        assert_eq!(
            webp(&extended(&payload), (1, 1))
                .expect_err("refuses")
                .code(),
            "UNREADABLE"
        );
    }
}
