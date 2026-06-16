import chalk from "chalk";
import { readSettings, updateSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/contract.js";
import { isOrchestratorEligibleRuntime, ProvidersDomainModule } from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
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
  clio targets use <id> [--model <id>] [--orchestrator-model <id>] [--fleet-model <id>]
  clio targets fleet [--json]
  clio targets profile <name> <id> [--model <id>] [--thinking <level>]
  clio targets convert <id> --runtime <runtimeId>
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
	if (subcommand === "fleet" || subcommand === "workers") return runFleet(args.slice(1));
	if (subcommand === "profile" || subcommand === "worker") return runProfile(args.slice(1));
	if (subcommand === "remove") return runRemove(args.slice(1));
	if (subcommand === "rename") return runRename(args.slice(1));
	if (subcommand === "convert") return runConvert(args.slice(1));
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
	const filtered = parsed.target ? entries.filter((e) => e.target.id === parsed.target) : entries;

	if (parsed.json) {
		const settings = readSettings();
		const candidateFor = (status: TargetStatus): string | null => {
			const orchestratorModel =
				settings.orchestrator?.target === status.target.id ? (settings.orchestrator?.model ?? null) : null;
			return orchestratorModel ?? status.target.defaultModel ?? null;
		};
		const rows = filtered.map((status) => {
			const candidate = candidateFor(status);
			const detectedReasoning = candidate ? providers.getDetectedReasoning(status.target.id, candidate) : null;
			return serializeStatus(status, { detectedReasoning, candidateModelId: candidate });
		});
		process.stdout.write(`${JSON.stringify({ targets: rows }, null, 2)}\n`);
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
		if (arg === "--fleet-model" || arg === "--worker-model") {
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
		printError("usage: clio targets use <id> [--model <id>] [--orchestrator-model <id>] [--fleet-model <id>]");
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const target = settings.targets.find((entry) => entry.id === parsed.id);
	if (!target) {
		printError(`no target with id ${parsed.id}`);
		return 1;
	}
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const runtime = registry.get(target.runtime);
	if (!runtime) {
		printError(
			`cannot use target '${target.id}' as orchestrator target because runtime '${target.runtime}' is not registered`,
		);
		return 1;
	}
	if (!isOrchestratorEligibleRuntime(runtime)) {
		printError(
			`cannot use target '${target.id}' as orchestrator target because runtime '${runtime.id}' is not an HTTP/native runtime`,
		);
		return 1;
	}
	const sharedModel = parsed.model ?? target.defaultModel ?? null;
	const orchestratorModel = parsed.orchestratorModel ?? sharedModel;
	const workerModel = parsed.workerModel ?? sharedModel;
	// Locked read-modify-write so a concurrent session's field-level
	// write-through (Shift+Tab, Alt+L, …) cannot be lost between our read
	// above and this save.
	updateSettings((fresh) => {
		fresh.orchestrator.target = target.id;
		fresh.orchestrator.model = orchestratorModel;
		fresh.workers.default.target = target.id;
		fresh.workers.default.model = workerModel;
	});
	printOk(`using target ${target.id} for chat and fleet dispatch`);
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
		throw new Error(`unknown targets profile argument: ${arg}`);
	}
	return parsed;
}

function runProfile(args: ReadonlyArray<string>): number {
	let parsed: WorkerProfileArgs | null;
	try {
		parsed = parseWorkerArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError("usage: clio targets profile <name> <id> [--model <id>] [--thinking <level>]");
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const target = settings.targets.find((entry) => entry.id === parsed.targetId);
	if (!target) {
		printError(`no target with id ${parsed.targetId}`);
		return 2;
	}
	const existing = settings.workers.profiles[parsed.name];
	const profileName = parsed.name;
	const profile = {
		target: target.id,
		model: parsed.model ?? target.defaultModel ?? null,
		thinkingLevel: parsed.thinkingLevel ?? existing?.thinkingLevel ?? "off",
	};
	updateSettings((fresh) => {
		fresh.workers.profiles[profileName] = profile;
	});
	printOk(`fleet profile ${parsed.name} -> ${target.id}`);
	return 0;
}

function runFleet(args: ReadonlyArray<string>): number {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write("usage: clio targets fleet [--json]\n");
			return 0;
		}
		printError(`unknown targets fleet argument: ${arg}`);
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const byId = new Map(settings.targets.map((target) => [target.id, target] as const));
	const rows = Object.entries(settings.workers.profiles).map(([name, profile]) => {
		const target = profile.target ? byId.get(profile.target) : undefined;
		return {
			name,
			target: profile.target,
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
		process.stdout.write("no fleet profiles configured. run `clio targets profile <name> <id>` to add one.\n");
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

function runConvert(args: ReadonlyArray<string>): number {
	const id = args[0];
	if (!id || id.startsWith("-")) {
		printError("usage: clio targets convert <id> --runtime <runtimeId>");
		return 2;
	}
	let runtimeId: string | undefined;
	for (let i = 1; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--runtime") {
			const value = args[i + 1];
			if (!value) {
				printError("--runtime requires a value");
				return 2;
			}
			runtimeId = value;
			i += 1;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write("usage: clio targets convert <id> --runtime <runtimeId>\n");
			return 0;
		}
		printError(`unknown convert argument: ${arg}`);
		return 2;
	}
	if (!runtimeId) {
		printError("--runtime is required");
		return 2;
	}
	ensureClioState();
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const runtime = registry.get(runtimeId);
	if (!runtime) {
		printError(`unknown runtime id: ${runtimeId} (run \`clio configure --list\` to see registered runtimes)`);
		return 2;
	}
	const settings = readSettings();
	const target = settings.targets.find((entry) => entry.id === id);
	if (!target) {
		printError(`no target with id ${id}`);
		return 1;
	}
	if (target.runtime === runtimeId) {
		printOk(`target ${id} already uses runtime ${runtimeId}`);
		return 0;
	}
	if (settings.orchestrator.target === id && !isOrchestratorEligibleRuntime(runtime)) {
		printError(`cannot convert orchestrator target '${id}' to non-HTTP/native runtime '${runtime.id}'`);
		return 1;
	}
	const previousRuntime = target.runtime;
	updateSettings((fresh) => {
		const entry = fresh.targets.find((candidate) => candidate.id === id);
		if (entry) entry.runtime = runtimeId;
	});
	printOk(`converted target ${id}: ${previousRuntime} -> ${runtimeId}`);
	return 0;
}

function pad(value: string, width: number): string {
	if (value.length >= width) return `${value.slice(0, Math.max(0, width - 1))} `;
	return value.padEnd(width);
}

function renderTable(providers: ProvidersContract, entries: ReadonlyArray<TargetStatus>): void {
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

function formatRow(providers: ProvidersContract, status: TargetStatus): string {
	const runtime = status.runtime;
	const ep = status.target;
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

function healthPadSlack(status: TargetStatus["health"]["status"]): number {
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

function colorHealth(status: TargetStatus["health"]["status"]): string {
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

function formatUrl(status: TargetStatus): string {
	if (status.target.url) return status.target.url;
	return "(built-in)";
}

function formatAuth(providers: ProvidersContract, status: TargetStatus): string {
	if (!status.runtime) return "-";
	if (status.runtime.auth !== "api-key" && status.runtime.auth !== "oauth") return status.runtime.auth;
	const auth = providers.auth.statusForTarget(status.target, status.runtime);
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

function formatNotes(status: TargetStatus): string {
	const parts: string[] = [];
	if (status.target.gateway) parts.push("gateway");
	if (status.runtime?.auth === "oauth") parts.push("oauth");
	if (status.runtime?.auth === "claude-cli") parts.push("claude-cli");
	if (status.capabilities.contextWindow > 0) parts.push(`ctx ${status.capabilities.contextWindow}`);
	if (!status.available && status.reason) parts.push(status.reason);
	if (status.probeNotes && status.probeNotes.length > 0) parts.push(`note: ${status.probeNotes.join("; ")}`);
	return parts.join(" ");
}

function statusTier(status: TargetStatus): ProviderOutputTier {
	return status.runtime?.tier ?? "unknown";
}

function tierLabel(tier: ProviderOutputTier): string {
	switch (tier) {
		case "protocol":
			return "Protocol";
		case "cloud":
			return "Cloud";
		case "subscription":
			return "Subscription";
		case "local-native":
			return "Local native";
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
		case "subscription":
			return 2;
		case "local-native":
			return 3;
		case "unknown":
			return 4;
	}
}

function compareStatusByTier(a: TargetStatus, b: TargetStatus): number {
	return (
		tierRank(statusTier(a)) - tierRank(statusTier(b)) ||
		a.target.id.localeCompare(b.target.id) ||
		a.target.runtime.localeCompare(b.target.runtime)
	);
}

interface SerializedStatus {
	target: TargetStatus["target"];
	runtime: TargetStatus["runtime"];
	available: boolean;
	reason: string;
	health: TargetStatus["health"];
	capabilities: TargetStatus["capabilities"];
	probeCapabilities?: TargetStatus["probeCapabilities"];
	probeModelId?: TargetStatus["probeModelId"];
	probeNotes?: TargetStatus["probeNotes"];
	discoveredModels: TargetStatus["discoveredModels"];
	discoveredModelsSource?: TargetStatus["discoveredModelsSource"];
	discoveredModelStates?: TargetStatus["discoveredModelStates"];
	tier: ProviderOutputTier;
	detectedReasoning: boolean | null;
	reasoningCandidateModelId: string | null;
}

function serializeStatus(
	status: TargetStatus,
	extras: { detectedReasoning: boolean | null; candidateModelId: string | null } = {
		detectedReasoning: null,
		candidateModelId: null,
	},
): SerializedStatus {
	const out: SerializedStatus = {
		target: status.target,
		runtime: status.runtime,
		available: status.available,
		reason: status.reason,
		health: status.health,
		capabilities: status.capabilities,
		discoveredModels: status.discoveredModels,
		tier: statusTier(status),
		detectedReasoning: extras.detectedReasoning,
		reasoningCandidateModelId: extras.candidateModelId,
	};
	if (status.discoveredModelsSource !== undefined) {
		out.discoveredModelsSource = status.discoveredModelsSource;
	}
	if (status.discoveredModelStates !== undefined) {
		out.discoveredModelStates = status.discoveredModelStates;
	}
	if (status.probeCapabilities !== undefined) {
		out.probeCapabilities = status.probeCapabilities;
	}
	if (status.probeModelId !== undefined) {
		out.probeModelId = status.probeModelId;
	}
	if (status.probeNotes !== undefined) {
		out.probeNotes = status.probeNotes;
	}
	return out;
}
