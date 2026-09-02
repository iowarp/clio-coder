/** Collapse descriptor-authored prompt guidance to one byte-stable line. */
export function normalizePromptHint(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const normalized = text
		.replace(/[\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return normalized.length > 0 ? normalized : undefined;
}
