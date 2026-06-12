import chalk from "chalk";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/contract.js";
import {
	modelCandidatesForStatus,
	ProvidersDomainModule,
	resolveModelCapabilities,
} from "../domains/providers/index.js";
import { printError } from "./shared.js";

export interface ModelRow {
	targetId: string;
	runtimeId: string;
	modelId: string;
	caps: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	state: string;
}

const HELP = `clio models [search] [--target <id>] [--json] [--offline] [--probe]

List live-discovered models for configured targets.

Options:
  --offline   use cached/configured/catalog model hints without probing targets
  --probe     accepted for compatibility; live probing is the default
`;

interface ModelArgs {
	json: boolean;
	probe: boolean;
	offline: boolean;
	target?: string;
	search?: string;
	help: boolean;
}

function parseModelArgs(args: ReadonlyArray<string>): ModelArgs {
	const parsed: ModelArgs = { json: false, probe: false, offline: false, help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--probe") {
			parsed.probe = true;
			continue;
		}
		if (arg === "--offline" || arg === "--no-probe") {
			parsed.offline = true;
			continue;
		}
		if (arg === "--target") {
			const value = args[i + 1];
			if (!value) throw new Error("--target requires a value");
			parsed.target = value;
			i += 1;
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		if (parsed.search) throw new Error("models accepts at most one search term");
		parsed.search = arg;
	}
	return parsed;
}

export async function runModelsCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ModelArgs;
	try {
		parsed = parseModelArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}

	ensureClioState();
	const loaded = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
	const providers = loaded.getContract<ProvidersContract>("providers");
	if (!providers) {
		process.stderr.write("models: provider domain not loaded\n");
		await loaded.stop();
		return 1;
	}
	if (!parsed.offline || parsed.probe) {
		try {
			await providers.probeAllLive();
		} catch (err) {
			process.stderr.write(`models: live probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	const entries = providers.list();
	const filtered = parsed.target ? entries.filter((e) => e.target.id === parsed.target) : entries;
	const rows = collectRows(filtered, providers).filter((row) => matchesSearch(row, parsed.search));

	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
	} else if (rows.length === 0) {
		process.stdout.write(`${emptyModelsMessage(parsed, entries.length, filtered.length)}\n`);
	} else {
		renderRows(rows);
	}
	await loaded.stop();
	return 0;
}

function collectRows(entries: ReadonlyArray<TargetStatus>, providers: ProvidersContract): ModelRow[] {
	const rows: ModelRow[] = [];
	for (const status of entries) {
		const runtimeId = status.runtime?.id ?? status.target.runtime;
		const candidates = modelCandidatesForStatus(status);
		if (candidates.length === 0) {
			const caps = resolveRowCapabilities(status, status.target.defaultModel ?? null, providers);
			rows.push({
				targetId: status.target.id,
				runtimeId,
				modelId: "(no models)",
				state: "-",
				...formatCapabilities(caps),
			});
			continue;
		}
		for (const candidate of candidates) {
			const modelId = candidate.id;
			const caps = resolveRowCapabilities(status, modelId, providers);
			rows.push({
				targetId: status.target.id,
				runtimeId,
				modelId,
				state: candidate.loadState ?? "-",
				...formatCapabilities(caps),
			});
		}
	}
	return rows;
}

function resolveRowCapabilities(status: TargetStatus, modelId: string | null, providers: ProvidersContract) {
	return resolveModelCapabilities(status, modelId, providers.knowledgeBase, {
		detectedReasoning: modelId ? providers.getDetectedReasoning(status.target.id, modelId) : null,
	});
}

function formatCapabilities(
	c: ReturnType<typeof resolveRowCapabilities>,
): Pick<ModelRow, "caps" | "contextWindow" | "maxTokens" | "reasoning"> {
	return {
		caps: capabilityBadges(c),
		contextWindow: c.contextWindow,
		maxTokens: c.maxTokens,
		reasoning: c.reasoning,
	};
}

function capabilityBadges(c: ReturnType<typeof resolveRowCapabilities>): string {
	const badge = (on: boolean, letter: string): string => (on ? letter : "-");
	return [
		badge(c.chat, "C"),
		badge(c.tools, "T"),
		badge(c.reasoning, "R"),
		badge(c.vision, "V"),
		badge(c.embeddings, "E"),
		badge(c.rerank, "K"),
		badge(c.fim, "F"),
	].join("");
}

function compactTokenCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "-";
	if (value >= 1_000_000) {
		const rounded = value / 1_000_000;
		return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}m`;
	}
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(value);
}

export function emptyModelsMessage(
	args: Pick<ModelArgs, "search" | "target">,
	configuredTargets: number,
	matchedTargets: number,
): string {
	if (configuredTargets === 0) {
		return "no targets configured. run `clio configure` or `clio targets add` to register one.";
	}
	if (args.target !== undefined && matchedTargets === 0) {
		return `no target with id ${args.target}. ${targetCount(configuredTargets)} configured.`;
	}
	if (args.search !== undefined) {
		return `no models matched "${args.search}" across ${targetCount(matchedTargets)}.`;
	}
	return `no models found across ${targetCount(matchedTargets)}.`;
}

function targetCount(n: number): string {
	return `${n} target${n === 1 ? "" : "s"}`;
}

const MODEL_ID_WIDTH_CAP = 56;
const COLUMN_GAP = "  ";

function truncateModelId(id: string): string {
	if (id.length <= MODEL_ID_WIDTH_CAP) return id;
	return `${id.slice(0, MODEL_ID_WIDTH_CAP - 3)}...`;
}

export function modelTableLines(rows: ReadonlyArray<ModelRow>): string[] {
	const includeState = rows.some((row) => row.state && row.state !== "-");
	const headers = includeState
		? ["target", "runtime", "model", "state", "caps", "ctx", "max"]
		: ["target", "runtime", "model", "caps", "ctx", "max"];
	const cells = rows.map((row) => {
		const base = [row.targetId, row.runtimeId, truncateModelId(row.modelId)];
		if (includeState) base.push(row.state || "-");
		base.push(row.caps, compactTokenCount(row.contextWindow), compactTokenCount(row.maxTokens));
		return base;
	});
	const widths = headers.map((h, col) => Math.max(h.length, ...cells.map((cell) => cell[col]?.length ?? 0)));
	const formatLine = (values: ReadonlyArray<string>): string =>
		values
			.map((value, col) => value.padEnd(widths[col] ?? 0))
			.join(COLUMN_GAP)
			.trimEnd();
	return [formatLine(headers), ...cells.map(formatLine)];
}

function renderRows(rows: ReadonlyArray<ModelRow>): void {
	const [header, ...body] = modelTableLines(rows);
	process.stdout.write(`${chalk.bold(header ?? "")}\n`);
	for (const line of body) {
		process.stdout.write(`${line}\n`);
	}
}

function matchesSearch(row: ModelRow, search: string | undefined): boolean {
	if (!search) return true;
	const needle = search.toLowerCase();
	return (
		row.targetId.toLowerCase().includes(needle) ||
		row.runtimeId.toLowerCase().includes(needle) ||
		row.modelId.toLowerCase().includes(needle) ||
		row.state.toLowerCase().includes(needle)
	);
}
