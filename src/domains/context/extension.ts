import { existsSync } from "node:fs";
import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { detectProjectType } from "../session/workspace/project-type.js";
import { runBootstrap } from "./bootstrap.js";
import {
	type ParsedClioMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
	tryReadClioMd,
} from "./clio-md.js";
import { buildCodewiki, codewikiPath, writeCodewiki } from "./codewiki/indexer.js";
import type { ContextContract, ProjectPromptContext } from "./contract.js";
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
	return hints;
}

export function createContextBundle(_context: DomainContext): DomainBundle<ContextContract> {
	let lastCwd = process.cwd();
	let startupHints: string[] = [];
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
				...(state?.lastInitAt ? { lastInitAt: state.lastInitAt } : {}),
				lastSessionAt: new Date().toISOString(),
				...(lastIndexedAt ? { lastIndexedAt } : {}),
			});
		},
	};

	const contract: ContextContract = {
		runBootstrap,
		renderPromptContext,
		startupHints: () => [...startupHints],
	};

	return { extension, contract };
}
