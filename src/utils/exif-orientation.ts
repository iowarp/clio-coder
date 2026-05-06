import type { PhotonImageType } from "./photon.js";

type Photon = typeof import("@silvia-odwyer/photon-node");

function byte(bytes: Uint8Array, offset: number): number {
	return bytes[offset] ?? 0;
}

function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
	if (tiffStart + 8 > bytes.length) return 1;

	const byteOrder = (byte(bytes, tiffStart) << 8) | byte(bytes, tiffStart + 1);
	const le = byteOrder === 0x4949;

	const read16 = (pos: number): number => {
		if (le) return byte(bytes, pos) | (byte(bytes, pos + 1) << 8);
		return (byte(bytes, pos) << 8) | byte(bytes, pos + 1);
	};

	const read32 = (pos: number): number => {
		if (le) {
			return byte(bytes, pos) | (byte(bytes, pos + 1) << 8) | (byte(bytes, pos + 2) << 16) | (byte(bytes, pos + 3) << 24);
		}
		return (
			((byte(bytes, pos) << 24) | (byte(bytes, pos + 1) << 16) | (byte(bytes, pos + 2) << 8) | byte(bytes, pos + 3)) >>> 0
		);
	};

	const ifdOffset = read32(tiffStart + 4);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdStart + 2 > bytes.length) return 1;

	const entryCount = read16(ifdStart);
	for (let i = 0; i < entryCount; i++) {
		const entryPos = ifdStart + 2 + i * 12;
		if (entryPos + 12 > bytes.length) return 1;

		if (read16(entryPos) === 0x0112) {
			const value = read16(entryPos + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}

	return 1;
}

function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
	return (
		byte(bytes, offset) === 0x45 &&
		byte(bytes, offset + 1) === 0x78 &&
		byte(bytes, offset + 2) === 0x69 &&
		byte(bytes, offset + 3) === 0x66 &&
		byte(bytes, offset + 4) === 0x00 &&
		byte(bytes, offset + 5) === 0x00
	);
}

function findJpegTiffOffset(bytes: Uint8Array): number {
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (byte(bytes, offset) !== 0xff) return -1;
		const marker = byte(bytes, offset + 1);
		if (marker === 0xff) {
			offset++;
			continue;
		}

		if (marker === 0xe1) {
			if (offset + 4 >= bytes.length) return -1;
			const segmentStart = offset + 4;
			if (segmentStart + 6 > bytes.length) return -1;
			if (!hasExifHeader(bytes, segmentStart)) return -1;
			return segmentStart + 6;
		}

		if (offset + 4 > bytes.length) return -1;
		const length = (byte(bytes, offset + 2) << 8) | byte(bytes, offset + 3);
		offset += 2 + length;
	}

	return -1;
}

function findWebpTiffOffset(bytes: Uint8Array): number {
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkId = String.fromCharCode(
			byte(bytes, offset),
			byte(bytes, offset + 1),
			byte(bytes, offset + 2),
			byte(bytes, offset + 3),
		);
		const chunkSize =
			byte(bytes, offset + 4) |
			(byte(bytes, offset + 5) << 8) |
			(byte(bytes, offset + 6) << 16) |
			(byte(bytes, offset + 7) << 24);
		const dataStart = offset + 8;

		if (chunkId === "EXIF") {
			if (dataStart + chunkSize > bytes.length) return -1;
			return chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
		}

		offset = dataStart + chunkSize + (chunkSize % 2);
	}

	return -1;
}

function getExifOrientation(bytes: Uint8Array): number {
	let tiffOffset = -1;

	if (bytes.length >= 2 && byte(bytes, 0) === 0xff && byte(bytes, 1) === 0xd8) {
		tiffOffset = findJpegTiffOffset(bytes);
	} else if (
		bytes.length >= 12 &&
		byte(bytes, 0) === 0x52 &&
		byte(bytes, 1) === 0x49 &&
		byte(bytes, 2) === 0x46 &&
		byte(bytes, 3) === 0x46 &&
		byte(bytes, 8) === 0x57 &&
		byte(bytes, 9) === 0x45 &&
		byte(bytes, 10) === 0x42 &&
		byte(bytes, 11) === 0x50
	) {
		tiffOffset = findWebpTiffOffset(bytes);
	}

	if (tiffOffset === -1) return 1;
	return readOrientationFromTiff(bytes, tiffOffset);
}

type DstIndexFn = (x: number, y: number, w: number, h: number) => number;

function rotate90(photon: Photon, image: PhotonImageType, dstIndex: DstIndexFn): PhotonImageType {
	const w = image.get_width();
	const h = image.get_height();
	const src = image.get_raw_pixels();
	const dst = new Uint8Array(src.length);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const srcIdx = (y * w + x) * 4;
			const dstIdx = dstIndex(x, y, w, h) * 4;
			dst[dstIdx] = src[srcIdx] ?? 0;
			dst[dstIdx + 1] = src[srcIdx + 1] ?? 0;
			dst[dstIdx + 2] = src[srcIdx + 2] ?? 0;
			dst[dstIdx + 3] = src[srcIdx + 3] ?? 0;
		}
	}

	return new photon.PhotonImage(dst, h, w);
}

export function applyExifOrientation(
	photon: Photon,
	image: PhotonImageType,
	originalBytes: Uint8Array,
): PhotonImageType {
	const orientation = getExifOrientation(originalBytes);
	if (orientation === 1) return image;

	switch (orientation) {
		case 2:
			photon.fliph(image);
			return image;
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			photon.flipv(image);
			return image;
		case 5: {
			const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
		case 7: {
			const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
		default:
			return image;
	}
}
