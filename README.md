# @c9up/prism

Image processing for the Ream framework, on a Rust engine. Resize, convert,
crop, composite and watermark.

```bash
pnpm add @c9up/prism
```

## Configure

```ts
// config/images.ts
import { defineConfig } from "@c9up/prism"

export default defineConfig({
  limits: { maxPixels: 50_000_000, maxBytes: 64 * 1024 * 1024 },
  quality: 82,
  autoOrient: true,
})
```

```ts
// reamrc.ts
providers: [() => import("@c9up/prism/provider")]
```

`ream configure @c9up/prism` writes both.

## Use

```ts
import images from "@c9up/prism/services/main"

const thumb = await images
  .edit(upload)
  .resize({ width: 300, height: 300, fit: "cover" })
  .toFormat("webp")
```

A pipeline is inert until it is asked for bytes. Everything queued then crosses
into Rust **once** — a resize followed by a watermark decodes and encodes a
single time, on a worker thread, so the event loop never waits on the
resampling.

### Inspect before accepting

```ts
const meta = images.inspect(upload)
// { width, height, format, orientedWidth, orientedHeight, orientation, hasAlpha }
```

Reads the header only — it never allocates a pixel buffer, so it is cheap
enough to run on every upload. `orientedWidth`/`orientedHeight` are the
dimensions *after* the EXIF rotation: a portrait phone photo reports landscape
dimensions in its header plus a tag saying to turn it, and a gallery laid out
from the header alone gets every phone photo's aspect ratio wrong.

### Fit

| `fit` | Result |
|---|---|
| `cover` (default) | fills the box, crops the overflow, centred |
| `contain` | largest size fitting inside the box |
| `fill` | exactly the requested size — distorts |
| `inside` | like `contain`, but never enlarges |

Give one dimension and the other is derived from the aspect ratio.

### Composite and watermark

```ts
await images.edit(photo)
  .composite({ image: logo, x: 20, y: 20, opacity: 0.6 })
  .watermarkText({ text: "ACME", font, size: 28, x: 20, y: 60 })
  .toFormat("png")
```

No font is bundled — pass the bytes. Shipping one would bind every consumer to
its licence and add megabytes for the majority who never draw text.

**Text is not shaped.** Glyphs are looked up per character, kerned and advanced
left to right. Correct for Latin, Cyrillic and Greek; wrong for anything
needing shaping or reordering — Arabic renders unjoined, Devanagari and Thai
misplace their marks, right-to-left comes out reversed. A watermark is short
and chosen by the operator, so the trade is deliberate; stamping user-supplied
text in an arbitrary language needs something else.

### Filters

```ts
await images.edit(photo)
  .grayscale()
  .blur(2)                              // gaussian, accurate and slow
  .fastBlur(2)                          // box-approximated, far cheaper
  .sharpen({ sigma: 2, threshold: 5 })  // unsharp mask
  .brighten(20)                         // -255 to 255
  .contrast(15)                         // -255 to 255
  .hueRotate(90)                        // degrees, wraps
  .invert()
  .filter3x3([0, -1, 0, -1, 5, -1, 0, -1, 0])
  .toFormat('png')
```

`sharpen`'s `threshold` suppresses sharpening below a contrast step — it is
what stops an unsharp mask amplifying sensor noise in flat areas, a clear sky
being the usual casualty.

Every numeric knob is bounded, because each arrives from a request: a sigma of
1000 on a 4000x3000 image is minutes of CPU on a worker thread, so blur radius
is capped, brightness and contrast are range-checked, and a 3x3 kernel must
carry exactly nine finite values. Hue is the exception — it is circular, so
400 degrees means 40 rather than an error.

### Thumbnails

```ts
await images.edit(photo).thumbnail({ width: 32, height: 32 }).toFormat('webp')
```

A box filter rather than Lanczos: several times cheaper and visibly softer,
which is the right trade for a 32px avatar and the wrong one for a 1200px
hero. `exact: true` ignores the aspect ratio, as `fit: 'fill'` does.

## Safety

Every byte reaching this package came from an upload, and the guards run
before anything is allocated:

- **Format from content, never from a name.** A filename and a `Content-Type`
  come from whoever sent the bytes.
- **An allowlist of three decoders.** Every decoder compiled in is parser
  surface facing hostile input; a format nobody asked for is a liability.
- **A pixel ceiling checked against the header.** A 40 KB PNG can declare
  50000x50000; decoding it asks for ten gigabytes before anything objects. The
  product is computed in 64 bits — in 32 it overflows to a small number for
  exactly the largest image expressible.
- **A panic net on every boundary.** A panic crossing NAPI takes the Node
  process down; on a worker thread it aborts outright.
- **Overlays are guarded exactly like the input**, because a per-tenant
  watermark is an upload too.
- **Metadata never survives.** Re-encoding from decoded pixels carries no EXIF,
  GPS, XMP or colour profile forward. A holiday photo carries the house's
  coordinates; dropping that is the right default, not a feature to opt into.

## Formats

Fifteen decoders are compiled in — `jpeg png webp gif bmp ico tiff tga qoi pnm
dds farbfeld hdr openexr avif` — and fourteen of them encode (`image` ships no
DDS encoder, so naming it as an output is refused up front).

**Which of them an application accepts is a runtime decision, and the default
is three.** Every decoder is parser surface reachable from whatever an upload
form receives, so widening is deliberate:

```ts
export default defineConfig({
  limits: { allowedFormats: ['jpeg', 'png', 'webp', 'gif'] },
})
```

An unknown name raises rather than being skipped — a typo that silently
narrowed the list would surface as uploads refused in production for no
visible reason.

### One that writes but cannot be read back

Prism identifies by CONTENT, never by a filename, and that has a cost: a
format whose bytes carry no signature at the front cannot be recognised.

**TGA** puts its identifier in a *footer*, so it is not recognised at all. It
can be written and never accepted as an upload — putting `tga` in
`allowedFormats` does not make a TGA uploadable.

AVIF used to be in this paragraph. It reads and writes now, which is why this
package takes a system dependency — see below.

### WebP is lossy by default

A lossless WebP is several times the size of a lossy one, and size is the
entire reason anyone reaches for the format. `image` ships no lossy encoder, so
that path goes through libwebp. `quality: 100` selects lossless — the one value
that cannot mean "compress a bit".

### What installing this needs: nothing

The published binaries carry their own codecs. libwebp is vendored, and
libdav1d — the AVIF *decoder*, without which an AVIF could be written and never
read — is compiled from source and linked statically by the release workflow.
`ldd` on a published binary lists libc, libm and libgcc, and that is all.

### What building it from source needs

Only relevant when no prebuilt binary matches the platform, or when working on
the crate itself. libwebp still costs nothing but a C compiler. libdav1d is the
one that asks for something, and there are two ways to give it:

- **a system libdav1d** — `libdav1d-dev` on Debian, `dav1d` on Homebrew, the
  vcpkg package on Windows. `dav1d-sys` finds it through pkg-config. The
  resulting binary then *needs* that library at runtime, which is fine for a
  local build and is why it is not how releases are made.
- **`SYSTEM_DEPS_DAV1D_BUILD_INTERNAL=auto`**, with `meson`, `ninja` and (on
  x86) `nasm` on PATH. `dav1d-sys` clones dav1d and builds it statically. This
  is what CI does.

One trap worth knowing if a build goes strange: `dav1d-sys` runs meson through
a call that checks the process could be *started*, not that it succeeded. With
`nasm` missing, meson fails, nothing is reported, and the link quietly falls
back to whatever else is on the system. Check that all three tools resolve
before blaming the crate.

### The size of the binary

All fifteen formats take the native binary from roughly 2.3 MB to 11 MB, most
of it the AVIF codec. Multiplied across prebuilt platforms that is the dominant
cost of the package: an application that only handles jpeg, png and webp is
paying for twelve codecs it will never allow. Making the set a build feature as
well as a runtime one would fix that, and has not been done.

## Colour

```ts
await images.edit(photo).convertColorSpace({ to: 'display-p3' }).toFormat('png')
```

The samples are *transformed* — primaries and transfer function applied —
rather than reinterpreted. `inspect()` reports what a file declares as
`colorSpace`.

Five spaces: `srgb`, `linear-srgb`, `display-p3`, `dci-p3`, `rec709`. The list
is short because it was proved rather than assumed: `rec2020` and the two HDR
transfers were implemented, tried against the library, found to raise "not
supported" for BT.2020 primaries, and removed. A name that can only fail is
worse than an absent one.

**Two things this cannot do**, both from the model rather than the code:

- **`image` reads no ICC profile.** A JPEG carrying an Adobe RGB profile is
  decoded as sRGB, because the profile is never seen. Pass `from` when you know
  better — it overrides the file's claim rather than converting:
  `convertColorSpace({ to: 'srgb', from: 'display-p3' })`.
- **Adobe RGB has no CICP code point at all**, so it cannot be named here by
  anyone. Work that needs it needs an ICC pipeline, which is a different
  dependency.

## Bit depth

```ts
await images.edit(scan).toBuffer({ format: 'png', depth: 16 })
```

Only PNG and TIFF carry sixteen bits. Elsewhere the encoder narrows back to
eight rather than refusing — a pipeline that sets `depth` once should not break
when its output format is switched.

## Errors

Every failure carries a code — `E_PRISM_TOO_MANY_PIXELS`,
`E_PRISM_UNKNOWN_FORMAT`, `E_PRISM_INVALID_GEOMETRY`, `E_PRISM_INVALID_FONT`,
`E_PRISM_NATIVE_REQUIRED` and the rest — so a controller can tell "that is not
an image" from "the engine is not installed" without matching on a message.

## The engine

Rust, loaded as a prebuilt `.node`. It is **not** optional and there is no
JavaScript fallback: a missing binary raises with build instructions rather
than degrading silently, so one deployment cannot behave differently from
another.

Build it locally with `pnpm build:napi`.

## Testing

```ts
import { fakeImages } from "@c9up/prism/testing"

const { images, restore } = fakeImages()
afterEach(restore)
```

The real engine, not a stub — an assertion about a thumbnail's dimensions is
only worth making against the code that produces it.

## License

MIT
