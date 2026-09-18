/**
 * PNG fixtures, built rather than checked in.
 *
 * Not a `.test.ts`, so vitest does not try to run it as a suite.
 *
 * A base64 blob pasted into a test is a CRC error waiting to be debugged as an
 * engine bug, and a fixture on disk is a binary nobody can review. Building the
 * bytes here keeps both problems away and lets a test ask for the exact size it
 * needs.
 */

import { crc32, deflateSync } from "node:zlib";

/** An RGBA PNG whose pixels come from a callback. */
export function makePng(
	width: number,
	height: number,
	pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
	const chunk = (kind: string, payload: Buffer): Buffer => {
		const body = Buffer.concat([Buffer.from(kind, "ascii"), payload]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(payload.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([length, body, checksum]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA

	// Each scanline is preceded by its filter byte, which is not a pixel.
	const raw = Buffer.alloc(height * (1 + width * 4));
	let offset = 0;
	for (let y = 0; y < height; y++) {
		raw[offset++] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = pixel(x, y);
			raw[offset++] = r;
			raw[offset++] = g;
			raw[offset++] = b;
			raw[offset++] = a;
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Detail in every pixel, so a re-encode has something to throw away.
 *
 * Deterministic, so comparing two encodings is reproducible rather than flaky.
 */
export function detailedPng(width: number, height: number): Buffer {
	return makePng(width, height, (x, y) => {
		const noise = (x * 2654435761 + y * 40503) % 256;
		return [noise, (noise * 7) % 256, (x * y) % 256, 255];
	});
}
