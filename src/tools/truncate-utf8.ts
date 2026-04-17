export function truncateUtf8(text: string, maxBytes: number, marker: string): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return text;

	let cut = maxBytes;
	while (cut > 0) {
		const nextByte = buf[cut];
		if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
		cut -= 1;
	}

	return `${buf.subarray(0, cut).toString("utf8")}${marker}`;
}
