import chalk from "chalk";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureInstalled } from "../domains/lifecycle/index.js";
import type { EndpointStatus, ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import type { CapabilityFlags } from "../domains/providers/types/capability-flags.js";

const HEADER: ReadonlyArray<string> = ["id", "runtime", "url", "model", "health", "caps", "notes"];
const WIDTHS: ReadonlyArray<number> = [14, 18, 34, 32, 10, 8, 32];

export async function runProvidersCommand(args: ReadonlyArray<string>): Promise<number> {
	const asJson = args.includes("--json");
	const probe = args.includes("--probe");
	const filterIdx = args.indexOf("--endpoint");
	const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;

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
			process.stderr.write(`providers: live probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	const entries = providers.list();
	const filtered = filter ? entries.filter((e) => e.endpoint.id === filter) : entries;

	if (asJson) {
		process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
	} else if (filtered.length === 0) {
		process.stdout.write("no endpoints configured. run `clio setup` to register one.\n");
	} else {
		renderTable(filtered);
	}
	await loaded.stop();
	return 0;
}

function pad(value: string, width: number): string {
	if (value.length >= width) return `${value.slice(0, Math.max(0, width - 1))} `;
	return value.padEnd(width);
}

function renderTable(entries: ReadonlyArray<EndpointStatus>): void {
	const headerLine = HEADER.map((h, i) => pad(h, WIDTHS[i] ?? 0)).join("");
	process.stdout.write(`${chalk.bold(headerLine.trimEnd())}\n`);
	for (const status of entries) process.stdout.write(`${formatRow(status)}\n`);
}

function formatRow(status: EndpointStatus): string {
	const runtime = status.runtime;
	const ep = status.endpoint;
	const w = (i: number): number => WIDTHS[i] ?? 0;
	const id = pad(ep.id, w(0));
	const runtimeCell = pad(runtime ? runtime.id : ep.runtime, w(1));
	const urlCell = pad(formatUrl(status), w(2));
	const modelCell = pad(ep.defaultModel ?? "-", w(3));
	const healthCell = pad(colorHealth(status.health.status), w(4) + healthPadSlack(status.health.status));
	const capsCell = pad(capabilityBadges(status.capabilities), w(5));
	const notesCell = formatNotes(status).padEnd(w(6));
	return `${id}${runtimeCell}${urlCell}${modelCell}${healthCell}${capsCell}${notesCell}`.trimEnd();
}

function healthPadSlack(status: EndpointStatus["health"]["status"]): number {
	// chalk adds ansi bytes; pad width should not shrink
	switch (status) {
		case "healthy":
		case "degraded":
		case "down":
		case "unknown":
			return 9;
		default:
			return 0;
	}
}

function colorHealth(status: EndpointStatus["health"]["status"]): string {
	switch (status) {
		case "healthy":
			return chalk.green("healthy");
		case "degraded":
			return chalk.yellow("degraded");
		case "down":
			return chalk.red("down");
		default:
			return chalk.dim("unknown");
	}
}

function formatUrl(status: EndpointStatus): string {
	const runtime = status.runtime;
	if (runtime?.kind === "subprocess") return "(subprocess)";
	if (status.endpoint.url) return status.endpoint.url;
	return "(built-in)";
}

function capabilityBadges(caps: CapabilityFlags): string {
	const badge = (on: boolean, letter: string): string => (on ? letter : "-");
	return [
		badge(caps.chat, "C"),
		badge(caps.tools, "T"),
		badge(caps.reasoning, "R"),
		badge(caps.vision, "V"),
		badge(caps.embeddings, "E"),
		badge(caps.rerank, "K"),
		badge(caps.fim, "F"),
	].join("");
}

function formatNotes(status: EndpointStatus): string {
	const parts: string[] = [];
	if (status.endpoint.gateway) parts.push("gateway");
	if (status.runtime?.auth === "oauth") parts.push("oauth");
	if (status.capabilities.contextWindow > 0) parts.push(`ctx ${status.capabilities.contextWindow}`);
	if (!status.available && status.reason) parts.push(status.reason);
	return parts.join(" ");
}
