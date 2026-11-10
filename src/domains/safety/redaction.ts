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
// What opens an authority: `://`, its JSON-escaped form `:\/\/`, or a scheme-relative `//` that starts a word. A `//` inside a
// word, as in `a//b` or `@//db`, is a path (#448).
const AUTHORITY_OPENER = String.raw`(?:(?<=[a-z0-9+.-]):|(?<![^\s"'(<=,{>]))(?:\/\/|\\\/\\\/)`;
// Any scheme can carry a password, as `postgres://`, `redis://`, `mongodb+srv://` and `ssh://` do, and matching from `://`
// back one character needs no scan of a long word. The name stops at its first colon and the password runs to the
// authority's last `@`, so `https://:pw@h`, `u:pa:ss@h`, `u:p@ss@h` and `me@corp.com:pw@h` hide the whole password. A `[` opens
// an IPv6 host or an earlier pass's marker, never a name. An authority with no `@` can still hold one past a `/` when what
// follows its colon cannot be a port, as in `u:p/ss@h`. Only that reach needs a bound, which keeps the scan linear. A name
// holding an `@` has no such reach, since `ssh://git@host:org/repo@v1` is a path (#446). A port followed by `;` opens
// parameters, as in `jdbc:sqlserver://db:1433;password=hun@ter;`, where the `@` belongs to the parameter's value (#448).
// The match ends at the password, so a caller replaces group 2 and every terminator stays.
const SECRET_STRING_RE = new RegExp(
	String.raw`(${AUTHORITY_OPENER}${stringRun(String.raw`[^\s/:["]`)}:)(?!\d+;)(${PASSWORD_RUN}|(?!\d*\\?\/)(?<!@[^/:]*:)${PASSWORD_RUN}\/(?:[^\s"]|${CONTINUING_QUOTE}){0,256})(?=@)`,
	"giu",
);
// A URL percent-encoded into a query value, as `redirect=https%3A%2F%2Falice%3Apw%40h` carries one. Its delimiters are escapes,
// so the name stops at the first `%3A` and the password runs to the authority's last `%40`. Neither crosses a `%2F` or a
// literal `&`, which ends the value holding the URL, so each opener's scan stops at the next one's `%2F` (#448).
const PERCENT_NAME_RUN = String.raw`(?:[^\s%&"]|%(?!3a|2f)[0-9a-f]{2})*`;
const PERCENT_PASSWORD_RUN = String.raw`(?:[^\s%&"]|%(?!2f)[0-9a-f]{2})*`;
const PERCENT_USERINFO_RE = new RegExp(
	`(?<=[a-z0-9+.-])(%3a%2f%2f${PERCENT_NAME_RUN}%3a)(${PERCENT_PASSWORD_RUN})(?=%40)`,
	"giu",
);
// Oracle's JDBC form puts `user/password` ahead of the `@` with no `//`, as in `jdbc:oracle:thin:scott/tiger@//db:1521/svc`.
// A password holding `@` or `/` has to be quoted there, so an unquoted one ends at the first `@` (#448).
const JDBC_ORACLE_PREFIX = String.raw`jdbc:oracle:[a-z0-9]+:[^\s/@:"]*\/`;
const JDBC_ORACLE_USERINFO_RE = new RegExp(String.raw`(${JDBC_ORACLE_PREFIX})("[^"\s]*"|[^\s"/@]*)(?=@)`, "giu");
// A token can be the whole username, as in `https://<token>@github.com`. `alice` and `first.last` are ordinary names, while
// a long opaque run holding a digit is not one worth keeping. A known git host token also counts ahead of a colon, where a
// long opaque name would more often be a host and its port (#446). Every opener the userinfo pattern reads opens one, and a
// percent-encoded URL ends it at `%40` (#448).
const GIT_TOKEN_PREFIX = "(?:gh[pousr]_|github_pat_|glpat-)";
const OPAQUE_NAME = String.raw`(?=[a-z0-9_-]*\d)[a-z0-9_-]{20,}`;
const PERCENT_OPENER_BEHIND = "(?<=[a-z0-9+.-]%3a%2f%2f)";
export const URL_USERNAME_TOKEN_RE = new RegExp(
	String.raw`(?<=${AUTHORITY_OPENER})(?:${OPAQUE_NAME}(?=@)|${GIT_TOKEN_PREFIX}[a-z0-9_-]{8,}(?=:[^\s/@]*@))` +
		`|${PERCENT_OPENER_BEHIND}(?:${OPAQUE_NAME}(?=%40)|${GIT_TOKEN_PREFIX}[a-z0-9_-]{8,}(?=%3a${PERCENT_PASSWORD_RUN}%40))`,
	"giu",
);
const GIT_TOKEN_NAME_RE = new RegExp(`^${GIT_TOKEN_PREFIX}`, "iu");
// A secret word has to be a whole word of the name, so `author`, `tokens`, `authenticated` and `credentials` keep their values
// while `db_password`, `password_confirmation`, `token[]` and `pageToken` lose theirs. A glued qualifier counts only when it is a
// known one. `auth` alone can be qualified into a setting, as `no_auth=1` is, so it stands only by itself (#446).
const SECRET_URL_PARAM_NAME_RE =
	/(?:^|_)(?:authorization|credential|pass(?:word|wd|phrase)?|pwd|secret|token|(?:access|api|auth|private|secret)_?key|(?:access|auth|oauth|refresh|id|session)token|clientsecret|(?:db|ssl)pass(?:word)?)(?:_|$)|^o?auth$/u;
const URL_PARAM_WORD_BREAK_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/gu;
const URL_PARAM_WORD_SEPARATOR_RE = /[-_.[\]\d]+/u;
// A delimiter opens a name, `//` or its JSON-escaped form opens a URL, and whitespace or a `"` closes one. `;` divides
// parameters only inside a URL, as in `jdbc:sqlserver://db:1433;user=sa;password=x;`, since code such as `a=1;token=next()` is
// full of them. `#` opens a fragment, which an OAuth implicit grant fills with `#access_token=`, and like `?` it counts
// anywhere, so a row that a bound starts at the `#` still reads it (#448). Names stop at every delimiter, so runs are disjoint
// and each name is read once: `&token` repeated took 8 s at 320 KB when each walked to the `=`.
const URL_PARAM_SCAN_RE = /\s+|\/\/|\\\/\\\/|"|[?&;#]([^?&;#=\s:"]*)/gu;
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

/**
 * Every shape of URL userinfo. Group 1 of each match is the part one-shot redaction shows and group 2, which ends the match,
 * is the part it hides.
 */
export const URL_USERINFO_PATTERNS: readonly RegExp[] = [
	SECRET_STRING_RE,
	PERCENT_USERINFO_RE,
	JDBC_ORACLE_USERINFO_RE,
];

// Text passes both redactors, and again on a re-export, where promotion and handoff mask earlier markers as private-use
// tokens. Only a password that is entirely one marker is exempt, so `https://u:REAL[redacted:abc]@h` is still rewritten.
const REDACTED_USERINFO_RE = /^(?:\[redacted(?::[a-z-]+)?\]|\uE000[\uE100-\uF8FF])$/u;

/** Whether a {@link URL_USERINFO_PATTERNS} match holds a credential, not a variable's name or an earlier pass's marker (#446). */
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
	const words = name.replace(URL_PARAM_WORD_BREAK_RE, "_").toLowerCase().split(URL_PARAM_WORD_SEPARATOR_RE);
	return SECRET_URL_PARAM_NAME_RE.test(words.filter((word) => word.length > 0).join("_"));
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
			inUrl = match[0] !== '"' && !/^\s/u.test(match[0]);
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
	let out = value;
	for (const pattern of URL_USERINFO_PATTERNS) {
		out = out.replace(pattern, (match, prefix: string, secret: string) =>
			urlUserinfoHoldsSecret(secret) ? `${prefix}[redacted]` : match,
		);
	}
	return redactSecretUrlParams(out.replace(URL_USERNAME_TOKEN_RE, "[redacted]"));
}

// The word-wise rules stop at whitespace, so a quoted value with spaces showed past its first word, as
// `PASSWORD="first second"` showed `second"`. A quoted value stays on one line and the bound keeps a hold on an open one
// cheap. A header keeps its scheme word. Names are whole words, as for URL parameters, so `author: "Jane Doe"` stays.
const QUOTED_SECRET_CHARS = 1024;
const QUOTED_HEADER_HEAD = String.raw`\s*([A-Za-z0-9_-]+)\s*:\s*(?:(?:bearer|basic|token)\s+)?`;
// A lead never starts inside a run of name characters and names stay bounded, so a long dash or `a-` run scans linearly.
const QUOTED_VALUE_LEAD = String.raw`(?<![A-Za-z0-9_-])--?([A-Za-z0-9_-]{1,64})(?:=|\s+)|(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})\s*[=:]\s*`;
const QUOTED_HEADER_RE = new RegExp(
	String.raw`(["'])(${QUOTED_HEADER_HEAD})((?:(?!\1).){0,${QUOTED_SECRET_CHARS}})\1`,
	"giu",
);
const QUOTED_VALUE_RE = new RegExp(
	String.raw`(${QUOTED_VALUE_LEAD})(["'])((?:(?!\4).){0,${QUOTED_SECRET_CHARS}})\4`,
	"gu",
);
const QUOTED_HEADER_LEAD_RE = new RegExp(`(["'])${QUOTED_HEADER_HEAD}`, "giu");
const QUOTED_VALUE_OPEN_RE = new RegExp(`(?:${QUOTED_VALUE_LEAD})(["'])`, "gu");
const AWAITING_QUOTED_VALUE_RE = /(?:--?([A-Za-z0-9_-]+)\s+|\b([A-Za-z0-9_.-]+)\s*[=:]\s*)$/u;
// Every secret name holds one of these, so other text skips both scans, which a whitespace-free token pays on every frame.
const QUOTED_SECRET_WORD_RE = /pass|pwd|secret|token|key|auth|credential/iu;
// `.` in the patterns above stops at these, so a quoted value never spans them.
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/u;

/** Redact whole quoted credential values: `NAME="a b"`, `--token 'a b'`, `"Authorization: Basic a b"`. */
export function redactQuotedSecrets(
	text: string,
	isSecretName: (name: string) => boolean = isSecretUrlParamName,
): string {
	if ((!text.includes('"') && !text.includes("'")) || !QUOTED_SECRET_WORD_RE.test(text)) return text;
	const headers = text.replace(QUOTED_HEADER_RE, (match, quote: string, head: string, name: string, value: string) =>
		isSecretName(name) && value.length > 0 ? `${quote}${head}[redacted]${quote}` : match,
	);
	return headers.replace(
		QUOTED_VALUE_RE,
		(match, lead: string, flag: string | undefined, key: string | undefined, quote: string, value: string) => {
			if (!isSecretName(flag ?? key ?? "") || value.length === 0 || value === "[redacted]") return match;
			return isEnvReference(`${quote}${value}${quote}`) ? match : `${lead}${quote}[redacted]${quote}`;
		},
	);
}

/**
 * The quoted secret value the end of this text leaves open: where its lead and its value start. Every match ahead of it
 * closes on its line, so the scan steps past each closing quote and stays linear.
 */
function openQuotedSecret(text: string): { lead: number; value: number } | null {
	if (!QUOTED_SECRET_WORD_RE.test(text)) return null;
	let lineStart = text.length;
	while (lineStart > 0 && !LINE_BREAK_RE.test(text.charAt(lineStart - 1))) lineStart -= 1;
	let open: { lead: number; value: number } | null = null;
	for (const lead of [QUOTED_HEADER_LEAD_RE, QUOTED_VALUE_OPEN_RE]) {
		const scan = new RegExp(lead);
		scan.lastIndex = lineStart;
		for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
			const header = lead === QUOTED_HEADER_LEAD_RE;
			const quote = (header ? match[1] : match[3]) ?? '"';
			const name = (header ? match[2] : (match[1] ?? match[2])) ?? "";
			const value = match.index + match[0].length;
			const close = text.indexOf(quote, value);
			if (close >= 0 && close - value <= QUOTED_SECRET_CHARS) {
				scan.lastIndex = close + 1;
				continue;
			}
			if (close < 0 && text.length - value <= QUOTED_SECRET_CHARS && isSecretUrlParamName(name)) {
				if (open === null || match.index < open.lead) open = { lead: match.index, value };
				break;
			}
			scan.lastIndex = match.index + 1;
		}
	}
	return open;
}

/** What a frame shows of text that may still close a quoted secret: its lead, never its value. */
function holdOpenQuotedSecret(value: string): string {
	const open = openQuotedSecret(value);
	return open === null ? value : value.slice(0, open.value);
}

/**
 * Where text must stop for a later piece to be redacted with the lead of a quoted secret: an open value, or a secret name
 * still waiting for its quote, as `password: ` does before `"a b"` arrives. Null when nothing waits.
 */
function quotedSecretLeadStart(text: string): number | null {
	const open = openQuotedSecret(text);
	const awaiting = AWAITING_QUOTED_VALUE_RE.exec(text.slice(-128));
	const waits =
		awaiting !== null && isSecretUrlParamName(awaiting[1] ?? awaiting[2] ?? "") ? text.length - awaiting[0].length : null;
	if (open === null) return waits;
	return waits === null ? open.lead : Math.min(open.lead, waits);
}

function redactPlainSecretString(value: string): string {
	return redactSecretFlags(
		redactUrlCredentials(redactQuotedSecrets(value)).replace(
			SECRET_ASSIGNMENT_RE,
			(match, prefix: string, secret: string) => redactUnlessEnvReference(match, prefix, secret),
		),
	);
}

export const SCHEME_CHAR_RE = /[a-z0-9+.-]/iu;
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
	// A JSON-escaped `\/` ends the authority as `/` does (#448).
	const end = slash < 0 ? value.length : slash > start && value.charAt(slash - 1) === "\\" ? slash - 1 : slash;
	const authority = value.slice(start, end);
	const firstAt = authority.indexOf("@");
	if (slash < 0 && GIT_TOKEN_NAME_RE.test(authority)) return firstAt >= 0 ? lastAt + 1 : start;
	const colon = authority.indexOf(":");
	if (colon < 0 || authority.lastIndexOf("[", colon) >= 0) return null;
	if (authority.indexOf("@", colon) >= 0) return slash < 0 ? lastAt + 1 : null;
	if (slash >= 0 && (firstAt >= 0 || /^\d*$/u.test(authority.slice(colon + 1)))) return null;
	return lastAt > end ? lastAt + 1 : start + colon + 1;
}

const AUTHORITY_OPENER_RE = new RegExp(AUTHORITY_OPENER, "giu");
// A percent-encoded or Oracle password that text still to come may continue, matched up to where it starts (#448). A known
// git host token stays back whole, as it does after a literal opener.
const OPEN_USERINFO_RES: readonly RegExp[] = [
	new RegExp(`(?<=[a-z0-9+.-])%3a%2f%2f${PERCENT_NAME_RUN}%3a(?=${PERCENT_PASSWORD_RUN}(?:%[0-9a-f]?)?$)`, "giu"),
	new RegExp(`(?<=[a-z0-9+.-])%3a%2f%2f(?=${GIT_TOKEN_PREFIX}${PERCENT_PASSWORD_RUN}(?:%[0-9a-f]?)?$)`, "giu"),
	new RegExp(String.raw`${JDBC_ORACLE_PREFIX}(?=(?:"[^"\s]*"?|[^\s"/@]*)$)`, "giu"),
];

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
	// `from` is one past the token's start or a closing quote, and a `//` or `jdbc:` can open the token itself.
	const scanFrom = Math.max(0, from - 1);
	let keep = value.length;
	const opener = new RegExp(AUTHORITY_OPENER_RE);
	opener.lastIndex = scanFrom;
	for (let match = opener.exec(value); match !== null; match = opener.exec(value)) {
		const shown = shownUserinfoEnd(value, match.index + match[0].length, lastAt);
		if (shown === null) continue;
		keep = shown;
		break;
	}
	// A percent-encoded or Oracle password has no literal `@` to show through, so all of it stays back until it resolves (#448).
	for (const open of OPEN_USERINFO_RES) {
		open.lastIndex = scanFrom;
		const match = open.exec(value);
		if (match !== null) keep = Math.min(keep, match.index + match[0].length);
	}
	if (keep === value.length) return value;
	return `${value.slice(0, keep)}${value.length - keep > USERINFO_HOLD_LIMIT ? USERINFO_HOLD_MARKER : ""}`;
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

// `https://u`, which goes on to hold a secret, in any of its shapes (#448).
const OPEN_URL_END_RES: readonly RegExp[] = [
	new RegExp(`${AUTHORITY_OPENER}${stringRun(String.raw`[^\s/"]`)}"?$`, "iu"),
	new RegExp(`(?<=[a-z0-9+.-])%3a%2f%2f${PERCENT_PASSWORD_RUN}(?:%[0-9a-f]?)?$`, "iu"),
	/jdbc:oracle:[^\s"@]*(?:"[^"\s]*)?$/iu,
];

/** Whether a cut at the end of this text would leave a piece of a credential on each side, neither of which matches (#446). */
export function endsInOpenCredential(text: string): boolean {
	if (OPEN_URL_END_RES.some((open) => open.test(text))) return true;
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

// Every opener a pattern reads, lowercased. A token ending in one or a piece of one, such as `https:\` or `%3A%2`, may be
// about to open a URL (#448).
const AUTHORITY_OPENER_MARKERS = ["://", ":\\/\\/", "//", "\\/\\/", "%3a%2f%2f"];
const LONGEST_OPENER = 9;

/**
 * Where the end of this text starts an authority opener or a piece of one, or -1. The earliest start wins, so the `\/` that
 * ends `:\/\/` reads as part of that opener and not as the start of another.
 */
function openerPieceStart(text: string): number {
	for (let at = Math.max(0, text.length - LONGEST_OPENER); at < text.length; at += 1) {
		const piece = text.slice(at).toLowerCase();
		if (AUTHORITY_OPENER_MARKERS.some((marker) => marker.startsWith(piece))) return at;
	}
	return -1;
}

const PERCENT_OPENER_RE = /(?<=[a-z0-9+.-])%3a%2f%2f/giu;

/** Where the first authority opener at or after `from` starts, in any shape, or -1 (#448). */
export function firstAuthorityOpener(text: string, from: number): number {
	let first = -1;
	for (const pattern of [AUTHORITY_OPENER_RE, PERCENT_OPENER_RE]) {
		const opener = new RegExp(pattern);
		opener.lastIndex = Math.max(0, from);
		const match = opener.exec(text);
		if (match !== null && (first < 0 || match.index < first)) first = match.index;
	}
	return first;
}

// The Oracle JDBC prefix still forming, `jdbc:ora` through `jdbc:oracle:thin:scott`. A cut inside it leaves neither row
// matching the pattern (#448).
const JDBC_ORACLE_LEAD = "jdbc:oracle:";
const FORMED_JDBC_ORACLE_RE = /jdbc:oracle:[a-z0-9]*(?::[^\s/@:"]*)?$/iu;

/**
 * Where a cut should land so that an opener or an Oracle JDBC prefix still forming at the end of this text reaches the next
 * row whole, with the one character ahead of it that the pattern reads, or null (#448).
 */
export function formingCredentialStart(text: string): number | null {
	const starts: number[] = [];
	const piece = openerPieceStart(text);
	if (piece >= 0) starts.push(Math.max(0, piece - 1));
	const from = Math.max(0, text.length - OPEN_NAME_CHARS - 24);
	const formed = FORMED_JDBC_ORACLE_RE.exec(text.slice(from));
	if (formed !== null) starts.push(from + formed.index);
	for (let at = Math.max(0, text.length - JDBC_ORACLE_LEAD.length + 1); at < text.length; at += 1) {
		if (JDBC_ORACLE_LEAD.startsWith(text.slice(at).toLowerCase())) {
			starts.push(at);
			break;
		}
	}
	return starts.length === 0 ? null : Math.min(...starts);
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
	return redactSecretString(completed ? value : holdUnresolvedUserinfo(holdOpenQuotedSecret(value)));
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
const CUT_OFF_USERNAME_TOKEN_RE = new RegExp(
	`(?<=${AUTHORITY_OPENER})${OPAQUE_NAME}(?=:?$)|${PERCENT_OPENER_BEHIND}${OPAQUE_NAME}(?=(?:%(?:3a?|4)?)?$)`,
	"iu",
);

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

// What makes the rest of a token wait for its whitespace: an authority opener in any shape, a query or fragment, or an Oracle
// JDBC prefix, whose userinfo has no `//` ahead of it (#448).
const APPEND_ONLY_WAIT_RE = /:?\/\/|:?\\\/\\\/|%3a%2f%2f|jdbc:|[?&#]/iu;
/** How much of its token a stream filter keeps as context: enough for the `jdbc` ahead of `:oracle:` (#448). */
const APPEND_ONLY_CONTEXT_CHARS = 16;

/**
 * Where text that a reader cannot retract becomes unsafe to send: from anything in its last token a later character could
 * make a credential. `waiting` says the rest of the token waits for whitespace, not just for its next character.
 */
function appendOnlySafeEnd(text: string): { end: number; waiting: boolean } {
	let tokenStart = text.length;
	while (tokenStart > 0 && !/\s/u.test(text.charAt(tokenStart - 1))) tokenStart -= 1;
	const unsafe = text.slice(tokenStart).search(APPEND_ONLY_WAIT_RE);
	if (unsafe >= 0) return { end: tokenStart + unsafe, waiting: true };
	const piece = openerPieceStart(text);
	return { end: piece < tokenStart ? text.length : piece, waiting: false };
}

/**
 * URL credentials for text sent as increments, where a reader only appends and nothing shown can be rewritten. A frame's hold
 * cannot serve here, since `https://abc` shows before an `@` makes it a token. Prose passes at once, including text with no
 * spaces, and a token holding a URL or a query waits from there for its whitespace. What it sends joins to the one-shot
 * output (#446).
 */
export class UrlCredentialStreamFilter {
	private pending = "";
	/**
	 * The end of the token already sent, which the patterns read ahead of what waits: one character ahead of a `://`, and the
	 * `jdbc` ahead of `:oracle:`. It never holds a credential, since anything that opens one waits.
	 */
	private context = "";
	/**
	 * What waits opens with an authority opener, a query or a fragment, so only whitespace ends the wait and only new text can
	 * hold it. Scanning the whole token per delta took 25.7 s on a 200 KB token in 8-character deltas, blocking the loop (#446).
	 */
	private waiting = false;

	private send(text: string, redact: (value: string) => string): string {
		const joined = this.context + text;
		const safe = redact(joined).slice(this.context.length);
		let start = joined.length;
		while (start > 0 && joined.length - start < APPEND_ONLY_CONTEXT_CHARS && !/\s/u.test(joined.charAt(start - 1)))
			start -= 1;
		this.context = joined.slice(start);
		return safe;
	}

	push(delta: string): string {
		this.pending += delta;
		if (this.waiting && !/\s/u.test(delta)) return "";
		const { end, waiting } = appendOnlySafeEnd(this.context + this.pending);
		const cut = Math.max(0, end - this.context.length);
		const safe = cut === 0 ? "" : this.send(this.pending.slice(0, cut), redactUrlCredentials);
		this.pending = this.pending.slice(cut);
		this.waiting = waiting;
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
	/** The source after `committed`, which no redaction has closed yet. */
	private uncommitted = "";
	/** The redacted open run `text` ends with. */
	private openText = "";
	private text = "";
	private restartCount = 0;
	/**
	 * `prefix` in the pieces it was appended in, so the end of the text can be
	 * read without flattening a long reply: loose pieces, and older ones joined
	 * a few hundred at a time (#428).
	 */
	private joined: string[] = [];
	private loose: string[] = [];

	/** Only the wider rule redacts quoted secrets, so only it holds one open across appends. */
	private readonly holdsQuoted: boolean;

	constructor(private readonly redact: (value: string) => string = redactSecretString) {
		this.holdsQuoted = redact === redactSecretString;
	}

	/** How much of the last projection later appends leave as it is: the redacted tokens already closed. */
	get settledLength(): number {
		return this.prefix.length;
	}

	/** How often a source that did not extend the last one restarted the projection, which drops the settled text. */
	get restarts(): number {
		return this.restartCount;
	}

	/** The length of the last projection. */
	get length(): number {
		return this.prefix.length + this.openText.length;
	}

	/** The last projection from `from` on, read from its pieces so a long text is not flattened to take its end. */
	textFrom(from: number): string {
		if (from <= 0) return this.text;
		let at = this.prefix.length;
		if (from >= at) return this.openText.slice(from - at);
		const parts = [this.openText];
		for (const pieces of [this.loose, this.joined]) {
			for (let index = pieces.length - 1; index >= 0; index -= 1) {
				const piece = pieces[index] ?? "";
				at -= piece.length;
				if (at <= from) {
					parts.push(piece.slice(from - at));
					return parts.reverse().join("");
				}
				parts.push(piece);
			}
		}
		return this.text.slice(from);
	}

	project(source: string, completed = false): string {
		if (source === this.source && completed === this.completed) return this.text;
		if (!source.startsWith(this.source)) {
			this.committed = 0;
			this.prefix = "";
			this.uncommitted = source;
			this.joined = [];
			this.loose = [];
			this.restartCount += 1;
		} else {
			this.uncommitted = source.slice(this.committed);
		}
		return this.advance(source, completed);
	}

	/**
	 * `project(source, completed)` for a source the caller knows is the last one
	 * with `delta` appended, without comparing the two: that comparison read the
	 * whole of a long streamed reply on every frame (#428).
	 */
	append(source: string, delta: string, completed = false): string {
		if (delta.length === 0 && completed === this.completed) {
			this.source = source;
			return this.text;
		}
		this.uncommitted += delta;
		return this.advance(source, completed);
	}

	private advance(source: string, completed: boolean): string {
		const tail = this.uncommitted;
		let through = 0;
		// Whitespace after a non-flag token closes every credential pattern. A flag
		// can consume the following token, so keep it buffered with its value (#428).
		// Only a token's start can match: retrying inside a long token cost 1.6 s per frame at 64 KB.
		const tokens = /(?<!\S)\S+\s+/gu;
		for (const match of tail.matchAll(tokens)) {
			if (!match[0].includes("-")) through = match.index + match[0].length;
		}
		// A quoted secret's lead and value reach one redaction together, so an open one stays uncommitted from its token.
		const lead = this.holdsQuoted && through > 0 ? quotedSecretLeadStart(tail.slice(0, through)) : null;
		if (lead !== null) {
			through = lead;
			while (through > 0 && !/\s/u.test(tail.charAt(through - 1))) through -= 1;
		}
		if (through > 0) {
			const piece = this.redact(tail.slice(0, through));
			this.prefix += piece;
			this.loose.push(piece);
			if (this.loose.length >= 512) {
				this.joined.push(this.loose.join(""));
				this.loose = [];
			}
			this.committed += through;
		}
		// A committed token ends in whitespace, so the open run a hold reads is always in this uncommitted tail (#446).
		const open = tail.slice(through);
		this.uncommitted = open;
		this.openText = this.redact(
			completed ? open : holdUnresolvedUserinfo(this.holdsQuoted ? holdOpenQuotedSecret(open) : open),
		);
		this.text = this.prefix + this.openText;
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
