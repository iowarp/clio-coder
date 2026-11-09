import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { isVerificationScriptName, VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import { type DeclaredCheck, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "./catalog.js";
import { type DeclaredCheckDiscoveryResult, discoverDeclaredChecksAtRoot } from "./discovery.js";
import { prepareVerifyArguments } from "./surface.js";
import { findTaskGate, taskGateCheck, taskGateFallbackHint, taskGatesConfined } from "./task-gates.js";
import { resolveCleanRunArgv } from "./toolchain.js";
import {
	discoverToolchainChecks,
	TOOLCHAIN_DISCOVERY_SOURCES,
	type ToolchainCheck,
	toolchainArgv,
} from "./toolchain-checks.js";

/**
 * What one verify call runs. The tool executes the resolution and the safety
 * policy engine scans it, so the two can never disagree about the command: a
 * model-supplied check string runs only when it names a declared or derived
 * check, and every other string resolves to `unresolved`, which runs nothing.
 */
export type VerifyResolution =
	| { kind: "list" }
	| { kind: "frontend" }
	/** `run` is the repository-relative run directory a `runs` check judges; its argv already ends with it. */
	| { kind: "catalog"; check: DeclaredCheck; run?: string }
	| { kind: "package"; check: DeclaredCheck; packageRoot: string }
	| { kind: "toolchain"; check: ToolchainCheck; argv: string[] }
	/** A gate the dispatched verifier task names; `confined` is the worker's OS sandbox, read by the safety scan. */
	| { kind: "task"; check: DeclaredCheck; confined: boolean }
	| { kind: "unavailable"; check: ToolchainCheck }
	| { kind: "unresolved"; message: string };

const FAMILY_WORDS = new Set(["test", "lint", "check", "typecheck", "format", "build", "ci"]);

function extraArgs(args: Record<string, unknown>): string[] {
	return Array.isArray(args.args) ? args.args.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Derived checks that no package script or catalog entry already owns by id. */
export function availableToolchainChecks(
	workspaceRoot: string,
	declared: ReadonlyArray<DeclaredCheck>,
	diagnostics?: string[],
): ToolchainCheck[] {
	const taken = new Set(declared.map((check) => check.id));
	return discoverToolchainChecks(workspaceRoot, diagnostics).filter((check) => !taken.has(check.id));
}

function nothingDeclared(root: string, diagnostics: ReadonlyArray<string>): string {
	const skipped = diagnostics.length > 0 ? ` Skipped during discovery: ${diagnostics.join(" ")}` : "";
	const fallback =
		taskGateFallbackHint() || " Run the repository's documented test or gate command through bash instead.";
	return `no declared or derivable verification checks in ${root}. Looked for ${TOOLCHAIN_DISCOVERY_SOURCES}.${fallback}${skipped}`;
}

interface VerifyDiscoveryCache {
	discovery: DeclaredCheckDiscoveryResult;
	derived: (declared: ReadonlyArray<DeclaredCheck>) => ToolchainCheck[];
}

/** One fresh root discovery per assessment; normal admission/execution still resolves each call independently. */
export function createRootVerifyResolver(workspaceRoot: string): (check: string) => VerifyResolution {
	const discovery = discoverDeclaredChecksAtRoot(workspaceRoot, undefined);
	let derived: ToolchainCheck[] | undefined;
	const cache: VerifyDiscoveryCache = {
		discovery,
		derived: (declared) => (derived ??= availableToolchainChecks(workspaceRoot, declared)),
	};
	return (check) => resolveWithDiscovery(workspaceRoot, { check }, cache);
}

export function resolveVerifyCall(workspaceRoot: string, args: Record<string, unknown>): VerifyResolution {
	return resolveTaskGate(args) ?? resolveWithDiscovery(workspaceRoot, args);
}

/**
 * A verify call naming a gate of the dispatched task. Only verify calls see
 * gates; the quality policy's root resolver does not, so a task cannot satisfy
 * a repository's own quality rule. A gate runs exactly as the task wrote it.
 */
function resolveTaskGate(rawArgs: Record<string, unknown>): VerifyResolution | null {
	const args = prepareVerifyArguments(rawArgs);
	const check = typeof args.check === "string" ? args.check.trim() : "";
	if (check.length === 0) return null;
	const gate = findTaskGate(check);
	if (gate === null) return null;
	if (!("id" in gate)) {
		return {
			kind: "unresolved",
			message: `the task names \`${gate.text}\`, but it cannot run as a gate: ${gate.reason}. Report it unverified with that reason.`,
		};
	}
	if (extraArgs(args).length > 0) {
		return {
			kind: "unresolved",
			message: `task gate '${gate.id}' runs exactly as the task wrote it (${gate.text}); call it with no args.`,
		};
	}
	return { kind: "task", check: taskGateCheck(gate), confined: taskGatesConfined() };
}

/**
 * The argv a resolved verify call executes, or null when the resolution runs no
 * command. The safety scan and the approval card both name this one command, so
 * neither can describe a check the tool would not run.
 */
export function verifyResolutionArgv(
	resolution: VerifyResolution,
	args: Record<string, unknown>,
	workspaceRoot: string = process.cwd(),
): string[] | null {
	switch (resolution.kind) {
		case "catalog": {
			// A reproduce check runs its python command through the resolved
			// interpreter; the scan and the approval card name that argv.
			if (resolution.check.kind !== "reproduce") return resolution.check.command;
			const clean = resolveCleanRunArgv(resolution.check.command, workspaceRoot);
			return clean.ok ? clean.argv : resolution.check.command;
		}
		case "toolchain":
			return resolution.argv;
		case "task":
			return resolution.check.command;
		case "package": {
			const extra = extraArgs(args);
			return ["npm", "run", resolution.check.id, ...(extra.length > 0 ? ["--", ...extra] : [])];
		}
		default:
			return null;
	}
}

const RUN_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

/**
 * One run of a sweep check: `<id>/<run>` names a directory directly under the check's `runs`, and the check's argv
 * gains that directory as its last argument, written relative to the check's cwd. The run directory is part of the
 * argv, so the safety scan, the approval card and the claim the result records all name the run that was judged.
 */
function resolveRunCheck(workspaceRoot: string, check: DeclaredCheck, run: string): VerifyResolution {
	if (check.runs === undefined) {
		return {
			kind: "unresolved",
			message: `'${check.id}' declares no runs directory, so it takes no run; call it as check="${check.id}".`,
		};
	}
	if (!RUN_NAME_PATTERN.test(run) || run.length > 128) {
		return {
			kind: "unresolved",
			message: `run '${run}' must be one directory name under ${check.runs} (letters, digits, '.', '_', '-', at most 128 characters).`,
		};
	}
	const declaredRun = path.posix.join(check.runs, run);
	try {
		const resolved = resolveSafeCwd(declaredRun, workspaceRoot);
		if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
		resolveSafeCwd(realpathSync(resolved), realpathSync(workspaceRoot));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			kind: "unresolved",
			message: `run directory ${declaredRun} is not a directory inside the workspace (${reason}).`,
		};
	}
	const argument = path.posix.relative(check.cwd === "." ? "" : check.cwd, declaredRun) || ".";
	return { kind: "catalog", check: { ...check, command: [...check.command, argument] }, run: declaredRun };
}

function resolveWithDiscovery(
	workspaceRoot: string,
	args: Record<string, unknown>,
	cache?: VerifyDiscoveryCache,
): VerifyResolution {
	args = prepareVerifyArguments(args);
	const check = typeof args.check === "string" ? args.check.trim() : "";
	if (check.length === 0) return { kind: "list" };
	if (check === "frontend") return { kind: "frontend" };
	const cwdArg = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
	const discovery = cache?.discovery ?? discoverDeclaredChecksAtRoot(workspaceRoot, cwdArg);
	if (!discovery.ok) return { kind: "unresolved", message: discovery.reason };
	const declared = discovery.sources.flatMap((source) => source.checks);
	const hit = declared.find((candidate) => candidate.id === check);
	if (hit?.source.kind === "project-catalog") {
		if (hit.runs !== undefined) {
			return {
				kind: "unresolved",
				message: `'${check}' judges one run under ${hit.runs}; call it as check="${check}/<run>", where <run> is one directory there.`,
			};
		}
		return { kind: "catalog", check: hit };
	}
	const separator = check.indexOf("/");
	if (separator > 0) {
		const owner = declared.find(
			(candidate) => candidate.source.kind === "project-catalog" && candidate.id === check.slice(0, separator),
		);
		if (owner !== undefined) return resolveRunCheck(workspaceRoot, owner, check.slice(separator + 1));
	}
	if (hit?.source.kind === "package.json") {
		return { kind: "package", check: hit, packageRoot: path.dirname(hit.source.path) };
	}

	const derived = cache?.derived(declared) ?? availableToolchainChecks(workspaceRoot, declared);
	const exact = derived.find((candidate) => candidate.id === check);
	const owners = FAMILY_WORDS.has(check) ? derived.filter((candidate) => candidate.tags.includes(check)) : [];
	const chosen = exact ?? (owners.length === 1 ? owners[0] : undefined);
	if (chosen !== undefined) {
		if (chosen.availability) return { kind: "unavailable", check: chosen };
		const argv = toolchainArgv(chosen, extraArgs(args));
		if (argv instanceof Error) return { kind: "unresolved", message: argv.message };
		return { kind: "toolchain", check: chosen, argv };
	}

	const ids = [...declared.map((candidate) => candidate.id), ...derived.map((candidate) => candidate.id)];
	if (ids.length === 0) {
		let root = workspaceRoot;
		try {
			root = resolveSafeCwd(cwdArg, workspaceRoot);
		} catch {
			// discoverDeclaredChecksAtRoot already accepted this cwd; keep the workspace root for the message.
		}
		// Rediscover only on this empty path, to name the files that were skipped.
		const diagnostics = [...(discovery.diagnostics ?? [])];
		discoverToolchainChecks(workspaceRoot, diagnostics);
		return { kind: "unresolved", message: nothingDeclared(root, diagnostics) };
	}
	if (owners.length > 1) {
		return {
			kind: "unresolved",
			message: `'${check}' matches several checks (${owners.map((owner) => owner.id).join(", ")}); name one.`,
		};
	}
	const hint = isVerificationScriptName(check)
		? ""
		: ` Check ids are ${VERIFICATION_SCRIPT_FAMILY_HINT} package scripts, ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH} ids, or the derived ids listed.`;
	return {
		kind: "unresolved",
		message: `'${check}' is not a declared check. Declared checks: ${ids.join(", ")}.${hint}${taskGateFallbackHint() || " For any other command, use bash."}`,
	};
}
