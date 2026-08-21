import { join, resolve } from "node:path";
import type { BootstrapProgressEvent } from "../domains/context/index.js";
import type { BootstrapGenerationState } from "../domains/context/state.js";

const HELP = `Usage:
  clio-coder context
  clio-coder context init [--yes] [--preview|--heuristic] [--adopt] [--propose|--apply|--rewrite]
  clio-coder context refresh [--wiki]
  clio-coder context wiki [--update] [--status] [--depth auto|simple|medium|detailed]
                    [--target <id>] [--model <id>] [--thinking off|low|medium|high]
  clio-coder context reset [--all] [--yes]
  clio-coder context index [--json]
  clio-coder context replay --sessions <path>... [options]
  clio-coder context working-set --session <id|path>

Project context commands:
  clio-coder context              show project context status (CLIO-CODER.md, preload, codewiki)
  clio-coder context init         explore the repo and bootstrap CLIO-CODER.md and codewiki
  clio-coder context refresh      re-index the codewiki and optionally update the Markdown wiki
  clio-coder context wiki         generate or inspect the agent-authored Markdown wiki
  clio-coder context reset        clear accumulated project context artifacts
  clio-coder context index        build the codewiki index without model calls
  clio-coder context replay       compare working-set policies over Clio ledgers
  clio-coder context working-set  inspect one session's working-set fold and path index
`;

function printWikiProgress(event: BootstrapProgressEvent): void {
	if (event.status === "completed") return;
	const detail = event.detail ? ` (${event.detail})` : "";
	process.stderr.write(`clio-coder context wiki: ${event.message}${detail}\n`);
}

function compactMetric(value: number, suffix: string): string {
	if (value < 1000) return `${value}${suffix}`;
	return `${(value / 1000).toFixed(1)}k${suffix}`;
}

function formatGenerationStatus(generation: BootstrapGenerationState | undefined): string | null {
	if (!generation) return null;
	const details: string[] = [`parser ${generation.parserOutcome}`];
	if (generation.structuredOutputMode) details.push(generation.structuredOutputMode);
	const route = [generation.targetId, generation.wireModelId, generation.runtimeId].filter(
		(value): value is string => typeof value === "string",
	);
	if (route.length > 0) details.push(route.join("/"));
	if (generation.thinkingLevel) details.push(`thinking ${generation.thinkingLevel}`);
	const usage: string[] = [];
	if (generation.tokenCount !== undefined) usage.push(`${generation.tokenCount} tokens`);
	if (generation.toolCalls !== undefined) usage.push(`${generation.toolCalls} tools`);
	if (generation.durationMs !== undefined) usage.push(`${(generation.durationMs / 1000).toFixed(2)}s`);
	if (generation.promptBytes !== undefined && generation.outputBytes !== undefined) {
		usage.push(`${compactMetric(generation.promptBytes, "B")} in/${compactMetric(generation.outputBytes, "B")} out`);
	}
	if (usage.length > 0) details.push(usage.join(", "));
	if (generation.fallbackReason) {
		const reason =
			generation.fallbackReason.length > 160 ? `${generation.fallbackReason.slice(0, 157)}...` : generation.fallbackReason;
		details.push(`fallback: ${reason}`);
	}
	return `generation: ${generation.mode} (${details.join("; ")})`;
}

async function printContextStatus(): Promise<number> {
	const context = await import("../domains/context/index.js");
	const preload = await import("../domains/prompts/preload.js");
	const cwd = process.cwd();

	const clio = context.loadProjectClioMd(cwd);
	const state = context.readClioState(cwd);
	const localStandardIsEffective = clio.files.some((file) => file.path === join(resolve(cwd), "CLIO-CODER.md"));
	const clioMdState =
		clio.files.length === 0 && clio.errors.length === 0
			? "none"
			: clio.errors.length > 0
				? "malformed"
				: localStandardIsEffective &&
						state?.contextSources !== undefined &&
						context.adoptionSourcesChanged(state.contextSources, { cwd })
					? "stale"
					: "ok";

	const prompt = context.renderPromptContext(cwd);
	const preloadClass = preload.classifyProjectPreload({
		hasClioMd: prompt.clioMd !== null,
		text: prompt.text,
	});

	const codewiki = context.readCodewiki(cwd);
	const codewikiCount = codewiki ? context.codewikiEntries(codewiki).length : 0;
	const codewikiState = !codewiki
		? "absent"
		: state && !context.isStale(state.fingerprint, context.computeFingerprint(cwd, codewiki))
			? "fresh"
			: "stale (run clio-coder context refresh)";
	const codewikiLines = [`codewiki: ${codewikiState} (${codewikiCount} entr${codewikiCount === 1 ? "y" : "ies"})`];
	if (codewiki) codewikiLines.push(context.renderCodewikiDigest(codewiki));

	const adoptionSources = state?.contextSources ?? [];
	const adoptionChanged =
		state?.contextSources !== undefined ? context.adoptionSourcesChanged(adoptionSources, { cwd }) : false;
	const adoptionState = adoptionChanged ? "changed (run clio-coder context init --adopt)" : "up to date";
	const generationLine = formatGenerationStatus(state?.lastBootstrap);

	process.stdout.write(
		[
			`CLIO-CODER.md: ${clioMdState}`,
			`preload: ${preloadClass.label}`,
			...codewikiLines,
			`adoption: ${adoptionSources.length} source${adoptionSources.length === 1 ? "" : "s"}, ${adoptionState}`,
			...(generationLine ? [generationLine] : []),
			"",
		].join("\n"),
	);
	return 0;
}

async function runRefreshCommand(args: string[]): Promise<number> {
	let updateWiki = false;
	for (const arg of args) {
		// The other four context verbs answer --help on stdout with status 0;
		// refresh alone called it an unknown flag.
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(HELP);
			return 0;
		}
		if (arg === "--wiki") {
			updateWiki = true;
			continue;
		}
		process.stderr.write(`clio-coder context refresh: unknown flag ${arg}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	try {
		const { runContextRefresh } = await import("../domains/context/index.js");
		const wikiEntry = updateWiki ? await import("./wiki-generate.js") : null;
		const result = await runContextRefresh({
			cwd: process.cwd(),
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
			wiki: updateWiki,
			...(wikiEntry
				? { wikiGenerate: wikiEntry.modelWikiGenerate(), wikiModel: await wikiEntry.resolveDocumenterModelId() }
				: {}),
		});
		if (result.hint) process.stdout.write(`${result.hint}\n`);
		if (result.wiki) {
			if (result.wiki.status === "failed") {
				process.stderr.write(
					`clio-coder context refresh: wiki update failed: ${(result.wiki.problems ?? ["unknown failure"]).join("; ")}\n`,
				);
				return 1;
			}
			process.stdout.write(
				result.wiki.status === "noop"
					? `clio-coder context refresh: wiki unchanged (${result.wiki.pages} page${result.wiki.pages === 1 ? "" : "s"})\n`
					: `clio-coder context refresh: wiki updated (${result.wiki.pages} page${result.wiki.pages === 1 ? "" : "s"})\n`,
			);
		}
		return 0;
	} catch (err) {
		process.stderr.write(`clio-coder context refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

async function runWikiStatusCommand(): Promise<number> {
	const context = await import("../domains/context/index.js");
	const cwd = process.cwd();
	const meta = context.readWikiMeta(cwd);
	if (!meta) {
		const pageCount = context.listWikiPages(cwd).length;
		process.stdout.write(`wiki: absent (${pageCount} page${pageCount === 1 ? "" : "s"})\n`);
		return 0;
	}
	const currentHead = context.currentWikiGitHead(cwd);
	const lines = [
		`wiki: present (${meta.pages.length} page${meta.pages.length === 1 ? "" : "s"})`,
		`updatedAt: ${meta.updatedAt}`,
		`gitHead: ${meta.gitHead ?? "none"}`,
	];
	if (meta.generation) {
		const { depth, requestedDepth, sourceFiles, pagesPlanned, pagesWritten } = meta.generation;
		lines.push(
			`depth: ${depth} (requested ${requestedDepth}; ${sourceFiles} source files; ` +
				`${pagesWritten}/${pagesPlanned} planned pages written)`,
		);
		if (pagesWritten < pagesPlanned) {
			lines.push(`pending: ${pagesPlanned - pagesWritten} page(s); run \`clio-coder context wiki --update\` to finish`);
		}
	}
	if (currentHead !== meta.gitHead) {
		lines.push(`staleness: gitHead differs from current HEAD (${currentHead ?? "none"})`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

type WikiCliDepth = "auto" | "simple" | "medium" | "detailed";
type WikiCliThinking = "off" | "low" | "medium" | "high";

const VALUE_FLAGS = new Set(["--target", "--model", "--thinking", "--depth"]);

function isWikiDepth(value: unknown): value is WikiCliDepth {
	return value === "auto" || value === "simple" || value === "medium" || value === "detailed";
}

function isThinkingLevel(value: unknown): value is WikiCliThinking {
	return value === "off" || value === "low" || value === "medium" || value === "high";
}

async function runWikiCommand(args: string[]): Promise<number> {
	let forceUpdate = false;
	let status = false;
	let depth: WikiCliDepth = "auto";
	let target: string | undefined;
	let model: string | undefined;
	let thinkingLevel: WikiCliThinking | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(HELP);
			return 0;
		}
		if (arg === "--update") {
			forceUpdate = true;
			continue;
		}
		if (arg === "--status") {
			status = true;
			continue;
		}
		if (VALUE_FLAGS.has(arg ?? "")) {
			const value = args[index + 1];
			index += 1;
			if (arg === "--target" || arg === "--model") {
				if (!value || value.startsWith("--")) {
					process.stderr.write(`clio-coder context wiki: ${arg} requires a value\n`);
					return 2;
				}
				if (arg === "--target") target = value;
				else model = value;
				continue;
			}
			if (arg === "--thinking") {
				if (!isThinkingLevel(value)) {
					process.stderr.write("clio-coder context wiki: --thinking must be off, low, medium, or high\n");
					return 2;
				}
				thinkingLevel = value;
				continue;
			}
			if (!isWikiDepth(value)) {
				process.stderr.write("clio-coder context wiki: --depth must be auto, simple, medium, or detailed\n");
				return 2;
			}
			depth = value;
			continue;
		}
		process.stderr.write(`clio-coder context wiki: unknown flag ${arg}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	if (status) return runWikiStatusCommand();
	try {
		const context = await import("../domains/context/index.js");
		const { modelWikiGenerate, resolveDocumenterModelId } = await import("./wiki-generate.js");
		const route = {
			...(target !== undefined ? { target } : {}),
			...(model !== undefined ? { model } : {}),
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		};
		const result = await context.runWikiGenerate({
			cwd: process.cwd(),
			...(forceUpdate ? { mode: "update" as const } : {}),
			depth,
			model: await resolveDocumenterModelId(route),
			generate: modelWikiGenerate({ route }),
			onProgress: printWikiProgress,
		});
		if (result.status === "failed") {
			process.stderr.write(`clio-coder context wiki failed: ${(result.problems ?? ["unknown failure"]).join("; ")}\n`);
			return 1;
		}
		process.stdout.write(
			result.status === "noop"
				? `clio-coder context wiki: unchanged (${result.pages} page${result.pages === 1 ? "" : "s"})\n`
				: `clio-coder context wiki: generated ${result.pages} page${result.pages === 1 ? "" : "s"}\n`,
		);
		return 0;
	} catch (err) {
		process.stderr.write(`clio-coder context wiki failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

export async function runContextCommand(args: string[]): Promise<number> {
	const [verb, ...rest] = args;
	if (verb === undefined) {
		return printContextStatus();
	}
	if (verb === "--help" || verb === "-h") {
		process.stdout.write(HELP);
		return 0;
	}

	switch (verb) {
		case "init":
			return (await import("./init.js")).runInitCommand(rest);
		case "refresh":
			return runRefreshCommand(rest);
		case "wiki":
			return runWikiCommand(rest);
		case "reset":
			return (await import("./context-clear.js")).runContextClearCommand(rest);
		case "index":
			return (await import("./context-index.js")).runContextIndexCommand(rest);
		case "replay":
			return (await import("./context-working-set.js")).runContextReplayCommand(rest);
		case "working-set":
			return (await import("./context-working-set.js")).runContextWorkingSetCommand(rest);
		default:
			process.stderr.write(`clio-coder context: unknown subcommand ${verb}\n`);
			process.stdout.write(HELP);
			return 2;
	}
}
