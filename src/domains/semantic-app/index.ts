/** Application boundary for the optional semantic index. No model is contacted at startup. */

import { realpathSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { type ClioSettings, readSettings } from "../../core/config.js";
import { clioCacheDir, clioDataDir } from "../../core/xdg.js";
import { evidenceDirectory, inspectEvidence, listEvidenceOverviews } from "../evidence/index.js";
import type { ExtensionEmbeddingRequest } from "../extensions/public-api-v2.js";
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
import { createSafetyPolicyEngine } from "../safety/policy-engine.js";
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
	sourceHash,
} from "../semantic/index.js";
import { SemanticStorage } from "../semantic/storage.js";

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

async function providerInput(
	input: SemanticInput,
	allowedRoots: readonly string[],
	allowsPath: (path: string) => boolean,
): Promise<EmbeddingInput> {
	if (input.kind === "text") return input;
	if (input.kind === "video") throw new Error("Video embedding requires a qualified sampler and transport");
	const canonicalPath = await realpath(input.path);
	const source = await lstat(input.path);
	if (
		source.isSymbolicLink() ||
		!source.isFile() ||
		!allowedRoots.some((root) => within(root, canonicalPath)) ||
		!allowsPath(canonicalPath)
	)
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

/** Route, profile and service only; extension embeds and qualification never need the index. */
async function openSemanticRoute(options: SemanticAppOptions) {
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
		},
	});
	return { profile, profileIdentity: embeddingProfileIdentity(profile), projectId, config, target, service };
}

export async function openSemanticApp(options: SemanticAppOptions) {
	const route = await openSemanticRoute(options);
	const { config, projectId, profile, profileIdentity, service } = route;
	const allowedMediaRoots = config.inboxes
		.filter((inbox) => inbox.scope === "global" || inbox.project === projectId)
		.flatMap((inbox) => {
			try {
				return [realpathSync(inbox.root)];
			} catch {
				// A removed inbox is reported by refresh; an existing generation stays searchable.
				return [];
			}
		});
	const pathPolicy = createSafetyPolicyEngine({ cwd: projectId });
	const index = new SemanticIndex({
		projectId,
		profile: embeddingProfileToSemanticProfile(profile, profileIdentity),
		...(!options.offline
			? {
					embed: async (inputs: readonly SemanticInput[], request: { task: "query" | "document"; signal?: AbortSignal }) => {
						const converted = await Promise.all(
							inputs.map((input) => providerInput(input, allowedMediaRoots, (path) => pathPolicy.readablePath(path))),
						);
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
	return { ...route, index };
}

/** Host-owned extension bridge. The extension sees vectors and profile identity, never target credentials. */
export async function embedForExtension(
	options: SemanticAppOptions,
	request: ExtensionEmbeddingRequest,
	signal: AbortSignal,
) {
	const app = await openSemanticRoute(options);
	if (request.expectedProfileIdentity && request.expectedProfileIdentity !== app.profileIdentity)
		throw new Error("Embedding profile changed; re-embed saved vectors before comparing them");
	return app.service.embed({
		inputs: request.inputs,
		task: request.task,
		profile: app.profile,
		signal,
		priority: "foreground",
		timeoutMs: 25_000,
	});
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
	const policy = createSafetyPolicyEngine({ cwd: projectId });
	return previewInbox(inbox, { allowPath: (path) => policy.readablePath(path) });
}

export async function refreshSemantic(options: SemanticAppOptions, signal?: AbortSignal) {
	const app = await openSemanticApp(options);
	const policy = createSafetyPolicyEngine({ cwd: app.projectId });
	const allowPath = (path: string) => policy.readablePath(path);
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
			allowPath,
			...(signal ? { signal } : {}),
		}),
	];
	snapshots.push(...recordingSnapshots);
	for (const inbox of registeredInboxes(app.config, app.projectId)) {
		snapshots.push(
			await extractInbox(inbox, {
				allowPath,
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
	const records = app.index.canonicalRecords();
	if (records.length === 0) return refreshSemantic(options, signal);
	return app.index.reembed(records, signal ? { signal } : {});
}

/** Manual offline bridge between two exact profile namespaces. Only canonical records cross; vectors never do. */
export async function reembedSemanticFrom(
	options: SemanticAppOptions,
	oldProfileIdentity: string,
	signal?: AbortSignal,
) {
	if (!/^[a-f0-9]{64}$/.test(oldProfileIdentity))
		throw new Error("Old semantic profile identity must be a SHA-256 recipe key");
	const app = await openSemanticApp(options);
	if (oldProfileIdentity === app.profileIdentity) return reembedSemantic(options, signal);
	const oldDirectory = join(clioCacheDir(), "semantic", sourceHash(app.projectId), oldProfileIdentity);
	const oldStorage = new SemanticStorage(oldDirectory, Math.floor(app.index.limits.maxBytes / 3));
	const generation = oldStorage.load(app.projectId, oldProfileIdentity);
	if (!generation) throw new Error("No complete generation exists for the old profile in this project");
	const policy = createSafetyPolicyEngine({ cwd: app.projectId });
	const records = generation.records.filter((record) => record.kind === "memory" || policy.readablePath(record.path));
	if (records.length !== generation.records.length)
		throw new Error("Old generation includes sources no longer readable under the current project policy");
	return app.index.reembed(records, signal ? { signal } : {});
}

export async function searchSemantic(
	options: SemanticAppOptions,
	query: string,
	filters: Omit<SemanticFilters, "projectId"> = {},
	signal?: AbortSignal,
) {
	let app: Awaited<ReturnType<typeof openSemanticApp>>;
	try {
		app = await openSemanticApp(options);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("Semantic target authentication unavailable")) throw error;
		app = await openSemanticApp({ ...options, offline: true });
	}
	const policy = createSafetyPolicyEngine({ cwd: app.projectId });
	const records = loadMemoryRecordsSync(clioDataDir());
	const evidenceRoot = join(clioDataDir(), "evidence");
	const realRoot = (root: string) => {
		try {
			return [realpathSync(root)];
		} catch {
			// A missing root admits nothing; its records are dropped at the next refresh.
			return [];
		}
	};
	// Recording paths are canonical, evidence surface paths are not; a symlinked data directory needs both.
	const evidenceRoots = [evidenceRoot, ...realRoot(evidenceRoot)];
	const inboxRoots = registeredInboxes(app.config, app.projectId).flatMap((inbox) => realRoot(inbox.root));
	const eligibleMemories = eligibleSemanticMemory(records, {
		activeRepository: canonicalMemoryRepositoryIdentity(app.projectId),
	});
	const eligibleMemoryHashes = new Map(
		eligibleMemories.map((record) => [record.id, sourceHash(JSON.stringify(record))]),
	);
	return app.index.search(
		query,
		{
			...filters,
			projectId: app.projectId,
			// User-scope inboxes and global memories are stamped global; roots and eligibility below still gate them.
			includeGlobal: true,
			eligibleMemoryIds: eligibleMemories.map((record) => record.id),
			allowsPath: (path) => policy.readablePath(path),
			allowsRecord: (record) => {
				if (record.kind === "memory") return record.contentHash === eligibleMemoryHashes.get(record.memoryId ?? "");
				const roots =
					record.kind === "evidence" || record.kind === "recording"
						? evidenceRoots
						: record.kind === "inbox"
							? inboxRoots
							: [app.projectId];
				return roots.some((root) => within(root, record.path));
			},
		},
		signal,
	);
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
	const app = await openSemanticRoute(options);
	const qualified = await qualifyEmbeddingProfile(app.service, app.profile);
	const image = {
		kind: "image" as const,
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
		mimeType: "image/png" as const,
	};
	const wav = Buffer.alloc(44 + 3200);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(16_000, 24);
	wav.writeUInt32LE(32_000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(3200, 40);
	for (let i = 0; i < 1600; i++)
		wav.writeInt16LE(Math.round(1000 * Math.sin((2 * Math.PI * 440 * i) / 16_000)), 44 + i * 2);
	const audio = { kind: "audio" as const, data: wav.toString("base64"), mimeType: "audio/wav" as const };
	const inputs: EmbeddingInput[] = [];
	if (app.config.modalities.includes("image")) inputs.push(image);
	if (app.config.modalities.includes("audio")) inputs.push(audio);
	if (app.config.modalities.includes("mixed")) {
		if (!app.config.modalities.includes("image") && !app.config.modalities.includes("audio"))
			throw new Error("Mixed embedding qualification requires image or audio to be enabled");
		inputs.push({
			kind: "mixed",
			parts: [
				{ kind: "text", text: "scientific delayed oscillation" },
				...(app.config.modalities.includes("image") ? [image] : []),
				...(app.config.modalities.includes("audio") ? [audio] : []),
			],
		});
	}
	if (inputs.length) await app.service.embed({ inputs, task: "document", profile: qualified, priority: "foreground" });
	return qualified;
}
