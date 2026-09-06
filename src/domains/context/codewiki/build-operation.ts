import { readFileSync } from "node:fs";
import { detectProjectType } from "../../session/workspace/project-type.js";
import { computeFingerprint, isStale } from "../fingerprint.js";
import { codewikiNeedsBackfill } from "./artifact.js";
import type { CodewikiBuildWorkerRequest, CodewikiBuildWorkerResult } from "./build-worker-protocol.js";
import { buildCodewiki, type CodewikiBuildOptions, syncCodewiki, updateCodewikiPaths } from "./indexer.js";

/** Worker-only build policy; options use the indexer's source reader for deterministic race tests. */
export async function executeCodewikiBuild(
	request: CodewikiBuildWorkerRequest,
	options: CodewikiBuildOptions = {},
): Promise<CodewikiBuildWorkerResult> {
	let current = request.kind === "build" ? null : request.current;
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
	if (request.kind === "incremental") {
		current = await updateCodewikiPaths(request.cwd, request.current, request.paths, buildOptions);
		// An unchanged notification proves nothing about unrelated files. Retain
		// the old global baseline so the next ensure still detects external edits.
		if (current === request.current && request.previous && !unreadable) {
			return { codewiki: current, fingerprint: request.previous, changed: false };
		}
	}
	if (request.kind === "ensure" && current && !codewikiNeedsBackfill(current)) {
		const fingerprint = computeFingerprint(request.cwd, current);
		if (request.previous && !isStale(request.previous, fingerprint)) {
			return { codewiki: current, fingerprint, changed: false };
		}
	}

	for (let attempt = 0; attempt < 3; attempt += 1) {
		// Both scans bracket all source reads, including sync's cached parse inputs.
		// Never stamp a post-build tree that changed after an earlier file was read.
		// This remains a metadata guard: equal path/size/floored-mtime collisions
		// are outside the fingerprint's detection contract.
		const before = computeFingerprint(request.cwd, current);
		unreadable = false;
		current = current
			? await syncCodewiki(request.cwd, current, buildOptions)
			: await buildCodewiki(
					{
						cwd: request.cwd,
						language:
							(request.kind === "incremental" ? request.current.language : request.language) ?? detectProjectType(request.cwd),
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
