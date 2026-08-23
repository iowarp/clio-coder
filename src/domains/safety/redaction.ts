/**
 * Display-time secret redaction for tool arguments.
 *
 * Two surfaces need the same rules and must not drift. The transcript's tool
 * renderer projects a call's arguments for the operator's own screen, and the
 * worker tool-admission seam composes a bounded action descriptor that crosses
 * the NDJSON stdout boundary. A credential that one of them scrubs and the
 * other prints is a leak, so the patterns live here and both import them.
 *
 * This is presentation only. Execution, receipts, and the safety verdict all
 * keep the original argument values; nothing here changes what a tool runs.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SECRET_KEY_RE =
	/(?:api[-_]?key|access[-_]?key|auth(?:orization)?|credential|password|private[-_]?key|secret|token)/iu;
const ENV_KEY_RE = /^env(?:ironment)?$/iu;
const SECRET_STRING_RE = /(https?:\/\/[^\s/@]+:)[^\s/@]+@/giu;
const SECRET_URL_PARAM_RE =
	/([?&](?:api[-_]?key|access[-_]?token|auth(?:orization)?|credential|password|secret|token)[^=\s]*=)[^&#\s]+/giu;
const SECRET_ASSIGNMENT_RE =
	/(?<![A-Z0-9_])((?:[A-Z0-9_]*(?:ACCESS|API|AUTH|CREDENTIAL|KEY|PASS(?:WORD)?|PRIVATE|SECRET|TOKEN)[A-Z0-9_]*)=)[^\s;&|]+/giu;
const SECRET_FLAG_RE =
	/(--?(?:[a-z0-9-]*(?:api[-_]?key|access[-_]?token|auth(?:orization)?|credential|password|secret|token)[a-z0-9-]*))(=|\s+)([^\s;&|]+)/giu;

/** Scrub credentials embedded in one string: URL userinfo, query params, `KEY=value`, and `--flag value`. */
export function redactSecretString(value: string): string {
	return value
		.replace(SECRET_STRING_RE, "$1[redacted]@")
		.replace(SECRET_URL_PARAM_RE, "$1[redacted]")
		.replace(SECRET_ASSIGNMENT_RE, "$1[redacted]")
		.replace(SECRET_FLAG_RE, "$1$2[redacted]");
}

/** Whether an argument key names a secret outright, so its value never renders. */
export function isSecretArgKey(key: string): boolean {
	return SECRET_KEY_RE.test(key);
}

/** Whether an argument key names an environment block, whose every string value is a candidate secret. */
export function isEnvironmentArgKey(key: string): boolean {
	return ENV_KEY_RE.test(key);
}

function redactEnvironmentValue(value: unknown, depth: number): unknown {
	if (depth > 8) return "[redacted nested values]";
	if (typeof value === "string") return "[redacted]";
	if (Array.isArray(value)) return value.map((item) => redactEnvironmentValue(item, depth + 1));
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		out[childKey] = redactEnvironmentValue(childValue, depth + 1);
	}
	return out;
}

/** Project tool arguments for display only; execution and receipts retain the original values. */
export function redactToolArgs(value: unknown, key = "", depth = 0): unknown {
	if (isSecretArgKey(key)) return "[redacted]";
	if (isEnvironmentArgKey(key)) return redactEnvironmentValue(value, depth);
	if (typeof value === "string") return redactSecretString(value);
	if (depth > 8) return "[redacted nested values]";
	if (Array.isArray(value)) return value.map((item) => redactToolArgs(item, key, depth + 1));
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		out[childKey] = redactToolArgs(childValue, childKey, depth + 1);
	}
	return out;
}
