import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Extract a gzipped npm package tarball into `target`. The tarball has
 * already passed its sha256 pin, so this guards against a pin that names a
 * hostile archive rather than against corruption: only regular files and
 * directories are accepted, every path is resolved under `target`, and the
 * leading `package/` directory npm puts on every entry is stripped. Links,
 * devices, FIFOs and extended (pax or GNU long-name) headers are refused
 * rather than interpreted, which the pinned reader tarballs never contain.
 */

const BLOCK = 512;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

function field(header: Buffer, offset: number, length: number): string {
	const raw = header.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(header: Buffer, offset: number, length: number): number {
	const text = field(header, offset, length).trim();
	if (text.length === 0) return 0;
	if (!/^[0-7]+$/u.test(text)) throw new Error(`tar header field at ${offset} is not octal`);
	return Number.parseInt(text, 8);
}

function checksumMatches(header: Buffer): boolean {
	let sum = 0;
	for (let index = 0; index < BLOCK; index += 1) {
		sum += index >= 148 && index < 156 ? 0x20 : (header[index] as number);
	}
	return sum === octal(header, 148, 8);
}

/** The entry path below `package/`, or null for the `package/` directory itself. */
function relativeEntry(name: string): string | null {
	if (isAbsolute(name) || name.includes("\\")) throw new Error(`tar entry ${JSON.stringify(name)} is not relative`);
	const parts = name.split("/").filter((part) => part.length > 0 && part !== ".");
	if (parts.some((part) => part === "..")) throw new Error(`tar entry ${JSON.stringify(name)} escapes the target`);
	if (parts[0] !== "package") throw new Error(`tar entry ${JSON.stringify(name)} is outside package/`);
	return parts.length === 1 ? null : parts.slice(1).join("/");
}

export function extractPackageTarball(gzipped: Uint8Array, target: string): void {
	const tar = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES });
	const root = resolve(target);
	mkdirSync(root, { recursive: true });
	let offset = 0;
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) break;
		if (!checksumMatches(header)) throw new Error(`tar header at byte ${offset} fails its checksum`);
		const prefix = field(header, 345, 155);
		const name = prefix.length > 0 ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] as number);
		const body = offset + BLOCK;
		if (body + size > tar.length) throw new Error(`tar entry ${JSON.stringify(name)} runs past the archive end`);
		const relative = relativeEntry(name);
		const destination = relative === null ? root : normalize(join(root, relative));
		if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
			throw new Error(`tar entry ${JSON.stringify(name)} escapes the target`);
		}
		if (type === "5") mkdirSync(destination, { recursive: true });
		else if (type === "0" || type === "\0") {
			if (relative === null) throw new Error("tar names package/ as a file");
			mkdirSync(join(destination, ".."), { recursive: true });
			writeFileSync(destination, tar.subarray(body, body + size), { flag: "wx" });
		} else {
			throw new Error(
				`tar entry ${JSON.stringify(name)} has type ${JSON.stringify(type)}; only files and directories are accepted`,
			);
		}
		offset = body + Math.ceil(size / BLOCK) * BLOCK;
	}
}
