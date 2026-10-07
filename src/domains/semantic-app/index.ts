/** Application boundary for the optional semantic index. No model is contacted at startup. */

import { realpathSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { type ClioSettings, readSettings } from "../../core/config.js";
import { clioDataDir } from "../../core/xdg.js";
import { evidenceDirectory, inspectEvidence, listEvidenceOverviews } from "../evidence/index.js";
import { canonicalMemoryRepositoryIdentity, loadMemoryRecordsSync } from "../memory/index.js";
import { openAuthStorage, resolveAuthTarget } from "../providers/auth/index.js";
import {
	createEmbeddingService,
	type EmbeddingInput,
	type EmbeddingProfile,
	embeddingGemma2Q8Profile,
	embeddingProfileIdentity,
	qualifyEmbeddingProfile,
} from "../providers/embedding/index.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";
import {
	type ExtractionResult,
	eligibleSemanticMemory,
	embeddingProfileToSemanticProfile,
	extractInbox,
	extractProjectSources,
	extractRecording,
	type InboxRegistration,
	previewInbox,
	type SampledMediaPiece,
	type SemanticFilters,
	SemanticIndex,
	type SemanticInput,
} from "../semantic/index.js";

export interface SemanticAppOptions {
	projectRoot: string;
	settings?: ClioSettings;
	/** Inspect an existing generation without making a model request. */
	offline?: boolean;
}

function configured(
	settings: ClioSettings,
): ClioSettings["context"]["semantic"] & { target: string; model: string; assetIdentity: string } {
	const config = settings.context.semantic;
	if (!config.enabled) throw new Error("Semantic indexing is disabled. Configure it explicitly first.");
	if (!config.target || !config.model || !config.assetIdentity)
		throw new Error("Semantic indexing requires a pinned target, model and asset identity.");
	return config as ClioSettings["context"]["semantic"] & { target: string; model: string; assetIdentity: string };
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	);
}

async function providerInput(input: SemanticInput, allowedRoots: readonly string[]): Promise<EmbeddingInput> {
	if (input.kind === "text") return input;
	if (input.kind === "video") throw new Error("Video embedding requires a qualified sampler and transport");
	const canonicalPath = await realpath(input.path);
	const source = await lstat(input.path);
	if (source.isSymbolicLink() || !source.isFile() || !allowedRoots.some((root) => within(root, canonicalPath)))
		throw new Error("Semantic media path is outside registered sources or changed to a symlink");
	if (source.size > 8 * 1024 * 1024) throw new Error("Semantic media source exceeds 8 MiB");
	const bytes = input.dataBase64 ? Buffer.from(input.dataBase64, "base64") : await readFile(canonicalPath);
	if (bytes.length > 8 * 1024 * 1024) throw new Error("Semantic media input exceeds 8 MiB");
	if (input.kind === "image") {
		if (!["image/png", "image/jpeg", "image/webp"].includes(input.mimeType))
			throw new Error("Unsupported image MIME type");
		return { kind: "image", data: bytes.toString("base64"), mimeType: input.mimeType as "image/png" };
	}
	if (!["audio/wav", "audio/mpeg", "audio/flac", "audio/ogg"].includes(input.mimeType))
		throw new Error("Unsupported audio MIME type");
	return { kind: "audio", data: bytes.toString("base64"), mimeType: input.mimeType as "audio/wav" };
}

export async function openSemanticApp(options: SemanticAppOptions) {
	const settings = options.settings ?? readSettings();
	const config = configured(settings);
	const projectId = realpathSync(options.projectRoot);
	const target = settings.targets.find((entry) => entry.id === config.target);
	if (!target) throw new Error(`Semantic target ${config.target} is not configured`);
	if (target.runtime !== "llamacpp-embed" && target.runtime !== "litellm")
		throw new Error("Semantic target must use a qualified llama.cpp embedding or LiteLLM runtime");
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	if (!runtime) throw new Error(`Semantic runtime ${target.runtime} is unavailable`);
	const profile = embeddingGemma2Q8Profile({
		model: config.model,
		assetIdentity: config.assetIdentity,
		...(config.projectorIdentity ? { projectorIdentity: config.projectorIdentity } : {}),
		...(config.canaryFingerprint ? { canaryFingerprint: config.canaryFingerprint } : {}),
	});
	let authToken: string | undefined;
	if (!options.offline && (target.auth?.apiKeyRef || target.auth?.apiKeyEnvVar || target.auth?.oauthProfile)) {
		const auth = await openAuthStorage().resolveForTarget(resolveAuthTarget(target, runtime));
		if (!auth.available || !auth.apiKey)
			throw new Error(`Semantic target authentication unavailable: ${auth.detail ?? target.id}`);
		authToken = auth.apiKey;
	}
	const service = createEmbeddingService({
		route: {
			target,
			model: config.model,
			modalities: config.modalities,
			...(authToken ? { authToken } : {}),
			admissionKey: target.url ?? target.id,
		},
	});
	const allowedMediaRoots = config.inboxes
		.filter((inbox) => inbox.scope === "global" || inbox.project === projectId)
		.map((inbox) => realpathSync(inbox.root));
	const profileIdentity = embeddingProfileIdentity(profile);
	const index = new SemanticIndex({
		projectId,
		profile: embeddingProfileToSemanticProfile(profile, profileIdentity),
		...(!options.offline
			? {
					embed: async (inputs: readonly SemanticInput[], request: { task: "query" | "document"; signal?: AbortSignal }) => {
						const converted = await Promise.all(inputs.map((input) => providerInput(input, allowedMediaRoots)));
						const response = await service.embed({
							inputs: converted,
							profile,
							task: request.task,
							priority: request.task === "document" ? "background" : "foreground",
							...(request.signal ? { signal: request.signal } : {}),
						});
						return { profileKey: response.profileIdentity, vectors: response.vectors };
					},
				}
			: {}),
	});
	return { index, profile, profileIdentity, projectId, config, target, service };
}

function registeredInboxes(config: ClioSettings["context"]["semantic"], projectId: string): InboxRegistration[] {
	return config.inboxes
		.filter((inbox) => inbox.scope === "global" || inbox.project === projectId)
		.map((inbox) => ({ id: inbox.id, root: inbox.root, scope: inbox.scope, projectId }));
}

/** One bounded native WAV segment. Other media await an explicitly qualified sampler. */
async function sampleQualifiedWav(
	path: string,
	options: { maxSeconds: number; maxPieces: number; signal?: AbortSignal },
): Promise<readonly SampledMediaPiece[]> {
	options.signal?.throwIfAborted();
	if (!path.toLowerCase().endsWith(".wav") || options.maxPieces < 1) return [];
	const source = await lstat(path);
	if (!source.isFile() || source.isSymbolicLink() || source.size > 8 * 1024 * 1024)
		throw new Error("WAV source is not a bounded regular file");
	const bytes = await readFile(path);
	if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
		throw new Error("Invalid WAV header");
	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	let byteRate = 0;
	let format = 0;
	let dataBytes = 0;
	while (offset + 8 <= bytes.length) {
		const length = bytes.readUInt32LE(offset + 4);
		if (offset + 8 + length > bytes.length) throw new Error("Invalid WAV chunk length");
		const tag = bytes.toString("ascii", offset, offset + 4);
		if (tag === "fmt " && length >= 16) {
			format = bytes.readUInt16LE(offset + 8);
			channels = bytes.readUInt16LE(offset + 10);
			sampleRate = bytes.readUInt32LE(offset + 12);
			byteRate = bytes.readUInt32LE(offset + 16);
		}
		if (tag === "data") dataBytes += length;
		offset += 8 + length + (length % 2);
	}
	if (![1, 3].includes(format) || channels !== 1 || sampleRate !== 16_000 || byteRate <= 0 || dataBytes === 0)
		throw new Error("WAV embedding requires mono 16 kHz PCM or float audio");
	const seconds = dataBytes / byteRate;
	if (!Number.isFinite(seconds) || seconds > options.maxSeconds)
		throw new Error("WAV duration exceeds the media budget");
	return [{ input: { kind: "audio", path, mimeType: "audio/wav" }, location: { startSeconds: 0, endSeconds: seconds } }];
}

export async function previewSemanticInbox(options: SemanticAppOptions, id: string) {
	const settings = options.settings ?? readSettings();
	const projectId = realpathSync(options.projectRoot);
	const inbox = registeredInboxes(configured(settings), projectId).find((entry) => entry.id === id);
	if (!inbox) throw new Error(`Semantic inbox ${id} is not registered for this project`);
	return previewInbox(inbox);
}

export async function refreshSemantic(options: SemanticAppOptions, signal?: AbortSignal) {
	const app = await openSemanticApp(options);
	const records = loadMemoryRecordsSync(clioDataDir());
	const memoryEligibility = { activeRepository: canonicalMemoryRepositoryIdentity(app.projectId) };
	const evidence: Array<{
		bundle: Awaited<ReturnType<typeof inspectEvidence>>;
		directory: string;
		redactedTranscript?: string;
	}> = [];
	const recordingSnapshots: ExtractionResult[] = [];
	for (const overview of (await listEvidenceOverviews(clioDataDir())).slice(-100)) {
		signal?.throwIfAborted();
		if (
			!overview.cwds.length ||
			overview.cwds.some((cwd) => {
				try {
					return realpathSync(cwd) !== app.projectId;
				} catch {
					return true;
				}
			})
		)
			continue;
		const directory = evidenceDirectory(clioDataDir(), overview.evidenceId);
		const bundle = await inspectEvidence(clioDataDir(), overview.evidenceId);
		const transcriptPath = join(directory, "transcript.md");
		const transcriptStat = await stat(transcriptPath).catch(() => null);
		const redactedTranscript =
			transcriptStat && transcriptStat.size <= 1024 * 1024 ? await readFile(transcriptPath, "utf8") : undefined;
		evidence.push({ bundle, directory, ...(redactedTranscript ? { redactedTranscript } : {}) });
		for (const recording of overview.recordings ?? []) {
			if (!recording.castPath || !recording.sha256) continue;
			try {
				recordingSnapshots.push(
					extractRecording(
						{
							projectId: app.projectId,
							runId: recording.runId,
							root: directory,
							path: join(directory, recording.castPath),
							sha256: recording.sha256,
							redacted: true,
						},
						signal ? { signal } : {},
					),
				);
			} catch (error) {
				recordingSnapshots.push({
					records: [],
					truncated: false,
					sources: [
						{
							path: join(directory, recording.castPath),
							state: "failed",
							reason: error instanceof Error ? error.message : String(error),
						},
					],
				});
			}
		}
	}
	const snapshots: ExtractionResult[] = [
		await extractProjectSources({
			projectRoot: app.projectId,
			projectId: app.projectId,
			memoryRecords: records,
			memoryEligibility,
			evidence,
			...(signal ? { signal } : {}),
		}),
	];
	snapshots.push(...recordingSnapshots);
	for (const inbox of registeredInboxes(app.config, app.projectId)) {
		snapshots.push(
			await extractInbox(inbox, {
				modalities: app.config.modalities.filter(
					(value): value is "image" | "audio" => value === "image" || value === "audio",
				),
				...(app.config.modalities.includes("audio") ? { mediaSampler: sampleQualifiedWav } : {}),
				...(signal ? { signal } : {}),
			}),
		);
	}
	const merged: ExtractionResult = {
		records: snapshots.flatMap((snapshot) => snapshot.records),
		sources: snapshots.flatMap((snapshot) => snapshot.sources),
		truncated: snapshots.some((snapshot) => snapshot.truncated),
	};
	return { result: await app.index.refreshExtracted(merged, signal ? { signal } : {}), sources: merged.sources };
}

export async function reembedSemantic(options: SemanticAppOptions, signal?: AbortSignal) {
	const app = await openSemanticApp(options);
	return app.index.reembed(undefined, signal ? { signal } : {});
}

export async function searchSemantic(
	options: SemanticAppOptions,
	query: string,
	filters: Omit<SemanticFilters, "projectId"> = {},
	signal?: AbortSignal,
) {
	const app = await openSemanticApp(options);
	const records = loadMemoryRecordsSync(clioDataDir());
	const eligibleMemoryIds = eligibleSemanticMemory(records, {
		activeRepository: canonicalMemoryRepositoryIdentity(app.projectId),
	}).map((record) => record.id);
	return app.index.search(query, { ...filters, projectId: app.projectId, eligibleMemoryIds }, signal);
}

export async function statusSemantic(options: SemanticAppOptions) {
	const app = await openSemanticApp({ ...options, offline: true });
	return {
		...app.index.status(),
		target: app.target.id,
		model: app.profile.model,
		profileIdentity: app.profileIdentity,
	};
}

/** Explicit operator canary: returned recipe must be persisted before use as a new profile. */
export async function qualifySemantic(options: SemanticAppOptions): Promise<EmbeddingProfile> {
	const app = await openSemanticApp(options);
	return qualifyEmbeddingProfile(app.service, app.profile);
}
