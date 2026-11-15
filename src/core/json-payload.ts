/**
 * The spans a model message may carry its JSON payload in, in the order they
 * are tried: the whole message, the first fenced block, then the outermost
 * brace span.
 *
 * A model asked for bare JSON reaches for a fence first, and prose in front of
 * the fence is the next most common deviation, so a reader that only tries one
 * span refuses payloads that are correct. The fence candidate is not enough on
 * its own either: a payload whose own strings contain a fenced block, such as a
 * "Commands" section holding a ```bash example, truncates at the inner close
 * and has to fall through to the brace span.
 *
 * Every caller parses each candidate in turn and keeps the first that yields
 * what it needs. None of them may return or throw on the first span that merely
 * looks plausible: the context-bootstrap reader did exactly that and turned a
 * complete handbook into "Unterminated string in JSON".
 *
 * After those three, a review written as Markdown that ends with its JSON
 * result still counts: every later fenced block, then every balanced top-level
 * object, each tried from the last back, since a result closes the answer
 * (WTF-P plan-checker, 2026-11-15). These only add spans after the original
 * three, so whatever parsed before still parses to the same object.
 */
function jsonPayloadCandidates(text: string): string[] {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const fences = [...trimmed.matchAll(/```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)```/g)]
		.map((match) => match[1]?.trim() ?? "")
		.filter((body) => body.length > 0);
	if (fences[0] !== undefined) candidates.push(fences[0]);
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
	candidates.push(...fences.slice(1).reverse(), ...balancedObjectSpans(trimmed));
	return [...new Set(candidates)];
}

/** Brace openings tried from the end; bounds the scan on a long reply that never closes its result. */
const BALANCED_OBJECT_START_LIMIT = 64;

/**
 * Balanced `{...}` spans, braces inside JSON strings ignored, the span that
 * ends last first and the outermost of those first, so a closing result wins
 * over the checks nested inside it. Each opening brace is matched on its own,
 * so an unmatched `{` in prose cannot swallow the object after it.
 */
function balancedObjectSpans(text: string): string[] {
	const starts: number[] = [];
	for (let index = text.lastIndexOf("{"); index >= 0 && starts.length < BALANCED_OBJECT_START_LIMIT; ) {
		starts.push(index);
		index = index === 0 ? -1 : text.lastIndexOf("{", index - 1);
	}
	const spans: Array<{ start: number; end: number }> = [];
	for (const start of starts) {
		const end = matchingBrace(text, start);
		if (end !== -1) spans.push({ start, end });
	}
	spans.sort((left, right) => right.end - left.end || left.start - right.start);
	return spans.map(({ start, end }) => text.slice(start, end + 1));
}

function matchingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

export type JsonObjectPayload =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; reason: "not-json" | "not-object" };

/**
 * The first JSON object a model message carries, searched over every span
 * `jsonPayloadCandidates` names. `not-json` means no span parsed at all;
 * `not-object` means something parsed and none of it was an object, so a
 * fenced array is refused with the reason its caller already reports.
 *
 * Every reader of a model's JSON answer goes through here so that a validator,
 * the reader that follows it, and a renderer of the same text agree on what
 * the payload is. When they held separate ideas, a fenced code report passed
 * its validator and then threw in the reader that re-parsed the raw text.
 */
export function parseJsonObjectPayload(text: string): JsonObjectPayload {
	let parsedSomething = false;
	for (const candidate of jsonPayloadCandidates(text)) {
		let value: unknown;
		try {
			value = JSON.parse(candidate) as unknown;
		} catch {
			continue;
		}
		parsedSomething = true;
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		return { ok: true, value: value as Record<string, unknown> };
	}
	return { ok: false, reason: parsedSomething ? "not-object" : "not-json" };
}

function jsonObject(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text) as unknown;
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		// Not JSON, as for text after a report; the caller keeps the reason it already has.
		return null;
	}
}

/**
 * A verifier report as every reader of one must see it, so a contract, its gate and claim grounding cannot disagree. A
 * local model often reasons in prose before its report, and a brace in that prose, such as a quoted function body,
 * defeats the brace span, so one report that closes the answer still counts, fenced or not. A second report leaves the
 * answer unreadable rather than letting the quoted one decide, because the fence and brace spans would read the first.
 */
export function parseVerifierPayload(text: string): JsonObjectPayload {
	const reports = [...text.matchAll(/\{\s*"verdict"/gu)];
	if (reports.length > 1) {
		const whole = jsonObject(text.trim());
		return whole === null ? { ok: false, reason: "not-json" } : { ok: true, value: whole };
	}
	const parsed = parseJsonObjectPayload(text);
	const report = reports[0];
	if (parsed.ok || report === undefined) return parsed;
	const closing = jsonObject(
		text
			.slice(report.index)
			.trim()
			.replace(/\s*```$/u, ""),
	);
	return closing === null ? parsed : { ok: true, value: closing };
}
