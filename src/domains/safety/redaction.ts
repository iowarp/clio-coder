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
const SECRET_STRING_RE = /(https?:\/\/[^\s/@]+:)([^\s/@]+)@/giu;
const SECRET_URL_PARAM_RE =
	/([?&](?:api[-_]?key|access[-_]?token|auth(?:orization)?|credential|password|secret|token)[^=\s]*=)([^&#\s]+)/giu;
const SECRET_ASSIGNMENT_RE =
	/(?<![A-Z0-9_])((?:[A-Z0-9_]*(?:ACCESS|API|AUTH|CREDENTIAL|KEY|PASS(?:WORD)?|PRIVATE|SECRET|TOKEN)[A-Z0-9_]*)=)([^\s;&|]+)/giu;
// `:_authToken=${NPM_TOKEN}` or `--token "$TOKEN"` names a variable instead of
// holding a credential. Hiding it leaves the operator unable to see what was
// written. A bare `$name` counts only in the uppercase environment shape, so a
// literal secret that happens to start with `$` still redacts.
const ENV_REFERENCE_RE = /^["']?\$(?:[A-Z_][A-Z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})["']?$/u;

function redactUnlessEnvReference(match: string, prefix: string, secret: string, suffix = ""): string {
	return ENV_REFERENCE_RE.test(secret) ? match : `${prefix}[redacted]${suffix}`;
}
// `auth` stops short of `author` and `authority`, so prose such as "operator-authority ask" keeps its next word.
const SECRET_FLAG_NAME_RE =
	/(?=(api[-_]?key|access[-_]?token|auth(?:orization)?(?!or)|credential|password|secret|token))/giu;

function secretFlagStart(word: string): number | null {
	// Plain prose words cannot name a shell flag; streaming cards revisit them often (#428).
	if (!word.includes("-")) return null;
	const lastUnderscore = word.lastIndexOf("_");
	const previousUnderscore = lastUnderscore <= 0 ? -1 : word.lastIndexOf("_", lastUnderscore - 1);
	const suffixDash = word.indexOf("-", lastUnderscore + 1);
	const spanningDash = word.indexOf("-", previousUnderscore + 1);
	for (const match of word.matchAll(SECRET_FLAG_NAME_RE)) {
		const end = match.index + (match[1]?.length ?? 0);
		if (end <= lastUnderscore) continue;
		const dash = match.index <= lastUnderscore ? spanningDash : suffixDash;
		if (dash >= 0 && dash < match.index) return dash;
	}
	return null;
}

function redactSecretFlags(value: string): string {
	// Consume each word once so repeated --token suffixes cannot restart a failing flag match.
	const words = /[a-z0-9_-]+/giu;
	const whitespace = /\s+/uy;
	const argument = /[^\s;&|]+/uy;
	const out: string[] = [];
	let copied = 0;
	for (let word = words.exec(value); word !== null; word = words.exec(value)) {
		const end = words.lastIndex;
		let valueStart = end;
		if (value[end] === "=") valueStart += 1;
		else {
			whitespace.lastIndex = end;
			if (whitespace.exec(value) === null) continue;
			valueStart = whitespace.lastIndex;
		}
		if (secretFlagStart(word[0]) === null) continue;
		argument.lastIndex = valueStart;
		if (argument.exec(value) === null) continue;
		if (ENV_REFERENCE_RE.test(value.slice(valueStart, argument.lastIndex))) continue;
		out.push(value.slice(copied, valueStart), "[redacted]");
		copied = argument.lastIndex;
		words.lastIndex = copied;
	}
	out.push(value.slice(copied));
	return out.join("");
}

/** Scrub credentials embedded in one string: URL userinfo, query params, `KEY=value`, and `--flag value`. */
export function redactSecretString(value: string): string {
	return redactSecretFlags(
		value
			.replace(SECRET_STRING_RE, (match, prefix: string, secret: string) =>
				redactUnlessEnvReference(match, prefix, secret, "@"),
			)
			.replace(SECRET_URL_PARAM_RE, (match, prefix: string, secret: string) =>
				redactUnlessEnvReference(match, prefix, secret),
			)
			.replace(SECRET_ASSIGNMENT_RE, (match, prefix: string, secret: string) =>
				redactUnlessEnvReference(match, prefix, secret),
			),
	);
}

// A hold ends only where SECRET_STRING_RE's userinfo run ends. A friendlier stop such as `)`, `,` or a quote sits inside
// that run, so `https://u:pa)ss@h` would show `pa)` before the pattern could ever match it (#446).
function endsUserinfoRun(code: number): boolean {
	if (code === 0x2f || code === 0x40) return true;
	if (code > 0x20 && code < 0x7f) return false;
	return /\s/u.test(String.fromCharCode(code));
}

const URL_SCHEME_END_RE = /https?:\/\/$/iu;
const LONGEST_URL_SCHEME = "https://".length;
const USERINFO_HOLD_LIMIT = 2048;
const USERINFO_HOLD_MARKER = "[held]";

/**
 * The part of text still being written that is safe to show when its last run may become URL userinfo. Everything
 * through the run's first colon appears in every completion, because the pattern's prefix always contains it; a later
 * colon does not, since `https://u:pw:@h` redacts `pw:`. No length or timeout ever shows held text: past the limit the
 * frame only gains a marker, so a run that never ends cannot reveal what it holds.
 */
export function holdUnresolvedUserinfo(value: string): string {
	let runStart = value.length;
	while (runStart > 0 && !endsUserinfoRun(value.charCodeAt(runStart - 1))) runStart -= 1;
	if (!URL_SCHEME_END_RE.test(value.slice(Math.max(0, runStart - LONGEST_URL_SCHEME), runStart))) return value;
	const colon = value.indexOf(":", runStart);
	if (colon < 0 || colon === value.length - 1) return value;
	return `${value.slice(0, colon + 1)}${value.length - colon - 1 > USERINFO_HOLD_LIMIT ? USERINFO_HOLD_MARKER : ""}`;
}

/** Redact text that may still grow; once it is complete, `final` releases any hold through full redaction. */
export function redactStreamingSecretString(value: string, final = false): string {
	return redactSecretString(final ? value : holdUnresolvedUserinfo(value));
}

/** A partial structured value, such as forming tool arguments, any string of which may stop inside a URL. */
export function holdUnresolvedStrings(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return holdUnresolvedUserinfo(value);
	if (depth > 8) return USERINFO_HOLD_MARKER;
	if (Array.isArray(value)) return value.map((item) => holdUnresolvedStrings(item, depth + 1));
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = holdUnresolvedStrings(item, depth + 1);
	return out;
}

/** Keep completed tokens while an appended display string changes only its tail (#428). */
export class RedactedStringProjection {
	private source = "";
	private final = false;
	private committed = 0;
	private prefix = "";
	private text = "";

	project(source: string, final = false): string {
		if (source === this.source && final === this.final) return this.text;
		if (!source.startsWith(this.source)) {
			this.committed = 0;
			this.prefix = "";
		}
		const tail = source.slice(this.committed);
		let through = 0;
		// Whitespace after a non-flag token closes every credential pattern. A flag
		// can consume the following token, so keep it buffered with its value (#428).
		const tokens = /\S+\s+/gu;
		for (const match of tail.matchAll(tokens)) {
			if (!match[0].includes("-")) through = match.index + match[0].length;
		}
		if (through > 0) {
			this.prefix += redactSecretString(tail.slice(0, through));
			this.committed += through;
		}
		// A committed token ends in whitespace, so the open run a hold reads is always in this uncommitted tail (#446).
		this.text = this.prefix + redactStreamingSecretString(tail.slice(through), final);
		this.source = source;
		this.final = final;
		return this.text;
	}
}

/** Whether an argument key names a secret outright, so its value never renders. */
export function isSecretArgKey(key: string): boolean {
	return SECRET_KEY_RE.test(key);
}

/** Whether an argument key names an environment block, whose every string value is a candidate secret. */
function isEnvironmentArgKey(key: string): boolean {
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
