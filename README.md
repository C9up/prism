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

JPEG, PNG and WebP, read and written.

**WebP is encoded losslessly.** The pure-Rust encoder has no lossy mode, so
expect a WebP several times the size of one written by libwebp. Lossy encoding
means a C dependency and a heavier cross-compilation matrix; it was left out of
0.1.0 deliberately. The encode contract does not change if it is added — only
the encoder behind it.

Transparency written to JPEG is composited onto a background (white by
default), not discarded: dropping the alpha channel keeps whatever colour sat
underneath, so a transparent red pixel would come out opaque red.

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
