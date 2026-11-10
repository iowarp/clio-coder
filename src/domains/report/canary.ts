import { readFileSync } from "node:fs";
import { telemetryInstallPath, unpackTelemetryArchive } from "../telemetry/index.js";
import type { RenderedReport } from "./body.js";
import { type IdentityKind, isReservedName, type LocalIdentity, scrubText } from "./scrub.js";

/**
 * The second, independent proof that a bundle carries none of this machine's identifiers (R-19). The projection
 * allowlist is sound by a schema walk; this scans the actual bytes about to leave for the values the scrubber knows,
 * and a hit names the member, the record's event and JSON path and the identifier's kind, never its value.
 */

export type CanaryKind = IdentityKind | "path" | "install-id" | "anonymization-key";

interface Canary {
	kind: CanaryKind;
	value: string;
}

export interface CanaryMember {
	name: string;
	bytes: Buffer;
}

export interface CanaryHit {
	/** The member, and for a member inside a nested archive `<archive>/<member>`. */
	member: string;
	kind: CanaryKind;
	/** The record's event kind when the member is a journal; null otherwise. */
	event: string | null;
	/** The JSON path of the string or key that holds it, relative to the record or document; null for raw text. */
	path: string | null;
}

/** A name shorter than this collides with ordinary words and ids (R-19). */
export const CANARY_MIN_LENGTH = 4;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function installCanaries(stateDir: string): Canary[] {
	try {
		const parsed = JSON.parse(readFileSync(telemetryInstallPath(stateDir), "utf8")) as Record<string, unknown>;
		return [
			...(typeof parsed.installId === "string" ? [{ kind: "install-id" as const, value: parsed.installId }] : []),
			...(typeof parsed.anonymizationKey === "string"
				? [{ kind: "anonymization-key" as const, value: parsed.anonymizationKey }]
				: []),
		];
	} catch {
		// No install.json, or one this reader cannot parse: there is no raw install id to look for.
		return [];
	}
}

interface Matcher {
	/** Names, whole words, case-insensitive. */
	words: RegExp | null;
	wordKinds: Map<string, CanaryKind>;
	/** Paths, remotes and install secrets, exact. */
	exact: RegExp | null;
	exactKinds: Map<string, CanaryKind>;
}

function matcher(canaries: ReadonlyArray<Canary>): Matcher {
	const wordKinds = new Map<string, CanaryKind>();
	const exactKinds = new Map<string, CanaryKind>();
	for (const { kind, value } of canaries) {
		const trimmed = value.trim();
		if (trimmed.length < CANARY_MIN_LENGTH) continue;
		if (kind === "path" || kind === "install-id" || kind === "anonymization-key" || /[\\/:]/u.test(trimmed)) {
			if (!exactKinds.has(trimmed)) exactKinds.set(trimmed, kind);
		} else if (!isReservedName(trimmed) && !wordKinds.has(trimmed.toLowerCase()))
			wordKinds.set(trimmed.toLowerCase(), kind);
	}
	const alternation = (values: Iterable<string>) =>
		[...values]
			.sort((a, b) => b.length - a.length)
			.map(escapeRegExp)
			.join("|");
	return {
		words:
			wordKinds.size > 0
				? new RegExp(`(?<![A-Za-z0-9_])(?:${alternation(wordKinds.keys())})(?![A-Za-z0-9_])`, "iu")
				: null,
		wordKinds,
		exact: exactKinds.size > 0 ? new RegExp(`(?:${alternation(exactKinds.keys())})(?![A-Za-z0-9._~@%+=-])`, "u") : null,
		exactKinds,
	};
}

function matchKind(text: string, m: Matcher): CanaryKind | null {
	const exact = m.exact?.exec(text);
	if (exact) return m.exactKinds.get(exact[0]) ?? "path";
	const word = m.words?.exec(text);
	if (word) return m.wordKinds.get(word[0].toLowerCase()) ?? "user";
	return null;
}

/** JSON string escapes undone, so `\/home\/x` and `\u002fhome` are found in text that is not parsed. */
function unescapeJsonText(text: string): string {
	return text
		.replace(/\\u([0-9a-fA-F]{4})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\(["\\/])/gu, "$1");
}

function walk(value: unknown, path: string, visit: (text: string, path: string) => void): void {
	if (typeof value === "string") visit(value, path);
	else if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`, visit);
	} else if (value !== null && typeof value === "object")
		for (const [key, item] of Object.entries(value)) {
			const at = path === "" ? key : `${path}.${key}`;
			visit(key, at);
			walk(item, at, visit);
		}
}

function scanMember(member: CanaryMember, m: Matcher, hits: CanaryHit[]): void {
	const nameKind = matchKind(member.name, m);
	if (nameKind !== null) hits.push({ member: member.name, kind: nameKind, event: null, path: null });
	if (member.name.endsWith(".tar.gz") || member.name.endsWith(".tgz")) {
		for (const entry of unpackTelemetryArchive(member.bytes))
			scanMember({ name: `${member.name}/${entry.path}`, bytes: entry.bytes }, m, hits);
		return;
	}
	const text = member.bytes.toString("utf8");
	const json = (source: string): unknown => {
		try {
			return JSON.parse(source);
		} catch {
			return undefined;
		}
	};
	const whole = member.name.endsWith(".jsonl") ? undefined : json(text);
	const units =
		whole !== undefined
			? [{ value: whole, raw: text }]
			: text.split("\n").map((line) => {
					// A journal line is JSON framed by a tab, `#` and its checksum.
					const frame = line.lastIndexOf("\t#");
					const body = frame >= 0 ? line.slice(0, frame) : line;
					return { value: json(body), raw: line };
				});
	for (const unit of units) {
		if (unit.value === undefined) {
			const kind = matchKind(unescapeJsonText(unit.raw), m);
			if (kind !== null) hits.push({ member: member.name, kind, event: null, path: null });
			continue;
		}
		const event =
			unit.value !== null && typeof unit.value === "object" && typeof (unit.value as { k?: unknown }).k === "string"
				? (unit.value as { k: string }).k
				: null;
		walk(unit.value, "", (piece, path) => {
			const kind = matchKind(piece, m);
			if (kind !== null) hits.push({ member: member.name, kind, event, path: path === "" ? null : path });
		});
	}
}

/** Every identifier this machine knows that a bundle must not carry; values under {@link CANARY_MIN_LENGTH} skip. */
export function identityCanaries(identity: LocalIdentity, stateDir?: string): Canary[] {
	return [
		...identity.names.map(({ kind, value }) => ({ kind, value })),
		...identity.paths.map((value) => ({ kind: "path" as const, value })),
		...identity.remotes.map((value) => ({ kind: "remote" as const, value })),
		...(stateDir !== undefined ? installCanaries(stateDir) : []),
	];
}

/**
 * Search every member's bytes for this machine's identifiers: names as whole words regardless of case, paths,
 * remotes and the raw install id and anonymization key exactly, after JSON escapes are undone. A nested `.tar.gz` is
 * scanned member by member. With `stateDir`, the install id and key in its `install.json` are canaries too.
 */
export function canaryScan(
	members: ReadonlyArray<CanaryMember>,
	identity: LocalIdentity,
	options: { stateDir?: string } = {},
): CanaryHit[] {
	const m = matcher(identityCanaries(identity, options.stateDir));
	const hits: CanaryHit[] = [];
	if (m.words === null && m.exact === null) return hits;
	for (const member of members) scanMember(member, m, hits);
	// A location is built from member names and object keys, which can be the identifier itself: mask it there too.
	const exact = m.exact ? new RegExp(m.exact.source, "gu") : null;
	const words = m.words ? new RegExp(m.words.source, "giu") : null;
	const mask = (text: string): string => {
		let out = exact ? text.replace(exact, (value) => `<${m.exactKinds.get(value) ?? "path"}>`) : text;
		if (words) out = out.replace(words, (value) => `<${m.wordKinds.get(value.toLowerCase()) ?? "user"}>`);
		return out;
	};
	const seen = new Set<string>();
	return hits
		.map((hit) => ({
			...hit,
			member: mask(hit.member),
			event: hit.event === null ? null : mask(hit.event),
			path: hit.path === null ? null : mask(hit.path),
		}))
		.filter((hit) => {
			const key = `${hit.member}\0${hit.kind}\0${hit.event}\0${hit.path}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

/** Where a hit is, as `<event>.<path>` for a journal record and `<member>[.<path>]` otherwise. */
export function canaryLocation(hit: CanaryHit): string {
	if (hit.event !== null) return hit.path === null ? hit.event : `${hit.event}.${hit.path}`;
	return hit.path === null ? hit.member : `${hit.member}.${hit.path}`;
}

/** The refusal for the first hit: the kind and the location, never the value. */
export function canaryRefusal(hits: ReadonlyArray<CanaryHit>, what = "the bundle was not built"): string {
	const hit = hits[0];
	if (hit === undefined) return "";
	const more = hits.length > 1 ? ` (and ${hits.length - 1} more)` : "";
	return `${what}: a ${hit.kind} appears in ${canaryLocation(hit)}${more}. This is a Clio Coder bug; \`/report\` it without a bundle.`;
}

/**
 * The identifiers a rendered issue still carries once every mask is applied again. The reporter's unmasked values are
 * expected in the text, and re-scrubbing with nothing unmasked removes exactly those, so any hit left is one the
 * scrubber missed and blocks Send.
 */
export function issueCanaryHits(
	rendered: Pick<RenderedReport, "title" | "body">,
	identity: LocalIdentity,
): CanaryHit[] {
	return canaryScan(
		[
			{ name: "title", bytes: Buffer.from(scrubText(rendered.title, identity).text) },
			{ name: "body", bytes: Buffer.from(scrubText(rendered.body, identity).text) },
		],
		identity,
	);
}
