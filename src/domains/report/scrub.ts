import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";
import { homedir, hostname, userInfo } from "node:os";
import { basename, sep } from "node:path";
import { knownSecretValues } from "../../core/sandbox/env-scrub.js";
import { FailureCause } from "../../core/telemetry/enums.js";
import { BILLING_PROVIDERS } from "../../core/telemetry/schemas.js";
import { createRedactionTally, redactKnownSecrets, redactSecretsText } from "../evidence/index.js";
import { inspectInstallation } from "../lifecycle/index.js";
import { isBuiltinRuntimeId } from "../telemetry/index.js";
import { type ReportCommandRunner, runReportCommand } from "./command.js";
import {
	REPORT_AREAS,
	REPORT_AUTONOMY,
	REPORT_BLOCK_TAG,
	REPORT_DETAILS_SUMMARY,
	REPORT_EMPTY_SECTION,
	REPORT_FOOTER,
	REPORT_FOOTER_UNREVIEWED,
	REPORT_HEADINGS,
	REPORT_INSTALL_KINDS,
	REPORT_KINDS,
	REPORT_NOTHING_OBSERVED,
	REPORT_NOTHING_UNKNOWN,
	REPORT_OS,
	REPORT_SURFACES,
	REPORT_TRIGGERS,
} from "./vocabulary.js";

export type IdentityKind = "user" | "host" | "project" | "branch" | "remote" | "target";
export type MaskKind = "secret" | "path" | "url" | "email" | "ip" | IdentityKind;

/** What this machine knows about itself and would not want in a public issue. */
export interface LocalIdentity {
	/** Clio's own package root: paths under it are about Clio and keep their package-relative tail. */
	packageRoot: string | null;
	/** Home directory, workspace root: masked even when they have a single segment. */
	paths: string[];
	/** Full git remote URLs. */
	remotes: string[];
	/** Whole-word names: user, host, project, branch, remote owner and repository, target id. */
	names: Array<{ value: string; kind: IdentityKind }>;
}

export interface ReportMask {
	/** Stable across renders of the same text; the value itself never appears in it. */
	id: string;
	kind: MaskKind;
	count: number;
}

export interface ScrubResult {
	text: string;
	masks: ReportMask[];
}

/** The one secret mask: it is listed so the reporter sees it, and it cannot be unmasked. */
export const SECRET_MASK_ID = "secret";

const PLACEHOLDER: Readonly<Record<Exclude<MaskKind, "secret">, string>> = {
	path: "<path>",
	url: "<url>",
	email: "<email>",
	ip: "<ip>",
	user: "<user>",
	host: "<host>",
	project: "<project>",
	branch: "<branch>",
	remote: "<remote>",
	target: "<target>",
};

const PUBLIC_GIT_HOSTS: ReadonlySet<string> = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);
const PUBLIC_OWNER = "iowarp";

/**
 * Words a name is never replaced as, so prose and the report's own structure are not mangled: a short stop list,
 * Clio's public names, and every word of the body's fixed headings, footer and block.
 */
/** A name shorter than this collides with ordinary words and ids (R-19); the canary scan skips it. */
export const CANARY_MIN_LENGTH = 4;

const RESERVED_WORDS: ReadonlySet<string> = new Set(
	[
		"test",
		"tests",
		"user",
		"admin",
		"main",
		"master",
		"dev",
		"root",
		"home",
		"local",
		"localhost",
		"clio",
		"clio-coder",
		"coder",
		"iowarp",
		"github",
		"none",
		"yes",
		"no",
		"debug",
		"attached",
		"also",
		"seen",
		"node",
		"platform",
		"install",
		"surface",
		"autonomy",
		"runtime",
		"model",
		"version",
		"fingerprint",
		"links",
		"regression",
		"bundle",
		"consent",
		"credit",
		"trigger",
		"cause",
		"area",
		"kind",
		"details",
		"summary",
		...REPORT_KINDS,
		...REPORT_AREAS,
		...REPORT_SURFACES,
		...REPORT_TRIGGERS,
		...REPORT_OS,
		...REPORT_INSTALL_KINDS,
		...REPORT_AUTONOMY,
		...FailureCause.enum,
		...[
			...Object.values(REPORT_HEADINGS),
			REPORT_BLOCK_TAG,
			REPORT_DETAILS_SUMMARY,
			REPORT_FOOTER,
			REPORT_FOOTER_UNREVIEWED,
			REPORT_EMPTY_SECTION,
			REPORT_NOTHING_OBSERVED,
			REPORT_NOTHING_UNKNOWN,
		].flatMap((text) => text.match(/[A-Za-z][A-Za-z0-9_'-]*/gu) ?? []),
	].map((word) => word.toLowerCase()),
);

const RUNTIME_ID_CHAR = /[A-Za-z0-9_-]/u;
const BILLING_PROVIDER_WORDS: ReadonlySet<string> = new Set(BILLING_PROVIDERS);

/** Whether a word is a harness word (a runtime id such as `copilot-sdk`, a billing provider such as `github-copilot`). */
function isHarnessCompound(word: string): boolean {
	return isBuiltinRuntimeId(word) || BILLING_PROVIDER_WORDS.has(word);
}

/** Whether the name matched at `start..end` is only part of a harness word, which is that word, not the name. */
export function insideHarnessWord(text: string, start: number, end: number): boolean {
	let from = start;
	let to = end;
	while (from > 0 && RUNTIME_ID_CHAR.test(text.charAt(from - 1))) from -= 1;
	while (to < text.length && RUNTIME_ID_CHAR.test(text.charAt(to))) to += 1;
	return isHarnessCompound(text.slice(from, to));
}

/** Where a long name may start: not after a letter or digit, except the letter of a `\n` escape or a `%2F`. */
const NAME_START = "(?:(?<![A-Za-z0-9])|(?<=\\\\[ntr]|%2[Ff]))";

function maskId(kind: MaskKind, value: string): string {
	return `${kind}-${createHash("sha256").update(`${kind}\u0000${value.toLowerCase()}`).digest("hex").slice(0, 8)}`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const SEG_CHARS = "[\\p{L}\\p{N}._~@%+=-]";
const SEG = `${SEG_CHARS}+`;
/** What may follow a path's last segment: nothing that could continue it. */
const SEG_END = "(?![\\p{L}\\p{N}._~@%+=-])";
/**
 * Under a known path, a directory whose name holds spaces: words that start with a letter or digit, up to the next
 * separator, so `/home/me/My Project/x` is masked whole instead of leaving ` Project/x` behind.
 */
const SPACED_DIR = `${SEG}(?: [\\p{L}\\p{N}]${SEG_CHARS}*){1,8}(?=[/\\\\])`;
/**
 * A path, URL or address starts at the text's start or after a space, opening punctuation or a marker such as `<`, `>`
 * or `#`, or right after a one-letter flag such as `-I`; never mid-word.
 */
const START = "(?:(?<![^\\s([{\"'`=:,;|<>#])|(?<=(?:^|\\s)-[A-Za-z]))";
const GENERIC_PATH = new RegExp(`${START}(?:~[\\p{L}\\p{N}._-]*(?:/${SEG})+|(?:/${SEG}){2,})/?`, "gu");
const WINDOWS_CHAR = "[^\\s\"'`<>|*?\\\\]";
const WINDOWS_PATH = new RegExp(
	`${START}(?:[A-Za-z]:\\\\|\\\\\\\\)(?:${WINDOWS_CHAR}+(?: ${WINDOWS_CHAR}+){0,8}\\\\)*${WINDOWS_CHAR}*`,
	"gu",
);
const SCP_REMOTE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[A-Za-z0-9._~-][A-Za-z0-9._~/-]*/gu;
const URL_PATTERN = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/gu;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;
const IPV4 = /(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9A-Za-z]|\.\d)/gu;
/** An IPv6 literal candidate: hex groups and colons with at least two colons; {@link isIPv6} and a digit decide. */
const IPV6 = /(?<![0-9A-Za-z:.])(?=[0-9A-Fa-f:]*:[0-9A-Fa-f]*:)[0-9A-Fa-f:]{2,39}(?![0-9A-Za-z:])/gu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

function isPublicUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		const host = url.hostname.toLowerCase();
		if (host === "coder.iowarp.ai" || host === "npmjs.com" || host.endsWith(".npmjs.com")) return true;
		return (host === "github.com" || host === "www.github.com") && /^\/iowarp(?:\/|$)/iu.test(url.pathname);
	} catch {
		return false;
	}
}

function isPublicIp(raw: string): boolean {
	const octets = raw.split(".").map(Number);
	if (octets.some((octet) => octet > 255)) return true;
	return octets[0] === 127 || octets.every((octet) => octet === 0);
}

/** Whether a name is on the stop list a scrub or a canary scan never treats as an identifier. */
export function isReservedName(value: string): boolean {
	return RESERVED_WORDS.has(value.toLowerCase());
}

function usableName(value: string): boolean {
	return value.length >= 3 && !isReservedName(value);
}

function scrubOnce(
	text: string,
	identity: LocalIdentity,
	allowed: ReadonlySet<string>,
	masks: Map<string, ReportMask>,
): string {
	const mask = (kind: Exclude<MaskKind, "secret">, value: string): string => {
		const id = maskId(kind, value);
		if (allowed.has(id)) return value;
		const entry = masks.get(id) ?? { id, kind, count: 0 };
		entry.count += 1;
		masks.set(id, entry);
		return PLACEHOLDER[kind];
	};
	const tally = createRedactionTally();
	// A credential this process holds is masked by value too, as every tool card already does: a pasted provider error
	// carries the key in whatever shape the provider prints it.
	let out = redactKnownSecrets(redactSecretsText(text, tally), knownSecretValues(process.env), tally);
	if (tally.count > 0) {
		const entry = masks.get(SECRET_MASK_ID) ?? { id: SECRET_MASK_ID, kind: "secret" as const, count: 0 };
		entry.count += tally.count;
		masks.set(SECRET_MASK_ID, entry);
	}

	const remotes = [...new Set(identity.remotes)].filter((r) => r.length >= 8).sort((a, b) => b.length - a.length);
	if (remotes.length > 0)
		out = out.replace(new RegExp(remotes.map(escapeRegExp).join("|"), "gu"), (match) => mask("remote", match));
	out = out.replace(SCP_REMOTE, (match) =>
		/:iowarp\//iu.test(match) && PUBLIC_GIT_HOSTS.has(match.slice(match.indexOf("@") + 1, match.indexOf(":")))
			? match
			: mask("remote", match),
	);
	out = out.replace(URL_PATTERN, (match) => {
		let url = match;
		let tail = TRAILING_PUNCTUATION.exec(url)?.[0] ?? "";
		url = url.slice(0, url.length - tail.length);
		if (url.endsWith(")") && !url.includes("(")) {
			tail = `)${tail}`;
			url = url.slice(0, -1);
		}
		return `${isPublicUrl(url) ? url : mask("url", url)}${tail}`;
	});
	out = out.replace(EMAIL, (match) => mask("email", match));

	const root = identity.packageRoot;
	if (root !== null && root.length > 1)
		out = out.replace(
			new RegExp(`${escapeRegExp(root)}((?:[/\\\\]${SEG})*)(?![A-Za-z0-9._~@%+=-])`, "gu"),
			(_match, rest: string) => `clio-coder${rest.replaceAll("\\", "/")}`,
		);
	const paths = [...new Set(identity.paths)].filter((p) => p.length > 1).sort((a, b) => b.length - a.length);
	if (paths.length > 0)
		out = out.replace(
			new RegExp(`(?:${paths.map(escapeRegExp).join("|")})(?:[/\\\\](?:${SPACED_DIR}|${SEG}))*${SEG_END}`, "gu"),
			(match) => mask("path", match),
		);
	const pathMask = (match: string) => {
		const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
		return `${mask("path", match.slice(0, match.length - tail.length))}${tail}`;
	};
	out = out.replace(GENERIC_PATH, pathMask);
	out = out.replace(WINDOWS_PATH, pathMask);
	out = out.replace(IPV4, (match) => (isPublicIp(match) ? match : mask("ip", match)));
	out = out.replace(IPV6, (match) =>
		!isIPv6(match) || !/\d/u.test(match) || match === "::1" ? match : mask("ip", match),
	);

	const kinds = new Map<string, IdentityKind>();
	for (const { value, kind } of identity.names) {
		const trimmed = value.trim();
		if (usableName(trimmed) && !kinds.has(trimmed.toLowerCase())) kinds.set(trimmed.toLowerCase(), kind);
	}
	const byLength = (a: string, b: string) => b.length - a.length;
	const long = [...kinds.keys()].filter((name) => name.length >= CANARY_MIN_LENGTH).sort(byLength);
	const short = [...kinds.keys()].filter((name) => name.length < CANARY_MIN_LENGTH).sort(byLength);
	const maskName = (match: string) => mask(kinds.get(match.toLowerCase()) ?? "user", match);
	// A name the canary would find is masked wherever a letter or digit does not continue it: `jdoe-laptop`,
	// `webapp.config.ts`, `id_jdoe`, and after a `\n` escape or a `%2F`. It is masked on screen (and unmaskable) instead
	// of refused at Send. A shorter name the canary skips keeps the stricter boundaries, so a compound word keeps it.
	if (long.length > 0)
		out = out.replace(
			new RegExp(`${NAME_START}(?:${long.map(escapeRegExp).join("|")})(?![A-Za-z0-9])`, "giu"),
			(match: string, offset: number, whole: string) =>
				insideHarnessWord(whole, offset, offset + match.length) ? match : maskName(match),
		);
	if (short.length > 0)
		out = out.replace(
			new RegExp(`(?<![A-Za-z0-9_.-])(?:${short.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "giu"),
			maskName,
		);
	return out;
}

/**
 * Remove this machine's identifiers from free text: secrets first, then remotes, URLs that are not Clio's own,
 * e-mail addresses, paths (Clio's own keep their package-relative tail), IP literals, and the user, host, project,
 * branch, remote and target names as whole words. Every pattern starts only at a boundary, so the work stays
 * linear in the text. The result is scrubbed again until nothing changes, so it is a fixed point.
 */
export function scrubText(text: string, identity: LocalIdentity, unmasked: ReadonlyArray<string> = []): ScrubResult {
	const allowed = new Set(unmasked.filter((id) => id !== SECRET_MASK_ID));
	const masks = new Map<string, ReportMask>();
	let out = text;
	for (let round = 0; round < 4; round += 1) {
		const next = scrubOnce(out, identity, allowed, masks);
		if (next === out) break;
		out = next;
	}
	return { text: out, masks: [...masks.values()] };
}

/** Merge mask lists from several scrubbed fields into one list, counts summed. */
export function mergeMasks(lists: ReadonlyArray<ReadonlyArray<ReportMask>>): ReportMask[] {
	const merged = new Map<string, ReportMask>();
	for (const list of lists)
		for (const mask of list) {
			const entry = merged.get(mask.id);
			if (entry) entry.count += mask.count;
			else merged.set(mask.id, { ...mask });
		}
	return [...merged.values()];
}

interface ParsedRemote {
	host: string;
	owner: string;
	repo: string;
}

function parseRemote(url: string): ParsedRemote | null {
	const match =
		/^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):\/?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url) ??
		/^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(?:.*\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(
			url,
		);
	return match ? { host: (match[1] ?? "").toLowerCase(), owner: match[2] ?? "", repo: match[3] ?? "" } : null;
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

export interface IdentitySettings {
	targets?: ReadonlyArray<{ id: string; url?: string | undefined }>;
}

/**
 * Gather what this machine knows about itself: user names, host name long and short, home directory, workspace root
 * and its base name, git remotes with their hosts, owners and repository names, git `user.name` and `user.email`, the
 * current branch, and the host and id of every configured target. Nothing here leaves the machine.
 */
export async function localIdentity(
	cwd: string,
	settings: IdentitySettings = {},
	deps: { run?: ReportCommandRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<LocalIdentity> {
	const run = deps.run ?? runReportCommand;
	const env = deps.env ?? process.env;
	const names: LocalIdentity["names"] = [];
	const paths: string[] = [];
	const remotes: string[] = [];
	const add = (kind: IdentityKind, value: string | undefined | null) => {
		if (value) names.push({ kind, value });
	};
	try {
		add("user", userInfo().username);
	} catch {
		// A uid with no passwd entry has no name to mask; USER and LOGNAME below still apply.
	}
	add("user", env.USER);
	add("user", env.LOGNAME);
	const host = hostname();
	add("host", host);
	add("host", host.split(".")[0]);
	const home = homedir();
	if (home) paths.push(home);

	let workspace = cwd;
	const git = async (args: string[]) => {
		try {
			const result = await run("git", ["-C", cwd, ...args], { timeoutMs: 5000 });
			return result.exitCode === 0 ? result.stdout : "";
		} catch {
			// No git, or not a repository: the workspace is then only the working directory.
			return "";
		}
	};
	const [head, config] = await Promise.all([
		git(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]),
		git(["config", "--get-regexp", "^(remote\\..*\\.url|user\\.name|user\\.email)$"]),
	]);
	const [top, branch] = head.split("\n").map((line) => line.trim());
	if (top) workspace = top;
	if (branch && branch !== "HEAD") add("branch", branch);
	for (const line of config.split("\n")) {
		const space = line.indexOf(" ");
		if (space < 0) continue;
		const key = line.slice(0, space);
		const value = line.slice(space + 1).trim();
		if (key === "user.name") {
			add("user", value);
			for (const part of value.split(/\s+/u)) add("user", part);
		} else if (key === "user.email") add("user", value.split("@")[0]);
		else if (key.endsWith(".url")) {
			const parsed = parseRemote(value);
			if (parsed && parsed.owner.toLowerCase() === PUBLIC_OWNER && PUBLIC_GIT_HOSTS.has(parsed.host)) continue;
			remotes.push(value);
			if (!parsed) continue;
			if (!PUBLIC_GIT_HOSTS.has(parsed.host)) add("host", parsed.host);
			add("remote", `${parsed.owner}/${parsed.repo}`);
			add("remote", parsed.owner);
			add("remote", parsed.repo);
		}
	}
	paths.push(workspace);
	if (workspace !== cwd) paths.push(cwd);
	add("project", basename(workspace));

	for (const target of settings.targets ?? []) {
		if (!isBuiltinRuntimeId(target.id)) add("target", target.id);
		const targetHost = target.url ? hostOf(target.url) : null;
		if (targetHost && !/^[\d.]+$/u.test(targetHost) && !targetHost.startsWith("[")) add("host", targetHost);
	}
	let packageRoot: string | null = null;
	try {
		packageRoot = inspectInstallation().root.replace(new RegExp(`${escapeRegExp(sep)}$`, "u"), "");
	} catch {
		// Without a package root, Clio's own paths are masked like any other.
	}
	return { packageRoot, paths, remotes, names };
}
