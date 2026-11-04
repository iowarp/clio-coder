/**
 * What may reach the dataset file. A decision's state is the operator's own
 * request, tool arguments and tool output, so nothing leaves this module
 * without passing the two secret filters the rest of the harness already
 * trusts, plus a key-name pass for values that carry no secret-shaped text of
 * their own (`{ "password": "hunter2" }`).
 */

import { homedir } from "node:os";
import type { RedactionTally } from "../evidence/redact.js";
import { createRedactionTally, headForRedaction, redactSecretsDeep, redactSecretsText } from "../evidence/redact.js";
import { cutHeadGuard, dropCutHead, isSecretArgKey, redactSecretString } from "../safety/redaction.js";

const MAX_DEPTH = 12;
let homePattern: { home: string; re: RegExp | null } | null = null;

/**
 * The operator's absolute home directory as a pattern, in both separator
 * spellings. It matches only a whole path prefix: not preceded by a path
 * character (so `/data/home/ana` is not touched) and not followed by a name
 * character (so `/home/ana2` is not). A sentence-ending period does not count as one.
 */
function homeRegExp(): RegExp | null {
	let home = "";
	try {
		home = homedir();
	} catch {
		// No resolvable home: there is no prefix to replace.
	}
	if (homePattern?.home === home) return homePattern.re;
	const forms = new Set([home, home.replaceAll("\\", "/")].map((form) => form.replace(/[\\/]+$/u, "")));
	// A root or empty home would rewrite every path.
	const usable = [...forms].filter((form) => form.length > 1);
	const re =
		usable.length === 0
			? null
			: new RegExp(
					`(?<![\\w./~\\\\-])(?:${usable.map((form) => form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})(?![\\w-])(?!\\.\\w)`,
					"gu",
				);
	homePattern = { home, re };
	return re;
}

/** Replace the operator's home directory prefix with `~`, so a dataset row does not name the account. */
function tildeHome(text: string): string {
	const re = homeRegExp();
	return re === null ? text : text.replace(re, "~");
}

function scrubNode(value: unknown, tally: RedactionTally, depth: number, keys: boolean): unknown {
	if (typeof value === "string") {
		const cleaned = redactSecretString(value);
		if (cleaned !== value) tally.count += 1;
		// A path rewrite is not a redaction and stays out of the tally.
		return tildeHome(cleaned);
	}
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) {
		tally.count += 1;
		return "[redacted nested values]";
	}
	if (Array.isArray(value)) return value.map((item) => scrubNode(item, tally, depth + 1, keys));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		// Numbers and booleans under a key such as `tokens` are measurements, not credentials.
		if (keys && isSecretArgKey(key) && (typeof item === "string" || (item !== null && typeof item === "object"))) {
			tally.count += 1;
			out[key] = "[redacted]";
			continue;
		}
		// A path is as likely to be a key as a value (a candidate keyed by file).
		out[tildeHome(key)] = scrubNode(item, tally, depth + 1, keys);
	}
	return out;
}

/**
 * Deep-redact a JSON-shaped value, counting every replacement in `tally`.
 * `keys: false` skips the key-name pass, for values whose keys are the
 * harness's own vocabulary (question criteria keyed `credential-access`,
 * probabilities keyed by option) and must survive intact.
 */
export function scrub<T>(value: T, tally: RedactionTally, keys = true): T {
	return scrubNode(redactSecretsDeep(value, tally), tally, 0, keys) as T;
}

export function scrubbed<T>(value: T): { value: T; redactions: number } {
	const tally = createRedactionTally();
	const out = scrub(value, tally);
	return { value: out, redactions: tally.count };
}

/** Each end kept of a longer string in a point's object, well past the 6000 code points any point reads from one end. */
const SITE_TEXT_WINDOW_CHARS = 32 * 1024;

/** The two ends of a text too long to redact on the pre-turn path. Neither cut can leave a partial secret behind. */
function objectTextWindow(text: string): string {
	if (text.length <= SITE_TEXT_WINDOW_CHARS * 2) return text;
	const head = headForRedaction(text, SITE_TEXT_WINDOW_CHARS);
	const tail = dropCutHead(text.slice(-SITE_TEXT_WINDOW_CHARS), cutHeadGuard());
	// A key block is the one secret that spans tokens. Its open end redacts through the end of the text, but the rest of
	// one whose header fell between the windows has nothing left to name it.
	const end = tail.indexOf("-----END ");
	const begin = tail.indexOf("-----BEGIN ");
	return `${head}\n…\n${end >= 0 && (begin < 0 || begin > end) ? tail.slice(end) : tail}`;
}

/**
 * A point's object with every string redacted, whole, before the point sees it. A point bounds its text, and a cut can leave
 * a partial secret no pattern recognizes, so the runner hands out only this copy. Ids stay usable: home paths are left
 * alone here, and only an id that itself looks like a secret changes.
 */
export function clearedObject<T>(value: T, tally: RedactionTally): T {
	if (typeof value === "string") {
		return redactSecretString(redactSecretsText(objectTextWindow(value), tally)) as T;
	}
	if (Array.isArray(value)) return value.map((item) => clearedObject(item, tally)) as T;
	if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = clearedObject(item, tally);
	return out as T;
}
