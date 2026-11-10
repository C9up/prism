# Test fixtures

## `VellumTestSans.ttf`

A small subset of DejaVu Sans, taken from `@c9up/vellum`'s own fixtures — the
same font, the same subset, copied rather than reached for across a package
boundary so this package's tests do not depend on another package's layout.

It exists because the watermark tests cannot be written without a real font: a
character map, glyph outlines and advance widths all have to come from
somewhere, and a font assembled by hand in the test would prove only that our
assembly matches our reader.

DejaVu Sans is distributed under the Bitstream Vera licence, reproduced in
`VellumTestSans.LICENSE.txt`. It permits modification and redistribution and
requires that a modified font not carry the original names — hence the name it
already carries, which is kept unchanged here.

It is a test fixture. It is not shipped with the package (`files` does not
include `tests`) and nothing at runtime reads it.

## `declares-16000x16000.avif`

1683 bytes that declare a 16000x16000 frame: a flat grey picture encoded by
ffmpeg with libaom (`-f lavfi -i color=c=gray:s=16000x16000 -frames:v 1
-c:v libaom-av1 -still-picture 1 -crf 63`). The decompression bomb in its
AVIF form, and checked in because nothing in this package encodes a 256 MP
AV1 frame in a test's time budget. A probe must refuse it from its headers;
before it did, `inspect` decoded it — a gigabyte and a third of a second on
the event loop.
