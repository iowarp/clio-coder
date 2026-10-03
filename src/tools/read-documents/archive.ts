import { isUtf8 } from "node:buffer";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { createGunzip, createInflateRaw } from "node:zlib";
import { formatSize } from "../truncate.js";
import { type DocumentRequest, RENDER_CAP_BYTES, type Rendered } from "./shared.js";

/**
 * Zip and tar (plain or gzip) archives: a member listing, or one UTF-8 text
 * member inflated in memory up to RENDER_CAP_BYTES. Nothing is written to
 * disk. Zip reads the central directory (zip64 included) and inflates stored
 * or deflated members; tar streams header by header and skips bodies.
 */

const ZIP_CENTRAL_DIRECTORY_MAX_BYTES = 64 * 1024 * 1024;

const ARCHIVE_LIST_CAP = 2000;
const TAR_META_CAP_BYTES = 64 * 1024;
const BINARY_SNIFF_BYTES = 64 * 1024;
interface ArchiveEntry {
	name: string;
	size: number;
	mtime: Date | null;
	directory: boolean;
	note?: string;
}

function renderListing(label: string, entries: ArchiveEntry[], total: number, unpacked: number): string {
	const lines = [
		`# ${label}: ${total} members, ${formatSize(unpacked)} unpacked; read one text member with member=<name>`,
	];
	for (const entry of entries) {
		const when = entry.mtime === null ? "                " : entry.mtime.toISOString().slice(0, 16).replace("T", " ");
		const size = entry.directory ? "-" : formatSize(entry.size);
		lines.push(`${size.padStart(10)}  ${when}  ${entry.name}${entry.note !== undefined ? `  (${entry.note})` : ""}`);
	}
	if (total > entries.length) lines.push(`[listing capped at ${entries.length} of ${total} members]`);
	return lines.join("\n");
}

/** Decode a member's bytes as UTF-8 text, refusing binary content. */
function memberText(name: string, bytes: Buffer, fullSize: number): Rendered {
	const nul = bytes.subarray(0, BINARY_SNIFF_BYTES).indexOf(0);
	if (nul >= 0) {
		return { error: `member ${name} looks binary (NUL at byte ${nul}); use run_script to inspect it in memory` };
	}
	let body = bytes;
	if (bytes.length < fullSize) {
		// The cut can land inside a multibyte sequence; drop the partial tail.
		let end = body.length;
		for (let back = 1; back <= 3 && back <= body.length; back += 1) {
			const byte = body[body.length - back] as number;
			if ((byte & 0xc0) === 0x80) continue;
			const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
			if (width > back) end = body.length - back;
			break;
		}
		body = body.subarray(0, end);
	}
	if (!isUtf8(body)) return { error: `member ${name} is not UTF-8 text; use run_script to inspect it in memory` };
	const text = body.toString("utf8");
	return {
		text:
			bytes.length < fullSize
				? `${text}\n[member cut at ${formatSize(RENDER_CAP_BYTES)} of ${formatSize(fullSize)}]`
				: text,
	};
}

function sameMember(a: string, b: string): boolean {
	const clean = (name: string) => name.replace(/^\.\//u, "");
	return clean(a) === clean(b);
}

function dosTime(time: number, date: number): Date | null {
	if (date === 0) return null;
	return new Date(
		Date.UTC(1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2),
	);
}

interface ZipEntry extends ArchiveEntry {
	method: number;
	flags: number;
	compressedSize: number;
	localOffset: number;
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

async function zipDirectory(
	handle: FileHandle,
	size: number,
): Promise<{ entries: ZipEntry[]; total: number } | { error: string }> {
	const tailLength = Math.min(size, 65_557);
	const tail = await readAt(handle, size - tailLength, tailLength);
	let eocd = -1;
	for (let index = tail.length - 22; index >= 0; index -= 1) {
		if (tail.readUInt32LE(index) === 0x06054b50) {
			eocd = index;
			break;
		}
	}
	if (eocd < 0) return { error: "no zip end-of-central-directory record; the archive is truncated or not a zip" };
	let total = tail.readUInt16LE(eocd + 10);
	let cdSize = tail.readUInt32LE(eocd + 12);
	let cdOffset = tail.readUInt32LE(eocd + 16);
	if ((total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20) {
		if (tail.readUInt32LE(eocd - 20) === 0x07064b50) {
			const record = await readAt(handle, Number(tail.readBigUInt64LE(eocd - 12)), 56);
			if (record.length === 56 && record.readUInt32LE(0) === 0x06064b50) {
				total = Number(record.readBigUInt64LE(32));
				cdSize = Number(record.readBigUInt64LE(40));
				cdOffset = Number(record.readBigUInt64LE(48));
			}
		}
	}
	if (cdSize > ZIP_CENTRAL_DIRECTORY_MAX_BYTES) {
		return { error: `zip central directory is ${formatSize(cdSize)}; use run_script with zipfile to list it` };
	}
	const cd = await readAt(handle, cdOffset, cdSize);
	const entries: ZipEntry[] = [];
	let at = 0;
	while (at + 46 <= cd.length && cd.readUInt32LE(at) === 0x02014b50) {
		const nameLength = cd.readUInt16LE(at + 28);
		const extraLength = cd.readUInt16LE(at + 30);
		const commentLength = cd.readUInt16LE(at + 32);
		const name = cd.toString("utf8", at + 46, at + 46 + nameLength);
		let size64 = cd.readUInt32LE(at + 24);
		let compressed = cd.readUInt32LE(at + 20);
		let localOffset = cd.readUInt32LE(at + 42);
		// The zip64 extra field carries, in order, whichever of these overflowed.
		let extra = at + 46 + nameLength;
		const extraEnd = extra + extraLength;
		while (extra + 4 <= extraEnd) {
			const id = cd.readUInt16LE(extra);
			const length = cd.readUInt16LE(extra + 2);
			if (id === 0x0001) {
				let field = extra + 4;
				if (size64 === 0xffffffff) {
					size64 = Number(cd.readBigUInt64LE(field));
					field += 8;
				}
				if (compressed === 0xffffffff) {
					compressed = Number(cd.readBigUInt64LE(field));
					field += 8;
				}
				if (localOffset === 0xffffffff) localOffset = Number(cd.readBigUInt64LE(field));
			}
			extra += 4 + length;
		}
		const flags = cd.readUInt16LE(at + 8);
		const method = cd.readUInt16LE(at + 10);
		const entry: ZipEntry = {
			name,
			size: size64,
			mtime: dosTime(cd.readUInt16LE(at + 12), cd.readUInt16LE(at + 14)),
			directory: name.endsWith("/"),
			method,
			flags,
			compressedSize: compressed,
			localOffset,
		};
		if ((flags & 1) !== 0) entry.note = "encrypted";
		else if (method !== 0 && method !== 8) entry.note = `compression method ${method}`;
		entries.push(entry);
		at += 46 + nameLength + extraLength + commentLength;
	}
	return { entries, total: Math.max(total, entries.length) };
}

export async function renderZip(
	filePath: string,
	handle: FileHandle,
	size: number,
	request: DocumentRequest,
): Promise<Rendered> {
	const directory = await zipDirectory(handle, size);
	if ("error" in directory) return directory;
	if (request.member === undefined) {
		const unpacked = directory.entries.reduce((sum, entry) => sum + entry.size, 0);
		return {
			text: renderListing(
				`zip ${basename(filePath)}`,
				directory.entries.slice(0, ARCHIVE_LIST_CAP),
				directory.total,
				unpacked,
			),
		};
	}
	const wanted = request.member;
	const entry = directory.entries.find((candidate) => sameMember(candidate.name, wanted));
	if (entry === undefined || entry.directory)
		return { error: `no file member named ${JSON.stringify(wanted)} in the zip` };
	if ((entry.flags & 1) !== 0) return { error: `member ${entry.name} is encrypted; encrypted members are not read` };
	if (entry.method !== 0 && entry.method !== 8) {
		return { error: `member ${entry.name} uses compression method ${entry.method}; use run_script with zipfile` };
	}
	const local = await readAt(handle, entry.localOffset, 30);
	if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50)
		return { error: `member ${entry.name}: bad local header` };
	const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
	if (entry.compressedSize === 0) return memberText(entry.name, Buffer.alloc(0), 0);
	const raw = createReadStream(filePath, { start, end: start + entry.compressedSize - 1 });
	const source = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
	const bytes = await collect(source, RENDER_CAP_BYTES, request.signal, () => raw.destroy());
	return memberText(entry.name, bytes, entry.size);
}

/** Read a stream into memory up to `cap` bytes, then stop it. */
async function collect(
	source: NodeJS.ReadableStream,
	cap: number,
	signal: AbortSignal | undefined,
	stop: () => void,
): Promise<Buffer> {
	const parts: Buffer[] = [];
	let length = 0;
	try {
		for await (const chunk of source as AsyncIterable<Buffer>) {
			if (signal?.aborted) throw new Error("cancelled");
			parts.push(chunk);
			length += chunk.length;
			if (length >= cap) break;
		}
	} finally {
		stop();
	}
	return Buffer.concat(parts).subarray(0, cap);
}

function tarNumber(field: Buffer): number {
	// GNU base-256 for sizes past the 8 GiB octal limit.
	if (((field[0] as number) & 0x80) !== 0) {
		let value = (field[0] as number) & 0x7f;
		for (let index = 1; index < field.length; index += 1) value = value * 256 + (field[index] as number);
		return value;
	}
	const text = field.toString("latin1").replace(/\0.*$/su, "").trim();
	return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function tarChecksumValid(header: Buffer): boolean {
	let sum = 0;
	for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : (header[index] as number);
	return sum === tarNumber(header.subarray(148, 156));
}

function tarString(field: Buffer): string {
	const end = field.indexOf(0);
	return field.toString("utf8", 0, end < 0 ? field.length : end);
}

/**
 * Walk a tar stream header by header. Entry bodies are skipped as they
 * stream past; only PAX and GNU long-name records and the one requested
 * member are held, each bounded.
 */
export async function renderTar(filePath: string, gzipped: boolean, request: DocumentRequest): Promise<Rendered> {
	const raw = createReadStream(filePath);
	const source = gzipped ? raw.pipe(createGunzip()) : raw;
	const entries: ArchiveEntry[] = [];
	let total = 0;
	let unpacked = 0;
	let pending: Buffer = Buffer.alloc(0);
	let skip = 0;
	let body: { kind: "meta" | "member"; type: string; size: number; parts: Buffer[]; held: number } | null = null;
	let longName: string | null = null;
	let paxPath: string | null = null;
	let paxSize: number | null = null;
	let found: { name: string; bytes: Buffer; size: number } | null = null;
	let first = true;
	let ended = false;
	try {
		for await (const chunk of source as AsyncIterable<Buffer>) {
			if (request.signal?.aborted) return { error: "cancelled" };
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			while (!ended && found === null) {
				if (skip > 0) {
					const take = Math.min(skip, pending.length);
					if (take === 0) break;
					if (body !== null && body.held < (body.kind === "meta" ? TAR_META_CAP_BYTES : RENDER_CAP_BYTES)) {
						const part = pending.subarray(0, take);
						body.parts.push(part);
						body.held += part.length;
					}
					pending = pending.subarray(take);
					skip -= take;
					if (skip > 0) break;
					if (body !== null) {
						const data = Buffer.concat(body.parts).subarray(0, body.size);
						if (body.kind === "member") {
							found = { name: request.member ?? "", bytes: data.subarray(0, RENDER_CAP_BYTES), size: body.size };
						} else if (body.type === "L") {
							longName = tarString(data);
						} else if (body.type === "x") {
							for (const record of data.toString("utf8").split("\n")) {
								const match = /^\d+ ([^=]+)=(.*)$/su.exec(record);
								if (match?.[1] === "path") paxPath = match[2] ?? null;
								if (match?.[1] === "size") paxSize = Number(match[2]);
							}
						}
						body = null;
					}
					continue;
				}
				if (pending.length < 512) break;
				const header = pending.subarray(0, 512);
				pending = pending.subarray(512);
				if (header.every((byte) => byte === 0)) {
					ended = true;
					break;
				}
				if (!tarChecksumValid(header)) {
					return first
						? { error: gzipped ? "a gzip stream that is not a tar archive; use run_script to read it" : "not a tar archive" }
						: { error: `tar header checksum failed after ${total} members; the archive is corrupt` };
				}
				first = false;
				const type = String.fromCharCode(header[156] || 48);
				const prefix = header.toString("latin1", 257, 262) === "ustar" ? tarString(header.subarray(345, 500)) : "";
				const size = paxSize ?? tarNumber(header.subarray(124, 136));
				const padded = Math.ceil(size / 512) * 512;
				if (type === "L" || type === "x") {
					body = { kind: "meta", type, size, parts: [], held: 0 };
					skip = padded;
					if (skip === 0) body = null;
					continue;
				}
				const plain = tarString(header.subarray(0, 100));
				const name = paxPath ?? longName ?? (prefix.length > 0 ? `${prefix}/${plain}` : plain);
				longName = null;
				paxPath = null;
				paxSize = null;
				skip = padded;
				if (type === "g") continue;
				const directory = type === "5";
				const regular = type === "0" || type === "7";
				total += 1;
				if (regular) unpacked += size;
				if (request.member === undefined) {
					if (entries.length < ARCHIVE_LIST_CAP) {
						const note =
							type === "2"
								? `symlink to ${tarString(header.subarray(157, 257))}`
								: type === "1"
									? `hard link to ${tarString(header.subarray(157, 257))}`
									: undefined;
						entries.push({
							name,
							size,
							mtime: new Date(tarNumber(header.subarray(136, 148)) * 1000),
							directory,
							...(note !== undefined ? { note } : {}),
						});
					}
				} else if (sameMember(name, request.member) && regular) {
					if (size === 0) found = { name, bytes: Buffer.alloc(0), size: 0 };
					else body = { kind: "member", type, size, parts: [], held: 0 };
				}
			}
			if (ended || found !== null) break;
		}
	} catch (err) {
		return { error: `cannot read the archive: ${err instanceof Error ? err.message : String(err)}` };
	} finally {
		raw.destroy();
	}
	if (first && !ended) {
		// Too short to hold one tar header: the stream ended before any member.
		return {
			error: gzipped ? "a gzip stream that is not a tar archive; use run_script to read it" : "not a tar archive",
		};
	}
	const label = `${gzipped ? "tar.gz" : "tar"} ${basename(filePath)}`;
	if (request.member === undefined) return { text: renderListing(label, entries, total, unpacked) };
	if (found === null) return { error: `no file member named ${JSON.stringify(request.member)} in the ${label}` };
	return memberText(found.name, found.bytes, found.size);
}
