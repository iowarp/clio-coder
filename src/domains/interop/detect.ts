import { createHash } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runCommandVector } from "../../core/safe-exec.js";
import { INTEROP_AGENT_KINDS } from "./registry.js";
import type {
	InteropAgentFacts,
	InteropAgentKind,
	InteropAgentRecord,
	InteropDetectInput,
	InteropPresence,
	InteropReport,
} from "./types.js";

const VERSION_PROBE_TIMEOUT_MS = 2000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 4096;

/** Resolve an executable on PATH without a shell. Never throws; unresolvable state reports "unknown". */
function resolveOnPath(binaryNames: ReadonlyArray<string>): { presence: InteropPresence; binary?: string } {
	if (binaryNames.length === 0) return { presence: "absent" };
	const rawPath = process.env.PATH;
	if (rawPath === undefined || rawPath.length === 0) return { presence: "unknown" };
	try {
		for (const dir of rawPath.split(path.delimiter)) {
			if (dir.length === 0) continue;
			for (const name of binaryNames) {
				const candidate = path.join(dir, name);
				try {
					accessSync(candidate, constants.X_OK);
					return { presence: "present", binary: candidate };
				} catch {
					// Not this entry. A directory Clio cannot traverse is not evidence of absence,
					// but it is also not evidence of presence, so the sweep simply continues.
				}
			}
		}
	} catch {
		return { presence: "unknown" };
	}
	return { presence: "absent" };
}

/**
 * Whether the ACP adapter can start without a network install. `npx` is never
 * run: a package under a local node_modules or an adapter executable already on
 * PATH answers the question, and anything else means npx would fetch it.
 */
function adapterPresence(kind: InteropAgentKind, cwd: string, binaryPresence: InteropPresence): InteropPresence {
	const recipe = kind.acp;
	if (recipe === undefined) return "absent";
	if (recipe.npmPackage === undefined) return binaryPresence;
	try {
		if (existsSync(path.join(cwd, "node_modules", recipe.npmPackage))) return "present";
	} catch {
		return "unknown";
	}
	if (recipe.npmPackageBin === undefined) return "absent";
	return resolveOnPath([recipe.npmPackageBin]).presence;
}

function installDirOf(kind: InteropAgentKind, home: string): string | undefined {
	const dir = path.join(home, kind.userDir);
	try {
		return existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}

/** First version-shaped token in the output of `<bin> --version`, or undefined. */
function parseVersion(output: string): string | undefined {
	return /\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/.exec(output)?.[0];
}

async function probeVersion(binary: string, cwd: string): Promise<string | undefined> {
	try {
		const result = await runCommandVector(binary, ["--version"], {
			cwd,
			workspaceRoot: cwd,
			timeoutMs: VERSION_PROBE_TIMEOUT_MS,
			maxOutputBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
		});
		if (result.timedOut || result.exitCode !== 0) return undefined;
		return parseVersion(`${result.stdout}\n${result.stderr}`);
	} catch {
		return undefined;
	}
}

/**
 * Facts a proposal is keyed by. Skill and artifact counts are deliberately out:
 * adding a skill to a foreign root must not re-propose an agent the operator
 * already declined.
 */
function interopFingerprint(kind: InteropAgentKind, facts: InteropAgentFacts): string {
	const recipe = kind.acp;
	const parts = [
		kind.id,
		facts.binary ?? "",
		facts.version ?? "",
		recipe === undefined ? "" : `${recipe.command} ${recipe.args.join(" ")}`,
	];
	return `sha256:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

function countBy<T>(values: ReadonlyArray<T> | undefined, match: T | undefined): number {
	if (values === undefined || match === undefined) return 0;
	return values.filter((value) => value === match).length;
}

function detected(facts: InteropAgentFacts): boolean {
	return (
		facts.presence === "present" || facts.installDir !== undefined || facts.skillCount > 0 || facts.projectArtifacts > 0
	);
}

/**
 * Probe every registered agent. Detection resolves paths and, only when asked
 * and only for a binary that already resolved, runs a bounded `--version`. It
 * never starts a foreign agent's work command and never reads under a foreign
 * session, history, cache, projects, or state directory.
 */
export async function detectInteropAgents(
	input: InteropDetectInput = {},
	previous: ReadonlyArray<InteropAgentRecord> = [],
): Promise<InteropReport> {
	const cwd = path.resolve(input.cwd ?? process.cwd());
	const home = input.home ?? homedir();
	const priorByKind = new Map(previous.map((record) => [record.kind, record]));
	const agents: InteropAgentRecord[] = [];

	for (const kind of INTEROP_AGENT_KINDS) {
		const resolved = resolveOnPath(kind.binaryNames);
		const prior = priorByKind.get(kind.id);
		const installDir = installDirOf(kind, home);
		const facts: InteropAgentFacts = {
			kind: kind.id,
			presence: resolved.presence,
			...(resolved.binary !== undefined ? { binary: resolved.binary } : {}),
			...(installDir !== undefined ? { installDir } : {}),
			...(kind.acp !== undefined ? { adapter: adapterPresence(kind, cwd, resolved.presence) } : {}),
			skillCount: countBy(input.skillSources, kind.skillSource),
			projectArtifacts: countBy(input.artifactProviders, kind.adoptionProvider),
		};
		if (resolved.binary !== undefined) {
			const version =
				input.probeVersion === true
					? await probeVersion(resolved.binary, cwd)
					: // A run that did not probe keeps the last version seen for the same
						// binary, so the fingerprint does not flip between probing callers.
						prior?.binary === resolved.binary
						? prior.version
						: undefined;
			if (version !== undefined) facts.version = version;
		}
		if (!detected(facts)) continue;
		agents.push({
			...facts,
			fingerprint: interopFingerprint(kind, facts),
			...(prior?.decision !== undefined ? { decision: prior.decision } : {}),
			...(prior?.decidedAt !== undefined ? { decidedAt: prior.decidedAt } : {}),
			...(prior?.decidedFingerprint !== undefined ? { decidedFingerprint: prior.decidedFingerprint } : {}),
			...(prior?.hintedFingerprint !== undefined ? { hintedFingerprint: prior.hintedFingerprint } : {}),
		});
	}

	return { version: 1, detectedAt: new Date().toISOString(), agents };
}
