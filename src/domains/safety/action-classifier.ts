import path from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import { extractCommandWriteTargets } from "./protected-artifacts.js";

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

const SYSTEM_WRITE_ROOT_PREFIXES: ReadonlyArray<string> = ["/etc", "/usr", "/var", "/bin", "/sbin"];

function baseClassify(tool: string): ActionClass | null {
	switch (tool) {
		case ToolNames.Read:
		case ToolNames.Grep:
		case ToolNames.Glob:
		case ToolNames.Ls:
		case ToolNames.WebFetch:
		case ToolNames.WorkspaceContext:
			return "read";
		case ToolNames.Write:
		case ToolNames.Edit:
		case ToolNames.WritePlan:
		case ToolNames.WriteReview:
			return "write";
		case ToolNames.Bash:
			return "execute";
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

function resolveCandidate(p: string): string {
	// ~ expansion is not performed here; any ~-prefixed path is treated as an
	// absolute user-home reference. We keep it as-is so the caller-visible
	// string drives the escape check, and classify conservatively as modify.
	if (p.startsWith("~")) return p;
	if (path.isAbsolute(p)) return path.resolve(p);
	return path.resolve(process.cwd(), p);
}

function isInsideCwd(abs: string): boolean {
	const cwd = path.resolve(process.cwd());
	const rel = path.relative(cwd, abs);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function writePathClass(pathArg: string): { cls: "system_modify" | "write"; reason?: string } {
	if (pathArg.startsWith("~")) {
		return { cls: "system_modify", reason: `write-path-home-escape: ${pathArg}` };
	}
	const abs = resolveCandidate(pathArg);
	for (const prefix of SYSTEM_WRITE_ROOT_PREFIXES) {
		if (abs === prefix || abs.startsWith(`${prefix}/`)) {
			return { cls: "system_modify", reason: `write-path-system-root: ${prefix}` };
		}
	}
	if (!isInsideCwd(abs)) {
		return { cls: "system_modify", reason: `write-path-outside-cwd: ${abs}` };
	}
	return { cls: "write" };
}

function extractWritePath(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
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
		// super-mode gate by emitting `echo X > /tmp/foo.txt` after the user
		// cancels the original write call.
		const command = typeof call.args?.command === "string" ? call.args.command : null;
		if (command !== null) {
			const targetReasons: string[] = [];
			for (const target of extractCommandWriteTargets(command)) {
				const decision = writePathClass(target);
				if (decision.cls === "system_modify") {
					targetReasons.push(decision.reason ?? `bash-write-target: ${target}`);
				}
			}
			if (targetReasons.length > 0) {
				return { actionClass: "system_modify", reasons: targetReasons };
			}
		}
		return { actionClass: "execute", reasons };
	}

	if (base === "write") {
		const pathArg = extractWritePath(call.args);
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
