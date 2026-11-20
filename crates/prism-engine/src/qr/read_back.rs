//! Reading a generated code back in the tests: the proof that it scans.

/// The text of the one QR code in a grayscale image, row-major, `width` wide.
pub(crate) fn read_luma(pixels: Vec<u8>, width: u32, height: u32) -> String {
    let image = zxingcpp::ImageView::from_slice(&pixels, width, height, zxingcpp::ImageFormat::Lum)
        .expect("a grayscale view");
    let found = zxingcpp::read()
        .formats([zxingcpp::BarcodeFormat::QRCode])
        .from(image)
        .expect("reads");
    found.first().expect("finds a code").text()
}
