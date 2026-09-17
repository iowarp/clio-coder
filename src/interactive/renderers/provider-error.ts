import { stripVTControlCharacters } from "node:util";
import { redactSecretsText } from "../../domains/evidence/redact.js";
import { redactSecretString } from "../../domains/safety/redaction.js";

const SCAN_LIMIT = 8_192;
const DISPLAY_LIMIT = 600;
const ROUTE_ADVICE_TAIL = 1_024;

/** Discard incomplete control sequences at the scan boundary, including their payload. */
function terminalSafePrefix(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	const parts: string[] = [];
	let start = 0;
	let i = 0;
	while (i < end) {
		const code = value.charCodeAt(i);
		if (code !== 27 && !(code >= 0x80 && code <= 0x9f)) {
			i++;
			continue;
		}
		parts.push(value.slice(start, i));
		const introducer = code === 27 ? value.charCodeAt(++i) : code;
		i++;
		if (introducer === 91 || introducer === 0x9b) {
			while (i < end) {
				const next = value.charCodeAt(i++);
				if (next >= 0x40 && next <= 0x7e) break;
			}
		} else if ([93, 80, 88, 94, 95, 0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(introducer)) {
			while (i < end) {
				const next = value.charCodeAt(i++);
				if (next === 7 || next === 0x9c) break;
				if (next === 27 && i < end && value.charCodeAt(i) === 92) {
					i++;
					break;
				}
			}
		}
		start = i;
	}
	parts.push(value.slice(start, end));
	return stripVTControlCharacters(parts.join(""));
}

/** Available evidence is sanitized and redacted only when explicitly inspected. */
export function providerErrorEvidence(value: string, scanLimit = value.length): string {
	return redactSecretsText(
		redactSecretString(terminalSafePrefix(value, scanLimit)).replace(
			/(\b(?:authorization["']?\s*[:=]\s*["']?\s*)?(?:Bearer|Basic)\s+)[^\s"'<>]+/gi,
			"$1[redacted]",
		),
		{ count: 0 },
	).replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : " "));
}

/** A bounded projection; never use this to replace a persisted diagnostic. */
export function presentProviderError(value: string): string {
	const available = providerErrorEvidence(value, SCAN_LIMIT);
	// Preserve the actual Clio wrapper suffix; never infer a retry policy from
	// provider error codes. A restored body can push this advice past the scan
	// window, so a long diagnostic is matched on its bounded tail instead.
	const beyondScan = value.length > SCAN_LIMIT;
	const routeParts = (beyondScan ? providerErrorEvidence(value.slice(-ROUTE_ADVICE_TAIL)) : available).match(
		/\n\n((LiteLLM route [^\n]+ failed\.) (Clio did not retry or substitute another model); (select a different route with \/model, then resend\.))$/,
	);
	const routeAdvice = routeParts?.[1];
	const sample =
		routeAdvice && !beyondScan ? available.slice(0, available.length - routeAdvice.length).trimEnd() : available;
	let summary = sample;
	const jsonStart = sample.indexOf("{");
	const html = /<!doctype\s+html|<html\b/i.test(sample);
	if (html) {
		const title = sample.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
		const prefix = sample.slice(0, sample.indexOf("<")).trim();
		summary = [
			prefix,
			title,
			routeAdvice ? "" : "Provider returned an HTML error page. Check the provider or gateway endpoint.",
		]
			.filter(Boolean)
			.join("; ");
	} else if (jsonStart >= 0) {
		// Decode only quoted diagnostic strings, never parse and round numeric
		// source facts. The scan and every allocation are bounded by SCAN_LIMIT.
		const fields = [...sample.matchAll(/"(?:message|detail|type|code)"\s*:\s*"((?:[^"\\]|\\.)*)/g)].map((match) => {
			const quoted = match[1];
			if (quoted === undefined) return "";
			try {
				// A bounded prefix of an unfinished quoted field is still useful
				// prose. The matcher excludes a dangling escape at the boundary.
				const decoded: unknown = JSON.parse(`"${quoted}"`);
				return typeof decoded === "string" ? providerErrorEvidence(decoded) : "";
			} catch {
				return "";
			}
		});
		if (fields.some(Boolean))
			summary = [sample.slice(0, jsonStart).trim(), ...new Set(fields)].filter(Boolean).join("; ");
	}
	const status =
		sample.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:_code)?["']?\s*[:=]\s*)([45]\d\d)\b/i)?.[1] ??
		sample.match(/"(?:status|status_?code)"\s*:\s*([45]\d{2})(?=\s*[,}])/i)?.[1] ??
		sample.match(/"error"\s*:\s*\{[^{}]*?"code"\s*:\s*([45]\d{2})(?=\s*[,}])/i)?.[1];
	if (status && !summary.includes(status)) summary = `HTTP ${status}; ${summary}`;
	summary = summary.replace(/\s+/g, " ").trim();
	if (routeAdvice) {
		// Keep route recovery ahead of long body detail so row clipping cannot
		// spend the entire primary preview on the provider payload.
		const prefix = summary.slice(0, 60);
		const identity = routeParts?.[2];
		const policy = routeParts?.[3];
		const remedy = routeParts?.[4];
		const advice = identity && policy && remedy ? `${remedy} ${policy}. ${identity}` : routeAdvice;
		summary = `${prefix}${summary.length > 60 ? " ..." : ""}; ${advice}`;
	}
	const shortened = summary.length > DISPLAY_LIMIT || value.length > SCAN_LIMIT || summary !== sample.trim();
	return `${summary.slice(0, DISPLAY_LIMIT)}${shortened ? " ... [available diagnostic: /view transcript]" : ""}`;
}
