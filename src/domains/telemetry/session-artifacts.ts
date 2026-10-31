import type { ContextSnapshot } from "../session/context-accounting.js";
import type { PromptManifestReadResult } from "../session/prompt-manifest.js";
import { readCallJournalSync } from "./call-journal.js";
import type { telemetryPromptStructure } from "./objects.js";
import { readTelemetryObjectSync } from "./objects.js";
import { telemetrySessionDirectory } from "./paths.js";
import { contextSnapshots, promptCompiles } from "./read-model.js";

/** Cold session readers use the journal's checked records and verified structure preimages (#434). */
export function readSessionPromptCompiles(stateDir: string, sessionId: string): PromptManifestReadResult {
	try {
		const directory = telemetrySessionDirectory(stateDir, sessionId);
		const read = readCallJournalSync(directory);
		const errors: PromptManifestReadResult["errors"] =
			read.skipped || read.damaged ? [{ line: null, message: "prompt journal contains unreadable records" }] : [];
		const records = promptCompiles(
			read.records.map((row) => row.record),
			sessionId,
			(ref) => {
				try {
					const object = readTelemetryObjectSync(directory, ref);
					if (object.kind !== "resolved") throw new Error("prompt compile preimage is unavailable");
					const structure = object.value as ReturnType<typeof telemetryPromptStructure>;
					if (!structure.compile || structure.fragments.some((fragment) => fragment.relPath === undefined))
						throw new Error("invalid prompt compile preimage");
					return structure;
				} catch (error) {
					errors.push({ line: null, message: error instanceof Error ? error.message : String(error) });
					return null;
				}
			},
		);
		return {
			records,
			errors,
		};
	} catch (error) {
		return { records: [], errors: [{ line: null, message: error instanceof Error ? error.message : String(error) }] };
	}
}

export function readSessionContextSnapshots(stateDir: string, sessionId: string): ContextSnapshot[] {
	const read = readCallJournalSync(telemetrySessionDirectory(stateDir, sessionId));
	return contextSnapshots(
		read.records.map((row) => row.record),
		sessionId,
	);
}
