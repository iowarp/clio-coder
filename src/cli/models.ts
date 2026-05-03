import chalk from "chalk";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import type { EndpointStatus, ProvidersContract } from "../domains/providers/contract.js";
import {
	listKnownModelsForRuntime,
	ProvidersDomainModule,
	resolveModelCapabilities,
} from "../domains/providers/index.js";
import { printError } from "./shared.js";

interface ModelRow {
	targetId: string;
	runtimeId: string;
	modelId: string;
	caps: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

const HELP = `clio models [search] [--target <id>] [--json] [--probe]

List known or discovered models for configured targets.
`;

interface ModelArgs {
	json: boolean;
	probe: boolean;
	target?: string;
	search?: string;
	help: boolean;
}

function parseModelArgs(args: ReadonlyArray<string>): ModelArgs {
	const parsed: ModelArgs = { json: false, probe: false, help: false };
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
	if (parsed.probe) {
		try {
			await providers.probeAllLive();
		} catch (err) {
			process.stderr.write(`models: live probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	const entries = providers.list();
	const filtered = parsed.target ? entries.filter((e) => e.endpoint.id === parsed.target) : entries;
	const rows = collectRows(filtered, providers).filter((row) => matchesSearch(row, parsed.search));

	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
	} else {
		renderRows(rows);
	}
	await loaded.stop();
	return 0;
}

function collectRows(entries: ReadonlyArray<EndpointStatus>, providers: ProvidersContract): ModelRow[] {
	const rows: ModelRow[] = [];
	for (const status of entries) {
		const runtimeId = status.runtime?.id ?? status.endpoint.runtime;
		const discovered = status.discoveredModels.length > 0 ? status.discoveredModels : fallbackModels(status);
		if (discovered.length === 0) {
			const caps = resolveRowCapabilities(status, status.endpoint.defaultModel ?? null, providers);
			rows.push({
				targetId: status.endpoint.id,
				runtimeId,
				modelId: "(no models)",
				...formatCapabilities(caps),
			});
			continue;
		}
		for (const modelId of discovered) {
			const caps = resolveRowCapabilities(status, modelId, providers);
			rows.push({ targetId: status.endpoint.id, runtimeId, modelId, ...formatCapabilities(caps) });
		}
	}
	return rows;
}

function fallbackModels(status: EndpointStatus): string[] {
	const wire = status.endpoint.wireModels;
	if (wire && wire.length > 0) return [...wire];
	if (status.runtime) {
		const known = listKnownModelsForRuntime(status.runtime.id);
		if (known.length > 0) return known;
	}
	if (status.endpoint.defaultModel) return [status.endpoint.defaultModel];
	return [];
}

function resolveRowCapabilities(status: EndpointStatus, modelId: string | null, providers: ProvidersContract) {
	return resolveModelCapabilities(status, modelId, providers.knowledgeBase, {
		detectedReasoning: modelId ? providers.getDetectedReasoning(status.endpoint.id, modelId) : null,
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

function renderRows(rows: ReadonlyArray<ModelRow>): void {
	if (rows.length === 0) {
		process.stdout.write("no targets configured. run `clio configure` or `clio targets add` to register one.\n");
		return;
	}
	const widths: ReadonlyArray<number> = [16, 18, 42, 8, 8, 8];
	const header = ["target", "runtime", "model", "caps", "ctx", "max"].map((h, i) => h.padEnd(widths[i] ?? 0)).join("");
	process.stdout.write(`${chalk.bold(header.trimEnd())}\n`);
	for (const row of rows) {
		const line = [
			row.targetId.padEnd(widths[0] ?? 0),
			row.runtimeId.padEnd(widths[1] ?? 0),
			row.modelId.padEnd(widths[2] ?? 0),
			row.caps.padEnd(widths[3] ?? 0),
			compactTokenCount(row.contextWindow).padEnd(widths[4] ?? 0),
			compactTokenCount(row.maxTokens).padEnd(widths[5] ?? 0),
		].join("");
		process.stdout.write(`${line.trimEnd()}\n`);
	}
}

function matchesSearch(row: ModelRow, search: string | undefined): boolean {
	if (!search) return true;
	const needle = search.toLowerCase();
	return (
		row.targetId.toLowerCase().includes(needle) ||
		row.runtimeId.toLowerCase().includes(needle) ||
		row.modelId.toLowerCase().includes(needle)
	);
}
