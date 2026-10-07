import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { assertSafeId } from "../../core/safe-id.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { resolveClioDirs, stateRootRemoved } from "../../core/xdg.js";
import { createRedactionTally, redactSecretSegments } from "../evidence/index.js";
import type { RunEventJournalSink } from "./run-event-journal.js";
import type { RunNodeIdentity } from "./types.js";

export const RECORDING_MAX_BYTES = 2 * 1024 * 1024;
export const RECORDING_MAX_DURATION_MS = 60 * 60 * 1000;
export interface RecordingReference {
	manifestPath: string;
}
export interface RecordingManifest {
	version: 1;
	sourceKind: "worker-display";
	captureMethod: "asciicast-v2-side-channel";
	runId: string;
	node: RunNodeIdentity;
	startedAt: string;
	endedAt: string | null;
	completion: "recording" | "complete" | "incomplete" | "failed";
	outcome: string | null;
	bytes: number;
	sha256: string | null;
	castPath: string | null;
	droppedFrames: number;
	redactionCount: number;
	error?: string;
}
export type CastOutputEvent = [number, "o", string];
export function recordingReference(runId: string): RecordingReference {
	assertSafeId(runId, "run");
	return { manifestPath: `runs/${runId}/recording.json` };
}
function displayText(text: string): string {
	// Cast playback must not execute OSC clipboard, hyperlinks or arbitrary terminal controls.
	return Array.from(stripVTControlCharacters(text))
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159));
		})
		.join("");
}
function assertRecordingDirectory(root: string, runId: string): void {
	for (const path of [join(root, "runs"), join(root, "runs", runId)]) {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
			throw new Error("recording directory is not a regular directory");
	}
}
function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Strict output-only v2 reader for evidence and time-attributed semantic extraction. */
export function parseRecordingCast(raw: string): CastOutputEvent[] {
	if (Buffer.byteLength(raw) > RECORDING_MAX_BYTES) throw new Error("recording exceeds byte cap");
	const lines = raw.trimEnd().split("\n");
	const header = JSON.parse(lines.shift() ?? "null") as Record<string, unknown> | null;
	if (
		header?.version !== 2 ||
		header.width !== 100 ||
		header.height !== 30 ||
		Object.keys(header).some((key) => !["version", "width", "height", "timestamp"].includes(key)) ||
		typeof header.timestamp !== "number" ||
		!Number.isFinite(header.timestamp)
	)
		throw new Error("invalid recording header");
	const events: CastOutputEvent[] = [];
	let previous = 0;
	for (const line of lines) {
		const event: unknown = JSON.parse(line);
		if (
			!Array.isArray(event) ||
			event.length !== 3 ||
			typeof event[0] !== "number" ||
			!Number.isFinite(event[0]) ||
			event[0] < previous ||
			event[0] > RECORDING_MAX_DURATION_MS / 1000 ||
			event[1] !== "o" ||
			typeof event[2] !== "string" ||
			displayText(event[2]) !== event[2]
		)
			throw new Error("invalid recording output event");
		previous = event[0];
		events.push([event[0], "o", event[2]]);
	}
	return events;
}

export interface RecordingJournal extends RunEventJournalSink {
	accepts(runId: string): boolean;
	start(runId: string, node: RunNodeIdentity): RecordingReference;
	stop(): void;
}
interface Capture {
	manifest: RecordingManifest;
	startMs: number;
	frames: CastOutputEvent[];
	bytes: number;
}

/** Bounded in-memory display capture; only fully redacted text is ever written to disk. */
export function createRecordingJournal(
	options: {
		stateDir?: string;
		maxBytes?: number;
		maxDurationMs?: number;
		nowMs?: () => number;
		now?: () => Date;
		warn?: (text: string) => void;
	} = {},
): RecordingJournal {
	const captures = new Map<string, Capture>();
	const root = options.stateDir ?? resolveClioDirs().state;
	const cap = Math.max(1024, Math.min(options.maxBytes ?? RECORDING_MAX_BYTES, RECORDING_MAX_BYTES));
	const duration = Math.max(0, Math.min(options.maxDurationMs ?? RECORDING_MAX_DURATION_MS, RECORDING_MAX_DURATION_MS));
	const nowMs = options.nowMs ?? (() => performance.now());
	const now = options.now ?? (() => new Date());
	const warn = options.warn ?? ((text: string) => process.stderr.write(`[clio-coder:recording] ${text}\n`));
	const persist = (capture: Capture): void => {
		if (stateRootRemoved()) throw new Error("state root removed");
		assertRecordingDirectory(root, capture.manifest.runId);
		const path = join(root, recordingReference(capture.manifest.runId).manifestPath);
		mkdirSync(join(root, "runs", capture.manifest.runId), { recursive: true, mode: 0o700 });
		safeResourceWrite(path, `${JSON.stringify(capture.manifest)}\n`, { mode: 0o600 });
	};
	const fail = (capture: Capture, error: unknown): void => {
		capture.manifest.completion = "failed";
		capture.manifest.error = error instanceof Error ? error.message : String(error);
		capture.manifest.castPath = null;
		capture.manifest.sha256 = null;
		capture.manifest.bytes = 0;
		warn(`run ${capture.manifest.runId}: ${capture.manifest.error}`);
		try {
			persist(capture);
		} catch {
			/* The warning remains visible when even the manifest cannot be written. */
		}
	};
	const finish = (runId: string, outcome: string): void => {
		const capture = captures.get(runId);
		if (!capture) return;
		captures.delete(runId);
		capture.manifest.endedAt = now().toISOString();
		capture.manifest.outcome = outcome;
		if (capture.manifest.completion === "failed") return;
		try {
			const tally = createRedactionTally();
			const safe = redactSecretSegments(
				capture.frames.map((frame) => frame[2]),
				tally,
			);
			const frames = capture.frames.map((frame, i): CastOutputEvent => [frame[0], "o", safe[i] ?? ""]);
			const header = JSON.stringify({
				version: 2,
				width: 100,
				height: 30,
				timestamp: Math.floor(Date.parse(capture.manifest.startedAt) / 1000),
			});
			let usedBytes = Buffer.byteLength(header) + 1;
			const lines = [`${header}\n`];
			for (const frame of frames) {
				const line = `${JSON.stringify(frame)}\n`;
				if (usedBytes + Buffer.byteLength(line) > cap - 256) {
					capture.manifest.droppedFrames += 1;
					continue;
				}
				lines.push(line);
				usedBytes += Buffer.byteLength(line);
			}
			const incomplete = outcome !== "succeeded" || capture.manifest.droppedFrames > 0;
			if (capture.manifest.droppedFrames > 0)
				lines.push(`${JSON.stringify([frames.at(-1)?.[0] ?? 0, "o", "\r\n[capture gap: display frames dropped]\r\n"])}\n`);
			const raw = lines.join("");
			parseRecordingCast(raw);
			capture.manifest.completion = incomplete ? "incomplete" : "complete";
			capture.manifest.redactionCount = tally.count;
			capture.manifest.bytes = Buffer.byteLength(raw);
			capture.manifest.sha256 = hash(raw);
			capture.manifest.castPath = `runs/${runId}/recording.cast`;
			safeResourceWrite(join(root, capture.manifest.castPath), raw, { mode: 0o600 });
			persist(capture);
		} catch (error) {
			fail(capture, error);
		}
	};
	return {
		accepts(runId) {
			return captures.has(runId);
		},
		start(runId, node) {
			const reference = recordingReference(runId);
			if (captures.has(runId)) return reference;
			if (captures.size >= 16) finish(captures.keys().next().value as string, "capture_capacity");
			const capture: Capture = {
				manifest: {
					version: 1,
					sourceKind: "worker-display",
					captureMethod: "asciicast-v2-side-channel",
					runId,
					node: structuredClone(node),
					startedAt: now().toISOString(),
					endedAt: null,
					completion: "recording",
					outcome: null,
					bytes: 0,
					sha256: null,
					castPath: null,
					droppedFrames: 0,
					redactionCount: 0,
				},
				startMs: nowMs(),
				frames: [],
				bytes: 0,
			};
			captures.set(runId, capture);
			try {
				persist(capture);
			} catch (error) {
				fail(capture, error);
			}
			return reference;
		},
		open() {
			/* Registration is explicit: journal traffic cannot opt a run into recording. */
		},
		append(runId, entry) {
			const capture = captures.get(runId);
			if (!capture || capture.manifest.completion === "failed") return;
			const elapsed = Math.max(0, nowMs() - capture.startMs);
			const text = displayText(
				entry.type === "text"
					? (entry.detail ?? "")
					: `${entry.type}${entry.tool ? ` ${entry.tool}` : ""}${entry.detail ? `: ${entry.detail}` : ""}${entry.outcome ? ` [${entry.outcome}]` : ""}${entry.reason ? ` ${entry.reason}` : ""}\r\n`,
			);
			const frame: CastOutputEvent = [Math.min(elapsed, duration) / 1000, "o", text];
			const bytes = Buffer.byteLength(JSON.stringify(frame)) + 1;
			if (elapsed > duration || capture.bytes + bytes > cap - 512 || capture.frames.length >= 10000) {
				capture.manifest.droppedFrames += 1;
				return;
			}
			capture.bytes += bytes;
			capture.frames.push(frame);
		},
		receipt() {
			/* Receipts retain their separate sealed authority. */
		},
		terminal(runId, outcome) {
			finish(runId, outcome);
		},
		stop() {
			for (const runId of captures.keys()) finish(runId, "capture_stopped");
		},
	};
}

/** Read only a bounded regular file at the canonical run path; refs cannot redirect export. */
export function readRunRecording(
	stateDir: string,
	runId: string,
): { manifest: RecordingManifest; cast: string | null } | null {
	const path = join(stateDir, recordingReference(runId).manifestPath);
	assertRecordingDirectory(stateDir, runId);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return null;
	if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("invalid recording manifest size");
	const manifest = parseRecordingManifest(JSON.parse(readFileSync(path, "utf8")));
	if (manifest.runId !== runId) throw new Error("recording run id mismatch");
	if (manifest.castPath === null) return { manifest, cast: null };
	if (manifest.castPath !== `runs/${runId}/recording.cast`) throw new Error("invalid recording path");
	const castPath = join(stateDir, manifest.castPath);
	const castStat = lstatSync(castPath);
	if (!castStat.isFile() || castStat.size > RECORDING_MAX_BYTES) throw new Error("invalid recording size");
	const cast = readFileSync(castPath, "utf8");
	if (Buffer.byteLength(cast) !== manifest.bytes || hash(cast) !== manifest.sha256)
		throw new Error("recording checksum mismatch");
	parseRecordingCast(cast);
	return { manifest, cast };
}

export function parseRecordingManifest(value: unknown): RecordingManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid recording manifest");
	const v = value as Record<string, unknown>;
	const node = v.node as Record<string, unknown> | null;
	const count = (x: unknown): boolean => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
	const date = (x: unknown): boolean => typeof x === "string" && Number.isFinite(Date.parse(x));
	if (
		v.version !== 1 ||
		v.sourceKind !== "worker-display" ||
		v.captureMethod !== "asciicast-v2-side-channel" ||
		typeof v.runId !== "string" ||
		!node ||
		typeof node.id !== "string" ||
		(node.kind !== "local" && node.kind !== "ssh") ||
		(node.host !== undefined && typeof node.host !== "string") ||
		!date(v.startedAt) ||
		(v.endedAt !== null && !date(v.endedAt)) ||
		!["recording", "complete", "incomplete", "failed"].includes(String(v.completion)) ||
		(v.outcome !== null && typeof v.outcome !== "string") ||
		!count(v.bytes) ||
		Number(v.bytes) > RECORDING_MAX_BYTES ||
		(v.sha256 !== null && (typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256))) ||
		(v.castPath !== null &&
			(typeof v.castPath !== "string" ||
				!/^(?:runs\/[A-Za-z0-9._-]+\/recording|recordings\/[A-Za-z0-9._-]+)\.cast$/.test(v.castPath))) ||
		!count(v.droppedFrames) ||
		!count(v.redactionCount) ||
		(v.error !== undefined && typeof v.error !== "string")
	)
		throw new Error("invalid recording manifest fields");
	if (
		Object.keys(v).some(
			(key) =>
				![
					"version",
					"sourceKind",
					"captureMethod",
					"runId",
					"node",
					"startedAt",
					"endedAt",
					"completion",
					"outcome",
					"bytes",
					"sha256",
					"castPath",
					"droppedFrames",
					"redactionCount",
					"error",
				].includes(key),
		) ||
		Object.keys(node).some((key) => !["id", "kind", "host"].includes(key))
	)
		throw new Error("unknown recording metadata");
	assertSafeId(v.runId, "run");
	return structuredClone(value) as RecordingManifest;
}
