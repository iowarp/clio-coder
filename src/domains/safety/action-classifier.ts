import { homedir } from "node:os";
import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { canonicalizeExistingPath, canonicalizePath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { isHarnessExtensionToolName, ToolNames } from "../../core/tool-names.js";
import { type CommandPathEvent, extractCommandPathWalk } from "./protected-artifacts.js";

/**
 * Deterministic action classifier for tool calls. Pure function, no I/O, no
 * state. Dispatch admission and tool audit consume it. This module only
 * owns the mapping from (tool, args) to an ActionClass.
 */

export type ActionClass = "read" | "write" | "execute" | "dispatch" | "system_modify" | "git_destructive" | "unknown";

export interface ClassifierCall {
	tool: string;
	args?: Record<string, unknown>;
}

export interface Classification {
	actionClass: ActionClass;
	reasons: ReadonlyArray<string>;
}

interface NamedPattern {
	name: string;
	re: RegExp;
}

const GIT_DESTRUCTIVE_PATTERNS: ReadonlyArray<NamedPattern> = [
	{ name: "git-push-force-long", re: /\bgit\s+push\s+--force\b/i },
	{ name: "git-push-force-short", re: /\bgit\s+push\s+-f\b/i },
	{ name: "git-reset-hard", re: /\bgit\s+reset\s+--hard\b/i },
	{ name: "git-clean-fd", re: /\bgit\s+clean\s+-fd?\b/i },
	{ name: "git-checkout-dot", re: /\bgit\s+checkout\s+--\s+\./i },
	{ name: "git-branch-D", re: /\bgit\s+branch\s+-D\b/i },
	{ name: "git-restore-source", re: /\bgit\s+restore\s+--source\b/i },
];

const SYSTEM_MODIFY_PATTERNS: ReadonlyArray<NamedPattern> = [
	{ name: "sudo-or-doas", re: /\b(sudo|doas)\b/i },
	// allow rm -rf /tmp/... and /var/tmp/... but flag everything else rooted at /
	{ name: "rm-rf-root", re: /\brm\s+-rf?\s+\/(?!(tmp|var\/tmp)(?:\/|\s|$))/i },
	{ name: "apt-install", re: /\bapt(-get)?\s+(install|remove|purge)/i },
	{ name: "brew-install", re: /\bbrew\s+(install|uninstall|reinstall)/i },
	{ name: "npm-install-global", re: /\bnpm\s+install\s+-g\b/i },
	{ name: "pip-install", re: /\bpip\s+install\b/i },
	{ name: "systemctl", re: /\bsystemctl\s+/i },
	{ name: "chmod-root", re: /\bchmod\s+[0-7]{3,4}\s+\//i },
	{ name: "chown", re: /\bchown\s+/i },
];

/**
 * `/run` is here because path resolution canonicalizes symlinks: on every
 * systemd distribution `/var/run` is a symlink to `/run` and `/var/lock` to
 * `/run/lock`, so a write aimed at either landed on a path no prefix covered
 * and escaped the system-root rule whenever the workspace happened to sit
 * under it. Found while auditing the `/var` subdirectories for the carve-out
 * below.
 */
const SYSTEM_WRITE_ROOT_PREFIXES: ReadonlyArray<string> = ["/etc", "/usr", "/var", "/bin", "/sbin", "/run"];

/**
 * Temp trees that sit under a protected root but are ordinary scratch space,
 * not system state. `/var/tmp` is the FHS's persistent temp directory and
 * `/var/folders` is macOS's per-user temp tree, and both are where an operator
 * or a harness puts a throwaway workspace. Classifying them as system_modify
 * made every mutating call from a workspace there require a confirmation, which
 * headless runs answer with a denial: a `clio-coder run` in a `/var/tmp` sandbox
 * could not write one byte, and the model's recovery was to report work it had
 * not done. The exemption is a carve-out rather than an enumeration of the
 * system directories under `/var` on purpose: `/var/log`, `/var/lib`,
 * `/var/spool`, `/var/db` and every other subdirectory, including ones this
 * list has never heard of, stay exactly as protected as before.
 *
 * `rm -rf` already reads the same line (SYSTEM_MODIFY_PATTERNS rm-rf-root
 * exempts `/tmp` and `/var/tmp`), so the two checks now agree.
 */
const SYSTEM_WRITE_EXEMPT_PREFIXES: ReadonlyArray<string> = ["/var/tmp", "/var/folders"];

function isUnderPrefix(abs: string, prefix: string): boolean {
	return abs === prefix || abs.startsWith(`${prefix}/`);
}

function baseClassify(tool: string): ActionClass | null {
	switch (tool) {
		case ToolNames.Evidence:
		case ToolNames.Read:
		case ToolNames.Grep:
		case ToolNames.Find:
		case ToolNames.Ls:
		// web_read is the GET-only half of the web split: no method, headers,
		// or body can make it outward, so it is read class unconditionally.
		case ToolNames.WebRead:
		case ToolNames.WebFetch:
		case ToolNames.Git:
		case ToolNames.CodeNav:
		case ToolNames.Context:
		// clio_docs and clio_library read Clio's bundled documentation and the
		// recipe catalog; data streams structured files. None writes.
		case ToolNames.ClioDocs:
		case ToolNames.ClioLibrary:
		case ToolNames.Data:
		// gateway lists and describes capabilities on its own; a call carries
		// the capability's own class through a nested admission, so the outer
		// call stays read class.
		case ToolNames.Gateway:
		case ToolNames.Monitor:
		case ToolNames.AskUser:
		case ToolNames.CredentialPresent:
		// tasks pick mutates only Clio-owned session-ledger and project-local
		// .clio-coder runtime state, never source-workspace files. By intentional
		// policy it stays read class and ungated; the tool itself still requires
		// a durable operator task id before it can mutate either store.
		case ToolNames.Tasks:
		// ledger posts a typed contribution to a coordination board and reads a
		// local mirror. Neither touches the workspace, so it is never gated
		// behind a confirmation.
		case ToolNames.Ledger:
		// panes focuses, opens, and closes terminal panes Clio itself created, in
		// a pane host that lives outside the workspace. Nothing it does writes a
		// file, runs a model-supplied command (its schema exposes presets only),
		// or survives the session, so it is reversible, local, and never gated
		// behind a confirmation.
		case ToolNames.Panes:
		// limitation appends a typed receipt to the session ledger and touches
		// nothing else, so it is never gated behind a confirmation.
		case ToolNames.Limitation:
		// decide appends the model's own design decision to the session
		// decision board. One ledger append, no workspace effect, never gated.
		case ToolNames.Decide:
			return "read";
		case ToolNames.Write:
		case ToolNames.Edit:
		case ToolNames.Artifact:
			return "write";
		case ToolNames.Bash:
		case ToolNames.Verify:
		// run_script runs an interpreter over a workspace script; its
		// safetyCall projects the exact argv to a bash command so the policy
		// engine applies the shell rules to it.
		case ToolNames.RunScript:
			return "execute";
		case ToolNames.Dispatch:
		case ToolNames.Steer:
			return "dispatch";
		default:
			return isHarnessExtensionToolName(tool) ? "execute" : null;
	}
}

function scanStringOf(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const parts: string[] = [];
	for (const value of Object.values(args)) {
		if (value == null) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			parts.push(String(value));
		} else {
			try {
				parts.push(JSON.stringify(value));
			} catch {
				// ignore values that cannot be serialized
			}
		}
	}
	return parts.join(" ");
}

function matchFirst(patterns: ReadonlyArray<NamedPattern>, haystack: string): NamedPattern | null {
	for (const p of patterns) {
		if (p.re.test(haystack)) return p;
	}
	return null;
}

/**
 * The directory a bash call runs in. The bash tool resolves its cwd argument
 * lexically (resolveSafeCwd) and the kernel follows links on chdir, so this
 * reads it the same way.
 */
function candidateBase(baseCwd?: string): string {
	return canonicalizeExistingPath(path.resolve(baseCwd ?? process.cwd()));
}

/**
 * Where a write through a model-supplied path lands. The kernel resolves an
 * open or a redirect one component at a time, so `data/link/../x` lands beside
 * the link's target, not in `data`. Null when the path cannot be canonicalized.
 */
function resolveCandidate(p: string, baseCwd?: string): string | null {
	// ~ expansion is not performed here; any ~-prefixed path is treated as an
	// absolute user-home reference. We keep it as-is so the caller-visible
	// string drives the escape check, and classify conservatively as modify.
	if (p.startsWith("~")) return p;
	return canonicalizeRawPath(p, candidateBase(baseCwd));
}

/**
 * Where a shell `cd` lands, under both readings. A shell `cd` is logical by
 * default: it collapses `link/..` against the path it names and then follows
 * links. `cd -P` and `set -P` walk physically instead. Null for a reading that
 * cannot be canonicalized.
 */
function resolveCdCandidates(target: string, baseCwd?: string): Array<string | null> {
	const base = candidateBase(baseCwd);
	const logical = canonicalizePath(path.resolve(base, target));
	const physical = canonicalizeRawPath(target, base);
	return logical === physical ? [logical] : [logical, physical];
}

// A path that cannot be canonicalized (a link loop, too many links) is
// outside, never inside: nothing proves where a write through it lands.
function isInsideCwd(abs: string): boolean {
	const cwd = canonicalizePath(path.resolve(process.cwd()));
	const candidate = canonicalizePath(abs);
	if (cwd === null || candidate === null) return false;
	const rel = path.relative(cwd, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function writePathClass(pathArg: string, baseCwd?: string): { cls: "system_modify" | "write"; reason?: string } {
	if (pathArg.startsWith("~")) {
		return { cls: "system_modify", reason: `write-path-home-escape: ${pathArg}` };
	}
	const abs = resolveCandidate(pathArg, baseCwd);
	// Nothing proves where a write through an unresolvable path lands.
	if (abs === null) return { cls: "system_modify", reason: `write-path-outside-cwd: ${pathArg}` };
	const exempt = SYSTEM_WRITE_EXEMPT_PREFIXES.some((prefix) => isUnderPrefix(abs, prefix));
	if (!exempt) {
		for (const prefix of SYSTEM_WRITE_ROOT_PREFIXES) {
			if (isUnderPrefix(abs, prefix)) {
				return { cls: "system_modify", reason: `write-path-system-root: ${prefix}` };
			}
		}
	}
	if (!isInsideCwd(abs)) {
		return { cls: "system_modify", reason: `write-path-outside-cwd: ${abs}` };
	}
	return { cls: "write" };
}

/** More directories than this after a run of cds is treated as an unknown base. */
const MAX_SHELL_BASES = 32;

/** A word the shell expands at run time: a variable, a substitution, or a glob. */
function isDynamicShellPath(p: string): boolean {
	return /[$`*?[]/u.test(p);
}

function expandShellHome(p: string): string | null {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
	return p.startsWith("~") ? null : p;
}

/** Where the shell can be; null once a cd leaves it unknown. */
type ShellBases = string[] | null;

function mergeBases(left: ShellBases, right: ShellBases): ShellBases {
	if (left === null || right === null) return null;
	const merged = [...new Set([...left, ...right])];
	return merged.length > MAX_SHELL_BASES ? null : merged;
}

/**
 * Reasons a bash command reaches outside the workspace through the paths it
 * names. The walk keeps every directory the shell can be in and resolves each
 * relative write, cd, and link from all of them.
 *
 * A cd adds where it lands under both readings and keeps where the shell was,
 * because the cd may fail. Two forms say it did not: after `cd X && ...` the
 * rest of the chain runs only if the cd succeeded, so the old directories wait
 * in `pending` and come back when the chain breaks at `;`, a newline, `||`, or
 * `&` (a compound command's inner `;` does not break it); after
 * `cd X || exit` they are gone. A cd reached through `||` or `|`, or negated
 * with `!`, keeps them. A subshell's cds end at its `)`, and `popd` can return
 * to any directory the shell was in. A cd the shell expands at run time, or one a loop, a
 * function, or CDPATH can repeat or redirect, leaves the base unknown, and a
 * relative write after it cannot be placed.
 */
function bashPathReasons(command: string, argCwd: string | undefined): string[] {
	const writeReasons = new Set<string>();
	const cdReasons = new Set<string>();
	const events = extractCommandPathWalk(command);
	let bases: ShellBases = [candidateBase(argCwd)];
	let pending: ShellBases = [];
	let visited: ShellBases = bases;
	const subshells: Array<{ bases: ShellBases; pending: ShellBases }> = [];
	const groups: ShellBases[] = [];
	let previous = ";";
	const fromEachBase = (target: string, check: (base: string | undefined) => void): boolean => {
		if (target.startsWith("~") || path.isAbsolute(target)) {
			check(undefined);
			return true;
		}
		if (bases === null) return false;
		for (const base of bases) check(base);
		return true;
	};
	for (const [index, event] of events.entries()) {
		if (event.kind === "separator") {
			if (event.value === "(") {
				subshells.push({ bases, pending });
				pending = [];
			} else if (event.value === ")") {
				const outer = subshells.pop();
				if (outer !== undefined) ({ bases, pending } = outer);
			} else if (event.value !== "&&" && event.value !== "|") {
				// A pipeline binds tighter than `&&`, so `|` does not break a chain.
				bases = mergeBases(bases, pending);
				pending = [];
			}
			previous = event.value;
			continue;
		}
		if (event.kind === "write") {
			const placed = fromEachBase(event.target, (base) => {
				const decision = writePathClass(event.target, base);
				if (decision.cls === "system_modify") writeReasons.add(decision.reason ?? `bash-write-target: ${event.target}`);
			});
			if (!placed) writeReasons.add(`write-path-unknown-base: ${event.target}`);
			continue;
		}
		if (event.kind === "link") {
			for (const reason of linkReasons(event, bases)) writeReasons.add(reason);
			continue;
		}
		if (event.kind === "group") {
			// A compound command's inner `;` does not break the chain around it.
			if (event.open) {
				groups.push(pending);
				pending = [];
			} else {
				pending = mergeBases(groups.pop() ?? [], pending);
			}
			continue;
		}
		if (event.kind === "popd") {
			bases = mergeBases(bases, visited);
			continue;
		}
		if (event.kind === "exit") continue;
		const target = event.target;
		if (target.startsWith("~")) {
			cdReasons.add(`bash-cd-home-escape: ${target}`);
			continue;
		}
		if (isDynamicShellPath(target)) {
			bases = null;
			continue;
		}
		const from = path.isAbsolute(target) ? [undefined] : (bases ?? []);
		const landed: string[] = [];
		for (const base of from) {
			for (const landing of resolveCdCandidates(target, base)) {
				// Inside means inside under the logical and the physical reading.
				if (landing === null || !isInsideCwd(landing)) cdReasons.add(`bash-cd-outside-workspace: ${landing ?? target}`);
				else landed.push(landing);
			}
		}
		// A relative cd from an unknown base lands somewhere unknown too.
		if (event.unmodeled || bases === null) {
			bases = null;
			continue;
		}
		const outcome = event.mayFail || previous === "||" || previous === "|" ? "may-fail" : cdOutcome(events, index);
		if (outcome === "chained") pending = mergeBases(pending, bases);
		bases = outcome === "may-fail" ? mergeBases(bases, landed) : mergeBases([], landed);
		visited = mergeBases(visited, landed);
	}
	return [...writeReasons, ...cdReasons];
}

/**
 * What the commands after a cd assume about it. `cd X && ...` runs the rest
 * only if the cd succeeded (`chained`); `cd X || exit` ends the shell if it
 * failed (`required`); anything else runs either way.
 */
function cdOutcome(events: ReadonlyArray<CommandPathEvent>, index: number): "chained" | "required" | "may-fail" {
	const separators = events
		.map((event, at) => ({ event, at }))
		.filter(({ event, at }) => at > index && event.kind === "separator");
	const next = separators[0];
	if (next?.event.kind !== "separator") return "may-fail";
	if (next.event.value === "&&") return "chained";
	if (next.event.value !== "||") return "may-fail";
	const after = separators[1];
	const branch = events.slice(next.at + 1, after?.at ?? events.length);
	const ends = after?.event.kind !== "separator" || !["&&", "||", "|"].includes(after.event.value);
	return ends && branch.some((event) => event.kind === "exit") ? "required" : "may-fail";
}

/**
 * A link a command creates is followed by every later path through it, which
 * static admission cannot model. A symbolic link whose text, resolved from the
 * link's directory, leaves the workspace escalates the command, and so does a
 * hard link to a file outside it, since a write through the link changes that
 * file. A link whose target or directory the shell expands at run time counts
 * as outside.
 */
function linkReasons(event: { symbolic: boolean; sources: string[]; linkDirs: string[] }, bases: ShellBases): string[] {
	const reasons: string[] = [];
	const label = event.symbolic ? "bash-symlink-outside-workspace" : "bash-hardlink-outside-workspace";
	const outside = (source: string, from: string | null): string | null => {
		const expanded = expandShellHome(source);
		if (expanded === null || isDynamicShellPath(source)) return source;
		if (!path.isAbsolute(expanded) && from === null) return source;
		const landing = canonicalizeRawPath(expanded, from ?? process.cwd());
		return landing !== null && isInsideCwd(landing) ? null : (landing ?? source);
	};
	const dirsFrom = (base: string | null): Array<string | null> => {
		if (!event.symbolic) return [base];
		return event.linkDirs.map((dir) => {
			const expanded = expandShellHome(dir);
			if (expanded === null || isDynamicShellPath(dir)) return null;
			if (!path.isAbsolute(expanded) && base === null) return null;
			return canonicalizeRawPath(expanded, base ?? process.cwd());
		});
	};
	for (const base of bases ?? [null]) {
		for (const from of dirsFrom(base)) {
			for (const source of event.sources) {
				const landing = outside(source, from);
				if (landing !== null) reasons.push(`${label}: ${landing}`);
			}
		}
	}
	return [...new Set(reasons)];
}

/**
 * The artifact tool writes a default file name when the call names no path, so
 * a classifier that only reads the path argument saw no target at all and
 * returned plain write for a call that writes into whatever the cwd is. The
 * live evidence: in a `/var/tmp` workspace where write, edit and every bash
 * redirect were refused as system_modify, `artifact(kind:"report")` wrote a
 * report into that same directory. The default now resolves through
 * core/artifact-paths.ts, the one place the tool, the write-root check, and the
 * protected-artifacts guard all read, so the four can never disagree.
 */
function extractWritePath(tool: string, args: Record<string, unknown> | undefined): string | null {
	const candidate = args?.path ?? args?.file_path ?? args?.filePath;
	if (typeof candidate === "string" && candidate.length > 0) return candidate;
	return tool === ToolNames.Artifact ? artifactDefaultPath(args?.kind) : null;
}

/** Shared by classification and registry exposure; an empty body still sends data. */
export function webFetchIsOutward(args: Record<string, unknown> | undefined): boolean {
	const method = typeof args?.method === "string" && args.method.length > 0 ? args.method.toUpperCase() : "GET";
	return (method !== "GET" && method !== "HEAD") || args?.body !== undefined;
}

export function classify(call: ClassifierCall): Classification {
	if (call.tool === ToolNames.WebFetch && webFetchIsOutward(call.args)) {
		return { actionClass: "write", reasons: ["web-fetch:outward"] };
	}
	const base = baseClassify(call.tool);
	if (base === null) {
		return { actionClass: "unknown", reasons: [`unknown tool: ${call.tool}`] };
	}

	const reasons: string[] = [];

	if (call.tool === ToolNames.Bash) {
		const scan = scanStringOf(call.args);
		const gitHit = matchFirst(GIT_DESTRUCTIVE_PATTERNS, scan);
		if (gitHit) {
			return { actionClass: "git_destructive", reasons: [`pattern:${gitHit.name}`] };
		}
		const sysHit = matchFirst(SYSTEM_MODIFY_PATTERNS, scan);
		if (sysHit) {
			return { actionClass: "system_modify", reasons: [`pattern:${sysHit.name}`] };
		}
		// Apply the same path-class gate we use for the write tool to every
		// shell write-target the command exposes (redirects, tee, cp/mv
		// destinations). Without this the model can dodge the write tool's
		// confirmation gate by emitting `echo X > /tmp/foo.txt` after the user
		// cancels the original write call. Relative write targets are
		// resolved against the bash call's explicit cwd argument when
		// supplied so a model cannot launder a write outside the workspace
		// by combining a relative redirect with a cwd outside the workspace.
		const command = typeof call.args?.command === "string" ? call.args.command : null;
		const argCwd = typeof call.args?.cwd === "string" && call.args.cwd.length > 0 ? call.args.cwd : undefined;
		if (command !== null) {
			const targetReasons = bashPathReasons(command, argCwd);
			if (targetReasons.length > 0) {
				return { actionClass: "system_modify", reasons: targetReasons };
			}
		}
		return { actionClass: "execute", reasons };
	}

	if (base === "write") {
		const pathArg = extractWritePath(call.tool, call.args);
		if (pathArg) {
			const decision = writePathClass(pathArg);
			if (decision.cls === "system_modify") {
				return { actionClass: "system_modify", reasons: decision.reason ? [decision.reason] : [] };
			}
		}
		return { actionClass: "write", reasons };
	}

	return { actionClass: base, reasons };
}
