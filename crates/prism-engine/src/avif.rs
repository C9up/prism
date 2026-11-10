//! Bounding an AVIF before anything decodes it.
//!
//! `image`'s AVIF decoder decodes the whole AV1 frame inside its constructor,
//! so asking it for the dimensions is a full decode — a 2 KB file declaring
//! 16000x16000 costs a gigabyte and a third of a second before any ceiling is
//! consulted. And it builds its `dav1d` decoder with default settings, which
//! put no bound on a frame's size at all.
//!
//! So an AVIF is bounded here in two steps, neither of which goes through
//! `image`:
//!
//! 1. [`declared`] reads the container and the AV1 sequence headers — a few
//!    hundred bits — for the largest frame the streams declare. That is what
//!    the probe checks, and it decodes nothing.
//! 2. [`preflight`] decodes the streams once with `dav1d`'s own
//!    `frame_size_limit` set to the ceiling, before `image` decodes them
//!    again. A frame header may override the sequence header's size, and
//!    `dav1d` checks neither against the other: its limit is the only place
//!    a frame lying about its size is caught before the allocation. The price
//!    is a second decode of every AVIF, which is the cheap half of AVIF.

use std::io::Cursor;

use mp4parse::{read_avif, ParseStrictness};

use crate::error::EngineError;

/// The largest frame an AVIF's AV1 streams declare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Declared {
    /// The primary item's frame size, as its first sequence header states it.
    pub width: u32,
    pub height: u32,
    /// The largest frame any sequence header of any item allows, in pixels.
    pub max_pixels: u64,
}

fn unreadable(why: impl std::fmt::Display) -> EngineError {
    EngineError::Unreadable(format!("AVIF: {why}"))
}

/// The coded AV1 data of the primary item and of the alpha item, if any.
fn items(bytes: &[u8]) -> Result<(Vec<u8>, Option<Vec<u8>>), EngineError> {
    let context = read_avif(&mut Cursor::new(bytes), ParseStrictness::Normal)
        .map_err(|error| unreadable(format!("{error:?}")))?;
    let primary = context
        .primary_item_coded_data()
        .filter(|data| !data.is_empty())
        .ok_or_else(|| unreadable("no primary image item"))?
        .to_vec();
    let alpha = context
        .alpha_item_coded_data()
        .filter(|data| !data.is_empty())
        .map(<[u8]>::to_vec);
    Ok((primary, alpha))
}

/// Read the dimensions an AVIF declares, decoding nothing.
pub fn declared(bytes: &[u8]) -> Result<Declared, EngineError> {
    let (primary, alpha) = items(bytes)?;
    let (width, height, mut max_pixels) = largest_frame(&primary)?;
    if let Some(alpha) = alpha {
        let (_, _, alpha_pixels) = largest_frame(&alpha)?;
        max_pixels = max_pixels.max(alpha_pixels);
    }
    Ok(Declared {
        width,
        height,
        max_pixels,
    })
}

/// Decode every AV1 stream of an AVIF under a frame-size limit, and throw
/// the pictures away. See the module documentation for why.
pub fn preflight(bytes: &[u8], max_pixels: u64) -> Result<(), EngineError> {
    let (primary, alpha) = items(bytes)?;
    decode_bounded(primary, max_pixels)?;
    if let Some(alpha) = alpha {
        decode_bounded(alpha, max_pixels)?;
    }
    Ok(())
}

/// `ERANGE`, which `dav1d` answers when a frame is over `frame_size_limit`.
const DAV1D_ERANGE: i32 = -34;

pub(crate) fn decode_bounded(data: Vec<u8>, max_pixels: u64) -> Result<(), EngineError> {
    let mut settings = dav1d::Settings::new();
    // One frame context: decoding is synchronous inside `send_data`, so a
    // stream that yields no picture is KNOWN to yield none once its data is
    // consumed. With frame threading `dav1d` keeps answering "again", and
    // `image`'s read loop spins on that forever.
    settings.set_n_threads(1);
    settings.set_max_frame_delay(1);
    // Zero means "no limit" to dav1d; `max_pixels` is never zero.
    settings.set_frame_size_limit(u32::try_from(max_pixels).unwrap_or(u32::MAX));
    let refused = |error: dav1d::Error| match error {
        dav1d::Error::UnknownError(DAV1D_ERANGE) => {
            EngineError::Decode(format!("an AV1 frame is over the {max_pixels}-pixel limit"))
        }
        other => EngineError::Decode(format!("AV1: {other}")),
    };

    let mut decoder = dav1d::Decoder::with_settings(&settings).map_err(refused)?;
    let mut pending = match decoder.send_data(data, None, None, None) {
        Ok(()) => false,
        Err(dav1d::Error::Again) => true,
        Err(error) => return Err(refused(error)),
    };
    loop {
        match decoder.get_picture() {
            Ok(_) => return Ok(()),
            Err(dav1d::Error::Again) if pending => {
                pending = match decoder.send_pending_data() {
                    Ok(()) => false,
                    Err(dav1d::Error::Again) => true,
                    Err(error) => return Err(refused(error)),
                };
            }
            Err(dav1d::Error::Again) => {
                return Err(EngineError::Decode(
                    "the AV1 stream holds no displayable frame".into(),
                ))
            }
            Err(error) => return Err(refused(error)),
        }
    }
}

/// The first sequence header's frame size, and the largest any sequence
/// header in the stream allows.
fn largest_frame(data: &[u8]) -> Result<(u32, u32, u64), EngineError> {
    let mut first = None;
    let mut max_pixels = 0u64;
    let mut rest = data;
    while !rest.is_empty() {
        let (kind, payload, next) = obu(rest)?;
        rest = next;
        if kind == OBU_SEQUENCE_HEADER {
            let (width, height) = sequence_header_size(payload)?;
            max_pixels = max_pixels.max(u64::from(width) * u64::from(height));
            first.get_or_insert((width, height));
        }
    }
    let (width, height) = first.ok_or_else(|| unreadable("no AV1 sequence header"))?;
    Ok((width, height, max_pixels))
}

const OBU_SEQUENCE_HEADER: u8 = 1;

/// Split one OBU off the front: its type, its payload, and what follows.
/// AV1 spec 5.3.
fn obu(data: &[u8]) -> Result<(u8, &[u8], &[u8]), EngineError> {
    let truncated = || unreadable("truncated OBU");
    let header = *data.first().ok_or_else(truncated)?;
    let kind = (header >> 3) & 0x0F;
    let has_extension = header & 0b100 != 0;
    let has_size = header & 0b10 != 0;
    let mut offset = 1 + usize::from(has_extension);
    if offset > data.len() {
        return Err(truncated());
    }
    let size = if has_size {
        let (size, used) = leb128(&data[offset..])?;
        offset += used;
        usize::try_from(size).map_err(|_| truncated())?
    } else {
        data.len() - offset
    };
    let end = offset.checked_add(size).ok_or_else(truncated)?;
    if end > data.len() {
        return Err(truncated());
    }
    Ok((kind, &data[offset..end], &data[end..]))
}

/// AV1 spec 4.10.5: at most eight bytes, seven bits each.
fn leb128(data: &[u8]) -> Result<(u64, usize), EngineError> {
    let mut value = 0u64;
    for (index, byte) in data.iter().take(8).enumerate() {
        value |= u64::from(byte & 0x7F) << (index * 7);
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
    }
    Err(unreadable("malformed OBU size"))
}

/// Read a sequence header far enough to reach `max_frame_width_minus_1` and
/// `max_frame_height_minus_1`. AV1 spec 5.5.
fn sequence_header_size(payload: &[u8]) -> Result<(u32, u32), EngineError> {
    let mut bits = Bits::new(payload);
    let _seq_profile = bits.read(3)?;
    let _still_picture = bits.read(1)?;
    let reduced_still_picture_header = bits.read(1)? == 1;
    if reduced_still_picture_header {
        let _seq_level_idx = bits.read(5)?;
    } else {
        let mut decoder_model_info_present = false;
        let mut buffer_delay_length = 0;
        if bits.read(1)? == 1 {
            // timing_info()
            let _num_units_in_display_tick = bits.read(32)?;
            let _time_scale = bits.read(32)?;
            if bits.read(1)? == 1 {
                bits.uvlc()?;
            }
            decoder_model_info_present = bits.read(1)? == 1;
            if decoder_model_info_present {
                // decoder_model_info()
                buffer_delay_length = bits.read(5)? + 1;
                let _num_units_in_decoding_tick = bits.read(32)?;
                let _buffer_removal_time_length_minus_1 = bits.read(5)?;
                let _frame_presentation_time_length_minus_1 = bits.read(5)?;
            }
        }
        let initial_display_delay_present = bits.read(1)? == 1;
        let operating_points = bits.read(5)? + 1;
        for _ in 0..operating_points {
            let _operating_point_idc = bits.read(12)?;
            let seq_level_idx = bits.read(5)?;
            if seq_level_idx > 7 {
                let _seq_tier = bits.read(1)?;
            }
            if decoder_model_info_present && bits.read(1)? == 1 {
                // operating_parameters_info()
                let _decoder_buffer_delay = bits.read(buffer_delay_length)?;
                let _encoder_buffer_delay = bits.read(buffer_delay_length)?;
                let _low_delay_mode_flag = bits.read(1)?;
            }
            if initial_display_delay_present && bits.read(1)? == 1 {
                let _initial_display_delay_minus_1 = bits.read(4)?;
            }
        }
    }
    let width_bits = bits.read(4)? + 1;
    let height_bits = bits.read(4)? + 1;
    let width = bits.read(width_bits)? + 1;
    let height = bits.read(height_bits)? + 1;
    Ok((width, height))
}

/// Big-endian bit reader over a sequence header. AV1 spec 4.10.
struct Bits<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    /// Up to 32 bits.
    fn read(&mut self, count: u32) -> Result<u32, EngineError> {
        let mut value = 0u64;
        for _ in 0..count {
            let byte = self
                .data
                .get(self.position / 8)
                .ok_or_else(|| unreadable("truncated AV1 sequence header"))?;
            let bit = (byte >> (7 - self.position % 8)) & 1;
            value = (value << 1) | u64::from(bit);
            self.position += 1;
        }
        u32::try_from(value).map_err(|_| unreadable("AV1 field wider than 32 bits"))
    }

    /// AV1 spec 4.10.3.
    fn uvlc(&mut self) -> Result<u64, EngineError> {
        let mut leading_zeros = 0u32;
        while self.read(1)? == 0 {
            leading_zeros += 1;
            if leading_zeros >= 32 {
                return Ok(u64::from(u32::MAX));
            }
        }
        let value = u64::from(self.read(leading_zeros)?);
        Ok(value + (1u64 << leading_zeros) - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

    fn avif(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 64, 200])
        });
        crate::encode::encode(&DynamicImage::ImageRgba8(image), ImageFormat::Avif, 80, 8)
            .expect("encodes")
    }

    #[test]
    fn reads_the_declared_size_of_an_encoded_avif() {
        let declared = declared(&avif(48, 32)).expect("reads");
        assert_eq!((declared.width, declared.height), (48, 32));
        assert_eq!(declared.max_pixels, 48 * 32);
    }

    #[test]
    fn the_dav1d_limit_refuses_a_frame_over_the_ceiling() {
        // The size check on the sequence header is the first line; this is
        // the second, for a frame header that overrides it. Exercised here
        // directly, since no encoder at hand writes a lying frame header.
        let (primary, _) = items(&avif(48, 32)).expect("parses");
        decode_bounded(primary.clone(), 48 * 32).expect("at the limit decodes");
        let error = decode_bounded(primary, 48 * 32 - 1).expect_err("refuses");
        assert_eq!(error.code(), "DECODE_FAILED");
        assert!(error.to_string().contains("pixel limit"), "{error}");
    }

    #[test]
    fn a_stream_with_no_frame_is_refused_rather_than_waited_on() {
        // Only the sequence header: `image`'s read loop would ask for a
        // picture forever.
        let (primary, _) = items(&avif(16, 16)).expect("parses");
        let mut rest = primary.as_slice();
        let mut header = None;
        while !rest.is_empty() {
            let (kind, _, next) = obu(rest).expect("splits");
            if kind == OBU_SEQUENCE_HEADER {
                header = Some(rest[..rest.len() - next.len()].to_vec());
            }
            rest = next;
        }
        let error =
            decode_bounded(header.expect("has a sequence header"), 1 << 20).expect_err("refuses");
        assert_eq!(error.code(), "DECODE_FAILED");
    }

    #[test]
    fn a_truncated_stream_is_unreadable_not_a_panic() {
        let (primary, _) = items(&avif(16, 16)).expect("parses");
        for cut in 0..primary.len().min(64) {
            let _ = largest_frame(&primary[..cut]);
        }
        assert_eq!(
            largest_frame(&[]).expect_err("refuses").code(),
            "UNREADABLE"
        );
    }
}
