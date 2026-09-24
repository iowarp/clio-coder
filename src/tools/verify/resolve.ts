import path from "node:path";
import { resolveSafeCwd } from "../../core/safe-exec.js";
import { isVerificationScriptName, VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import { type DeclaredCheck, PROJECT_VERIFIER_CATALOG_RELATIVE_PATH } from "./catalog.js";
import { discoverDeclaredChecksAtRoot } from "./discovery.js";
import { prepareVerifyArguments } from "./surface.js";
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
	| { kind: "catalog"; check: DeclaredCheck }
	| { kind: "package"; check: DeclaredCheck; packageRoot: string }
	| { kind: "toolchain"; check: ToolchainCheck; argv: string[] }
	| { kind: "unresolved"; message: string };

const FAMILY_WORDS = new Set(["test", "lint", "check", "typecheck", "format", "build", "ci"]);

function extraArgs(args: Record<string, unknown>): string[] {
	return Array.isArray(args.args) ? args.args.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Derived checks that no package script or catalog entry already owns by id. */
export function availableToolchainChecks(
	workspaceRoot: string,
	declared: ReadonlyArray<DeclaredCheck>,
): ToolchainCheck[] {
	const taken = new Set(declared.map((check) => check.id));
	return discoverToolchainChecks(workspaceRoot).filter((check) => !taken.has(check.id));
}

function nothingDeclared(root: string): string {
	return (
		`no declared or derivable verification checks in ${root}. Looked for ${TOOLCHAIN_DISCOVERY_SOURCES}. ` +
		"Run the repository's documented test or gate command through bash instead."
	);
}

export function resolveVerifyCall(workspaceRoot: string, args: Record<string, unknown>): VerifyResolution {
	args = prepareVerifyArguments(args);
	const check = typeof args.check === "string" ? args.check.trim() : "";
	if (check.length === 0) return { kind: "list" };
	if (check === "frontend") return { kind: "frontend" };
	const cwdArg = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
	const discovery = discoverDeclaredChecksAtRoot(workspaceRoot, cwdArg);
	if (!discovery.ok) return { kind: "unresolved", message: discovery.reason };
	const declared = discovery.sources.flatMap((source) => source.checks);
	const hit = declared.find((candidate) => candidate.id === check);
	if (hit?.source.kind === "project-catalog") return { kind: "catalog", check: hit };
	if (hit?.source.kind === "package.json") {
		return { kind: "package", check: hit, packageRoot: path.dirname(hit.source.path) };
	}

	const derived = availableToolchainChecks(workspaceRoot, declared);
	const exact = derived.find((candidate) => candidate.id === check);
	const owners = FAMILY_WORDS.has(check) ? derived.filter((candidate) => candidate.tags.includes(check)) : [];
	const chosen = exact ?? (owners.length === 1 ? owners[0] : undefined);
	if (chosen !== undefined) {
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
		return { kind: "unresolved", message: nothingDeclared(root) };
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
		message: `'${check}' is not a declared check. Declared checks: ${ids.join(", ")}.${hint} For any other command, use bash.`,
	};
}
