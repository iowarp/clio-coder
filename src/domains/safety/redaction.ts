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
// A `"` ends a JSON or call string when structure follows it, so `{"a":"http://h:80","b":"me@corp.com"}` stays whole. Any other
// `"` can sit inside a password, as in `https://u:a"b@h`, so it stays in the run (#446).
const CONTINUING_QUOTE = String.raw`"(?=[^,:;}\])>\\\s])`;
// The bound on quotes is what keeps the regex stack shallow: an open `*` threw a RangeError on 8 million of them.
const stringRun = (chars: string): string => `${chars}*(?:${CONTINUING_QUOTE}${chars}*){0,64}`;
const PASSWORD_RUN = stringRun(String.raw`[^\s/"]`);
// Any scheme can carry a password, as `postgres://`, `redis://`, `mongodb+srv://` and `ssh://` do, and matching from `://`
// back one character needs no scan of a long word. The name stops at its first colon and the password runs to the
// authority's last `@`, so `https://:pw@h`, `u:pa:ss@h`, `u:p@ss@h` and `me@corp.com:pw@h` hide the whole password. A `[` opens
// an IPv6 host or an earlier pass's marker, never a name. An authority with no `@` can still hold one past a `/` when what
// follows its colon cannot be a port, as in `u:p/ss@h`. Only that reach needs a bound, which keeps the scan linear. A name
// holding an `@` has no such reach, since `ssh://git@host:org/repo@v1` is a path (#446).
const SECRET_STRING_RE = new RegExp(
	String.raw`(?<=[a-z0-9+.-])(:\/\/${stringRun(String.raw`[^\s/:["]`)}:)(${PASSWORD_RUN}|(?!\d*\/)(?<!@[^/:]*:)${PASSWORD_RUN}\/(?:[^\s"]|${CONTINUING_QUOTE}){0,256})@`,
	"giu",
);
// A token can be the whole username, as in `https://<token>@github.com`. `alice` and `first.last` are ordinary names, while
// a long opaque run holding a digit is not one worth keeping. A known git host token also counts ahead of a colon, where a
// long opaque name would more often be a host and its port (#446).
const GIT_TOKEN_PREFIX = "(?:gh[pousr]_|github_pat_|glpat-)";
export const URL_USERNAME_TOKEN_RE = new RegExp(
	`(?<=:\\/\\/)(?:(?=[a-z0-9_-]*\\d)[a-z0-9_-]{20,}(?=@)|${GIT_TOKEN_PREFIX}[a-z0-9_-]{8,}(?=:[^\\s/@]*@))`,
	"giu",
);
const GIT_TOKEN_NAME_RE = new RegExp(`^${GIT_TOKEN_PREFIX}`, "iu");
// The whole name decides, so `author`, `tokens`, `authenticated` and `credentials` keep their values while `db_password` and
// `oauth_token` lose theirs. A qualifier ahead of the word has to end at a separator or be a known glued one. `auth` alone can
// be qualified into a setting, as `no_auth=1` is, so it stands only by itself (#446).
const SECRET_URL_PARAM_NAME_RE =
	/(?:^|[-_.])(?:authorization|credential|pass(?:word|wd|phrase)?|pwd|secret|token|(?:access|api|auth|private|secret)[-_]?key|(?:access|auth|oauth|refresh|id|session)token|clientsecret|dbpassword)$|^o?auth$/u;
// A delimiter opens a name, `://` opens a URL, and whitespace or a `"` closes one. `;` divides parameters only inside a URL, as
// in `jdbc:sqlserver://db:1433;user=sa;password=x;`, since code such as `a=1;token=next()` is full of them. Names stop at every
// delimiter, so runs are disjoint and each name is read once: `&token` repeated took 8 s at 320 KB when each walked to the `=`.
const URL_PARAM_SCAN_RE = /\s+|:\/\/|"|[?&;]([^?&;=\s:"]*)/gu;
const SECRET_URL_PARAM_VALUE_RE = new RegExp(`"?${stringRun(String.raw`[^&#\s"]`)}`, "uy");
const SECRET_URL_SEMICOLON_VALUE_RE = new RegExp(`"?${stringRun(String.raw`[^;\s"]`)}`, "uy");
// A name's run must reach the `=`, so only the run's start can match and the secret word need only be found once. Two
// stars around the word retried at every occurrence: `api_key_` repeated took 9 s at 320 KB, on a path a frame can wait on.
const SECRET_ASSIGNMENT_RE =
	/(?<![A-Z0-9_])(?=[A-Z0-9_]*?(?:ACCESS|API|AUTH|CREDENTIAL|KEY|PASS|PRIVATE|SECRET|TOKEN))([A-Z0-9_]*=)([^\s;&|]+)/giu;
// `:_authToken=${NPM_TOKEN}` or `--token "$TOKEN"` names a variable instead of
// holding a credential. Hiding it leaves the operator unable to see what was
// written. A bare `$name` counts only in the uppercase environment shape, so a
// literal secret that happens to start with `$` still redacts.
const ENV_REFERENCE_RE = /^["']?\$(?:[A-Z_][A-Z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})["']?$/u;

/** Whether a whole value names a variable rather than holding a credential. */
export function isEnvReference(value: string): boolean {
	return ENV_REFERENCE_RE.test(value);
}

/** Groups 1 and 2 of {@link URL_USERINFO_RE} hold the part one-shot redaction shows and the part it hides. */
export const URL_USERINFO_RE = SECRET_STRING_RE;

// Text passes both redactors, and again on a re-export, where promotion and handoff mask earlier markers as private-use
// tokens. Only a password that is entirely one marker is exempt, so `https://u:REAL[redacted:abc]@h` is still rewritten.
const REDACTED_USERINFO_RE = /^(?:\[redacted(?::[a-z-]+)?\]|\uE000[\uE100-\uF8FF])$/u;

/** Whether a {@link URL_USERINFO_RE} match holds a credential, not a variable's name or an earlier pass's marker (#446). */
export function urlUserinfoHoldsSecret(secret: string): boolean {
	return !ENV_REFERENCE_RE.test(secret) && !REDACTED_USERINFO_RE.test(secret);
}

function redactUnlessEnvReference(match: string, prefix: string, secret: string): string {
	return ENV_REFERENCE_RE.test(secret) ? match : `${prefix}[redacted]`;
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

function isSecretUrlParamName(name: string): boolean {
	return SECRET_URL_PARAM_NAME_RE.test(name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase());
}

/** The value spans of `?token=value` and of `;password=value` inside a URL. */
export function secretUrlParamValues(value: string): Array<{ start: number; end: number }> {
	const found: Array<{ start: number; end: number }> = [];
	if (!value.includes("=")) return found;
	const scan = new RegExp(URL_PARAM_SCAN_RE);
	const secrets = new RegExp(SECRET_URL_PARAM_VALUE_RE);
	const semicolonSecrets = new RegExp(SECRET_URL_SEMICOLON_VALUE_RE);
	let inUrl = false;
	for (let match = scan.exec(value); match !== null; match = scan.exec(value)) {
		const name = match[1];
		if (name === undefined) {
			inUrl = match[0] === "://";
			continue;
		}
		const semicolon = match[0].startsWith(";");
		if (value[scan.lastIndex] !== "=" || (semicolon && !inUrl) || !isSecretUrlParamName(name)) continue;
		const start = scan.lastIndex + 1;
		const secret = semicolon ? semicolonSecrets : secrets;
		secret.lastIndex = start;
		if (!secret.exec(value)?.[0]) continue;
		scan.lastIndex = secret.lastIndex;
		if (ENV_REFERENCE_RE.test(value.slice(start, secret.lastIndex))) continue;
		found.push({ start, end: secret.lastIndex });
	}
	return found;
}

function redactSecretUrlParams(value: string): string {
	const out: string[] = [];
	let copied = 0;
	for (const { start, end } of secretUrlParamValues(value)) {
		out.push(value.slice(copied, start), "[redacted]");
		copied = end;
	}
	out.push(value.slice(copied));
	return out.join("");
}

// Groups 1 and 2 are a string sequence's introducer and payload (OSC, DCS, SOS, PM, APC), which can carry any text. An
// escape a row cut short still ends the string it opened.
const ESCAPE_SEQUENCE_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this pattern exists to match terminal escapes
	/\u001b(?:\[[0-?]*[ -/]*(?:[@-~]|$)|([\]P^_X])([^\u0007\u001b]*)(?:\u0007|\u001b\\|$)|[ -/]*[0-~]?)/gu;

/**
 * Patterns read escapes as secret text: `--token ESC[0mESC[38;2;1;2;3m` loses the sequence's head and shows `;2;1;2;3m`,
 * which crashed the TUI's width check, while a value styled `ESC[38;2;1;2;3mSECRET` ended at the `;` and leaked. So the
 * patterns read the visible text, and every sequence survives whole. Those inside a replaced span follow its marker, in
 * order, so the style after it is unchanged.
 */
function redactStyledString(value: string): string {
	const escapes: Array<{ at: number; sequence: string }> = [];
	let plain = "";
	let copied = 0;
	for (const match of value.matchAll(ESCAPE_SEQUENCE_RE)) {
		plain += value.slice(copied, match.index);
		copied = match.index + match[0].length;
		const introducer = match[1];
		const payload = match[2];
		let sequence = match[0];
		if (introducer !== undefined && payload !== undefined) {
			// A visible name can lead into a value held here, and the patterns reading the visible text never see it.
			const shown = headGuardAfter(plain) === null ? redactPlainSecretString(payload) : "[redacted]";
			sequence = `\u001b${introducer}${shown}${match[0].slice(payload.length + 2)}`;
		}
		escapes.push({ at: plain.length, sequence });
	}
	plain += value.slice(copied);
	const redacted = redactPlainSecretString(plain);
	const shorter = Math.min(plain.length, redacted.length);
	let head = 0;
	while (head < shorter && plain[head] === redacted[head]) head += 1;
	let tail = 0;
	while (tail < shorter - head && plain[plain.length - 1 - tail] === redacted[redacted.length - 1 - tail]) tail += 1;
	const marker = redacted.slice(head, redacted.length - tail);
	const out: string[] = [];
	let cursor = 0;
	let placed = false;
	for (const { at, sequence } of escapes) {
		if (!placed && at >= head) {
			out.push(plain.slice(cursor, head), marker);
			cursor = plain.length - tail;
			placed = true;
		}
		if (at > cursor) {
			out.push(plain.slice(cursor, at));
			cursor = at;
		}
		out.push(sequence);
	}
	if (!placed) {
		out.push(plain.slice(cursor, head), marker);
		cursor = plain.length - tail;
	}
	out.push(plain.slice(cursor));
	return out.join("");
}

/** Scrub credentials embedded in one string: URL userinfo, query params, `KEY=value`, and `--flag value`. */
export function redactSecretString(value: string): string {
	return value.includes("\u001b") ? redactStyledString(value) : redactPlainSecretString(value);
}

/**
 * URL credentials alone: userinfo, username tokens and query parameters. This is the rule for prose a person reads or a
 * script consumes, where `BASE_TOKENS=100` or "pass --token to it" are ordinary text the wider rule would blank (#446).
 */
export function redactUrlCredentials(value: string): string {
	return redactSecretUrlParams(
		value
			.replace(SECRET_STRING_RE, (match, prefix: string, secret: string) =>
				urlUserinfoHoldsSecret(secret) ? `${prefix}[redacted]@` : match,
			)
			.replace(URL_USERNAME_TOKEN_RE, "[redacted]"),
	);
}

function redactPlainSecretString(value: string): string {
	return redactSecretFlags(
		redactUrlCredentials(value).replace(SECRET_ASSIGNMENT_RE, (match, prefix: string, secret: string) =>
			redactUnlessEnvReference(match, prefix, secret),
		),
	);
}

const SCHEME_CHAR_RE = /[a-z0-9+.-]/iu;
const USERINFO_HOLD_LIMIT = 2048;
const USERINFO_HOLD_MARKER = "[held]";

/**
 * How much of the URL whose authority starts at `start` is safe to show, or null when it cannot hold a password. Everything
 * through the first colon appears in every completion, because the pattern's prefix ends there, and so does everything
 * through a later `@`, which the pattern replaces. What follows that `@` stays back, since `https://u:p@ss@h` makes it
 * password. A numeric port followed by `/` ends the question, which is why `http://h:8080/x` never waits. A known git host
 * token stays back whole, while any other opaque name cannot, since it looks like a host until its `@`.
 */
function shownUserinfoEnd(value: string, start: number, lastAt: number): number | null {
	const slash = value.indexOf("/", start);
	const end = slash < 0 ? value.length : slash;
	const authority = value.slice(start, end);
	const firstAt = authority.indexOf("@");
	if (slash < 0 && GIT_TOKEN_NAME_RE.test(authority)) return firstAt >= 0 ? lastAt + 1 : start;
	const colon = authority.indexOf(":");
	if (colon < 0 || authority.lastIndexOf("[", colon) >= 0) return null;
	if (authority.indexOf("@", colon) >= 0) return slash < 0 ? lastAt + 1 : null;
	if (slash >= 0 && (firstAt >= 0 || /^\d*$/u.test(authority.slice(colon + 1)))) return null;
	return lastAt > end ? lastAt + 1 : start + colon + 1;
}

/** The last `"` in the token that closed a string. No URL ahead of it can still grow, whatever follows (#446). */
function lastClosingQuote(value: string, tokenStart: number): number {
	for (
		let quote = value.lastIndexOf('"');
		quote >= tokenStart && quote >= 0;
		quote = value.lastIndexOf('"', quote - 1)
	) {
		if (quote + 1 < value.length && /[,:;}\])>\\]/u.test(value.charAt(quote + 1))) return quote;
		if (quote === 0) break;
	}
	return -1;
}

/**
 * The part of text still being written that is safe to show when its last token may hold URL userinfo. A hold ends only at
 * whitespace or end of text, at the `/` after a numeric port, or at a `"` closing a string. A friendlier stop such as `)` or
 * `,` sits inside what the pattern matches, so `https://u:pa)ss@h` would show `pa)` before it could ever match. No length or timeout ever
 * shows held text: past the limit the frame only gains a marker, so a run that never ends cannot reveal what it holds.
 */
export function holdUnresolvedUserinfo(value: string): string {
	let tokenStart = value.length;
	while (tokenStart > 0 && !/\s/u.test(value.charAt(tokenStart - 1))) tokenStart -= 1;
	// One scan for every URL in the token: a token of 80,000 of them took 9.5 s per frame when each looked for itself.
	const lastAt = value.lastIndexOf("@");
	const from = Math.max(tokenStart, lastClosingQuote(value, tokenStart)) + 1;
	for (let at = value.indexOf("://", from); at >= 0; at = value.indexOf("://", at + 3)) {
		if (!SCHEME_CHAR_RE.test(value.charAt(at - 1))) continue;
		const keep = shownUserinfoEnd(value, at + 3, lastAt);
		if (keep === null) continue;
		if (keep === value.length) return value;
		return `${value.slice(0, keep)}${value.length - keep > USERINFO_HOLD_LIMIT ? USERINFO_HOLD_MARKER : ""}`;
	}
	return value;
}

/**
 * Tokens still to discard after a text lost its head. Patterns recognize a secret by what precedes it, so whatever a cut
 * leaves of a token goes, and so does the next token, which that piece may have named. A discarded token that names a secret
 * takes the following token too, or the discard could stop between `password:` and its value. It is state rather than a
 * one-off strip because the unsafe token can continue in text not yet seen (#446).
 */
export interface CutHeadGuard {
	tokens: number;
	inToken: boolean;
	/** The end of the token being discarded, enough to tell whether it names a secret. */
	token: string;
}

// `https://u`, which goes on to hold a secret.
const OPEN_URL_END_RE = new RegExp(String.raw`:\/\/${stringRun(String.raw`[^\s/"]`)}"?$`, "iu");

/** Whether a cut at the end of this text would leave a piece of a credential on each side, neither of which matches (#446). */
export function endsInOpenCredential(text: string): boolean {
	if (OPEN_URL_END_RE.test(text)) return true;
	// One more character shows whether a value is open here, even an empty one or a variable's name so far.
	return secretUrlParamValues(`${text}x`).at(-1)?.end === text.length + 1;
}

const OPEN_NAME_CHARS = 64;
const OPEN_NAME_END_RE = new RegExp(String.raw`[a-z0-9_+.-]{0,${OPEN_NAME_CHARS}}["']?(?:=|:\/?)$`, "iu");

/**
 * Where a name ending this text starts: `"key":`, `password=`, `https:` or `https:/`. Every word of compact JSON and minified
 * code can end this way, and what follows may be that name's value, so the two have to reach one row together (#446).
 */
export function openNameStart(text: string): number | null {
	const from = Math.max(0, text.length - OPEN_NAME_CHARS - 3);
	const match = OPEN_NAME_END_RE.exec(text.slice(from));
	return match === null ? null : from + match.index;
}

const CUT_TOKENS = 2;
const NAME_TAIL_CHARS = 64;
// A JSON or shell value opens with its quote, so `"Bearer` and `'Basic` lead into a secret as `Bearer` does (#446).
const SECRET_LEAD_IN_RE = /^["'`]?(?:[:=]+|bearer|basic)$|passwd/iu;

export function cutHeadGuard(): CutHeadGuard {
	return { tokens: CUT_TOKENS, inToken: true, token: "" };
}

/** Whether a whole token leads into a secret. Prose such as `well-known` does not, so it cannot extend a discard. */
export function namesSecret(token: string): boolean {
	let start = token.length;
	while (start > 0 && /[a-z0-9_-]/iu.test(token.charAt(start - 1))) start -= 1;
	return secretFlagStart(token.slice(start)) !== null || SECRET_KEY_RE.test(token) || SECRET_LEAD_IN_RE.test(token);
}

/** A guard for text following a whole-line cut, needed only when the removed text ends in a name awaiting its secret. */
export function headGuardAfter(removed: string): CutHeadGuard | null {
	const tail = removed.trimEnd().slice(-NAME_TAIL_CHARS);
	return namesSecret(tail.slice(tail.search(/\S+$/u))) ? { tokens: 1, inToken: false, token: "" } : null;
}

const TOKEN_RE = /\S*/uy;
const SPACE_RE = /\s*/uy;

/** Discard what the guard still covers from the front of `text`, advancing the guard. */
export function dropCutHead(text: string, guard: CutHeadGuard): string {
	let at = 0;
	while (guard.tokens > 0 && at < text.length) {
		const start = at;
		const scan = guard.inToken ? TOKEN_RE : SPACE_RE;
		scan.lastIndex = at;
		scan.exec(text);
		at = scan.lastIndex;
		if (guard.inToken)
			guard.token = `${guard.token}${text.slice(start, at).slice(-NAME_TAIL_CHARS)}`.slice(-NAME_TAIL_CHARS);
		if (at === text.length) break;
		if (guard.inToken) {
			// The next token is already covered for the cut token, whatever piece of a name it holds.
			if (guard.tokens === CUT_TOKENS || !namesSecret(guard.token)) guard.tokens -= 1;
			guard.token = "";
		}
		guard.inToken = !guard.inToken;
	}
	if (guard.tokens > 0) return "";
	SPACE_RE.lastIndex = at;
	SPACE_RE.exec(text);
	return text.slice(SPACE_RE.lastIndex);
}

/** The most a settled cut trims. A longer token is implausible as a credential, and it is routine minified output (#446). */
export const CUT_TRIM_LIMIT_CHARS = 512;

/**
 * {@link dropCutHead} for output a reader needs: the trim stops at {@link CUT_TRIM_LIMIT_CHARS}, so a long token keeps the
 * plain cut's bytes, and it never leaves nothing. That token can hold a URL the cut has stripped (#446).
 */
export function dropShortCutHead(text: string, guard: CutHeadGuard): string {
	const window = text.slice(0, CUT_TRIM_LIMIT_CHARS);
	const kept = dropCutHead(window, guard);
	// When the window runs out the discard stops after the cut token, so a key is never gone with its value still here.
	const afterCutToken = /^\S*\s+/u.exec(window);
	const trimmed =
		guard.tokens === 0
			? text.slice(window.length - kept.length)
			: afterCutToken === null
				? text
				: text.slice(afterCutToken[0].length);
	return trimmed.length === 0 ? text : trimmed;
}

/**
 * Redact text that may still grow. Only a stream that completed releases a hold through full redaction: after an abort or
 * an error no later text can resolve it, so the last frame reads like the open one (#446).
 */
export function redactStreamingSecretString(value: string, completed = false): string {
	return redactSecretString(completed ? value : holdUnresolvedUserinfo(value));
}

/** {@link redactStreamingSecretString} under the URL rule alone, for model prose an operator reads (#446). */
export function redactStreamingUrlCredentials(value: string, completed = false): string {
	return redactUrlCredentials(completed ? value : holdUnresolvedUserinfo(value));
}

/**
 * Whether a model message's stop reason means its text ended where the model meant it to. `length`, `error`, `aborted` and
 * anything unrecognized or absent, as a legacy ledger row can be, may have stopped inside a URL (#446).
 */
export function messageStopCompleted(stopReason: unknown): boolean {
	return stopReason === "stop" || stopReason === "toolUse";
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

// The username token's shape at the very end of a stream that stopped. No `@` will come, and a frame's hold reads it as a host (#446).
const CUT_OFF_USERNAME_TOKEN_RE = /(?<=:\/\/)(?=[a-z0-9_-]*\d)[a-z0-9_-]{20,}(?=:?$)/iu;

/**
 * What a text that stopped short may still show. An open frame keeps an opaque name, which reads as a host until an `@` comes,
 * but at the last frame no `@` will come and a name of a token's shape stays hidden (#446).
 */
export function holdCutOffText(value: string): string {
	return holdUnresolvedUserinfo(value).replace(CUT_OFF_USERNAME_TOKEN_RE, "");
}

/** URL credentials for the last text of a stream, which is whole only when the stream completed. */
export function redactFinalUrlCredentials(value: string, completed: boolean): string {
	return redactUrlCredentials(completed ? value : holdCutOffText(value));
}

/** Where text that a reader cannot retract becomes unsafe to send: from anything in its last token a later character could make a credential. */
function appendOnlySafeEnd(text: string): number {
	let tokenStart = text.length;
	while (tokenStart > 0 && !/\s/u.test(text.charAt(tokenStart - 1))) tokenStart -= 1;
	const unsafe = text.slice(tokenStart).search(/:\/\/|[?&]|:\/?$/u);
	return unsafe < 0 ? text.length : tokenStart + unsafe;
}

/**
 * URL credentials for text sent as increments, where a reader only appends and nothing shown can be rewritten. A frame's hold
 * cannot serve here, since `https://abc` shows before an `@` makes it a token. Prose passes at once, including text with no
 * spaces, and a token holding a URL or a query waits from there for its whitespace. What it sends joins to the one-shot
 * output (#446).
 */
export class UrlCredentialStreamFilter {
	private pending = "";
	/** The last character sent, which is all the pattern reads ahead of a `://`. */
	private context = "";
	/**
	 * What waits opens with a `://` or a query, so only whitespace ends the wait and only new text can hold it. Scanning the
	 * whole token per delta took 25.7 s on a 200 KB token in 8-character deltas, blocking the loop (#446).
	 */
	private waiting = false;

	private send(text: string, redact: (value: string) => string): string {
		const safe = redact(this.context + text).slice(this.context.length);
		if (text.length > 0) this.context = text.slice(-1);
		return safe;
	}

	push(delta: string): string {
		this.pending += delta;
		if (this.waiting && !/\s/u.test(delta)) return "";
		const end = appendOnlySafeEnd(this.pending);
		const safe = end === 0 ? "" : this.send(this.pending.slice(0, end), redactUrlCredentials);
		this.pending = this.pending.slice(end);
		this.waiting = /^(?::\/\/|[?&])/u.test(this.pending);
		return safe;
	}

	/** Send what is left. Only a stream that completed releases a hold. */
	end(completed: boolean): string {
		const rest = this.pending;
		this.pending = "";
		this.waiting = false;
		return this.send(rest, (value) => redactFinalUrlCredentials(value, completed));
	}
}

/** Keep completed tokens while an appended display string changes only its tail (#428). */
export class RedactedStringProjection {
	private source = "";
	private completed = false;
	private committed = 0;
	private prefix = "";
	private text = "";

	constructor(private readonly redact: (value: string) => string = redactSecretString) {}

	project(source: string, completed = false): string {
		if (source === this.source && completed === this.completed) return this.text;
		if (!source.startsWith(this.source)) {
			this.committed = 0;
			this.prefix = "";
		}
		const tail = source.slice(this.committed);
		let through = 0;
		// Whitespace after a non-flag token closes every credential pattern. A flag
		// can consume the following token, so keep it buffered with its value (#428).
		// Only a token's start can match: retrying inside a long token cost 1.6 s per frame at 64 KB.
		const tokens = /(?<!\S)\S+\s+/gu;
		for (const match of tail.matchAll(tokens)) {
			if (!match[0].includes("-")) through = match.index + match[0].length;
		}
		if (through > 0) {
			this.prefix += this.redact(tail.slice(0, through));
			this.committed += through;
		}
		// A committed token ends in whitespace, so the open run a hold reads is always in this uncommitted tail (#446).
		const open = tail.slice(through);
		this.text = this.prefix + this.redact(completed ? open : holdUnresolvedUserinfo(open));
		this.source = source;
		this.completed = completed;
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
