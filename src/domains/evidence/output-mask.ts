/**
 * Credential masking for command output: what bash, run_script, the operator shell and a pane read print. A value is hidden
 * when it is a credential the environment holds ({@link redactKnownSecrets}) or when its shape alone says it is one
 * ({@link redactCommandOutputSecrets}).
 *
 * Output arrives in pieces, so a piece may end inside a credential that no pattern recognizes yet. A live frame holds back
 * an open one until it resolves, an append-only sink commits only up to a point where every pattern is closed, and a tail
 * window that lost its head drops the cut token, whose remainder could be a credential's.
 */

import { cutHeadGuard, dropShortCutHead, holdCutOffText, secretUrlParamValues } from "../safety/redaction.js";
import { redactCommandOutputSecrets, redactKnownSecrets } from "./redact.js";

/**
 * How the end of a text stands. `open` text is a frame of output still growing, `cut-off` text stopped where nothing more
 * will come (a kill, a timeout or a byte cap), and `complete` text ended where the program left it.
 */
export type OutputEnding = "complete" | "open" | "cut-off";

// What a credential's own characters are: every shape below draws on these, and none on whitespace or quotes.
const VALUE_CHAR_RE = /[A-Za-z0-9._~+/=-]/u;
// Where a shape starts. An open run from one of these may still grow into a match, so a frame shows none of it.
const SHAPE_START_RE = /(?<![A-Za-z0-9])(?:AKIA|gh[pousr]_|github_pat_|xox[bpars]-|AIza)|(?<![A-Za-z0-9_-])sk-|eyJ/gu;
// A header or scheme naming the credential that follows it, which the authorization pattern reads across whitespace.
const CREDENTIAL_LEAD_RE =
	/(?:authorization\s*(?:["']\s*)?[:=]\s*["']?(?:(?:bearer|basic|token)\b\s*)?|\bbearer\s*)$/iu;
const CREDENTIAL_LEAD_CHARS = 64;
/** A known value shows nothing worth hiding until this much of it is printed. */
const KNOWN_PREFIX_MIN = 3;

/** No credential runs longer than this, so a run is read back only this far. */
const OPEN_RUN_CHARS = 8 * 1024;
const PEM_HEADER_CHARS = 64;
// Every opener the URL rule reads, then the name run after it up to the end of the text.
const OPEN_AUTHORITY_RE =
	/(?::\/\/|:\\\/\\\/|(?<![^\s"'(<=,{>])(?:\/\/|\\\/\\\/)|%3a%2f%2f)([A-Za-z0-9._~+-]+(?:%[0-9a-f]?)?)$/iu;

/** Where the end of `text` starts a run that is, or may still become, a credential's prefix, or `text.length`. */
function openSecretStart(text: string, known: readonly string[]): number {
	const floor = Math.max(0, text.length - OPEN_RUN_CHARS);
	let runStart = text.length;
	while (runStart > floor && VALUE_CHAR_RE.test(text.charAt(runStart - 1))) runStart -= 1;
	let start = text.length;
	if (runStart < text.length) {
		const shape = new RegExp(SHAPE_START_RE);
		shape.lastIndex = runStart;
		const match = shape.exec(text);
		if (match !== null) start = match.index;
		const lead = text.slice(Math.max(0, runStart - CREDENTIAL_LEAD_CHARS), runStart);
		if (CREDENTIAL_LEAD_RE.test(lead)) start = Math.min(start, runStart);
	}
	// An authority name still forming may be a token that only its `@` will show to be one.
	const authority = OPEN_AUTHORITY_RE.exec(text.slice(-OPEN_RUN_CHARS));
	if (authority?.[1] !== undefined) start = Math.min(start, text.length - authority[1].length);
	// A secret query value still forming is too short to mask until it ends.
	let tokenStart = text.length;
	while (tokenStart > floor && !/\s/u.test(text.charAt(tokenStart - 1))) tokenStart -= 1;
	const param = secretUrlParamValues(text.slice(tokenStart)).at(-1);
	if (param !== undefined && tokenStart + param.end === text.length) start = Math.min(start, tokenStart + param.start);
	// A PEM header still forming has no secret yet, but its body follows on the next lines.
	const tail = text.slice(-PEM_HEADER_CHARS);
	const header = /-----BEGIN [A-Z0-9 ]*$/u.exec(tail);
	if (header !== null) start = Math.min(start, text.length - tail.length + header.index);
	return Math.min(start, knownPrefixStart(text, known));
}

/** Where `text` ends with the start of a known value, or `text.length`. Only a final character a value holds is tried. */
function knownPrefixStart(text: string, known: readonly string[]): number {
	const last = text.charCodeAt(text.length - 1);
	let start = text.length;
	for (const value of known) {
		for (let length = Math.min(value.length - 1, text.length); length >= KNOWN_PREFIX_MIN; length -= 1) {
			if (value.charCodeAt(length - 1) !== last) continue;
			if (text.endsWith(value.slice(0, length))) {
				start = Math.min(start, text.length - length);
				break;
			}
		}
	}
	return start;
}

function holdOpenSecrets(text: string, known: readonly string[], ending: OutputEnding): string {
	if (ending === "complete") return text;
	// A frame also keeps back an opaque name that may be a token, which a display frame shows as a host until its `@` comes.
	// Output only waits a frame for it.
	const held = holdCutOffText(text);
	return held.slice(0, openSecretStart(held, known));
}

function maskWhole(text: string, known: readonly string[], ending: OutputEnding): string {
	return redactCommandOutputSecrets(redactKnownSecrets(holdOpenSecrets(text, known, ending), known));
}

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----/u;
const PEM_END_RE = /-----END [A-Z0-9 ]*(?:PRIVATE KEY|PRIVATE KEY BLOCK)-----/u;
const OMITTED_MARKER_RE = /\[\.\.\. (\d+) bytes omitted \.\.\.\]\n/u;

/**
 * Text that lost its head: the cut token goes, with the token after it, which the cut piece may have named, and so does a
 * private key's body whose header was cut away. Returns the masked text and how many bytes the cut took.
 */
function maskCutHead(
	text: string,
	known: readonly string[],
	ending: OutputEnding,
): { text: string; droppedBytes: number } {
	let rest = dropShortCutHead(text, cutHeadGuard());
	const droppedBytes = Buffer.byteLength(text.slice(0, text.length - rest.length), "utf8");
	const end = PEM_END_RE.exec(rest);
	let lead = "";
	if (end !== null) {
		const begin = PEM_BEGIN_RE.exec(rest);
		if (begin === null || begin.index > end.index) {
			lead = "[redacted:pem]";
			rest = rest.slice(end.index + end[0].length);
		}
	}
	return { text: lead + maskWhole(rest, known, ending), droppedBytes };
}

/**
 * Mask one text in a single pass. A retained window's `[... N bytes omitted ...]` marker says the text after it lost its
 * head, so that part starts at its first whole token and the marker counts the bytes that cut took.
 */
export function maskCommandOutput(text: string, known: readonly string[], ending: OutputEnding = "complete"): string {
	const omitted = OMITTED_MARKER_RE.exec(text);
	if (omitted === null) return maskWhole(text, known, ending);
	const head = text.slice(0, omitted.index);
	const tail = maskCutHead(text.slice(omitted.index + omitted[0].length), known, ending);
	const count = Number(omitted[1]) + tail.droppedBytes;
	return `${maskWhole(head, known, "cut-off")}[... ${count} bytes omitted ...]\n${tail.text}`;
}

/** A single line longer than this commits at its last whitespace, so a stream with no newlines stays linear. */
const LINE_COMMIT_CHARS = 64 * 1024;
/** A run with no whitespace longer than this commits all but its last few kilobytes, which is longer than any credential. */
const RUN_COMMIT_CHARS = 64 * 1024;
const RUN_KEEP_CHARS = 4 * 1024;
const PEM_END_KEEP_CHARS = 128;

function lastBreak(text: string, re: RegExp): number {
	for (let at = text.length - 1; at >= 0; at -= 1) if (re.test(text.charAt(at))) return at;
	return -1;
}

/**
 * Mask a stream as it is appended. {@link push} returns the masked text that became final and {@link frame} what is still
 * pending, held back where it may end inside a credential. Committed text is masked once, and where pending text breaks is
 * tracked as it arrives, so the whole stream costs one pass however many pieces and frames it has.
 */
export class CommandOutputMask {
	private pending = "";
	/** Indexes into {@link pending} of its last newline and its last whitespace, or -1. */
	private lastNewline = -1;
	private lastSpace = -1;
	/** A private key's header was committed without its footer, so everything up to the footer is already masked. */
	private inPrivateKey = false;

	constructor(private readonly known: readonly string[]) {}

	push(text: string): string {
		const base = this.pending.length;
		this.pending += text;
		const newline = text.lastIndexOf("\n");
		if (newline >= 0) this.lastNewline = base + newline;
		const space = lastBreak(text, /\s/u);
		if (space >= 0) this.lastSpace = base + space;
		let out = "";
		for (;;) {
			if (this.inPrivateKey) {
				const end = PEM_END_RE.exec(this.pending);
				this.drop(end === null ? Math.max(0, this.pending.length - PEM_END_KEEP_CHARS) : end.index + end[0].length);
				if (end === null) return out;
				this.inPrivateKey = false;
			}
			const cut = this.commitCut();
			if (cut === 0) return out;
			const chunk = this.pending.slice(0, cut);
			this.drop(cut);
			out += maskWhole(chunk, this.known, "complete");
			const begin = chunk.lastIndexOf("-----BEGIN ");
			if (begin >= 0 && PEM_BEGIN_RE.test(chunk.slice(begin)) && !PEM_END_RE.test(chunk.slice(begin))) {
				this.inPrivateKey = true;
			}
		}
	}

	/** What the pending text may show now. */
	frame(): string {
		return this.inPrivateKey ? "" : maskWhole(this.pending, this.known, "open");
	}

	/** Everything left, masked as the stream ended. */
	end(ending: Exclude<OutputEnding, "open"> = "complete"): string {
		const rest = this.inPrivateKey ? "" : maskWhole(this.pending, this.known, ending);
		this.drop(this.pending.length);
		this.inPrivateKey = false;
		return rest;
	}

	private drop(count: number): void {
		this.pending = this.pending.slice(count);
		this.lastNewline = this.lastNewline >= count ? this.lastNewline - count : -1;
		this.lastSpace = this.lastSpace >= count ? this.lastSpace - count : -1;
	}

	/** How much of the pending text can be masked now and never revisited, or 0. */
	private commitCut(): number {
		const text = this.pending;
		let cut = this.lastNewline + 1;
		if (cut === 0 && text.length > LINE_COMMIT_CHARS) cut = this.lastSpace + 1;
		if (cut === 0 && text.length > RUN_COMMIT_CHARS) cut = text.length - RUN_KEEP_CHARS;
		if (cut === 0) return 0;
		// Every pattern closes at whitespace except one naming a credential before it, a known value holding whitespace,
		// and a forced cut inside a run, so the cut steps back ahead of whichever is open there.
		const before = text.slice(Math.max(0, cut - CREDENTIAL_LEAD_CHARS), cut);
		const lead = CREDENTIAL_LEAD_RE.exec(before);
		if (lead !== null) cut -= before.length - lead.index;
		return cut <= 0 ? 0 : openSecretStart(text.slice(0, cut), this.known);
	}
}

/**
 * Masked frames of a stream a producer reports as its whole text so far, as bash progress does. Only what is new since the
 * last frame is masked.
 */
export class CumulativeOutputMask {
	private readonly mask: CommandOutputMask;
	private seen = 0;
	private committed = "";

	constructor(known: readonly string[]) {
		this.mask = new CommandOutputMask(known);
	}

	frame(text: string): string {
		this.advance(text);
		return this.committed + this.mask.frame();
	}

	final(text: string, ending: Exclude<OutputEnding, "open"> = "complete"): string {
		this.advance(text);
		return this.committed + this.mask.end(ending);
	}

	private advance(text: string): void {
		if (text.length < this.seen) {
			// The producer restarted its text; nothing committed belongs to it any more.
			this.seen = 0;
			this.committed = "";
			this.mask.end();
		}
		this.committed += this.mask.push(text.slice(this.seen));
		this.seen = text.length;
	}
}
