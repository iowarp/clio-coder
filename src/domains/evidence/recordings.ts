import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { RecordingManifest, RunEnvelope } from "../dispatch/index.js";
import { readRunRecording } from "../dispatch/index.js";
import { createRedactionTally, redactSecretsDeep, redactSecretsText } from "./redact.js";

/** Export only canonical, validated, redacted display recordings; failures remain visible metadata. */
export function exportEvidenceRecordings(
	stateDir: string,
	directory: string,
	runs: RunEnvelope[],
): RecordingManifest[] {
	const manifests: RecordingManifest[] = [];
	for (const run of runs) {
		if (!run.recording) continue;
		try {
			const source = readRunRecording(stateDir, run.id);
			if (!source) throw new Error("requested recording manifest missing");
			const manifest = source.manifest;
			if (manifest.completion === "recording") {
				manifest.completion = "incomplete";
				manifest.error = "capture was not finalized; process interruption or run still active";
			}
			if (source.cast !== null) {
				// readRunRecording verified this cast against the checksum of its redacted write; a second
				// pass re-matches its own [redacted:assignment] markers and inflates redactionCount.
				manifest.castPath = `recordings/${run.id}.cast`;
				mkdirSync(join(directory, "recordings"), { recursive: true, mode: 0o700 });
				safeResourceWrite(join(directory, manifest.castPath), source.cast, { mode: 0o600 });
			}
			manifests.push(redactSecretsDeep(manifest, createRedactionTally()));
		} catch (error) {
			manifests.push({
				version: 1,
				sourceKind: "worker-display",
				captureMethod: "asciicast-v2-side-channel",
				runId: run.id,
				node: run.node ?? { id: "local", kind: "local" },
				startedAt: run.startedAt,
				endedAt: run.endedAt,
				completion: "failed",
				outcome: run.outcome ?? null,
				bytes: 0,
				sha256: null,
				castPath: null,
				droppedFrames: 0,
				redactionCount: 0,
				error: redactSecretsText(error instanceof Error ? error.message : String(error), createRedactionTally()),
			});
		}
	}
	return manifests;
}
