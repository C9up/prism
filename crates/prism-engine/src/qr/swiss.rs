//! The Swiss QR code's symbol: the module matrix of a QR-bill's payload.
//!
//! Encoded as `swissqrbill` (4.4.2, read from its tarball) encodes it with
//! its bundled `qrcodegen`: an ECI designator 26 announcing UTF-8, the payload
//! in byte mode, error correction M, the smallest version from 10 to 25 that
//! holds it — 25 being the ceiling the Swiss implementation guidelines set —
//! and the mask `qrcodegen`'s penalty score picks. The `qrcode` crate scores
//! masks its own way and can pick another one; the symbol would still scan,
//! but it would no longer be upstream's, module for module.
//!
//! The swiss cross and the drawing are the caller's: the bill is laid out in
//! TypeScript, around this.

use qrcode::bits::Bits;
use qrcode::canvas::{Canvas, MaskPattern};
use qrcode::types::QrError;
use qrcode::{ec, Color, EcLevel, Version};

use super::MAX_TEXT_BYTES;
use crate::error::EngineError;

/// The ECI assignment number of UTF-8.
const UTF8_ECI: u32 = 26;

/// The versions `swissqrbill` lets its encoder choose from.
const VERSIONS: std::ops::RangeInclusive<i16> = 10..=25;

/// The eight masks, in the order of their numbers — `qrcodegen` keeps the
/// first of equally scored ones.
const MASKS: [MaskPattern; 8] = [
    MaskPattern::Checkerboard,
    MaskPattern::HorizontalLines,
    MaskPattern::VerticalLines,
    MaskPattern::DiagonalLines,
    MaskPattern::LargeCheckerboard,
    MaskPattern::Fields,
    MaskPattern::Diamonds,
    MaskPattern::Meadow,
];

/// The symbol: `size` × `size` modules, row by row, dark = true.
pub struct SwissMatrix {
    pub size: usize,
    pub modules: Vec<bool>,
}

/// The unmasked symbol at `version`, or why the payload does not fit it.
fn canvas(payload: &[u8], version: Version) -> Result<Canvas, QrError> {
    let mut bits = Bits::new(version);
    bits.push_eci_designator(UTF8_ECI)?;
    bits.push_byte_data(payload)?;
    bits.push_terminator(EcLevel::M)?;
    let (data, ec) = ec::construct_codewords(&bits.into_bytes(), version, EcLevel::M)?;
    let mut canvas = Canvas::new(version, EcLevel::M);
    canvas.draw_all_functional_patterns();
    canvas.draw_data(&data, &ec);
    Ok(canvas)
}

/// `qrcodegen`'s run history: the last seven run lengths, newest first, the
/// light border counted into the first run of a line.
struct Runs {
    size: u32,
    history: [u32; 7],
}

impl Runs {
    fn new(size: u32) -> Self {
        Self {
            size,
            history: [0; 7],
        }
    }

    fn push(&mut self, mut length: u32) {
        if self.history[0] == 0 {
            length += self.size;
        }
        self.history.copy_within(0..6, 1);
        self.history[0] = length;
    }

    /// How many finder-like patterns (1:1:3:1:1 with four light on a side)
    /// end at the run just pushed: 0, 1 or 2.
    fn finder_like(&self) -> u32 {
        let h = &self.history;
        let n = h[1];
        let core = n > 0 && h[2] == n && h[3] == n * 3 && h[4] == n && h[5] == n;
        u32::from(core && h[0] >= n * 4 && h[6] >= n)
            + u32::from(core && h[6] >= n * 4 && h[0] >= n)
    }

    /// Close the line, counting its light border in.
    fn terminate(&mut self, dark: bool, mut length: u32) -> u32 {
        if dark {
            self.push(length);
            length = 0;
        }
        self.push(length + self.size);
        self.finder_like()
    }
}

/// `qrcodegen`'s `getPenaltyScore`, over a symbol read row by row.
fn penalty(modules: &[bool], size: usize) -> u32 {
    const N1: u32 = 3;
    const N2: u32 = 3;
    const N3: u32 = 40;
    const N4: u32 = 10;
    let side = size as u32;
    let mut result = 0;
    // Rows, then columns: long runs of one colour and finder-like patterns.
    for horizontal in [true, false] {
        for line in 0..size {
            let at = |i: usize| {
                if horizontal {
                    modules[line * size + i]
                } else {
                    modules[i * size + line]
                }
            };
            let mut runs = Runs::new(side);
            let mut colour = false;
            let mut length = 0;
            for i in 0..size {
                if at(i) == colour {
                    length += 1;
                    if length == 5 {
                        result += N1;
                    } else if length > 5 {
                        result += 1;
                    }
                } else {
                    runs.push(length);
                    if !colour {
                        result += runs.finder_like() * N3;
                    }
                    colour = at(i);
                    length = 1;
                }
            }
            result += runs.terminate(colour, length) * N3;
        }
    }
    // 2 × 2 blocks of one colour.
    for y in 0..size - 1 {
        for x in 0..size - 1 {
            let colour = modules[y * size + x];
            if colour == modules[y * size + x + 1]
                && colour == modules[(y + 1) * size + x]
                && colour == modules[(y + 1) * size + x + 1]
            {
                result += N2;
            }
        }
    }
    // Balance of dark and light, in steps of 5 % away from half.
    let dark = modules.iter().filter(|&&module| module).count() as u32;
    let total = side * side;
    let k = (dark * 20).abs_diff(total * 10).div_ceil(total) - 1;
    result + k * N4
}

/// The masked symbol with the lowest penalty, the first of equals.
fn best_masked(canvas: &Canvas, size: usize) -> Vec<bool> {
    let mut best: Option<(u32, Vec<bool>)> = None;
    for mask in MASKS {
        let mut masked = canvas.clone();
        masked.apply_mask(mask);
        let modules: Vec<bool> = masked
            .into_colors()
            .into_iter()
            .map(|colour| colour == Color::Dark)
            .collect();
        let score = penalty(&modules, size);
        if best.as_ref().is_none_or(|(lowest, _)| score < *lowest) {
            best = Some((score, modules));
        }
    }
    best.map(|(_, modules)| modules).unwrap_or_default()
}

/// The module matrix of a QR-bill payload.
pub fn matrix(payload: &str) -> Result<SwissMatrix, EngineError> {
    if payload.is_empty() {
        return Err(EngineError::Empty);
    }
    if payload.len() > MAX_TEXT_BYTES {
        return Err(EngineError::QrTooLong {
            bytes: payload.len(),
        });
    }
    for number in VERSIONS {
        let version = Version::Normal(number);
        match canvas(payload.as_bytes(), version) {
            Ok(canvas) => {
                // 57 to 117 modules: positive, and small.
                let size = version.width() as usize;
                return Ok(SwissMatrix {
                    size,
                    modules: best_masked(&canvas, size),
                });
            }
            Err(QrError::DataTooLong) => continue,
            Err(other) => return Err(EngineError::QrOption(other.to_string())),
        }
    }
    Err(EngineError::QrTooLong {
        bytes: payload.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A QR-bill payload, with an umlaut so the UTF-8 designator matters.
    const PAYLOAD: &str = "SPC\n0200\n1\nCH4431999123000889012\nS\nRobert Schneider AG\nRue du Lac\n1268\n2501\nBiel\nCH\n\n\n\n\n\n\n\n1949.75\nCHF\nS\nPia-Maria Rutschmann-Schnyder\nGrosse Marktgasse\n28\n9400\nRorschach\nCH\nQRR\n210000000003139471430009017\nAuftrag vom 15.06.2020 – Zürich\nEPD";

    fn read(matrix: &SwissMatrix) -> String {
        // Four modules of quiet zone, four pixels a module.
        let scale = 4;
        let side = (matrix.size + 8) * scale;
        let mut pixels = vec![255u8; side * side];
        for row in 0..matrix.size {
            for col in 0..matrix.size {
                if !matrix.modules[row * matrix.size + col] {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let y = (row + 4) * scale + dy;
                        let x = (col + 4) * scale + dx;
                        pixels[y * side + x] = 0;
                    }
                }
            }
        }
        rxing::helpers::detect_in_luma(
            pixels,
            side as u32,
            side as u32,
            Some(rxing::BarcodeFormat::QR_CODE),
        )
        .expect("reads")
        .getText()
        .to_string()
    }

    #[test]
    fn reads_back_as_the_payload_accents_included() {
        let matrix = matrix(PAYLOAD).expect("encodes");
        assert_eq!(read(&matrix), PAYLOAD);
    }

    #[test]
    fn never_goes_below_version_10_nor_above_25() {
        // Version v is 17 + 4v modules wide.
        assert_eq!(matrix("SPC").expect("encodes").size, 57);
        // Version 25 at level M holds 997 bytes, the guidelines' payload
        // ceiling; the UTF-8 designator takes one of them.
        assert_eq!(matrix(&"x".repeat(996)).expect("encodes").size, 117);
        assert!(matches!(
            matrix(&"x".repeat(997)),
            Err(EngineError::QrTooLong { .. })
        ));
    }

    #[test]
    fn refuses_an_empty_payload() {
        assert!(matches!(matrix(""), Err(EngineError::Empty)));
    }
}
