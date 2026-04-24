import chalk from "chalk";
import { readSettings, writeSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import type { EndpointStatus, ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import type { CapabilityFlags } from "../domains/providers/types/capability-flags.js";
import type { RuntimeTier } from "../domains/providers/types/runtime-descriptor.js";
import { runConfigureCommand, runTargetRemove, runTargetRename } from "./configure.js";
import { printError, printOk } from "./shared.js";

const HEADER: ReadonlyArray<string> = ["id", "tier", "runtime", "auth", "url", "model", "health", "caps", "notes"];
const WIDTHS: ReadonlyArray<number> = [14, 14, 18, 18, 28, 26, 10, 8, 28];
type ProviderOutputTier = RuntimeTier | "unknown";

const HELP = `clio targets

List and manage configured model targets.

Usage:
  clio targets [--json] [--probe] [--target <id>]
  clio targets add [configure flags]
  clio targets use <id> [--model <id>] [--orchestrator-model <id>] [--worker-model <id>]
  clio targets workers [--json]
  clio targets worker <profile> <id> [--model <id>] [--thinking <level>]
  clio targets remove <id>
  clio targets rename <old> <new>
`;

interface ListArgs {
	json: boolean;
	probe: boolean;
	target?: string;
	help: boolean;
}

interface UseArgs {
	id: string;
	model?: string;
	orchestratorModel?: string;
	workerModel?: string;
}

type WorkerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const VALID_THINKING = new Set<WorkerThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

interface WorkerProfileArgs {
	name: string;
	targetId: string;
	model?: string;
	thinkingLevel?: WorkerThinkingLevel;
}

function parseListArgs(args: ReadonlyArray<string>): ListArgs {
	const parsed: ListArgs = { json: false, probe: false, help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
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
		throw new Error(`unknown targets argument: ${arg}`);
	}
	return parsed;
}

export async function runTargetsCommand(args: ReadonlyArray<string>): Promise<number> {
	const subcommand = args[0];
	if (subcommand === "add") return runConfigureCommand(args.slice(1));
	if (subcommand === "use") return runUse(args.slice(1));
	if (subcommand === "workers") return runWorkers(args.slice(1));
	if (subcommand === "worker") return runWorker(args.slice(1));
	if (subcommand === "remove") return runRemove(args.slice(1));
	if (subcommand === "rename") return runRename(args.slice(1));
	if (subcommand === "--help" || subcommand === "-h") {
		process.stdout.write(HELP);
		return 0;
	}

	let parsed: ListArgs;
	try {
		parsed = parseListArgs(args);
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
		process.stderr.write("targets: provider domain not loaded\n");
		await loaded.stop();
		return 1;
	}
	if (parsed.probe) {
		try {
			await providers.probeAllLive();
		} catch (err) {
			process.stderr.write(`targets: live probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}
	const entries = providers.list();
	const filtered = parsed.target ? entries.filter((e) => e.endpoint.id === parsed.target) : entries;

	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(filtered.map(serializeStatus), null, 2)}\n`);
	} else if (filtered.length === 0) {
		process.stdout.write("no targets configured. run `clio configure` or `clio targets add` to register one.\n");
	} else {
		renderTable(providers, filtered);
	}
	await loaded.stop();
	return 0;
}

function parseUseArgs(args: ReadonlyArray<string>): UseArgs | null {
	const id = args[0];
	if (!id) return null;
	const parsed: UseArgs = { id };
	for (let i = 1; i < args.length; i += 1) {
		const arg = args[i];
		const need = (): string => {
			const value = args[i + 1];
			if (!value) throw new Error(`${arg} requires a value`);
			i += 1;
			return value;
		};
		if (arg === "--model") {
			parsed.model = need();
			continue;
		}
		if (arg === "--orchestrator-model") {
			parsed.orchestratorModel = need();
			continue;
		}
		if (arg === "--worker-model") {
			parsed.workerModel = need();
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		throw new Error(`unknown targets use argument: ${arg}`);
	}
	return parsed;
}

function runUse(args: ReadonlyArray<string>): number {
	let parsed: UseArgs | null;
	try {
		parsed = parseUseArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError("usage: clio targets use <id> [--model <id>] [--orchestrator-model <id>] [--worker-model <id>]");
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const target = settings.endpoints.find((entry) => entry.id === parsed.id);
	if (!target) {
		printError(`no target with id ${parsed.id}`);
		return 1;
	}
	const sharedModel = parsed.model ?? target.defaultModel ?? null;
	settings.orchestrator.endpoint = target.id;
	settings.orchestrator.model = parsed.orchestratorModel ?? sharedModel;
	settings.workers.default.endpoint = target.id;
	settings.workers.default.model = parsed.workerModel ?? sharedModel;
	writeSettings(settings);
	printOk(`using target ${target.id} for chat and workers`);
	return 0;
}

function parseWorkerArgs(args: ReadonlyArray<string>): WorkerProfileArgs | null {
	const name = args[0];
	const targetId = args[1];
	if (!name || !targetId) return null;
	const parsed: WorkerProfileArgs = { name, targetId };
	for (let i = 2; i < args.length; i += 1) {
		const arg = args[i];
		const need = (): string => {
			const value = args[i + 1];
			if (!value) throw new Error(`${arg} requires a value`);
			i += 1;
			return value;
		};
		if (arg === "--model") {
			parsed.model = need();
			continue;
		}
		if (arg === "--thinking") {
			const value = need();
			if (!VALID_THINKING.has(value as WorkerThinkingLevel)) {
				throw new Error("--thinking must be one of: off|minimal|low|medium|high|xhigh");
			}
			parsed.thinkingLevel = value as WorkerThinkingLevel;
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		throw new Error(`unknown targets worker argument: ${arg}`);
	}
	return parsed;
}

function runWorker(args: ReadonlyArray<string>): number {
	let parsed: WorkerProfileArgs | null;
	try {
		parsed = parseWorkerArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError("usage: clio targets worker <profile> <id> [--model <id>] [--thinking <level>]");
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const target = settings.endpoints.find((entry) => entry.id === parsed.targetId);
	if (!target) {
		printError(`no target with id ${parsed.targetId}`);
		return 1;
	}
	const existing = settings.workers.profiles[parsed.name];
	settings.workers.profiles[parsed.name] = {
		endpoint: target.id,
		model: parsed.model ?? target.defaultModel ?? null,
		thinkingLevel: parsed.thinkingLevel ?? existing?.thinkingLevel ?? "off",
	};
	writeSettings(settings);
	printOk(`worker profile ${parsed.name} -> ${target.id}`);
	return 0;
}

function runWorkers(args: ReadonlyArray<string>): number {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write("usage: clio targets workers [--json]\n");
			return 0;
		}
		printError(`unknown targets workers argument: ${arg}`);
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const byId = new Map(settings.endpoints.map((target) => [target.id, target] as const));
	const rows = Object.entries(settings.workers.profiles).map(([name, profile]) => {
		const target = profile.endpoint ? byId.get(profile.endpoint) : undefined;
		return {
			name,
			target: profile.endpoint,
			runtime: target?.runtime ?? null,
			model: profile.model,
			thinkingLevel: profile.thinkingLevel,
		};
	});
	if (json) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write("no worker profiles configured. run `clio targets worker <profile> <id>` to add one.\n");
		return 0;
	}
	process.stdout.write(`${pad("profile", 18)}${pad("target", 16)}${pad("runtime", 20)}${pad("model", 30)}thinking\n`);
	for (const row of rows) {
		process.stdout.write(
			`${pad(row.name, 18)}${pad(row.target ?? "-", 16)}${pad(row.runtime ?? "-", 20)}${pad(row.model ?? "-", 30)}${row.thinkingLevel}\n`,
		);
	}
	return 0;
}

function runRemove(args: ReadonlyArray<string>): number {
	if (args.length !== 1 || !args[0]) {
		printError("usage: clio targets remove <id>");
		return 2;
	}
	ensureClioState();
	return runTargetRemove(args[0]);
}

function runRename(args: ReadonlyArray<string>): number {
	if (args.length !== 2 || !args[0] || !args[1]) {
		printError("usage: clio targets rename <old> <new>");
		return 2;
	}
	ensureClioState();
	return runTargetRename(args[0], args[1]);
}

function pad(value: string, width: number): string {
	if (value.length >= width) return `${value.slice(0, Math.max(0, width - 1))} `;
	return value.padEnd(width);
}

function renderTable(providers: ProvidersContract, entries: ReadonlyArray<EndpointStatus>): void {
	const headerLine = HEADER.map((h, i) => pad(h, WIDTHS[i] ?? 0)).join("");
	let currentTier: ProviderOutputTier | null = null;
	for (const status of [...entries].sort(compareStatusByTier)) {
		const tier = statusTier(status);
		if (tier !== currentTier) {
			currentTier = tier;
			process.stdout.write(`${chalk.bold(tierLabel(tier))}\n`);
			process.stdout.write(`${chalk.bold(headerLine.trimEnd())}\n`);
		}
		process.stdout.write(`${formatRow(providers, status)}\n`);
	}
}

function formatRow(providers: ProvidersContract, status: EndpointStatus): string {
	const runtime = status.runtime;
	const ep = status.endpoint;
	const w = (i: number): number => WIDTHS[i] ?? 0;
	const id = pad(ep.id, w(0));
	const tierCell = pad(statusTier(status), w(1));
	const runtimeCell = pad(runtime ? runtime.id : ep.runtime, w(2));
	const authCell = pad(formatAuth(providers, status), w(3));
	const urlCell = pad(formatUrl(status), w(4));
	const modelCell = pad(ep.defaultModel ?? "-", w(5));
	const healthCell = pad(colorHealth(status.health.status), w(6) + healthPadSlack(status.health.status));
	const capsCell = pad(capabilityBadges(status.capabilities), w(7));
	const notesCell = formatNotes(status).padEnd(w(8));
	return `${id}${tierCell}${runtimeCell}${authCell}${urlCell}${modelCell}${healthCell}${capsCell}${notesCell}`.trimEnd();
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
	if (runtime?.kind === "sdk") return "(sdk)";
	if (status.endpoint.url) return status.endpoint.url;
	return "(built-in)";
}

function formatAuth(providers: ProvidersContract, status: EndpointStatus): string {
	if (!status.runtime) return "-";
	if (status.runtime.auth !== "api-key" && status.runtime.auth !== "oauth") return status.runtime.auth;
	const auth = providers.auth.statusForTarget(status.endpoint, status.runtime);
	if (!auth.available) return "disconnected";
	if (auth.source === "environment") return auth.detail ? `env:${auth.detail}` : "environment";
	return auth.source.replace("stored-", "");
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

function statusTier(status: EndpointStatus): ProviderOutputTier {
	return status.runtime?.tier ?? "unknown";
}

function tierLabel(tier: ProviderOutputTier): string {
	switch (tier) {
		case "protocol":
			return "Protocol";
		case "cloud":
			return "Cloud";
		case "local-native":
			return "Local native";
		case "sdk":
			return "SDK runtimes";
		case "cli":
			return "CLI runtimes";
		case "cli-gold":
			return "Gold CLI runtimes";
		case "cli-silver":
			return "Silver CLI runtimes";
		case "cli-bronze":
			return "Bronze CLI runtimes";
		case "unknown":
			return "Unknown";
	}
}

function tierRank(tier: ProviderOutputTier): number {
	switch (tier) {
		case "protocol":
			return 0;
		case "cloud":
			return 1;
		case "local-native":
			return 2;
		case "sdk":
			return 3;
		case "cli-gold":
			return 4;
		case "cli-silver":
			return 5;
		case "cli":
			return 6;
		case "cli-bronze":
			return 7;
		case "unknown":
			return 8;
	}
}

function compareStatusByTier(a: EndpointStatus, b: EndpointStatus): number {
	return (
		tierRank(statusTier(a)) - tierRank(statusTier(b)) ||
		a.endpoint.id.localeCompare(b.endpoint.id) ||
		a.endpoint.runtime.localeCompare(b.endpoint.runtime)
	);
}

function serializeStatus(status: EndpointStatus): {
	target: EndpointStatus["endpoint"];
	runtime: EndpointStatus["runtime"];
	available: boolean;
	reason: string;
	health: EndpointStatus["health"];
	capabilities: EndpointStatus["capabilities"];
	probeCapabilities?: EndpointStatus["probeCapabilities"];
	discoveredModels: EndpointStatus["discoveredModels"];
	tier: ProviderOutputTier;
} {
	const out = {
		target: status.endpoint,
		runtime: status.runtime,
		available: status.available,
		reason: status.reason,
		health: status.health,
		capabilities: status.capabilities,
		discoveredModels: status.discoveredModels,
		tier: statusTier(status),
	};
	if (status.probeCapabilities !== undefined) {
		return { ...out, probeCapabilities: status.probeCapabilities };
	}
	return out;
}
