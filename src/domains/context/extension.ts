import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { detectProjectType } from "../session/workspace/project-type.js";
import { runBootstrap } from "./bootstrap.js";
import { renderProjectContextFragment, renderProjectTypeFragment, tryReadClioMd } from "./clio-md.js";
import type { ContextContract, ProjectPromptContext } from "./contract.js";
import { computeFingerprint, isStale } from "./fingerprint.js";
import { readClioState, writeClioState } from "./state.js";

function renderPromptContext(cwd: string): ProjectPromptContext {
	const projectType = detectProjectType(cwd);
	const pieces = [renderProjectTypeFragment(projectType)];
	const warnings: string[] = [];
	const clio = tryReadClioMd(cwd);
	if (clio?.ok) {
		pieces.push(renderProjectContextFragment(clio.value));
		return { text: pieces.join("\n\n"), clioMd: clio.value, warnings };
	}
	if (clio && !clio.ok) warnings.push(`clio: malformed CLIO.md ignored: ${clio.error}`);
	return { text: pieces.join("\n\n"), clioMd: null, warnings };
}

function emitStartupHints(cwd: string): void {
	let projectType: ReturnType<typeof detectProjectType>;
	try {
		projectType = detectProjectType(cwd);
	} catch {
		projectType = "unknown";
	}
	const clio = tryReadClioMd(cwd);
	if (!clio && projectType !== "unknown") {
		process.stderr.write("clio: No CLIO.md detected. Run /init or `clio init` to bootstrap.\n");
	}
	if (clio && !clio.ok) {
		process.stderr.write(`clio: malformed CLIO.md ignored: ${clio.error}\n`);
	}
	if (clio?.ok && clio.value.firstInit) {
		process.stderr.write("clio: CLIO.md has no fingerprint footer. Run /init to refresh.\n");
	}
	const state = readClioState(cwd);
	if (!state) return;
	const current = computeFingerprint(cwd);
	if (isStale(state.fingerprint, current)) {
		process.stderr.write("clio: CLIO.md fingerprint differs from current project state. Run /init to refresh.\n");
	}
}

export function createContextBundle(_context: DomainContext): DomainBundle<ContextContract> {
	let lastCwd = process.cwd();
	const onStart = (): void => {
		lastCwd = process.cwd();
		emitStartupHints(lastCwd);
	};

	const extension: DomainExtension = {
		start() {
			_context.bus.on(BusChannels.SessionStart, onStart);
		},
		stop() {
			const projectType = detectProjectType(lastCwd);
			const state = readClioState(lastCwd);
			writeClioState(lastCwd, {
				version: 1,
				projectType,
				fingerprint: computeFingerprint(lastCwd),
				...(state?.lastInitAt ? { lastInitAt: state.lastInitAt } : {}),
				lastSessionAt: new Date().toISOString(),
				...(state?.lastIndexedAt ? { lastIndexedAt: state.lastIndexedAt } : {}),
			});
		},
	};

	const contract: ContextContract = {
		runBootstrap,
		renderPromptContext,
	};

	return { extension, contract };
}
