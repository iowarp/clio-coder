import chalk from "chalk";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureInstalled } from "../domains/lifecycle/index.js";
import type { EndpointStatus, ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule, listKnownModelsForRuntime } from "../domains/providers/index.js";

interface ModelRow {
	endpointId: string;
	runtimeId: string;
	modelId: string;
	caps: string;
}

export async function runListModelsCommand(args: ReadonlyArray<string>): Promise<number> {
	const asJson = args.includes("--json");
	const probe = args.includes("--probe");
	const filterIdx = args.indexOf("--endpoint");
	const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;
	const search = args.find((arg, index) => index !== filterIdx + 1 && !arg.startsWith("--"));

	ensureInstalled();
	const loaded = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
	const providers = loaded.getContract<ProvidersContract>("providers");
	if (!providers) {
		process.stderr.write("providers: domain not loaded\n");
		await loaded.stop();
		return 1;
	}
	if (probe) {
		try {
			await providers.probeAllLive();
		} catch (err) {
			process.stderr.write(`list-models: live probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	const entries = providers.list();
	const filtered = filter ? entries.filter((e) => e.endpoint.id === filter) : entries;
	const rows = collectRows(filtered).filter((row) => matchesSearch(row, search));

	if (asJson) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
	} else {
		renderRows(rows);
	}
	await loaded.stop();
	return 0;
}

function collectRows(entries: ReadonlyArray<EndpointStatus>): ModelRow[] {
	const rows: ModelRow[] = [];
	for (const status of entries) {
		const runtimeId = status.runtime?.id ?? status.endpoint.runtime;
		const caps = capabilityBadges(status);
		const discovered = status.discoveredModels.length > 0 ? status.discoveredModels : fallbackModels(status);
		if (discovered.length === 0) {
			rows.push({
				endpointId: status.endpoint.id,
				runtimeId,
				modelId: "(no models)",
				caps,
			});
			continue;
		}
		for (const modelId of discovered) {
			rows.push({ endpointId: status.endpoint.id, runtimeId, modelId, caps });
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

function capabilityBadges(status: EndpointStatus): string {
	const c = status.capabilities;
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

function renderRows(rows: ReadonlyArray<ModelRow>): void {
	if (rows.length === 0) {
		process.stdout.write("no endpoints configured. run `clio setup` to register one.\n");
		return;
	}
	const widths: ReadonlyArray<number> = [16, 18, 42, 8];
	const header = ["endpoint", "runtime", "model", "caps"].map((h, i) => h.padEnd(widths[i] ?? 0)).join("");
	process.stdout.write(`${chalk.bold(header.trimEnd())}\n`);
	for (const row of rows) {
		const line = [
			row.endpointId.padEnd(widths[0] ?? 0),
			row.runtimeId.padEnd(widths[1] ?? 0),
			row.modelId.padEnd(widths[2] ?? 0),
			row.caps.padEnd(widths[3] ?? 0),
		].join("");
		process.stdout.write(`${line.trimEnd()}\n`);
	}
}

function matchesSearch(row: ModelRow, search: string | undefined): boolean {
	if (!search) return true;
	const needle = search.toLowerCase();
	return (
		row.endpointId.toLowerCase().includes(needle) ||
		row.runtimeId.toLowerCase().includes(needle) ||
		row.modelId.toLowerCase().includes(needle)
	);
}
