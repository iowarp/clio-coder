import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The tar.gz container a telemetry share travels in (#434): ustar regular files only, written and read in memory.
 * The reader takes archives from other machines, so it refuses anything but a regular file under a relative path
 * without `..`, and caps what one archive may expand to.
 */

const BLOCK = 512;
/** A share is a handful of sealed scopes; an archive expanding past this is refused rather than buffered. */
export const MAX_SHARE_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export interface ShareArchiveEntry {
	path: string;
	bytes: Buffer;
}

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** ustar keeps 100 bytes of name and 155 of prefix; split at the last slash that fits both. */
function splitName(path: string): { name: string; prefix: string } {
	if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
	for (let cut = path.lastIndexOf("/"); cut > 0; cut = path.lastIndexOf("/", cut - 1)) {
		const name = path.slice(cut + 1);
		const prefix = path.slice(0, cut);
		if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
	}
	throw new Error(`archive path is too long for ustar: ${path}`);
}

function header(path: string, size: number, mtime: number): Buffer {
	const block = Buffer.alloc(BLOCK);
	const { name, prefix } = splitName(path);
	block.write(name, 0, 100, "utf8");
	block.write(octal(0o644, 8), 100, 8, "ascii");
	block.write(octal(0, 8), 108, 8, "ascii");
	block.write(octal(0, 8), 116, 8, "ascii");
	block.write(octal(size, 12), 124, 12, "ascii");
	block.write(octal(mtime, 12), 136, 12, "ascii");
	block.write("        ", 148, 8, "ascii");
	block.write("0", 156, 1, "ascii");
	block.write("ustar\u000000", 257, 8, "ascii");
	block.write(prefix, 345, 155, "utf8");
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return block;
}

/**
 * The uncompressed tar size `entries` pack to: a header and padded body per member, then the end-of-archive blocks.
 * A share checks it before writing, so it never writes an archive its own reader refuses (#434).
 */
export function telemetryArchiveSize(entries: ReadonlyArray<{ bytes: { length: number } }>): number {
	let size = BLOCK * 2;
	for (const entry of entries) size += BLOCK + Math.ceil(entry.bytes.length / BLOCK) * BLOCK;
	return size;
}

/** One gzipped ustar stream holding `entries` in order, every member stamped with `mtime` (epoch seconds). */
export function packTelemetryArchive(entries: ReadonlyArray<ShareArchiveEntry>, mtime: number): Buffer {
	const size = telemetryArchiveSize(entries);
	if (size > MAX_SHARE_ARCHIVE_BYTES)
		throw new Error(`archive would expand to ${size} bytes, past the ${MAX_SHARE_ARCHIVE_BYTES}-byte limit`);
	const parts: Buffer[] = [];
	for (const entry of entries) {
		parts.push(header(entry.path, entry.bytes.length, mtime), entry.bytes);
		const pad = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
		if (pad > 0) parts.push(Buffer.alloc(pad));
	}
	parts.push(Buffer.alloc(BLOCK * 2));
	return gzipSync(Buffer.concat(parts));
}

function field(block: Buffer, offset: number, length: number): string {
	const slice = block.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return slice.toString("utf8", 0, end < 0 ? length : end);
}

function safeMember(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}

/** Every member of a share archive, in order; any member that is not a plain regular file refuses the archive. */
export function unpackTelemetryArchive(archive: Buffer): ShareArchiveEntry[] {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive, { maxOutputLength: MAX_SHARE_ARCHIVE_BYTES });
	} catch (error) {
		throw new Error(`not a gzip archive within 1 GiB: ${error instanceof Error ? error.message : String(error)}`);
	}
	const entries: ShareArchiveEntry[] = [];
	const seen = new Set<string>();
	let offset = 0;
	while (offset + BLOCK <= tar.length) {
		const block = tar.subarray(offset, offset + BLOCK);
		if (block.every((byte) => byte === 0)) {
			// Bytes past the end-of-archive blocks, a second tar appended or a second gzip member, are outside the
			// manifest and every check; only zero padding may follow (#434).
			if (offset + BLOCK * 2 > tar.length) throw new Error("archive ends without its second end-of-archive block");
			if (!tar.subarray(offset + BLOCK).every((byte) => byte === 0))
				throw new Error(`archive holds bytes after its end-of-archive blocks at ${offset}`);
			return entries;
		}
		let sum = 0;
		for (const [index, byte] of block.entries()) sum += index >= 148 && index < 156 ? 0x20 : byte;
		if (Number.parseInt(field(block, 148, 8).trim(), 8) !== sum)
			throw new Error(`archive header at ${offset} is damaged`);
		const type = String.fromCharCode(block[156] ?? 0);
		if (type !== "0" && type !== "\0") throw new Error(`archive member at ${offset} is not a regular file`);
		const name = field(block, 0, 100);
		const prefix = field(block, 345, 155);
		const path = prefix.length > 0 ? `${prefix}/${name}` : name;
		if (!safeMember(path)) throw new Error(`archive member has an unsafe path: ${path}`);
		if (seen.has(path)) throw new Error(`archive member appears twice: ${path}`);
		seen.add(path);
		const size = Number.parseInt(field(block, 124, 12).trim(), 8);
		const start = offset + BLOCK;
		if (!Number.isSafeInteger(size) || size < 0 || start + size > tar.length)
			throw new Error(`archive member ${path} runs past the archive`);
		entries.push({ path, bytes: Buffer.from(tar.subarray(start, start + size)) });
		offset = start + Math.ceil(size / BLOCK) * BLOCK;
	}
	throw new Error("archive ends without its end-of-archive blocks");
}
