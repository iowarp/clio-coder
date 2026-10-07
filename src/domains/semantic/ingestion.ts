import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runCommandVector } from "../../core/safe-exec.js";
import { codemapPath, readCodewiki, wikiDir } from "../context/index.js";
import type { EvidenceInspectable } from "../evidence/index.js";
import type { MemoryPromptOptions, MemoryRecord } from "../memory/index.js";
import { selectMemoryForPrompt } from "../memory/index.js";
import type { CompiledPathPolicy } from "../safety/index.js";
import { evaluatePathPolicy } from "../safety/index.js";
import { FrameDecoderUnavailable, sampleMediaFrames } from "./frames.js";
import { sourceHash } from "./storage.js";
import type { SemanticInput, SemanticLocation, SemanticRecord } from "./types.js";

export const SEMANTIC_EXTRACTION_VERSION = "semantic-v1";
export const SEMANTIC_FRAME_EXTRACTION_VERSION = "semantic-frames-v1-1s-512px";
export interface ExtractionLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	maxTextChars: number;
	maxPieces: number;
	maxPages: number;
	maxMediaSeconds: number;
}
export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
	maxFiles: 1000,
	maxFileBytes: 8 * 1024 * 1024,
	maxTotalBytes: 32 * 1024 * 1024,
	maxTextChars: 8000,
	maxPieces: 5000,
	maxPages: 50,
	maxMediaSeconds: 300,
};
export interface SourceState {
	path: string;
	state: "ready" | "unsupported" | "failed" | "skipped";
	reason?: string;
}
export interface ExtractionResult {
	records: SemanticRecord[];
	sources: SourceState[];
	truncated: boolean;
}
export interface ExtractionOptions {
	limits?: Partial<ExtractionLimits>;
	signal?: AbortSignal;
	pathPolicy?: CompiledPathPolicy;
	/** Additional caller-owned protection rules; false excludes before reads. */
	allowPath?: (path: string) => boolean;
}
export interface InboxRegistration {
	id: string;
	root: string;
	projectId: string;
	scope: "project" | "global";
	experimentId?: string;
	runId?: string;
}
export interface SampledMediaPiece {
	input: SemanticInput;
	location: SemanticLocation;
	text?: string;
}
export interface InboxOptions extends ExtractionOptions {
	/** Explicit qualification is required before a multimodal input is emitted. */
	modalities?: readonly ("image" | "audio" | "video")[];
	pdfPages?: (
		path: string,
		options: { maxPages: number; maxBytes: number; signal?: AbortSignal },
	) => Promise<readonly { page: number; text: string }[]>;
	/** Optional qualified sampler override. Empty GIF/video output falls back to bounded PNG frames.
	 * Samplers must enforce the supplied duration/piece limits and preserve exact timestamps. */
	mediaSampler?: (
		path: string,
		options: { maxSeconds: number; maxPieces: number; signal?: AbortSignal },
	) => Promise<readonly SampledMediaPiece[]>;
}

function limitsFor(options: ExtractionOptions): ExtractionLimits {
	const limits = { ...DEFAULT_EXTRACTION_LIMITS, ...options.limits };
	for (const n of Object.values(limits))
		if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid extraction limit");
	return limits;
}
function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	);
}
function protectedName(path: string): boolean {
	return (
		/(^|[/\\])(\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.git|node_modules|\.venv|credentials?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|id_rsa|id_ed25519)([/\\]|$)/i.test(
			path,
		) || /\.(pem|key|p12|pfx)$/i.test(path)
	);
}
function allowed(root: string, path: string, options: ExtractionOptions): boolean {
	if (!within(root, path) || protectedName(path) || options.allowPath?.(path) === false) return false;
	if (options.pathPolicy && evaluatePathPolicy(options.pathPolicy, "read", path).kind === "block") return false;
	let current = path;
	while (within(root, current)) {
		if (lstatSync(current).isSymbolicLink()) return false;
		if (current === root) break;
		current = dirname(current);
	}
	return within(root, realpathSync(path));
}
function secretContent(text: string): boolean {
	// Evidence has already replaced secret values with these placeholders. Scan
	// the remaining text for any unredacted value without discarding the useful
	// warning or failure on the same terminal frame.
	const unredacted = text.replace(/\[redacted:[a-z-]+\]/gi, "x");
	return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b|(?:api[_-]?key|password|access[_-]?token|auth[_-]?token|authorization|_auth|client[_-]?secret)\s*[=:]\s*["']?[^\s"']{8,}/i.test(
		unredacted,
	);
}
function piece(
	base: Omit<SemanticRecord, "id" | "text" | "input" | "location" | "extractionVersion">,
	suffix: string,
	text: string,
	input: SemanticInput,
	location: SemanticLocation,
): SemanticRecord {
	return {
		...base,
		id: `${base.sourceId}#${suffix}`,
		text,
		input,
		location,
		extractionVersion:
			input.kind === "image" && (base.mediaType.startsWith("video/") || base.mediaType === "image/gif")
				? SEMANTIC_FRAME_EXTRACTION_VERSION
				: SEMANTIC_EXTRACTION_VERSION,
	};
}
function textPieces(
	base: Parameters<typeof piece>[0],
	text: string,
	limits: ExtractionLimits,
	location: SemanticLocation = {},
): SemanticRecord[] {
	if (secretContent(text)) return [];
	const records: SemanticRecord[] = [];
	for (let offset = 0; offset < text.length && records.length < limits.maxPieces; offset += limits.maxTextChars) {
		const chunk = text.slice(offset, offset + limits.maxTextChars);
		const line = (location.line ?? 1) + (text.slice(0, offset).match(/\n/g)?.length ?? 0);
		records.push(
			piece(
				base,
				`text:${location.cell ?? ""}:${location.output ?? ""}:${location.page ?? ""}:${offset}`,
				chunk,
				{ kind: "text", text: chunk },
				{ ...location, line, byte: Buffer.byteLength(text.slice(0, offset)) },
			),
		);
	}
	return records;
}

async function discover(root: string, options: ExtractionOptions, limits: ExtractionLimits) {
	const scan = await runCommandVector(
		"rg",
		[
			"--files",
			"--hidden",
			"--no-require-git",
			"-0",
			"--glob",
			"!**/.git/**",
			"--glob",
			"!**/node_modules/**",
			"--glob",
			"!**/.clio-coder/**",
			"--glob",
			"!**/.venv/**",
			".",
		],
		{
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 10_000,
			maxOutputBytes: 512_000,
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	options.signal?.throwIfAborted();
	if (scan.aborted || scan.timedOut || scan.outputCapped || (scan.exitCode !== 0 && scan.exitCode !== 1))
		throw new Error("Inbox discovery unavailable or exceeded its scan budget; ripgrep is required to honor ignore rules");
	const paths = scan.stdout.split("\0").filter(Boolean).sort();
	return {
		paths: paths.slice(0, limits.maxFiles).map((p) => resolve(root, p)),
		truncated: paths.length > limits.maxFiles,
	};
}

export async function previewInbox(registration: InboxRegistration, options: ExtractionOptions = {}) {
	if (
		!registration.id ||
		!registration.projectId ||
		!isAbsolute(registration.root) ||
		!["project", "global"].includes(registration.scope)
	)
		throw new Error("Inbox requires an explicit absolute root, registration ID and scope identity");
	const root = resolve(registration.root);
	if (
		lstatSync(root).isSymbolicLink() ||
		realpathSync(root) !== root ||
		!statSync(root).isDirectory() ||
		protectedName(root)
	)
		throw new Error("Inbox root must be a canonical unprotected directory");
	const limits = limitsFor(options);
	const scan = await discover(root, options, limits);
	const files: { path: string; bytes: number; mediaType: string }[] = [];
	const sources: SourceState[] = [];
	let totalBytes = 0;
	let truncated = scan.truncated;
	for (const path of scan.paths) {
		options.signal?.throwIfAborted();
		try {
			if (!allowed(root, path, options)) {
				sources.push({ path, state: "skipped", reason: "Protected path or symlink" });
				continue;
			}
			const bytes = statSync(path).size;
			if (bytes > limits.maxFileBytes || totalBytes + bytes > limits.maxTotalBytes) {
				truncated = true;
				sources.push({ path, state: "skipped", reason: "File or total byte budget" });
				continue;
			}
			totalBytes += bytes;
			files.push({ path, bytes, mediaType: mediaType(path) });
		} catch (error) {
			sources.push({ path, state: "failed", reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return {
		files,
		sources,
		totalBytes,
		estimatedPieces: files.reduce((sum, file) => sum + Math.max(1, Math.ceil(file.bytes / limits.maxTextChars)), 0),
		truncated,
	};
}

function mediaType(path: string): string {
	const ext = extname(path).toLowerCase();
	const types: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".webp": "image/webp",
		".gif": "image/gif",
		".pdf": "application/pdf",
		".ipynb": "application/x-ipynb+json",
		".wav": "audio/wav",
		".mp3": "audio/mpeg",
		".flac": "audio/flac",
		".ogg": "audio/ogg",
		".mp4": "video/mp4",
		".webm": "video/webm",
		".mov": "video/quicktime",
	};
	if (types[ext]) return types[ext];
	return /\.(txt|md|rst|csv|tsv|json|jsonl|yaml|yml|toml|xml|html|tex|log|py|ts|tsx|js|jsx|c|h|cpp|hpp|cu|rs|go|jl|r|f90|sh)$/i.test(
		path,
	)
		? "text/plain"
		: "application/octet-stream";
}

export async function extractPdfPages(
	path: string,
	options: { maxPages: number; maxBytes: number; signal?: AbortSignal },
): Promise<{ page: number; text: string }[]> {
	const result = await runCommandVector(
		"pdftotext",
		["-f", "1", "-l", String(options.maxPages), "-enc", "UTF-8", "-q", path, "-"],
		{
			cwd: dirname(path),
			workspaceRoot: dirname(path),
			timeoutMs: 15_000,
			maxOutputBytes: options.maxBytes,
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	options.signal?.throwIfAborted();
	if (result.exitCode !== 0 || result.outputCapped || result.timedOut || result.aborted)
		throw new Error("PDF text extraction unavailable or exceeded its budget (requires pdftotext)");
	return result.stdout
		.split("\f")
		.slice(0, options.maxPages)
		.flatMap((text, index) => (text.trim() ? [{ page: index + 1, text }] : []));
}

export async function extractInbox(
	registration: InboxRegistration,
	options: InboxOptions = {},
): Promise<ExtractionResult> {
	const limits = limitsFor(options);
	const preview = await previewInbox(registration, options);
	const result: ExtractionResult = { records: [], sources: [...preview.sources], truncated: preview.truncated };
	let retainedBytes = 0;
	for (const file of preview.files) {
		options.signal?.throwIfAborted();
		if (result.records.length >= limits.maxPieces) {
			result.truncated = true;
			break;
		}
		try {
			if (!allowed(registration.root, file.path, options) || statSync(file.path).size > limits.maxFileBytes)
				throw new Error("Source changed or became protected");
			const bytes = readFileSync(file.path);
			const base = {
				sourceId: `inbox:${registration.id}:${relative(registration.root, file.path)}`,
				kind: "inbox" as const,
				projectId: registration.projectId,
				scope: registration.scope,
				visibility: registration.scope === "global" ? ("global" as const) : ("project" as const),
				path: file.path,
				contentHash: sourceHash(bytes),
				updatedAt: statSync(file.path).mtime.toISOString(),
				mediaType: file.mediaType,
				...(registration.runId ? { runId: registration.runId } : {}),
				...(registration.experimentId ? { experimentId: registration.experimentId } : {}),
			};
			let records: SemanticRecord[] = [];
			if (file.mediaType === "text/plain") {
				const text = bytes.toString("utf8");
				if (text.includes("\0") || secretContent(text)) {
					result.sources.push({ path: file.path, state: "skipped", reason: "Binary or credential-shaped content" });
					continue;
				}
				records = textPieces(base, text, limits);
			} else if (file.mediaType === "application/pdf") {
				const pages = await (options.pdfPages ?? extractPdfPages)(file.path, {
					maxPages: limits.maxPages,
					maxBytes: limits.maxFileBytes,
					...(options.signal ? { signal: options.signal } : {}),
				});
				records = pages
					.slice(0, limits.maxPages)
					.flatMap((page) => textPieces(base, page.text, limits, { page: page.page }));
				if (!records.length) {
					result.sources.push({
						path: file.path,
						state: "unsupported",
						reason: "No extractable PDF text; scanned-page OCR is unavailable",
					});
					continue;
				}
			} else if (file.mediaType === "application/x-ipynb+json") {
				records = notebookPieces(base, bytes.toString("utf8"), limits, options);
			} else if (file.mediaType.startsWith("image/") && file.mediaType !== "image/gif") {
				if (!options.modalities?.includes("image")) {
					result.sources.push({ path: file.path, state: "unsupported", reason: "Image backend has not been qualified" });
					continue;
				}
				records = [
					piece(
						base,
						"image",
						relative(registration.root, file.path),
						{ kind: "image", path: file.path, mimeType: file.mediaType },
						{},
					),
				];
			} else if (
				file.mediaType.startsWith("audio/") ||
				file.mediaType.startsWith("video/") ||
				file.mediaType === "image/gif"
			) {
				const frames = file.mediaType.startsWith("video/") || file.mediaType === "image/gif";
				if (frames && !options.modalities?.includes("image")) {
					result.sources.push({
						path: file.path,
						state: "unsupported",
						reason: "Frame sampling requires a qualified image backend; raw video is unsupported",
					});
					continue;
				}
				if (!frames && !options.mediaSampler) {
					result.sources.push({ path: file.path, state: "unsupported", reason: "No qualified bounded media sampler" });
					continue;
				}
				const samplerOptions = {
					maxSeconds: limits.maxMediaSeconds,
					maxPieces: Math.min(limits.maxPieces - result.records.length, 64),
					...(options.signal ? { signal: options.signal } : {}),
				};
				let samples = (await options.mediaSampler?.(file.path, samplerOptions)) ?? [];
				if (frames && samples.length === 0)
					samples = await sampleMediaFrames(file.path, bytes, {
						...samplerOptions,
						maxBytes: Math.min(limits.maxFileBytes, Math.floor(limits.maxTotalBytes * 0.7)),
					});
				if (samples.length === 0) {
					result.sources.push({
						path: file.path,
						state: "unsupported",
						reason: "No qualified bounded sampler for this format",
					});
					continue;
				}
				for (const [i, sample] of samples.slice(0, 64).entries()) {
					if (
						sample.input.kind === "text" ||
						!options.modalities?.includes(sample.input.kind) ||
						sample.location.startSeconds === undefined ||
						!Number.isFinite(sample.location.startSeconds) ||
						sample.location.startSeconds < 0 ||
						sample.location.startSeconds > limits.maxMediaSeconds ||
						(sample.location.endSeconds !== undefined &&
							(!Number.isFinite(sample.location.endSeconds) ||
								sample.location.endSeconds < sample.location.startSeconds ||
								sample.location.endSeconds > limits.maxMediaSeconds))
					)
						throw new Error("Media sampler returned unqualified modality or invalid timestamp");
					records.push(
						piece(
							base,
							`sample:${i}`,
							(sample.text ?? relative(registration.root, file.path)).slice(0, limits.maxTextChars),
							sample.input,
							sample.location,
						),
					);
				}
			} else {
				result.sources.push({ path: file.path, state: "unsupported", reason: "Unsupported file type" });
				continue;
			}
			const remaining = limits.maxPieces - result.records.length;
			if (records.length > remaining) result.truncated = true;
			for (const record of records.slice(0, remaining)) {
				const size = Buffer.byteLength(JSON.stringify(record));
				if (retainedBytes + size > limits.maxTotalBytes) {
					result.truncated = true;
					break;
				}
				retainedBytes += size;
				result.records.push(record);
			}
			result.sources.push({ path: file.path, state: "ready" });
		} catch (error) {
			options.signal?.throwIfAborted();
			result.sources.push({
				path: file.path,
				state: error instanceof FrameDecoderUnavailable ? "unsupported" : "failed",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

function notebookPieces(
	base: Parameters<typeof piece>[0],
	text: string,
	limits: ExtractionLimits,
	options: InboxOptions,
): SemanticRecord[] {
	if (secretContent(text)) return [];
	const notebook = JSON.parse(text) as {
		cells?: {
			source?: string | string[];
			outputs?: { text?: string | string[]; data?: Record<string, string | string[]> }[];
		}[];
	};
	const records: SemanticRecord[] = [];
	const joinText = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join("") : (value ?? ""));
	for (const [cell, item] of (notebook.cells ?? []).entries()) {
		if (records.length >= limits.maxPieces) break;
		records.push(...textPieces(base, joinText(item.source), limits, { cell }));
		for (const [output, value] of (item.outputs ?? []).entries()) {
			records.push(...textPieces(base, joinText(value.text ?? value.data?.["text/plain"]), limits, { cell, output }));
			if (options.modalities?.includes("image"))
				for (const mimeType of ["image/png", "image/jpeg"]) {
					const dataBase64 = joinText(value.data?.[mimeType]);
					if (dataBase64 && dataBase64.length <= (limits.maxFileBytes * 4) / 3 && /^[A-Za-z0-9+/=\s]+$/.test(dataBase64))
						records.push(
							piece(
								base,
								`cell:${cell}:output:${output}:${mimeType}`,
								`Notebook cell ${cell} output ${output}`,
								{ kind: "image", path: base.path, mimeType, dataBase64 },
								{ cell, output },
							),
						);
				}
		}
	}
	return records.slice(0, limits.maxPieces);
}

export interface ProjectSourcesOptions extends ExtractionOptions {
	projectRoot: string;
	projectId: string;
	memoryRecords?: readonly MemoryRecord[];
	memoryEligibility?: MemoryPromptOptions;
	/** Only caller-authorized inspected bundles; raw sessions and receipts are never read. */
	evidence?: readonly { bundle: EvidenceInspectable; directory: string; redactedTranscript?: string }[];
}

export function eligibleSemanticMemory(
	records: readonly MemoryRecord[],
	eligibility: MemoryPromptOptions,
): MemoryRecord[] {
	return selectMemoryForPrompt(records, { ...eligibility, tokenBudget: 1_000_000, maxItems: 500 });
}

export async function extractProjectSources(options: ProjectSourcesOptions): Promise<ExtractionResult> {
	const limits = limitsFor(options);
	const root = realpathSync(options.projectRoot);
	const result: ExtractionResult = { records: [], sources: [], truncated: false };
	const baseFor = (path: string, sourceId: string, kind: SemanticRecord["kind"], hash: string) => ({
		sourceId,
		kind,
		projectId: options.projectId,
		scope: "project" as const,
		visibility: "project" as const,
		path,
		contentHash: hash,
		mediaType: "text/plain",
	});
	let extractedBytes = 0;
	let readBytes = 0;
	const admitRead = (path: string) => {
		const size = statSync(path).size;
		if (size > limits.maxFileBytes || readBytes + size > limits.maxTotalBytes) {
			result.truncated = true;
			return false;
		}
		readBytes += size;
		return true;
	};
	const add = (records: SemanticRecord[]) => {
		records = records.filter((record) => {
			const size = Buffer.byteLength(JSON.stringify(record));
			if (extractedBytes + size > limits.maxTotalBytes) {
				result.truncated = true;
				return false;
			}
			extractedBytes += size;
			return true;
		});
		if (result.records.length + records.length > limits.maxPieces) result.truncated = true;
		result.records.push(...records.slice(0, Math.max(0, limits.maxPieces - result.records.length)));
	};
	const mapPath = codemapPath(root);
	try {
		if (allowed(root, mapPath, options) && admitRead(mapPath)) {
			const map = readCodewiki(root);
			if (!map) throw new Error("Invalid codemap; refusing an incomplete extraction snapshot");
			if (map.files.length > limits.maxFiles) result.truncated = true;
			for (const file of (map?.files ?? []).slice(0, limits.maxFiles)) {
				options.signal?.throwIfAborted();
				const path = resolve(root, file.path);
				try {
					if (!allowed(root, path, options) || !admitRead(path)) continue;
					const text = readFileSync(path, "utf8");
					if (secretContent(text)) continue;
					const hash = sourceHash(text);
					const base = { ...baseFor(path, `code:${file.id}`, "code", hash), updatedAt: statSync(path).mtime.toISOString() };
					add(textPieces(base, `${file.path}\n${file.summary ?? ""}`, limits));
					const lines = text.split("\n");
					for (const symbol of (map?.symbols ?? []).filter((s) => s.fileId === file.id)) {
						const excerpt =
							`${symbol.name}\n${symbol.sig ?? ""}\n${lines.slice(Math.max(0, symbol.line - 4), symbol.line + 20).join("\n")}`.slice(
								0,
								limits.maxTextChars,
							);
						add([
							piece(
								{ ...base, sourceId: `${base.sourceId}:${symbol.name}:${symbol.line}` },
								"symbol",
								excerpt,
								{ kind: "text", text: excerpt },
								{ line: symbol.line },
							),
						]);
					}
					result.sources.push({ path, state: "ready" });
				} catch (error) {
					result.sources.push({ path, state: "failed", reason: error instanceof Error ? error.message : String(error) });
				}
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			result.sources.push({
				path: mapPath,
				state: "failed",
				reason: error instanceof Error ? error.message : String(error),
			});
	}
	// Discover only the established wiki source tree, retaining the same symlink and protection gates.
	const wiki = wikiDir(root);
	try {
		if (allowed(root, wiki, options)) {
			const scan = await discover(wiki, options, limits);
			result.truncated ||= scan.truncated;
			for (const path of scan.paths.filter((p) => p.endsWith(".md"))) {
				if (!allowed(root, path, options) || !admitRead(path)) continue;
				const text = readFileSync(path, "utf8");
				add(
					textPieces(
						{
							...baseFor(path, `wiki:${relative(wiki, path)}`, "wiki", sourceHash(text)),
							updatedAt: statSync(path).mtime.toISOString(),
						},
						text,
						limits,
					),
				);
				result.sources.push({ path, state: "ready" });
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			result.sources.push({ path: wiki, state: "failed", reason: error instanceof Error ? error.message : String(error) });
	}
	if (options.memoryEligibility)
		for (const memory of eligibleSemanticMemory(options.memoryRecords ?? [], options.memoryEligibility)) {
			const text = [memory.key, memory.lesson, ...memory.appliesWhen, ...memory.avoidWhen].join("\n");
			const base = {
				...baseFor(`memory:${memory.id}`, `memory:${memory.id}`, "memory", sourceHash(JSON.stringify(memory))),
				memoryId: memory.id,
				...(memory.scope === "global" ? { scope: "global" as const, visibility: "global" as const } : {}),
			};
			add(textPieces(base, text, limits));
		}
	for (const entry of options.evidence ?? []) {
		const { overview, findings } = entry.bundle;
		// Every asserted owner must resolve to this project; a mixed-owner bundle is excluded whole.
		if (
			!overview.cwds.length ||
			overview.cwds.some((cwd) => {
				try {
					return realpathSync(cwd) !== root;
				} catch {
					return true;
				}
			})
		)
			continue;
		const common = {
			updatedAt: overview.generatedAt,
			...(overview.runIds.length === 1 && overview.runIds[0] ? { runId: overview.runIds[0] } : {}),
		};
		const addSurface = (name: string, text: string, location: SemanticLocation = {}) => {
			const base = {
				...baseFor(join(entry.directory, name), `evidence:${overview.evidenceId}:${name}`, "evidence", sourceHash(text)),
				...common,
			};
			add(textPieces(base, text, limits, location));
		};
		addSurface("overview.json", overview.tasks.join("\n"));
		for (const [index, finding] of findings.entries()) {
			const base = {
				...baseFor(
					join(entry.directory, "findings.json"),
					`evidence:${overview.evidenceId}:finding:${finding.id}`,
					"evidence",
					sourceHash(finding.message),
				),
				updatedAt: overview.generatedAt,
				...(finding.runId ? { runId: finding.runId } : {}),
			};
			add(textPieces(base, finding.message, limits, { output: index }));
		}
		if (entry.redactedTranscript) addSurface("transcript.md", entry.redactedTranscript);
	}
	options.signal?.throwIfAborted();
	return result;
}

export interface RecordingSource {
	projectId: string;
	runId: string;
	root: string;
	path: string;
	sha256: string;
	/** Only evidence-exported, redacted recordings are admitted. Never pass raw run state. */
	redacted: true;
}

/** A cast is timed terminal output; no image/video understanding is implied. */
export function extractRecording(source: RecordingSource, options: ExtractionOptions = {}): ExtractionResult {
	const limits = limitsFor(options);
	const lexicalRoot = resolve(source.root);
	const root = realpathSync(lexicalRoot);
	// allowed() compares canonical paths, so a symlinked data directory must not reject every cast.
	const path = join(root, relative(lexicalRoot, resolve(source.path)));
	if (
		source.redacted !== true ||
		!source.projectId ||
		!source.runId ||
		!allowed(root, path, options) ||
		statSync(path).size > Math.min(limits.maxFileBytes, limits.maxTotalBytes)
	)
		throw new Error("Recording source is unredacted, protected or exceeds its byte budget");
	const bytes = readFileSync(path);
	if (sourceHash(bytes) !== source.sha256) throw new Error("Recording checksum mismatch");
	const lines = bytes.toString("utf8").trimEnd().split("\n");
	const header = JSON.parse(lines.shift() ?? "null") as { version?: number } | null;
	if (header?.version !== 2) throw new Error("Only strict asciicast v2 recordings are supported");
	const records: SemanticRecord[] = [];
	let previous = -1;
	let truncated = false;
	const base = {
		// A run's cast is exported into both its run bundle and its session bundle.
		sourceId: `recording:${basename(root)}:${source.runId}`,
		kind: "recording" as const,
		projectId: source.projectId,
		scope: "project" as const,
		visibility: "project" as const,
		path,
		contentHash: source.sha256,
		mediaType: "application/x-asciicast",
		runId: source.runId,
	};
	for (const [index, line] of lines.entries()) {
		options.signal?.throwIfAborted();
		const event = JSON.parse(line) as unknown;
		if (
			!Array.isArray(event) ||
			event.length !== 3 ||
			typeof event[0] !== "number" ||
			!Number.isFinite(event[0]) ||
			event[0] < previous ||
			event[0] < 0 ||
			typeof event[1] !== "string" ||
			typeof event[2] !== "string"
		)
			throw new Error("Malformed asciicast event or timestamps");
		previous = event[0];
		if (event[0] > limits.maxMediaSeconds || records.length >= limits.maxPieces) {
			truncated = true;
			break;
		}
		if (event[1] !== "o") continue;
		const text = Array.from(stripVTControlCharacters(event[2]))
			.filter((char) => {
				const code = char.codePointAt(0) ?? 0;
				return code === 9 || code === 10 || (code >= 32 && code !== 127);
			})
			.join("");
		if (!text.trim() || secretContent(text)) continue;
		for (const record of textPieces({ ...base, sourceId: `${base.sourceId}:event:${index}` }, text, limits, {
			startSeconds: event[0],
			endSeconds: event[0],
			frame: index,
		})) {
			if (records.length >= limits.maxPieces) {
				truncated = true;
				break;
			}
			records.push(record);
		}
	}
	return { records, sources: [{ path, state: "ready" }], truncated };
}
