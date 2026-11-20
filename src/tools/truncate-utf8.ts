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

export function truncateHeadTailUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return text;
	if (maxBytes <= 0) return "";

	const total = buf.byteLength;
	const worstMarkerBytes = Buffer.byteLength(`\n[... ${total} bytes omitted ...]\n`, "utf8");
	const bodyBudget = maxBytes - worstMarkerBytes;
	if (bodyBudget <= 0) return `[... ${total} bytes omitted ...]`;

	const headBudget = Math.floor(bodyBudget / 3);
	const tailBudget = bodyBudget - headBudget;

	let headCut = headBudget;
	while (headCut > 0) {
		const nextByte = buf[headCut];
		if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
		headCut -= 1;
	}

	let tailStart = total - tailBudget;
	while (tailStart < total) {
		const byte = buf[tailStart];
		if (byte === undefined || (byte & 0xc0) !== 0x80) break;
		tailStart += 1;
	}

	const dropped = tailStart - headCut;
	if (dropped <= 0) return text;

	const headText = buf.subarray(0, headCut).toString("utf8");
	const tailText = buf.subarray(tailStart).toString("utf8");
	const marker = `[... ${dropped} bytes omitted ...]`;
	if (headText.length === 0) {
		return tailText.length > 0 ? `${marker}${tailText.startsWith("\n") ? "" : "\n"}${tailText}` : marker;
	}
	if (tailText.length === 0) {
		return `${headText}${headText.endsWith("\n") ? "" : "\n"}${marker}`;
	}
	const before = headText.endsWith("\n") ? "" : "\n";
	const after = tailText.startsWith("\n") ? "" : "\n";
	return `${headText}${before}${marker}${after}${tailText}`;
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}
