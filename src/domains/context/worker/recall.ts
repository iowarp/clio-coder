import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioStateDir } from "../../../core/xdg.js";
import type { AgentMessage } from "../../../engine/types.js";
import type { WorkerRecallLineage } from "./contract.js";
import { workerObservationsDirectory } from "./observation-retention.js";
import { contextHash } from "./snapshot.js";

export type WorkerRecallResult =
	| { error: string }
	| { body: string; total: number; shown: number; nextOffset?: number };
export type WorkerRecall = (args: Record<string, unknown>) => WorkerRecallResult;

/**
 * The in-memory allowlist is the capability. A ref never grants arbitrary file or parent-ledger access. A dispatched
 * worker archives under its run id, so retention can key the archives on that run (D1-5). Refs are the run's own
 * `r<N>` aliases; an alias at or under the seed's floor names parent history this run cannot recall.
 */
export function createWorkerObservationStore(
	runId?: string,
	lineage: WorkerRecallLineage = { aliasFloor: 0, inheritedMarkers: [] },
): {
	archive(alias: string, message: AgentMessage): string;
	archivePath(message: AgentMessage): string;
	recall: WorkerRecall;
} {
	const archivePath = (message: AgentMessage) =>
		join(workerObservationsDirectory(clioStateDir(), runId), `${contextHash(message)}.json`);
	const records = new Map<string, { file: string; digest: string; label: string }>();
	const inherited = new Map(lineage.inheritedMarkers.map((marker) => [marker.alias, marker.ref]));
	const parentAlias = (ref: string) =>
		inherited.has(ref) || (/^r[1-9]\d*$/u.test(ref) && Number(ref.slice(1)) <= lineage.aliasFloor);
	return {
		archivePath,
		archive(alias, message) {
			if (!/^r[1-9]\d*$/u.test(alias) || records.has(alias) || parentAlias(alias))
				throw new Error(`worker context: ${alias} is not a fresh recall alias for this run`);
			const digest = contextHash(message);
			const file = archivePath(message);
			safeResourceWrite(file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
			records.set(alias, { file, digest, label: message.role === "toolResult" ? message.toolName : message.role });
			return file;
		},
		recall(args) {
			if (args.ref !== undefined) {
				const ref = typeof args.ref === "string" ? args.ref.trim() : "";
				const record = records.get(ref);
				if (!record) {
					if (parentAlias(ref)) {
						const entry = inherited.get(ref);
						return {
							error: `not_in_stream: ${ref} names parent history${entry === undefined ? "" : ` (parent entry ${entry})`}, which this worker run cannot recall; its marker is all the run holds of it`,
						};
					}
					return { error: "ref is not an evicted observation from this worker run" };
				}
				try {
					const body = readFileSync(record.file, "utf8");
					if (contextHash(JSON.parse(body)) !== record.digest) return { error: "observation digest mismatch" };
					return { body: `Historical observation ${ref}; this is not a new source read.\n${body}`, total: 1, shown: 1 };
				} catch {
					return { error: "persisted worker observation is unavailable or malformed" };
				}
			}
			const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
			const limit =
				typeof args.limit === "number" && Number.isSafeInteger(args.limit) ? Math.max(1, Math.min(12, args.limit)) : 8;
			const offset = typeof args.offset === "number" && Number.isSafeInteger(args.offset) ? Math.max(0, args.offset) : 0;
			const matches = [...records]
				.map(([ref, item]) => `${ref} ${item.label}`)
				.filter((line) => line.toLowerCase().includes(query));
			const page = matches.slice(offset, offset + limit);
			const nextOffset = offset + page.length < matches.length ? offset + page.length : undefined;
			return {
				body: [
					...page,
					nextOffset === undefined
						? "End of this worker's evicted observations."
						: `More observations: offset=${nextOffset}.`,
				].join("\n"),
				total: matches.length,
				shown: page.length,
				...(nextOffset === undefined ? {} : { nextOffset }),
			};
		},
	};
}
