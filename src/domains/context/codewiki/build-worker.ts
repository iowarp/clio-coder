import { parentPort, workerData } from "node:worker_threads";
import { detectProjectType } from "../../session/workspace/project-type.js";
import { computeFingerprint, isStale } from "../fingerprint.js";
import { codewikiNeedsBackfill } from "./artifact.js";
import type {
	CodewikiBuildWorkerMessage,
	CodewikiBuildWorkerRequest,
	CodewikiBuildWorkerResult,
} from "./build-worker-protocol.js";
import { buildCodewiki, syncCodewiki, updateCodewikiPaths } from "./indexer.js";

async function execute(request: CodewikiBuildWorkerRequest): Promise<CodewikiBuildWorkerResult> {
	if (request.kind === "build") {
		const codewiki = await buildCodewiki({ cwd: request.cwd, language: request.language });
		return { codewiki, fingerprint: computeFingerprint(request.cwd, codewiki), changed: true };
	}
	if (request.kind === "incremental") {
		const codewiki = await updateCodewikiPaths(request.cwd, request.current, request.paths);
		return {
			codewiki,
			fingerprint: computeFingerprint(request.cwd, codewiki),
			changed: codewiki !== request.current,
		};
	}
	if (request.current && !codewikiNeedsBackfill(request.current)) {
		const currentFingerprint = computeFingerprint(request.cwd, request.current);
		if (request.previous && !isStale(request.previous, currentFingerprint)) {
			return { codewiki: request.current, fingerprint: currentFingerprint, changed: false };
		}
	}
	const codewiki = request.current
		? await syncCodewiki(request.cwd, request.current)
		: await buildCodewiki({ cwd: request.cwd, language: request.language ?? detectProjectType(request.cwd) });
	return { codewiki, fingerprint: computeFingerprint(request.cwd, codewiki), changed: true };
}

const port = parentPort;
if (!port) throw new Error("codewiki build worker requires a worker_threads parent");

execute(workerData as CodewikiBuildWorkerRequest).then(
	(result) => {
		port.postMessage({ ok: true, result } satisfies CodewikiBuildWorkerMessage);
		port.close();
	},
	(error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		port.postMessage({
			ok: false,
			error: message,
			...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
		} satisfies CodewikiBuildWorkerMessage);
		port.close();
	},
);
