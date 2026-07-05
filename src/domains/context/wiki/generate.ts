import type { ContextActivityPayload } from "../../../core/bus-events.js";
import { detectProjectType } from "../../session/workspace/project-type.js";
import type { BootstrapProgressSink } from "../bootstrap.js";
import {
	buildCodewiki,
	type Codewiki,
	codewikiNeedsBackfill,
	readCodewiki,
	writeCodewiki,
} from "../codewiki/indexer.js";
import { computeFingerprint, isStale } from "../fingerprint.js";
import { readClioState, writeClioState } from "../state.js";
import { listWikiPages, validateWikiLayout } from "./layout.js";
import { computeWikiContentHash, currentWikiGitHead, readWikiMeta, wikiMetaPath, writeWikiMeta } from "./meta.js";
import { buildWikiPrompt, type WikiGenerateMode } from "./prompts.js";

export type { WikiGenerateMode };

export interface WikiGenerateInput {
	cwd: string;
	mode: WikiGenerateMode;
	prompt: string;
}

export type WikiGenerate = (input: WikiGenerateInput) => void | Promise<void>;

export interface RunWikiGenerateInput {
	cwd?: string;
	mode?: WikiGenerateMode;
	model: string;
	generate?: WikiGenerate;
	onProgress?: BootstrapProgressSink;
}

export interface RunWikiGenerateResult {
	status: "generated" | "noop" | "failed";
	pages: number;
	problems?: string[];
}

type ProgressEvent = Omit<ContextActivityPayload, "kind" | "at">;

function progress(input: RunWikiGenerateInput, event: ProgressEvent): void {
	input.onProgress?.(event);
}

function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

async function loadOrBuildCodewiki(cwd: string): Promise<Codewiki> {
	const existing = readCodewiki(cwd);
	const prev = readClioState(cwd);
	// Mirror the code_nav demand-load freshness check: a stale index must never
	// ground the wiki writer prompt, so drift forces a rebuild here too.
	if (existing && !codewikiNeedsBackfill(existing)) {
		const fingerprint = computeFingerprint(cwd, existing);
		if (prev && !isStale(prev.fingerprint, fingerprint)) return existing;
	}
	const generatedAt = new Date().toISOString();
	const projectType = detectProjectType(cwd);
	const rebuilt = await buildCodewiki({ cwd, language: projectType, generatedAt });
	writeCodewiki(cwd, rebuilt);
	writeClioState(cwd, {
		version: 1,
		projectType: prev?.projectType ?? projectType,
		fingerprint: computeFingerprint(cwd, rebuilt),
		codewikiVersion: rebuilt.version,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? generatedAt,
		lastIndexedAt: generatedAt,
	});
	return rebuilt;
}

function failed(problems: string[], pages: number): RunWikiGenerateResult {
	return { status: "failed", pages, problems };
}

export async function runWikiGenerate(
	input: RunWikiGenerateInput = { model: "configured-clio-target" },
): Promise<RunWikiGenerateResult> {
	const cwd = input.cwd ?? process.cwd();
	const existingMeta = readWikiMeta(cwd);
	const mode = input.mode ?? (existingMeta ? "update" : "init");

	progress(input, { phase: "codewiki", status: "started", message: "loading codewiki for wiki generation" });
	const codewiki = await loadOrBuildCodewiki(cwd);
	progress(input, {
		phase: "codewiki",
		status: "completed",
		message: `loaded ${indexedSourceFileCount(codewiki)} source file${indexedSourceFileCount(codewiki) === 1 ? "" : "s"}`,
		current: indexedSourceFileCount(codewiki),
		total: indexedSourceFileCount(codewiki),
	});

	const beforeHash = computeWikiContentHash(cwd);
	const prompt = buildWikiPrompt({
		cwd,
		mode,
		codewiki,
		gitHead: existingMeta?.gitHead ?? null,
	});

	if (!input.generate) {
		const problems = ["wiki generation requires a model runtime"];
		progress(input, {
			phase: "generate",
			status: "failed",
			message: "wiki generation requires a model runtime",
		});
		progress(input, { phase: "done", status: "failed", message: "wiki generation failed" });
		return failed(problems, listWikiPages(cwd).length);
	}

	progress(input, {
		phase: "generate",
		status: "started",
		message: mode === "init" ? "drafting project wiki" : "updating project wiki",
	});
	try {
		await input.generate({ cwd, mode, prompt });
	} catch (err) {
		const problem = err instanceof Error ? err.message : String(err);
		progress(input, {
			phase: "generate",
			status: "failed",
			message: "wiki generator failed",
			detail: problem,
		});
		progress(input, { phase: "done", status: "failed", message: "wiki generation failed", detail: problem });
		return failed([problem], listWikiPages(cwd).length);
	}
	progress(input, { phase: "generate", status: "completed", message: "wiki generator completed" });

	const validation = validateWikiLayout(cwd);
	const pages = listWikiPages(cwd);
	if (!validation.ok) {
		progress(input, {
			phase: "done",
			status: "failed",
			message: "wiki layout validation failed",
			detail: validation.problems.join("; "),
		});
		return failed(validation.problems, pages.length);
	}

	const afterHash = computeWikiContentHash(cwd);
	// The before/after content hashes decide a no-op so scheduled updates never
	// churn metadata. Missing metadata is the one exception: an unchanged wiki
	// with no meta.json must still get one written so the artifact is complete.
	if (beforeHash === afterHash && existingMeta) {
		progress(input, {
			phase: "state",
			status: "completed",
			message: "wiki unchanged; metadata preserved",
			detail: wikiMetaPath(cwd),
		});
		progress(input, { phase: "done", status: "completed", message: "wiki unchanged" });
		return { status: "noop", pages: pages.length };
	}

	progress(input, { phase: "state", status: "running", message: "writing wiki metadata" });
	writeWikiMeta(cwd, {
		version: 1,
		updatedAt: new Date().toISOString(),
		gitHead: currentWikiGitHead(cwd),
		model: input.model,
		contentHash: afterHash,
		pages,
	});
	progress(input, { phase: "state", status: "completed", message: "wiki metadata written" });
	progress(input, { phase: "done", status: "completed", message: "wiki generated" });
	return { status: "generated", pages: pages.length };
}
