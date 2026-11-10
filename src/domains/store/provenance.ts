/**
 * Provenance for a store put, copied out of `run_script` manifests. Run
 * records are swept at 100, so the facts are copied into the store record
 * rather than referenced.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
	type HashObservation,
	isRunId,
	type RunManifest,
	readRunManifest,
	runRecordsDir,
	workspaceRelativePath,
} from "../../core/run-records.js";
import { decodeTagSegment, storeProjectDir } from "../../core/store-paths.js";
import { isSecretArgKey, redactSecretString } from "../safety/redaction.js";
import type { StoreBackend } from "./backend.js";
import {
	currentState,
	readBlobHistory,
	type StoreRecord,
	type StoreRecordBody,
	type StoreRecordUse,
} from "./records.js";
import { type StoreBlobStat, StoreRefusal } from "./types.js";

const PRODUCING_RUN_SCAN_LIMIT = 100;

/** Each element scrubbed as the run log text is, plus the value after a secret-named flag (`--token VALUE`). */
function redactArgv(argv: readonly string[]): string[] {
	return argv.map((arg, index) => {
		const flag = /^--?([A-Za-z][\w-]*)$/u.exec(argv[index - 1] ?? "")?.[1];
		return flag !== undefined && isSecretArgKey(flag) ? "[redacted]" : redactSecretString(arg);
	});
}

/**
 * The newest run whose declared output at `sourceRelPath` was created or
 * modified with these exact contents: the same sha256, or, when either side
 * has no hash, the same size and mtime. Never a match on the name alone.
 */
export function findProducingRun(
	workspaceRoot: string,
	sourceRelPath: string,
	observed: { bytes: number; mtimeMs: number; sha256: string | null },
): { manifest: RunManifest; matchedBy: "sha256" | "size-mtime" } | null {
	let runIds: string[];
	try {
		runIds = readdirSync(runRecordsDir(workspaceRoot)).filter(isRunId);
	} catch {
		return null;
	}
	runIds.sort().reverse();
	for (const runId of runIds.slice(0, PRODUCING_RUN_SCAN_LIMIT)) {
		const manifest = readRunManifest(workspaceRoot, runId);
		if (manifest === null) continue;
		for (const output of manifest.outputs) {
			if (output.path !== sourceRelPath || (output.status !== "created" && output.status !== "modified")) continue;
			const hash = output.sha256 ?? null;
			if (hash !== null && observed.sha256 !== null) {
				if (hash === observed.sha256) return { manifest, matchedBy: "sha256" };
			} else if (output.bytes === observed.bytes && output.mtimeMs === observed.mtimeMs) {
				return { manifest, matchedBy: "size-mtime" };
			}
		}
	}
	return null;
}

/** The script's declared inputs as `used` entries; an input that resolves into this project's store names its blob. */
function usedFrom(manifest: RunManifest, workspaceRoot: string): StoreRecordUse[] {
	let storeDir: string | null;
	try {
		storeDir = realpathSync(storeProjectDir(workspaceRoot));
	} catch {
		storeDir = null;
	}
	return manifest.inputs.map((input) => {
		const facts = { ...(input.bytes !== undefined ? { bytes: input.bytes } : {}), sha256: input.sha256 ?? null };
		if (storeDir !== null) {
			try {
				const relative = path.relative(storeDir, realpathSync(path.resolve(workspaceRoot, input.path)));
				const [tags, encodedTag, blobs, ...rest] = relative.split(path.sep);
				if (tags === "tags" && encodedTag !== undefined && blobs === "blobs" && rest.length > 0) {
					return { tag: decodeTagSegment(encodedTag), blob: rest.join("/"), ...facts };
				}
			} catch {
				// A missing or unreadable input keeps its declared path.
			}
		}
		return { path: input.path, ...facts };
	});
}

export interface PutRecordInput {
	backend: StoreBackend;
	cwd: string;
	tag: string;
	blob: string;
	/** The workspace file the blob was put from. */
	sourceAbs: string;
	/** The stored blob after the put. */
	stat: StoreBlobStat;
	/** Hash of the source, which holds the same bytes as the blob. */
	hash: HashObservation;
	receipt: NonNullable<StoreRecord["receipt"]>;
	actor: "main" | "worker";
	ids?: { sessionId?: string; turnId?: string; dispatchRunId?: string };
	note?: string;
	derivedFrom?: ReadonlyArray<{ tag: string; blob: string }>;
}

/** The `put` record for one blob, with the run that produced its source when one matches. */
export async function buildPutRecord(input: PutRecordInput): Promise<StoreRecordBody> {
	const derived: StoreRecordUse[] = [];
	for (const ref of input.derivedFrom ?? []) {
		const stat = await input.backend.statBlob(ref.tag, ref.blob);
		if (stat === null)
			throw new StoreRefusal("not-found", `derivedFrom names ${ref.tag}/${ref.blob}, which does not exist.`);
		const { put } = currentState((await readBlobHistory(input.backend, ref.tag, ref.blob)).records);
		derived.push({ tag: ref.tag, blob: ref.blob, bytes: stat.bytes, sha256: put?.identity?.sha256 ?? null });
	}

	const sourcePath = workspaceRelativePath(input.cwd, input.sourceAbs);
	let generatedBy: StoreRecord["generatedBy"];
	let used: StoreRecordUse[] = [];
	if (sourcePath !== null) {
		try {
			const source = statSync(input.sourceAbs);
			const run = findProducingRun(input.cwd, sourcePath, {
				bytes: source.size,
				mtimeMs: source.mtimeMs,
				sha256: input.hash.sha256,
			});
			if (run !== null) {
				const { manifest } = run;
				generatedBy = {
					tool: "run_script",
					runId: manifest.runId,
					script: { path: manifest.script.path, sha256: manifest.script.sha256 },
					argv: redactArgv(manifest.argv),
					outcome: manifest.outcome,
					finishedAt: manifest.finishedAt,
					matchedBy: run.matchedBy,
				};
				used = usedFrom(manifest, input.cwd);
			}
		} catch {
			// A source that vanished after the put has no producing run to report.
		}
	}
	used.push(...derived);

	return {
		kind: "put",
		tag: input.tag,
		blob: input.blob,
		identity: {
			bytes: input.stat.bytes,
			modifiedMs: input.stat.modifiedMs,
			sha256: input.hash.sha256,
			...(input.hash.hashOmitted !== undefined ? { hashOmitted: input.hash.hashOmitted } : {}),
		},
		receipt: input.receipt,
		...(sourcePath !== null ? { source: { path: sourcePath } } : {}),
		producedBy: { actor: input.actor, ...input.ids },
		...(generatedBy !== undefined ? { generatedBy } : {}),
		...(used.length > 0 ? { used } : {}),
		...(input.note !== undefined ? { note: input.note } : {}),
	};
}
