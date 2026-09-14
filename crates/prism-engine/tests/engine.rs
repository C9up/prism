//! Engine tests.
//!
//! Fixtures are built in-process rather than checked in: a PNG generated here
//! cannot drift from the decoder that reads it, and the one file that must be
//! hand-made — a header lying about its size — is clearer written out byte by
//! byte than committed as an opaque blob.

use image::{ImageFormat, Rgba, RgbaImage};
use prism_engine::{encode, guard, inspect, ops::Fit, process, Limits, Operation, Output};

/// A solid image, encoded.
fn fixture(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
    let mut image = RgbaImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        *pixel = Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
    }
    encode::encode(&image::DynamicImage::ImageRgba8(image), format, 90, 8).expect("fixture encodes")
}

fn output(format: ImageFormat) -> Output {
    Output {
        format,
        quality: 82,
        background: Output::WHITE,
        depth: Output::DEPTH_8,
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

/// A real, decodable GIF.
fn fixture_gif() -> Vec<u8> {
    let mut image = RgbaImage::new(2, 2);
    for pixel in image.pixels_mut() {
        *pixel = Rgba([10, 200, 30, 255]);
    }
    encode::encode(
        &image::DynamicImage::ImageRgba8(image),
        ImageFormat::Gif,
        90,
        8,
    )
    .expect("gif encodes")
}

#[test]
fn refuses_a_format_outside_the_allowlist() {
    // A GIF is a perfectly valid image, its decoder IS compiled in, and it is
    // still refused by default: accepting thirteen more parsers from an upload
    // form is a decision, not a default.
    let gif = fixture_gif();
    let error = inspect(&gif, Limits::default()).expect_err("refuses");
    assert_eq!(error.code(), "FORMAT_NOT_ALLOWED");
    // The message must name what IS accepted, or it is not actionable.
    assert!(format!("{error}").contains("jpeg"), "got {error}");
}

#[test]
fn an_application_can_widen_the_allowlist() {
    let limits = Limits {
        allowed: guard::FormatSet::from_names(["jpeg", "png", "webp", "gif"]).expect("names"),
        ..Limits::default()
    };
    assert_eq!(
        inspect(&fixture_gif(), limits).expect("accepts").format,
        "gif"
    );
}

#[test]
fn widening_to_everything_is_possible_and_explicit() {
    let limits = Limits {
        allowed: guard::FormatSet::all(),
        ..Limits::default()
    };
    assert_eq!(
        inspect(&fixture_gif(), limits).expect("accepts").format,
        "gif"
    );
}

#[test]
fn an_unknown_name_in_the_allowlist_is_refused_rather_than_ignored() {
    // Silently dropping a typo'd name would narrow the allowlist without
    // saying so, and the failure would surface as an upload rejected in
    // production for no visible reason.
    assert_eq!(
        guard::FormatSet::from_names(["jpeg", "jpeg2000"])
            .expect_err("refuses")
            .code(),
        "UNSUPPORTED_FORMAT"
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
        8,
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
        guard::parse_format("jpeg2000").expect_err("refuses").code(),
        "UNSUPPORTED_FORMAT"
    );
    assert!(guard::parse_format("JPG").is_ok(), "case-insensitive");
    assert!(guard::parse_format("avif").is_ok(), "avif encodes");
}

#[test]
fn a_format_that_reads_but_cannot_be_written_is_refused_up_front() {
    // `image` has no DDS encoder. Saying so here beats failing inside the
    // encoder with a message about a trait bound.
    let error = guard::parse_format("dds").expect_err("refuses");
    assert_eq!(error.code(), "UNSUPPORTED_FORMAT");
    assert!(format!("{error}").contains("not written"), "got {error}");
}

// ─── Filters ────────────────────────────────────────────────────────

/// Run one operation and hand back the decoded pixels.
fn run_one(op: Operation) -> image::RgbaImage {
    let png = fixture(32, 32, ImageFormat::Png);
    let out = process(
        &png,
        &[op],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("runs");
    image::load_from_memory(&out).expect("decodes").to_rgba8()
}

fn baseline() -> image::RgbaImage {
    let png = fixture(32, 32, ImageFormat::Png);
    image::load_from_memory(&png).expect("decodes").to_rgba8()
}

#[test]
fn every_filter_actually_changes_the_pixels() {
    // A forwarding bug that silently returned the input would pass any
    // dimension assertion; comparing against the untouched image is what
    // catches it.
    let before = baseline();
    for (name, op) in [
        ("blur", Operation::Blur(2.0)),
        ("fastBlur", Operation::FastBlur(2.0)),
        (
            "sharpen",
            Operation::Sharpen {
                sigma: 2.0,
                threshold: 0,
            },
        ),
        ("brighten", Operation::Brighten(40)),
        ("contrast", Operation::Contrast(40.0)),
        ("hueRotate", Operation::HueRotate(90)),
        ("invert", Operation::Invert),
        ("grayscale", Operation::Grayscale),
        (
            "filter3x3",
            Operation::Filter3x3(vec![0.0, -1.0, 0.0, -1.0, 5.0, -1.0, 0.0, -1.0, 0.0]),
        ),
    ] {
        assert_ne!(run_one(op).into_raw(), before.clone().into_raw(), "{name}");
    }
}

#[test]
fn grayscale_leaves_no_colour_behind() {
    for pixel in run_one(Operation::Grayscale).pixels() {
        assert_eq!(pixel.0[0], pixel.0[1], "r == g");
        assert_eq!(pixel.0[1], pixel.0[2], "g == b");
    }
}

#[test]
fn invert_is_its_own_inverse() {
    let png = fixture(16, 16, ImageFormat::Png);
    let once = process(
        &png,
        &[Operation::Invert, Operation::Invert],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("runs");
    let back = image::load_from_memory(&once).expect("decodes").to_rgba8();
    let original = image::load_from_memory(&png).expect("decodes").to_rgba8();
    assert_eq!(back.into_raw(), original.into_raw());
}

#[test]
fn an_unbounded_blur_is_refused_rather_than_run() {
    // The cost of a Gaussian grows with its radius, on a buffer the caller
    // also sized. An unbounded sigma is a denial of service, not a blurry
    // picture.
    for sigma in [-1.0, 1000.0, f32::INFINITY, f32::NAN] {
        assert_eq!(
            process(
                &fixture(8, 8, ImageFormat::Png),
                &[Operation::Blur(sigma)],
                &output(ImageFormat::Png),
                Limits::default(),
                true,
            )
            .expect_err("refuses")
            .code(),
            "INVALID_GEOMETRY",
            "for sigma {sigma}"
        );
    }
}

#[test]
fn brightness_and_contrast_are_bounded() {
    for op in [Operation::Brighten(9_000), Operation::Contrast(9_000.0)] {
        assert_eq!(
            process(
                &fixture(8, 8, ImageFormat::Png),
                &[op],
                &output(ImageFormat::Png),
                Limits::default(),
                true,
            )
            .expect_err("refuses")
            .code(),
            "INVALID_GEOMETRY"
        );
    }
}

#[test]
fn a_kernel_that_is_not_three_by_three_is_refused() {
    assert_eq!(
        process(
            &fixture(8, 8, ImageFormat::Png),
            &[Operation::Filter3x3(vec![1.0, 2.0, 3.0])],
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
fn thumbnail_keeps_the_aspect_ratio_unless_told_otherwise() {
    let png = fixture(400, 200, ImageFormat::Png);
    let kept = process(
        &png,
        &[Operation::Thumbnail {
            width: Some(40),
            height: Some(40),
            exact: false,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("runs");
    let meta = inspect(&kept, Limits::default()).expect("inspects");
    assert_eq!((meta.width, meta.height), (40, 20));

    let exact = process(
        &png,
        &[Operation::Thumbnail {
            width: Some(40),
            height: Some(40),
            exact: true,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("runs");
    let meta = inspect(&exact, Limits::default()).expect("inspects");
    assert_eq!((meta.width, meta.height), (40, 40));
}

#[test]
fn a_hue_rotation_wraps_instead_of_being_refused() {
    // Unlike the bounded knobs, hue is circular: 400 degrees is 40.
    for degrees in [-720, 0, 400] {
        assert!(process(
            &fixture(8, 8, ImageFormat::Png),
            &[Operation::HueRotate(degrees)],
            &output(ImageFormat::Png),
            Limits::default(),
            true,
        )
        .is_ok());
    }
}

// ─── Colour spaces ──────────────────────────────────────────────────

#[test]
fn converting_between_named_spaces_changes_the_samples() {
    // sRGB and Display P3 have different primaries, so the same colour needs
    // different numbers in each. An implementation that reinterpreted the
    // samples instead of transforming them would leave them identical.
    let png = fixture(16, 16, ImageFormat::Png);
    let out = process(
        &png,
        &[Operation::ConvertColourSpace {
            to: "display-p3".into(),
            from: None,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("converts");
    let before = image::load_from_memory(&png).expect("decodes").to_rgba8();
    let after = image::load_from_memory(&out).expect("decodes").to_rgba8();
    assert_ne!(before.into_raw(), after.into_raw());
}

#[test]
fn converting_to_the_space_it_is_already_in_is_a_no_op() {
    let png = fixture(16, 16, ImageFormat::Png);
    let out = process(
        &png,
        &[Operation::ConvertColourSpace {
            to: "srgb".into(),
            from: None,
        }],
        &output(ImageFormat::Png),
        Limits::default(),
        true,
    )
    .expect("converts");
    let before = image::load_from_memory(&png).expect("decodes").to_rgba8();
    let after = image::load_from_memory(&out).expect("decodes").to_rgba8();
    assert_eq!(before.into_raw(), after.into_raw());
}

#[test]
fn declaring_the_source_changes_the_result() {
    // `from` overrides what the file claims. Converting to P3 from sRGB and
    // from Rec.2020 cannot land in the same place — if it did, `from` would
    // be decorative.
    let png = fixture(16, 16, ImageFormat::Png);
    let run = |from: Option<&str>| {
        process(
            &png,
            &[Operation::ConvertColourSpace {
                to: "display-p3".into(),
                from: from.map(str::to_string),
            }],
            &output(ImageFormat::Png),
            Limits::default(),
            true,
        )
        .expect("converts")
    };
    assert_ne!(run(None), run(Some("dci-p3")));
}

#[test]
fn every_named_space_round_trips_through_its_own_name() {
    for name in ["srgb", "linear-srgb", "display-p3", "dci-p3", "rec709"] {
        let cicp = prism_engine::colour::parse_space(name).expect(name);
        assert_eq!(prism_engine::colour::space_name(cicp), name, "{name}");
    }
}

#[test]
fn an_unknown_space_is_refused_and_says_what_it_knows() {
    // Adobe RGB is the one people ask for, and CICP has no code point for it.
    // Saying which names exist is the only useful answer.
    let error = prism_engine::colour::parse_space("adobe-rgb").expect_err("refuses");
    assert_eq!(error.code(), "COLOUR_SPACE");
    assert!(format!("{error}").contains("display-p3"), "got {error}");
}

#[test]
fn every_named_space_can_actually_be_converted_to() {
    // A name that only ever raises is worse than an absent one. This is what
    // caught rec2020 and the two HDR transfers: `image` has no colorimetric
    // interpretation for BT.2020 primaries, so they were removed rather than
    // shipped.
    let png = fixture(8, 8, ImageFormat::Png);
    for name in ["srgb", "linear-srgb", "display-p3", "dci-p3", "rec709"] {
        process(
            &png,
            &[Operation::ConvertColourSpace {
                to: name.into(),
                from: None,
            }],
            &output(ImageFormat::Png),
            Limits::default(),
            true,
        )
        .unwrap_or_else(|error| panic!("{name} must convert, got {error}"));
    }
}

#[test]
fn inspect_reports_a_colour_space() {
    let meta = inspect(&fixture(8, 8, ImageFormat::Png), Limits::default()).expect("inspects");
    // `srgb` for a file that declares nothing, which is most of them.
    assert_eq!(meta.colour_space, "srgb");
}

#[test]
fn sixteen_bits_survive_into_the_formats_that_carry_them() {
    let png = fixture(8, 8, ImageFormat::Png);
    let deep = Output {
        format: ImageFormat::Png,
        quality: 82,
        background: Output::WHITE,
        depth: Output::DEPTH_16,
    };
    let out = process(&png, &[], &deep, Limits::default(), true).expect("encodes");
    let decoded = image::load_from_memory(&out).expect("decodes");
    // `color()` reports the sample type the file actually carries.
    assert!(
        format!("{:?}", decoded.color()).contains("16"),
        "expected a 16-bit colour type, got {:?}",
        decoded.color()
    );
}

#[test]
fn asking_for_sixteen_bits_from_a_format_that_cannot_is_not_an_error() {
    // JPEG is eight bits by definition. Narrowing quietly beats refusing: a
    // pipeline that sets depth once should not break when its output format
    // is switched.
    let png = fixture(8, 8, ImageFormat::Png);
    let deep = Output {
        format: ImageFormat::Jpeg,
        quality: 82,
        background: Output::WHITE,
        depth: Output::DEPTH_16,
    };
    assert!(process(&png, &[], &deep, Limits::default(), true).is_ok());
}

#[test]
fn webp_is_lossy_by_default_and_lossless_on_request() {
    // The whole reason anyone reaches for WebP is size. A lossless-only
    // encoder produces files several times larger, which defeats it.
    let png = fixture(64, 64, ImageFormat::Png);
    let lossy = process(
        &png,
        &[],
        &Output {
            format: ImageFormat::WebP,
            quality: 60,
            background: Output::WHITE,
            depth: Output::DEPTH_8,
        },
        Limits::default(),
        true,
    )
    .expect("lossy");
    let lossless = process(
        &png,
        &[],
        &Output {
            format: ImageFormat::WebP,
            quality: 100,
            background: Output::WHITE,
            depth: Output::DEPTH_8,
        },
        Limits::default(),
        true,
    )
    .expect("lossless");

    assert!(
        lossy.len() < lossless.len(),
        "lossy {} should be smaller than lossless {}",
        lossy.len(),
        lossless.len()
    );
    // Both must still be WebP the reader recognises.
    for bytes in [&lossy, &lossless] {
        assert_eq!(
            inspect(bytes, Limits::default()).expect("inspects").format,
            "webp"
        );
    }
}

#[test]
fn webp_quality_actually_moves_the_size() {
    let png = fixture(64, 64, ImageFormat::Png);
    let at = |quality: u8| {
        process(
            &png,
            &[],
            &Output {
                format: ImageFormat::WebP,
                quality,
                background: Output::WHITE,
                depth: Output::DEPTH_8,
            },
            Limits::default(),
            true,
        )
        .expect("encodes")
        .len()
    };
    assert!(at(20) < at(90), "{} should be under {}", at(20), at(90));
}
