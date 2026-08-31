import { gunzipSync, inflateRawSync } from "node:zlib";

/**
 * Just enough zip and tar.gz reading to unpack a pinned release asset.
 *
 * Node ships neither reader, and the alternatives were a dependency or shelling
 * out to `unzip` and `tar`. A dependency for two hundred lines of well-specified
 * format is a poor trade, and shelling out makes the install fail on a machine
 * that has one of the two but not the other, which is exactly the machine a
 * vendored-tool installer exists to serve. Both readers are deliberately narrow:
 * they read the members the registry names and refuse anything they do not
 * understand rather than guessing.
 *
 * The bytes reaching here have already been checksum-verified against the pin,
 * so these are not parsing hostile input. The size cap and the path checks are
 * belt and braces for the day a pin is updated carelessly.
 */

/** One file read out of an archive. */
export interface ArchiveEntry {
	path: string;
	data: Buffer;
	/** Unix mode when the archive records one, otherwise null. */
	mode: number | null;
}

/** Refuse to materialize more than this from one asset. */
const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

/** Every regular file in a zip, keyed by its path inside the archive. */
export function readZipEntries(buffer: Buffer): Map<string, ArchiveEntry> {
	const eocd = findEndOfCentralDirectory(buffer);
	if (eocd < 0) throw new Error("not a zip archive: end-of-central-directory record not found");
	const entryCount = buffer.readUInt16LE(eocd + 10);
	let cursor = buffer.readUInt32LE(eocd + 16);
	const entries = new Map<string, ArchiveEntry>();
	let total = 0;

	for (let i = 0; i < entryCount; i += 1) {
		if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
			throw new Error(`zip central directory is malformed at entry ${i}`);
		}
		const method = buffer.readUInt16LE(cursor + 10);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const uncompressedSize = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const externalAttributes = buffer.readUInt32LE(cursor + 38);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
		cursor += 46 + nameLength + extraLength + commentLength;

		if (name.endsWith("/")) continue;
		assertSafeMember(name);
		total += uncompressedSize;
		if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("zip archive expands beyond the size cap");

		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
			throw new Error(`zip local header is malformed for ${name}`);
		}
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		const data =
			method === ZIP_STORED
				? Buffer.from(raw)
				: method === ZIP_DEFLATED
					? inflateRawSync(raw)
					: (() => {
							throw new Error(`unsupported zip compression method ${method} for ${name}`);
						})();
		// The high 16 bits of the external attributes carry the unix mode when the
		// archive was produced on a unix host, which is where the executable bit
		// on a release binary lives.
		const unixMode = (externalAttributes >>> 16) & 0o7777;
		entries.set(name, { path: name, data, mode: unixMode === 0 ? null : unixMode });
	}
	return entries;
}

/** Every regular file in a gzipped tar, keyed by its path inside the archive. */
export function readTarGzEntries(buffer: Buffer): Map<string, ArchiveEntry> {
	const tar = gunzipSync(buffer);
	const entries = new Map<string, ArchiveEntry>();
	let offset = 0;
	let total = 0;
	let pendingLongName: string | null = null;

	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		// Two consecutive zero blocks end the archive; one is enough to stop.
		if (header.every((byte) => byte === 0)) break;
		const rawName = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const size = readTarOctal(header, 124, 12);
		const mode = readTarOctal(header, 100, 8);
		const typeFlag = String.fromCharCode(header[156] ?? 0);
		const dataStart = offset + 512;
		const padded = Math.ceil(size / 512) * 512;
		offset = dataStart + padded;

		// GNU long-name extension: this block's payload is the next block's name.
		if (typeFlag === "L") {
			pendingLongName = tar.toString("utf8", dataStart, dataStart + size).replace(/\0+$/, "");
			continue;
		}
		// PAX headers and directories carry no file content Clio wants.
		if (typeFlag === "x" || typeFlag === "g" || typeFlag === "5") {
			pendingLongName = null;
			continue;
		}
		if (typeFlag !== "0" && typeFlag !== "\0") {
			pendingLongName = null;
			continue;
		}

		const name = pendingLongName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
		pendingLongName = null;
		if (name.length === 0 || name.endsWith("/")) continue;
		assertSafeMember(name);
		total += size;
		if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("tar archive expands beyond the size cap");
		entries.set(name, {
			path: name,
			data: Buffer.from(tar.subarray(dataStart, dataStart + size)),
			mode: mode === 0 ? null : mode & 0o7777,
		});
	}
	return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
	// The record is at the very end unless a zip comment follows it, and the
	// comment length field is 16 bits, so 22 + 65535 bytes is the whole search.
	const start = Math.max(0, buffer.length - (22 + 0xffff));
	for (let i = buffer.length - 22; i >= start; i -= 1) {
		if (buffer.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) return i;
	}
	return -1;
}

function readTarString(header: Buffer, offset: number, length: number): string {
	const slice = header.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return slice.toString("utf8", 0, end === -1 ? slice.length : end);
}

function readTarOctal(header: Buffer, offset: number, length: number): number {
	const text = readTarString(header, offset, length).trim();
	if (text.length === 0) return 0;
	const value = Number.parseInt(text, 8);
	return Number.isNaN(value) ? 0 : value;
}

/**
 * An archive member's path is used to look up a registry-named member, never to
 * build a write path, but a member escaping the archive root still means the
 * asset is not what the pin says it is.
 */
function assertSafeMember(name: string): void {
	if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
		throw new Error(`archive member has an absolute path: ${name}`);
	}
	if (name.split(/[/\\]/).includes("..")) {
		throw new Error(`archive member escapes the archive root: ${name}`);
	}
}
