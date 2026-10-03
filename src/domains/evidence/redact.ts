/**
 * Export-boundary secret redaction. Applied when an evidence bundle is built
 * (cold path), never during live turns: previews, transcript text, and
 * receipt payloads are scrubbed before serialization so a leaked value stops
 * at the machine boundary. Raw session files stay untouched; the bundle is
 * the boundary, and its overview records how much was filtered so the bundle
 * stays truthful about its own redaction.
 */

export interface RedactionTally {
	count: number;
}

export function createRedactionTally(): RedactionTally {
	return { count: 0 };
}

interface SecretPattern {
	kind: string;
	re: RegExp;
}

/**
 * Value-shaped secrets, matched on content alone. Deliberately conservative:
 * each pattern targets a documented credential format, plus one generic
 * key/token/secret/password assignment shape. Audit rows already get
 * key-name-based redaction at write time; this pass catches values that
 * escaped into free text, command output, or tool arguments.
 */
const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
	{
		kind: "pem",
		re: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END [A-Z0-9 ]*(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----|$)/g,
	},
	{ kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
	{ kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ kind: "sk-key", re: /\bsk-(?:[A-Za-z0-9_-]{2,20}-)?[A-Za-z0-9_-]{16,}\b/g },
	{ kind: "slack-token", re: /\bxox[bpars]-[A-Za-z0-9-]{8,}\b/g },
	{ kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
	{ kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
	{
		kind: "assignment",
		// KEY=value / key: value / "api_key": "value" shapes where the key name
		// is secret-flavored and the value is long enough to be a credential.
		// A value that opens a call with no argument, a literal or a line break
		// is code, not a credential: source constants such as
		// `BASE_TOKENS = frozenset({` were redacted on every read (DF-12). A
		// password like `Summer2024(!)` still reads as a value.
		re: /\b((?:[A-Za-z0-9_-]*(?:api[_-]?key|apikey|secret|token|passwd|password|credential)[A-Za-z0-9_-]*)\s*["']?\s*[:=]\s*["']?)(?![A-Za-z_][\w.]*\((?:[\s"'{[)]|$))([^\s"'`;,&|<>]{8,})/gi,
	},
];

/** The assignment pattern's key and value halves, for a key that arrives as a JSON property name. */
const SECRET_PROPERTY_NAME = /(?:api[_-]?key|apikey|secret|token|passwd|password|credential)[A-Za-z0-9_-]*$/i;
const CREDENTIAL_PREFIX = /^[^\s"'`;,&|<>]{8,}/;

/** Replace every secret-shaped value in `text`, tallying replacements. */
export function redactSecretsText(text: string, tally: RedactionTally): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern.re, (...match: unknown[]) => {
			tally.count += 1;
			if (pattern.kind === "assignment") {
				// Keep the key and separator; replace only the value.
				return `${String(match[1])}[redacted:${pattern.kind}]`;
			}
			return `[redacted:${pattern.kind}]`;
		});
	}
	return out;
}

/**
 * Deep-redact every string in a JSON-shaped value. Arrays and plain objects
 * are walked; other object types (dates, buffers) pass through untouched.
 */
export function redactSecretsDeep<T>(value: T, tally: RedactionTally): T {
	if (typeof value === "string") return redactSecretsText(value, tally) as unknown as T;
	if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, tally)) as unknown as T;
	if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = redactSecretsDeep(item, tally);
		}
		return out as unknown as T;
	}
	return value;
}

/**
 * A `JSON.stringify` replacer that redacts string leaves before they are
 * escaped. Redacting the serialized text instead let the assignment value
 * swallow the backslash of an escaped quote, which left an unescaped quote in
 * the durable trace and an undecodable payload (DF-12). Leaf by leaf the
 * assignment pattern never sees a property name, so a secret-flavored name
 * redacts its credential-shaped value the way `"api_key": "value"` text would.
 */
export function secretRedactingReplacer(tally: RedactionTally): (key: string, value: unknown) => unknown {
	return (key, value) => {
		if (typeof value !== "string") return value;
		const redacted = redactSecretsText(value, tally);
		if (!SECRET_PROPERTY_NAME.test(key) || redacted.startsWith("[redacted:")) return redacted;
		return redacted.replace(CREDENTIAL_PREFIX, () => {
			tally.count += 1;
			return "[redacted:assignment]";
		});
	};
}
