import type { RecordRead, SegmentHeader, TelemetryRecord } from "./envelope.js";
import { readTelemetryRecord } from "./envelope.js";

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	return crc >>> 0;
});

/** IEEE CRC32 over UTF-8 bytes; corruption detection, never a content commitment (#434). */
export function crc32(bytes: Uint8Array): string {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
	return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function encodeTelemetryLine(value: TelemetryRecord | SegmentHeader): Buffer {
	const json = Buffer.from(JSON.stringify(value), "utf8");
	return Buffer.concat([json, Buffer.from(`\t#${crc32(json)}\n`)]);
}

export interface SegmentScan {
	rows: RecordRead[];
	/** Last complete physical line, including future records the reader cannot interpret. */
	validBytes: number;
	tornTailBytes: number;
	/** Interior corruption requires intervention; it must never truncate valid later records. */
	corruptOffset: number | null;
}

/** Pure scan: only the adjudicated writer may repair a tail; read-only queries never mutate (#434). */
export function scanTelemetrySegment(bytes: Buffer): SegmentScan {
	const result: SegmentScan = { rows: [], validBytes: 0, tornTailBytes: 0, corruptOffset: null };
	let offset = 0;
	while (offset < bytes.length) {
		const newline = bytes.indexOf(0x0a, offset);
		if (newline < 0) {
			result.tornTailBytes = bytes.length - offset;
			break;
		}
		const line = bytes.subarray(offset, newline);
		const suffix = line.subarray(-10).toString("ascii");
		const json = line.subarray(0, -10);
		if (!/^\t#[0-9a-f]{8}$/.test(suffix) || crc32(json) !== suffix.slice(2)) {
			if (newline === bytes.length - 1) result.tornTailBytes = bytes.length - offset;
			else result.corruptOffset = offset;
			break;
		}
		try {
			result.rows.push(readTelemetryRecord(JSON.parse(json.toString("utf8"))));
		} catch {
			// A complete checksummed but invalid JSON record is skipped and counted, never truncated (#434).
			result.rows.push({ kind: "skipped", reason: "invalid-record" });
		}
		offset = newline + 1;
		result.validBytes = offset;
	}
	return result;
}
