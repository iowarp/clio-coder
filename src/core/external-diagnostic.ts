const REDACTED = "[redacted]";

/**
 * Sanitize free-form text received from an external process before it crosses
 * into errors, receipts, transcripts, evidence, or model-catalog snapshots.
 */
function redactExternalDiagnostic(input: string): string {
	return input
		.replace(/\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+/giu, `Authorization: ${REDACTED}`)
		.replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/giu, `Cookie: ${REDACTED}`)
		.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED}`)
		.replace(
			/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
			(match) => {
				const separator = match.includes(":") ? ":" : "=";
				return `${match.slice(0, match.indexOf(separator)).trim()}${separator}${REDACTED}`;
			},
		)
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
		.replace(
			/(?:~|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/\.(?:gemini\/antigravity-cli|antigravitycli)(?:\/[^\s]*)?/gu,
			"[redacted credential path]",
		)
		.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => {
			try {
				const parsed = new URL(url);
				if (/(?:auth|oauth|login|signin|callback)/iu.test(parsed.pathname)) return "[redacted authorization URL]";
				parsed.username = "";
				parsed.password = "";
				parsed.search = "";
				parsed.hash = "";
				return parsed.toString();
			} catch {
				return REDACTED;
			}
		});
}

export function boundedExternalDiagnostic(input: string, maxBytes = 8192): string {
	const redacted = redactExternalDiagnostic(input).trim();
	const bytes = Buffer.from(redacted, "utf8");
	if (bytes.byteLength <= maxBytes) return redacted;
	return `${bytes.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n[diagnostic truncated]`;
}
