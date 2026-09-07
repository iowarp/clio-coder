import { readFileSync } from "node:fs";
import { detectProjectType } from "../../session/workspace/project-type.js";
import { computeFingerprint, isStale } from "../fingerprint.js";
import { codewikiNeedsBackfill, readCodewiki } from "./artifact.js";
import type {
	CodewikiArtifactRef,
	CodewikiBuildWorkerOutcome,
	CodewikiBuildWorkerRequest,
	CodewikiBuildWorkerResult,
} from "./build-worker-protocol.js";
import { buildCodewiki, type CodewikiBuildOptions, syncCodewiki, updateCodewikiPaths } from "./indexer.js";
import type { Codewiki } from "./schema.js";

function isArtifactRef(value: Codewiki | CodewikiArtifactRef | null): value is CodewikiArtifactRef {
	return value !== null && "source" in value && value.source === "artifact";
}

/**
 * Worker-side build policy; options use the indexer's source reader for
 * deterministic race tests. The outcome omits the artifact when it was handed
 * in by reference and left unchanged, so the coordinator never receives a
 * clone of what it already holds.
 */
export async function executeCodewikiBuildOutcome(
	request: CodewikiBuildWorkerRequest,
	options: CodewikiBuildOptions = {},
): Promise<CodewikiBuildWorkerOutcome> {
	const handed = request.kind === "build" ? null : request.current;
	// Resolved lazily: the unchanged-ensure path below never needs the artifact's
	// contents, and parsing it there would put the cost back that the reference
	// took out. Read once, then reused by every later step.
	let resolved: Codewiki | null | undefined = isArtifactRef(handed) ? undefined : handed;
	const resolveCurrent = (): Codewiki | null => {
		if (resolved === undefined) resolved = readCodewiki(request.cwd);
		return resolved;
	};
	// A reference the disk no longer honors (deleted or corrupt between the
	// coordinator's read and this resolution) is exactly the "no artifact" case:
	// an ensure rebuilds from source as it would have with `current: null`,
	// and an incremental refuses rather than fabricating an index from one path.
	const requireCurrent = (): Codewiki => {
		const current = resolveCurrent();
		if (!current) throw new Error("codewiki artifact referenced by the coordinator is unreadable; rebuild it");
		return current;
	};
	let unreadable = false;
	const buildOptions: CodewikiBuildOptions = {
		...options,
		readFile: (path) => {
			try {
				const text = options.readFile ? options.readFile(path) : readFileSync(path, "utf8");
				if (text === null) unreadable = true;
				return text;
			} catch {
				unreadable = true;
				return null;
			}
		},
	};
	if (request.kind === "ensure" && handed !== null) {
		const needsBackfill = isArtifactRef(handed) ? handed.needsBackfill : codewikiNeedsBackfill(handed);
		if (!needsBackfill) {
			const fingerprint = isArtifactRef(handed)
				? computeFingerprint(request.cwd, null, { artifactLoc: handed.loc })
				: computeFingerprint(request.cwd, handed);
			if (request.previous && !isStale(request.previous, fingerprint)) {
				return { codewiki: isArtifactRef(handed) ? null : handed, fingerprint, changed: false };
			}
		}
	}
	let current: Codewiki | null = handed === null ? null : resolveCurrent();
	if (request.kind === "incremental") {
		const base = requireCurrent();
		current = await updateCodewikiPaths(request.cwd, base, request.paths, buildOptions);
		// An unchanged notification proves nothing about unrelated files. Retain
		// the old global baseline so the next ensure still detects external edits.
		if (current === base && request.previous && !unreadable) {
			return { codewiki: isArtifactRef(handed) ? null : base, fingerprint: request.previous, changed: false };
		}
	}

	for (let attempt = 0; attempt < 3; attempt += 1) {
		// Both scans bracket all source reads, including sync's cached parse inputs.
		// Never stamp a post-build tree that changed after an earlier file was read.
		const before = computeFingerprint(request.cwd, current);
		unreadable = false;
		current = current
			? await syncCodewiki(request.cwd, current, buildOptions)
			: await buildCodewiki(
					{
						cwd: request.cwd,
						language:
							(request.kind === "incremental" ? requireCurrent().language : request.language) ??
							detectProjectType(request.cwd),
					},
					buildOptions,
				);
		const after = computeFingerprint(request.cwd, current);
		if (!isStale(before, after) && !unreadable) {
			return { codewiki: current, fingerprint: after, changed: true };
		}
	}
	throw new Error("codewiki source snapshot did not stabilize after 3 attempts; previous index preserved");
}

/**
 * In-process form for callers that hold the artifact: the worker outcome with
 * the handed object substituted wherever the reconciliation left it unchanged.
 */
export async function executeCodewikiBuild(
	request: CodewikiBuildWorkerRequest,
	options: CodewikiBuildOptions = {},
): Promise<CodewikiBuildWorkerResult> {
	const outcome = await executeCodewikiBuildOutcome(request, options);
	if (outcome.codewiki)
		return { codewiki: outcome.codewiki, fingerprint: outcome.fingerprint, changed: outcome.changed };
	const handed = request.kind === "build" ? null : request.current;
	const current = handed && !isArtifactRef(handed) ? handed : readCodewiki(request.cwd);
	if (!current) throw new Error("codewiki reconciliation returned no artifact");
	return { codewiki: current, fingerprint: outcome.fingerprint, changed: outcome.changed };
}
