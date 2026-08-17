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
 */
function jsonPayloadCandidates(text: string): string[] {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const fenced = /```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)```/.exec(trimmed)?.[1]?.trim();
	if (fenced !== undefined && fenced.length > 0) candidates.push(fenced);
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
	return candidates;
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
