import { existsSync } from "node:fs";
import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { clioDataDir } from "../../core/xdg.js";
import { loadMemoryRecordsSync } from "../memory/index.js";
import { detectProjectType } from "../session/workspace/project-type.js";
import { adoptionSourcesChanged } from "./adoption.js";
import { runBootstrap } from "./bootstrap.js";
import {
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
	tryReadClioMd,
} from "./clio-md.js";
import { buildCodewiki, codewikiPath, writeCodewiki } from "./codewiki/indexer.js";
import type { ContextContract, ContextState, ProjectPromptContext } from "./contract.js";
import { computeFingerprint, isStale } from "./fingerprint.js";
import { readClioState, writeClioState } from "./state.js";

function renderPromptContext(cwd: string): ProjectPromptContext {
	const projectType = detectProjectType(cwd);
	const pieces = [renderProjectTypeFragment(projectType)];
	const warnings: string[] = [];
	const clio = tryReadClioMd(cwd);
	let clioMd: ParsedClioMd | null = null;
	if (clio?.ok) {
		clioMd = clio.value;
		pieces.push(renderProjectContextFragment(clio.value));
	}
	if (clio && !clio.ok) warnings.push(`clio: malformed CLIO.md ignored: ${clio.error}`);
	if (existsSync(codewikiPath(cwd))) {
		const state = readClioState(cwd);
		const stale = state ? state.fingerprint.treeHash !== computeFingerprint(cwd).treeHash : true;
		const suffix = stale ? " (stale; run /init to refresh)" : "";
		pieces.push(`<codewiki>available${suffix}; use find_symbol, entry_points, where_is</codewiki>`);
	}
	return { text: pieces.join("\n\n"), clioMd, warnings };
}

const CONTEXT_STATE_CACHE_TTL_MS = 1500;

function memoryCount(): number {
	try {
		return loadMemoryRecordsSync(clioDataDir()).length;
	} catch {
		return 0;
	}
}

function resolveClioMdState(cwd: string): ContextState["clioMd"] {
	const clio = tryReadClioMd(cwd);
	if (!clio) return "none";
	if (!clio.ok) return "malformed";
	if (clio.value.firstInit || !clio.value.fingerprint) return "no-fingerprint";
	const state = readClioState(cwd);
	const reference = state?.bootstrapFingerprint ?? state?.fingerprint ?? clio.value.fingerprint;
	const current = computeFingerprint(cwd);
	return isStale(reference, current) ? "stale" : "ok";
}

function createContextStateReader(): (cwd?: string) => ContextState {
	let cached: { cwd: string; at: number; state: ContextState } | null = null;
	return (cwd = process.cwd()): ContextState => {
		const now = Date.now();
		if (cached && cached.cwd === cwd && now - cached.at < CONTEXT_STATE_CACHE_TTL_MS) return cached.state;
		const state: ContextState = { clioMd: resolveClioMdState(cwd), memoryCount: memoryCount() };
		cached = { cwd, at: now, state };
		return state;
	};
}

function collectStartupHints(cwd: string): string[] {
	const hints: string[] = [];
	let projectType: ReturnType<typeof detectProjectType>;
	try {
		projectType = detectProjectType(cwd);
	} catch {
		projectType = "unknown";
	}
	const clio = tryReadClioMd(cwd);
	if (!clio && projectType !== "unknown") {
		hints.push("clio: No CLIO.md detected. Run /init or `clio init` to bootstrap.");
	}
	if (clio && !clio.ok) {
		hints.push(`clio: malformed CLIO.md ignored: ${clio.error}`);
	}
	if (clio?.ok && clio.value.firstInit) {
		hints.push("clio: CLIO.md has no fingerprint footer. Run /init to refresh.");
	}
	const state = readClioState(cwd);
	if (!state) return hints;
	const reference = state.bootstrapFingerprint ?? state.fingerprint;
	const current = computeFingerprint(cwd);
	if (isStale(reference, current)) {
		hints.push("clio: CLIO.md fingerprint differs from current project state. Run /init to refresh.");
	}
	if (state.contextSources && state.contextSources.length > 0 && adoptionSourcesChanged(state.contextSources)) {
		hints.push("clio: Imported agent context changed. Run /init --adopt to refresh.");
	}
	return hints;
}

export function createContextBundle(_context: DomainContext): DomainBundle<ContextContract> {
	let lastCwd = process.cwd();
	let startupHints: string[] = [];
	const contextState = createContextStateReader();
	const onStart = (): void => {
		lastCwd = process.cwd();
		startupHints = collectStartupHints(lastCwd);
		if (process.env.CLIO_INTERACTIVE === "1") return;
		for (const hint of startupHints) process.stderr.write(`${hint}\n`);
	};

	const extension: DomainExtension = {
		start() {
			_context.bus.on(BusChannels.SessionStart, onStart);
		},
		stop() {
			const projectType = detectProjectType(lastCwd);
			const state = readClioState(lastCwd);
			const fingerprint = computeFingerprint(lastCwd);
			let lastIndexedAt = state?.lastIndexedAt;
			if (!state || state.fingerprint.treeHash !== fingerprint.treeHash || !existsSync(codewikiPath(lastCwd))) {
				lastIndexedAt = new Date().toISOString();
				writeCodewiki(lastCwd, buildCodewiki({ cwd: lastCwd, language: projectType, generatedAt: lastIndexedAt }));
			}
			writeClioState(lastCwd, {
				version: 1,
				projectType,
				fingerprint,
				...(state?.bootstrapFingerprint ? { bootstrapFingerprint: state.bootstrapFingerprint } : {}),
				...(state?.contextSources ? { contextSources: state.contextSources } : {}),
				...(state?.contextSourceHash ? { contextSourceHash: state.contextSourceHash } : {}),
				...(state?.lastInitAt ? { lastInitAt: state.lastInitAt } : {}),
				lastSessionAt: new Date().toISOString(),
				...(lastIndexedAt ? { lastIndexedAt } : {}),
			});
		},
	};

	const contract: ContextContract = {
		runBootstrap,
		renderPromptContext,
		contextState,
		startupHints: () => [...startupHints],
	};

	return { extension, contract };
}
