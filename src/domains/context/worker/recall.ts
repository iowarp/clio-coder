import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioStateDir } from "../../../core/xdg.js";
import type { AgentMessage } from "../../../engine/types.js";
import { contextHash } from "./snapshot.js";

export type WorkerRecallResult =
	| { error: string }
	| { body: string; total: number; shown: number; nextOffset?: number };
export type WorkerRecall = (args: Record<string, unknown>) => WorkerRecallResult;

/** The in-memory allowlist is the capability. A ref never grants arbitrary file or parent-ledger access. */
export function createWorkerObservationStore(): {
	archive(ref: string, message: AgentMessage): string;
	recall: WorkerRecall;
} {
	const records = new Map<string, { file: string; label: string }>();
	return {
		archive(ref, message) {
			if (contextHash(message) !== ref) throw new Error("worker context: observation digest mismatch");
			const file = join(clioStateDir(), "context-observations", `${ref}.json`);
			safeResourceWrite(file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
			records.set(`worker:${ref}`, { file, label: message.role === "toolResult" ? message.toolName : message.role });
			return file;
		},
		recall(args) {
			if (args.ref !== undefined) {
				const ref = typeof args.ref === "string" ? args.ref.trim() : "";
				const record = records.get(ref);
				if (!record) return { error: "ref is not an evicted observation from this worker run" };
				try {
					const body = readFileSync(record.file, "utf8");
					if (`worker:${contextHash(JSON.parse(body))}` !== ref) return { error: "observation digest mismatch" };
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
