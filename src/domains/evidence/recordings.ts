import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { RecordingManifest, RunEnvelope } from "../dispatch/index.js";
import { parseRecordingCast, readRunRecording } from "../dispatch/index.js";
import { createRedactionTally, redactSecretSegments, redactSecretsDeep, redactSecretsText } from "./redact.js";

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
				const frames = parseRecordingCast(source.cast);
				const tally = createRedactionTally();
				const text = redactSecretSegments(
					frames.map((frame) => frame[2]),
					tally,
				);
				const header = source.cast.slice(0, source.cast.indexOf("\n"));
				const cast = `${header}\n${frames.map((frame, i) => JSON.stringify([frame[0], "o", text[i]])).join("\n")}${frames.length ? "\n" : ""}`;
				parseRecordingCast(cast);
				manifest.castPath = `recordings/${run.id}.cast`;
				manifest.bytes = Buffer.byteLength(cast);
				manifest.sha256 = createHash("sha256").update(cast).digest("hex");
				manifest.redactionCount += tally.count;
				mkdirSync(join(directory, "recordings"), { recursive: true, mode: 0o700 });
				safeResourceWrite(join(directory, manifest.castPath), cast, { mode: 0o600 });
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
