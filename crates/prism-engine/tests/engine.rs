//! Engine tests.
//!
//! Fixtures are built in-process rather than checked in: a PNG generated here
//! cannot drift from the decoder that reads it, and the one file that must be
//! hand-made — a header lying about its size — is clearer written out byte by
//! byte than committed as an opaque blob.

use image::{ImageFormat, Rgba, RgbaImage};
use prism_engine::{
    encode, error::EngineError, guard, inspect, ops::Fit, process, Limits, Operation, Output,
};

/// A solid image, encoded.
fn fixture(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
    let mut image = RgbaImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
    }
    encode::encode(&image::DynamicImage::ImageRgba8(image), format, 90).expect("fixture encodes")
}

fn output(format: ImageFormat) -> Output {
    Output {
        format,
        quality: 82,
        background: Output::WHITE,
    }
}

/// A VALID PNG whose header declares `width` x `height` and whose body is a
/// few bytes.
///
/// This is the decompression bomb in its smallest form: a file the decoder
/// accepts, that asks it to allocate the product of two numbers it was
/// handed. It has to be a well-formed stream — a truncated one is refused as
/// unreadable long before the dimensions are consulted, which would test the
/// wrong thing.
fn lying_png(width: u32, height: u32) -> Vec<u8> {
    fn crc(bytes: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for (i, entry) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *entry = c;
        }
        let mut c = 0xFFFF_FFFFu32;
        for byte in bytes {
            c = table[((c ^ u32::from(*byte)) & 0xFF) as usize] ^ (c >> 8);
        }
        c ^ 0xFFFF_FFFF
    }

    fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
        let mut body = kind.to_vec();
        body.extend_from_slice(payload);
        png.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        png.extend_from_slice(&body);
        png.extend_from_slice(&crc(&body).to_be_bytes());
    }

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
    chunk(&mut png, b"IHDR", &ihdr);
    // An empty deflate stream. Never decompressed by a dimension read — which
    // is the entire reason the guard can refuse before allocating.
    chunk(
        &mut png,
        b"IDAT",
        &[0x78, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01],
    );
    chunk(&mut png, b"IEND", &[]);
    png
}

#[test]
fn identifies_the_format_from_the_content() {
    let png = fixture(8, 8, ImageFormat::Png);
    let meta = inspect(&png, Limits::default()).expect("inspects");
    assert_eq!(meta.format, "png");
    assert_eq!((meta.width, meta.height), (8, 8));

    let jpeg = fixture(8, 8, ImageFormat::Jpeg);
    assert_eq!(
        inspect(&jpeg, Limits::default()).expect("inspects").format,
        "jpeg"
    );
}

#[test]
fn refuses_a_header_that_declares_more_pixels_than_allowed() {
    // The whole point: this must fail on the HEADER, before anything asks the
    // allocator for 2.5 billion pixels.
    let bomb = lying_png(50_000, 50_000);
    assert!(bomb.len() < 100, "the bomb is tiny — that is the attack");
    let error = inspect(&bomb, Limits::default()).expect_err("refuses");
    assert_eq!(error.code(), "TOO_MANY_PIXELS");
}

#[test]
fn pixel_count_does_not_overflow_into_a_small_number() {
    // 65536 x 65536 overflows u32 to exactly 0. Multiplied in u32 the guard
    // would compare 0 against the limit and wave through the largest image
    // expressible.
    let bomb = lying_png(65_536, 65_536);
    assert_eq!(
        inspect(&bomb, Limits::default())
            .expect_err("refuses")
            .code(),
        "TOO_MANY_PIXELS"
    );
}

#[test]
fn refuses_an_input_over_the_byte_limit() {
    let png = fixture(64, 64, ImageFormat::Png);
    let limits = Limits {
        max_bytes: 10,
        ..Limits::default()
    };
    assert_eq!(
        inspect(&png, limits).expect_err("refuses").code(),
        "INPUT_TOO_LARGE"
    );
}

#[test]
fn refuses_bytes_that_are_not_an_image() {
    assert_eq!(
        inspect(
            b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
            Limits::default()
        )
        .expect_err("refuses")
        .code(),
        "UNKNOWN_FORMAT"
    );
    assert_eq!(
        inspect(b"", Limits::default()).expect_err("refuses").code(),
        "EMPTY_INPUT"
    );
}

#[test]
fn refuses_a_format_outside_the_allowlist() {
    // A GIF is a perfectly valid image and still refused: every decoder built
    // in is parser surface facing hostile input.
    let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";
    let error = inspect(gif, Limits::default()).expect_err("refuses");
    assert!(
        matches!(
            error,
            EngineError::UnsupportedFormat(_) | EngineError::UnknownFormat
        ),
        "got {error:?}"
    );
}

#[test]
fn resize_keeps_the_aspect_ratio_when_one_side_is_given() {
    let png = fixture(1000, 500, ImageFormat::Png);
    let out = process(
        &png,
        &[Operation::Resize {
            width: Some(300),
            height: None,
            fit: Fit::Contain,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("resizes");
    let meta = inspect(&out, Limits::default()).expect("inspects");
    assert_eq!((meta.width, meta.height), (300, 150));
}

#[test]
fn cover_fills_the_box_exactly_and_contain_does_not() {
    let png = fixture(1000, 500, ImageFormat::Png);
    let cover = process(
        &png,
        &[Operation::Resize {
            width: Some(200),
            height: Some(200),
            fit: Fit::Cover,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("covers");
    let meta = inspect(&cover, Limits::default()).expect("inspects");
    assert_eq!((meta.width, meta.height), (200, 200));

    let contain = process(
        &png,
        &[Operation::Resize {
            width: Some(200),
            height: Some(200),
            fit: Fit::Contain,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("contains");
    let meta = inspect(&contain, Limits::default()).expect("inspects");
    assert_eq!((meta.width, meta.height), (200, 100));
}

#[test]
fn inside_never_enlarges() {
    let png = fixture(50, 40, ImageFormat::Png);
    let out = process(
        &png,
        &[Operation::Resize {
            width: Some(4000),
            height: Some(4000),
            fit: Fit::Inside,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("leaves it alone");
    let meta = inspect(&out, Limits::default()).expect("inspects");
    assert_eq!((meta.width, meta.height), (50, 40));
}

#[test]
fn a_crop_outside_the_image_is_refused_rather_than_clamped() {
    // `crop_imm` clamps silently, which returns a smaller picture than asked
    // for with nothing to say so.
    let png = fixture(100, 100, ImageFormat::Png);
    let error = process(
        &png,
        &[Operation::Crop {
            x: 80,
            y: 80,
            width: 50,
            height: 50,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect_err("refuses");
    assert_eq!(error.code(), "INVALID_GEOMETRY");
}

#[test]
fn rotation_normalises_and_swaps_the_axes() {
    let png = fixture(100, 50, ImageFormat::Png);
    for degrees in [90, 450, -270] {
        let out = process(
            &png,
            &[Operation::Rotate(degrees)],
            &output(ImageFormat::Png),
            Limits::default(),
            true,
        )
        .expect("rotates");
        let meta = inspect(&out, Limits::default()).expect("inspects");
        assert_eq!((meta.width, meta.height), (50, 100), "at {degrees}");
    }
}

#[test]
fn a_rotation_that_is_not_a_right_angle_is_refused() {
    let png = fixture(10, 10, ImageFormat::Png);
    assert_eq!(
        process(
            &png,
            &[Operation::Rotate(45)],
            &output(ImageFormat::Png),
            Limits::default(),
            true,
        )
        .expect_err("refuses")
        .code(),
        "INVALID_GEOMETRY"
    );
}

#[test]
fn a_transparent_png_becomes_white_not_black_as_jpeg() {
    // Converting an RGBA canvas straight to JPEG leaves the alpha channel
    // behind and the transparent area reads as black.
    let mut image = RgbaImage::new(4, 4);
    for pixel in image.pixels_mut() {
        *pixel = Rgba([255, 0, 0, 0]); // fully transparent
    }
    let png = encode::encode(
        &image::DynamicImage::ImageRgba8(image),
        ImageFormat::Png,
        90,
    )
    .expect("png");

    let jpeg = process(
        &png,
        &[],
        &output(ImageFormat::Jpeg),
        Limits::default(),
        true,
    )
    .expect("converts");
    let decoded = image::load_from_memory(&jpeg).expect("decodes").to_rgb8();
    let pixel = decoded.get_pixel(0, 0);
    assert!(
        pixel.0.iter().all(|channel| *channel > 200),
        "expected near-white, got {pixel:?}"
    );
}

#[test]
fn metadata_never_survives_a_pass_through_the_engine() {
    // Not an implementation detail to rely on loosely: a holiday photo
    // carries the house's coordinates, and re-encoding from pixels is what
    // drops them.
    let jpeg = fixture(16, 16, ImageFormat::Jpeg);
    let out = process(
        &jpeg,
        &[],
        &output(ImageFormat::Jpeg),
        Limits::default(),
        true,
    )
    .expect("re-encodes");
    let mut cursor = std::io::Cursor::new(&out);
    assert!(
        exif::Reader::new()
            .read_from_container(&mut cursor)
            .is_err(),
        "the output still carries an EXIF block"
    );
}

#[test]
fn an_overlay_is_guarded_exactly_like_the_input() {
    let base = fixture(100, 100, ImageFormat::Png);
    let error = process(
        &base,
        &[Operation::Composite {
            image: lying_png(60_000, 60_000),
            x: 0,
            y: 0,
            opacity: 1.0,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect_err("refuses");
    assert_eq!(error.code(), "TOO_MANY_PIXELS");
}

#[test]
fn the_output_format_is_what_was_asked_for() {
    let png = fixture(20, 20, ImageFormat::Png);
    for (format, name) in [
        (ImageFormat::Jpeg, "jpeg"),
        (ImageFormat::Png, "png"),
        (ImageFormat::WebP, "webp"),
    ] {
        let out = process(&png, &[], &output(format), Limits::default(), true).expect("encodes");
        assert_eq!(
            inspect(&out, Limits::default()).expect("inspects").format,
            name
        );
    }
}

#[test]
fn an_unknown_output_format_is_refused_by_name() {
    assert_eq!(
        guard::parse_format("avif").expect_err("refuses").code(),
        "UNSUPPORTED_FORMAT"
    );
    assert!(guard::parse_format("JPG").is_ok(), "case-insensitive");
}
