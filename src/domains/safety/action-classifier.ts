import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import { extractCommandCdTargets, extractCommandWriteTargets } from "./protected-artifacts.js";

/**
 * Deterministic action classifier for tool calls. Pure function, no I/O, no
 * state. Slice 3 wires it into dispatch admission and audit. This module only
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
		case ToolNames.Read:
		case ToolNames.Grep:
		case ToolNames.Find:
		case ToolNames.Ls:
		case ToolNames.WebFetch:
		case ToolNames.Git:
		case ToolNames.CodeNav:
		case ToolNames.Context:
		case ToolNames.Monitor:
		case ToolNames.AskUser:
		case ToolNames.CredentialPresent:
		// tasks mutates only the session's task ledger, never the workspace,
		// so it stays read class and is never gated behind a confirmation.
		case ToolNames.Tasks:
		// ledger posts a typed contribution to a coordination board and reads a
		// local mirror. Neither touches the workspace, so it is never gated
		// behind a confirmation.
		case ToolNames.Ledger:
			return "read";
		case ToolNames.Write:
		case ToolNames.Edit:
		case ToolNames.Artifact:
			return "write";
		case ToolNames.Bash:
		case ToolNames.Verify:
			return "execute";
		case ToolNames.Dispatch:
		case ToolNames.Steer:
			return "dispatch";
		default:
			return null;
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

function resolveCandidate(p: string, baseCwd?: string): string {
	// ~ expansion is not performed here; any ~-prefixed path is treated as an
	// absolute user-home reference. We keep it as-is so the caller-visible
	// string drives the escape check, and classify conservatively as modify.
	if (p.startsWith("~")) return p;
	const base = canonicalizeExistingPath(path.resolve(baseCwd ?? process.cwd()));
	const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
	return canonicalizeExistingPath(resolved);
}

function isInsideCwd(abs: string): boolean {
	const cwd = canonicalizeExistingPath(path.resolve(process.cwd()));
	const candidate = canonicalizeExistingPath(abs);
	const rel = path.relative(cwd, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function writePathClass(pathArg: string, baseCwd?: string): { cls: "system_modify" | "write"; reason?: string } {
	if (pathArg.startsWith("~")) {
		return { cls: "system_modify", reason: `write-path-home-escape: ${pathArg}` };
	}
	const abs = resolveCandidate(pathArg, baseCwd);
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

/**
 * The artifact tool writes a default file name when the call names no path, so
 * a classifier that only reads the path argument saw no target at all and
 * returned plain write for a call that writes into whatever the cwd is. The
 * live evidence: in a `/var/tmp` workspace where write, edit and every bash
 * redirect were refused as system_modify, `artifact(kind:"report")` wrote
 * REPORT.md into that same directory. The policy engine's write-root check
 * already resolves these defaults; this keeps the two in agreement.
 */
function artifactDefaultPath(args: Record<string, unknown> | undefined): string {
	const kind = args?.kind;
	return kind === "review" ? "REVIEW.md" : kind === "report" ? "REPORT.md" : "PLAN.md";
}

function extractWritePath(tool: string, args: Record<string, unknown> | undefined): string | null {
	const candidate = args?.path ?? args?.file_path ?? args?.filePath;
	if (typeof candidate === "string" && candidate.length > 0) return candidate;
	return tool === ToolNames.Artifact ? artifactDefaultPath(args) : null;
}

export function classify(call: ClassifierCall): Classification {
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
			const targetReasons: string[] = [];
			for (const target of extractCommandWriteTargets(command)) {
				const decision = writePathClass(target, argCwd);
				if (decision.cls === "system_modify") {
					targetReasons.push(decision.reason ?? `bash-write-target: ${target}`);
				}
			}
			// A `cd` outside the workspace re-bases every relative path after it,
			// so static write-target extraction stops describing what the command
			// touches. Escalate through the same system_modify confirm gate as an
			// out-of-workspace write target; inside-workspace `cd` stays plain
			// execute.
			for (const target of extractCommandCdTargets(command)) {
				if (target.startsWith("~")) {
					targetReasons.push(`bash-cd-home-escape: ${target}`);
					continue;
				}
				const abs = resolveCandidate(target, argCwd);
				if (!isInsideCwd(abs)) {
					targetReasons.push(`bash-cd-outside-workspace: ${abs}`);
				}
			}
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
