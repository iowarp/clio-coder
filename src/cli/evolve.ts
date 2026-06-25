import { resolve } from "node:path";
import { clioDataDir } from "../core/xdg.js";
import { listEvidenceOverviews } from "../domains/evidence/index.js";
import type { ChangeManifestSummary, ManifestValidationIssue } from "../domains/evolution/index.js";
import {
	createChangeManifestTemplate,
	loadChangeManifestJson,
	summarizeChangeManifest,
	validateChangeManifest,
} from "../domains/evolution/index.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio evolve manifest init
clio evolve manifest validate <path>
clio evolve manifest summarize <path>

Create, validate, or summarize a Clio Coder change manifest. validate and
summarize resolve each non-empty evidenceRef (run-<id> / session-<id>) against
the local evidence store, so a manifest that points at a missing bundle fails.
`;

interface EvidenceRefResolver {
	resolveEvidenceRef: (ref: string) => boolean;
	knownCount: number;
	resolvable: boolean;
}

/**
 * Snapshot the local evidence-store bundle ids once and expose them as a pure
 * predicate the evolution validator can call without importing the evidence
 * domain. On any read failure the predicate rejects every ref and `resolvable`
 * is false, so the caller can warn that refs could not be checked rather than
 * silently passing.
 */
async function loadEvidenceRefResolver(): Promise<EvidenceRefResolver> {
	let knownIds: Set<string>;
	try {
		const overviews = await listEvidenceOverviews(clioDataDir());
		knownIds = new Set(overviews.map((overview) => overview.evidenceId));
	} catch {
		return { resolveEvidenceRef: () => false, knownCount: 0, resolvable: false };
	}
	return {
		resolveEvidenceRef: (ref: string) => knownIds.has(ref),
		knownCount: knownIds.size,
		resolvable: true,
	};
}

function countEvidenceRefs(changes: ReadonlyArray<{ evidenceRefs: ReadonlyArray<string> }>): number {
	let total = 0;
	for (const change of changes) total += change.evidenceRefs.length;
	return total;
}

type ManifestCommand = "init" | "validate" | "summarize";

interface ParsedEvolveArgs {
	manifest: boolean;
	command?: ManifestCommand;
	path?: string;
	help: boolean;
}

function parseEvolveArgs(args: ReadonlyArray<string>): ParsedEvolveArgs {
	const parsed: ParsedEvolveArgs = { manifest: false, help: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (!parsed.manifest) {
			if (arg !== "manifest") throw new Error(`unknown evolve argument: ${arg}`);
			parsed.manifest = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (arg === "init" || arg === "validate" || arg === "summarize") {
				parsed.command = arg;
				continue;
			}
			throw new Error(`unknown evolve manifest command: ${arg}`);
		}
		if (parsed.path === undefined && (parsed.command === "validate" || parsed.command === "summarize")) {
			if (arg.startsWith("-")) throw new Error(`${parsed.command} requires a path`);
			parsed.path = arg;
			continue;
		}
		throw new Error(`unexpected evolve argument: ${arg}`);
	}
	if (parsed.help) return parsed;
	if (!parsed.manifest) throw new Error("evolve requires manifest");
	if (parsed.command === undefined) throw new Error("manifest requires init, validate, or summarize");
	if (parsed.command === "init" && parsed.path !== undefined) throw new Error("init does not accept a path");
	if ((parsed.command === "validate" || parsed.command === "summarize") && parsed.path === undefined) {
		throw new Error(`${parsed.command} requires a path`);
	}
	return parsed;
}

export async function runEvolveCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedEvolveArgs;
	try {
		parsed = parseEvolveArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.command === "init") {
		process.stdout.write(`${JSON.stringify(createChangeManifestTemplate(), null, 2)}\n`);
		return 0;
	}
	if (parsed.command === "validate") return runValidate(parsed);
	if (parsed.command === "summarize") return runSummarize(parsed);
	printError("manifest requires init, validate, or summarize");
	return 2;
}

async function runValidate(parsed: ParsedEvolveArgs): Promise<number> {
	const manifestPath = parsed.path;
	if (manifestPath === undefined) {
		printError("validate requires a path");
		return 2;
	}
	let value: unknown;
	const resolvedPath = resolve(manifestPath);
	try {
		value = await loadChangeManifestJson(resolvedPath);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const resolver = await loadEvidenceRefResolver();
	const result = validateChangeManifest(value, { resolveEvidenceRef: resolver.resolveEvidenceRef });
	if (!result.valid) {
		renderInvalid(result.issues);
		return 1;
	}
	const refCount = countEvidenceRefs(result.manifest.changes);
	printOk(`manifest valid (${formatCount(result.manifest.changes.length, "change")})`);
	reportRefResolution(refCount, resolver);
	return 0;
}

async function runSummarize(parsed: ParsedEvolveArgs): Promise<number> {
	const manifestPath = parsed.path;
	if (manifestPath === undefined) {
		printError("summarize requires a path");
		return 2;
	}
	let value: unknown;
	const resolvedPath = resolve(manifestPath);
	try {
		value = await loadChangeManifestJson(resolvedPath);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	const resolver = await loadEvidenceRefResolver();
	const result = validateChangeManifest(value, { resolveEvidenceRef: resolver.resolveEvidenceRef });
	if (!result.valid) {
		printError("manifest invalid; cannot summarize");
		renderIssues(result.issues);
		return 1;
	}
	const refCount = countEvidenceRefs(result.manifest.changes);
	renderSummary(summarizeChangeManifest(result.manifest));
	reportRefResolution(refCount, resolver);
	return 0;
}

function reportRefResolution(refCount: number, resolver: EvidenceRefResolver): void {
	if (!resolver.resolvable) {
		process.stdout.write("evidence refs: could not read the local evidence store; refs were not resolved\n");
		return;
	}
	if (refCount === 0) {
		process.stdout.write("evidence refs: none to resolve\n");
		return;
	}
	process.stdout.write(
		`evidence refs: ${formatCount(refCount, "ref")} resolved against ${formatCount(resolver.knownCount, "local bundle")}\n`,
	);
}

function renderInvalid(issues: ReadonlyArray<ManifestValidationIssue>): void {
	printError(`manifest invalid (${formatCount(issues.length, "issue", "issues")})`);
	renderIssues(issues);
}

function renderIssues(issues: ReadonlyArray<ManifestValidationIssue>): void {
	for (const issue of issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
}

function renderSummary(summary: ChangeManifestSummary): void {
	process.stdout.write(`iteration: ${summary.iterationId}\n`);
	process.stdout.write(`base sha: ${summary.baseGitSha}\n`);
	process.stdout.write(`changes: ${summary.changeCount}\n`);
	process.stdout.write(`authority levels: ${formatList(summary.authorityLevels)}\n`);
	process.stdout.write(`components: ${formatList(summary.componentIds)}\n`);
	process.stdout.write(`files changed: ${formatList(summary.filesChanged)}\n`);
	process.stdout.write(`predicted regressions: ${formatList(summary.predictedRegressions)}\n`);
	process.stdout.write(`validation steps: ${summary.validationPlanCount}\n`);
}

function formatList(values: ReadonlyArray<string>): string {
	return values.length === 0 ? "none" : values.join(", ");
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}
