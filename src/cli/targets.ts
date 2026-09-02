import chalk from "chalk";
import {
	bindAgentProfileInSettings,
	type ClioSettings,
	readSettings,
	removeFleetProfileFromSettings,
	setFleetProfileInSettings,
	updateSettings,
	useTargetInSettings,
} from "../core/config.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../core/defaults.js";
import { loadDomains } from "../core/domain-loader.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/contract.js";
import {
	endpointCapacityForStatus,
	isDispatchEligibleRuntime,
	isOrchestratorEligibleRuntime,
	ProvidersDomainModule,
} from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import type { CapabilityFlags } from "../domains/providers/types/capability-flags.js";
import type { RuntimeTier } from "../domains/providers/types/runtime-descriptor.js";
import { runConfigureCommand, runTargetRemove, runTargetRename } from "./configure.js";
import { noteDeprecatedFlag, printError, printOk } from "./shared.js";
import { column, terminalColumns, truncate, wrapPlain } from "./text-layout.js";

const HEADER: ReadonlyArray<string> = ["id", "tier", "runtime", "auth", "url", "model", "health", "caps", "notes"];
type ProviderOutputTier = RuntimeTier | "unknown";

const HELP = `clio-coder targets

List and manage configured model targets.

Usage:
  clio-coder targets [--json] [--probe] [--target <id>]
  clio-coder targets add [configure flags]
  clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>]
                       [--fleet-target <id>] [--fleet-model <id>]
  clio-coder targets fleet [--json]
  clio-coder targets profile list [--json]
  clio-coder targets profile set <name> <id> [--model <id>] [--thinking <level>]
  clio-coder targets profile <name> <id> [--model <id>] [--thinking <level>]
  clio-coder targets profile remove <name> [--force]
  clio-coder targets profile rename <old> <new>
  clio-coder targets profile bind <agentId> <profileName>
  clio-coder targets profile unbind <agentId>
  clio-coder targets profile bindings [--json]
  clio-coder targets convert <id> --runtime <runtimeId>
  clio-coder targets remove <id>
  clio-coder targets rename <old> <new>

Aliases:
  --worker-target and --worker-model are accepted for --fleet-target and
  --fleet-model, carried over from before the worker/fleet rename.
`;

const USE_USAGE =
	"clio-coder targets use <id> [--model <id>] [--orchestrator-model <id>] [--background-model <id>] [--fleet-target <id>] [--fleet-model <id>]";

/**
 * `--help` anywhere on a targets subcommand is a question, not an argument.
 *
 * `use --help` and `remove --help` read it as the target id and answered
 * `no target with id --help`; `rename`, `profile`, and `convert` answered their
 * usage as an error on stderr. Each now prints the same usage on stdout with
 * status 0 and executes nothing.
 */
function wantsHelp(args: ReadonlyArray<string>): boolean {
	return args.includes("--help") || args.includes("-h");
}

function printUsage(usage: string): number {
	process.stdout.write(`usage: ${usage}\n`);
	return 0;
}

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
	backgroundModel?: string;
	workerModel?: string;
	workerTarget?: string;
}

type WorkerThinkingLevel = ThinkingLevel;

const VALID_THINKING = new Set<WorkerThinkingLevel>(THINKING_LEVELS);

interface WorkerProfileArgs {
	name: string;
	targetId: string;
	model?: string;
	thinkingLevel?: WorkerThinkingLevel;
}

interface ProfileRemoveArgs {
	name: string;
	force: boolean;
}

interface ProfileRenameArgs {
	oldName: string;
	newName: string;
}

interface ProfileBindArgs {
	agentId: string;
	profileName: string;
}

const PROFILE_SUBCOMMANDS = new Set(["list", "set", "remove", "rename", "bind", "unbind", "bindings"]);

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
		process.stderr.write(HELP);
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
	if (parsed.target !== undefined && !entries.some((e) => e.target.id === parsed.target)) {
		printError(
			`no target with id ${parsed.target}. ${entries.length} target${entries.length === 1 ? "" : "s"} configured.`,
		);
		await loaded.stop();
		return 2;
	}
	const filtered = parsed.target ? entries.filter((e) => e.target.id === parsed.target) : entries;

	if (parsed.json) {
		const settings = readSettings();
		const candidateFor = (status: TargetStatus): string | null => {
			const orchestratorModel = settings.chat?.target === status.target.id ? (settings.chat?.model ?? null) : null;
			return orchestratorModel ?? status.target.defaultModel ?? null;
		};
		const rows = filtered.map((status) => {
			const candidate = candidateFor(status);
			const detectedReasoning = candidate ? providers.getDetectedReasoning(status.target.id, candidate) : null;
			return serializeStatus(status, { detectedReasoning, candidateModelId: candidate });
		});
		process.stdout.write(`${JSON.stringify({ targets: rows }, null, 2)}\n`);
	} else if (filtered.length === 0) {
		process.stdout.write(
			"no targets configured. run `clio-coder configure` or `clio-coder targets add` to register one.\n",
		);
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
		if (arg === "--background-model") {
			parsed.backgroundModel = need();
			continue;
		}
		if (arg === "--fleet-model" || arg === "--worker-model") {
			if (arg === "--worker-model") noteDeprecatedFlag(arg, "--fleet-model");
			parsed.workerModel = need();
			continue;
		}
		if (arg === "--fleet-target" || arg === "--worker-target") {
			if (arg === "--worker-target") noteDeprecatedFlag(arg, "--fleet-target");
			parsed.workerTarget = need();
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		throw new Error(`unknown targets use argument: ${arg}`);
	}
	return parsed;
}

function runUse(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage(USE_USAGE);
	let parsed: UseArgs | null;
	try {
		parsed = parseUseArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError(`usage: ${USE_USAGE}`);
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
	let workerTarget = target;
	if (parsed.workerTarget !== undefined && parsed.workerTarget !== target.id) {
		const resolved = resolveDispatchProfileTarget(settings, parsed.workerTarget, "fleet worker target");
		if ("exitCode" in resolved) return resolved.exitCode;
		workerTarget = resolved.target;
	}
	const backgroundModel = parsed.backgroundModel;
	// Locked read-modify-write so a concurrent session's field-level
	// write-through (Shift+Tab, Alt+L, …) cannot be lost between our read
	// above and this save.
	updateSettings((fresh) => {
		useTargetInSettings(fresh, target.id, {
			...(parsed.model !== undefined ? { model: parsed.model } : {}),
			...(parsed.orchestratorModel !== undefined ? { orchestratorModel: parsed.orchestratorModel } : {}),
			...(parsed.workerModel !== undefined ? { workerModel: parsed.workerModel } : {}),
			workerTargetId: workerTarget.id,
			...(backgroundModel !== undefined ? { backgroundModel } : {}),
		});
	});
	const dispatchWhere = workerTarget === target ? "" : ` and ${workerTarget.id} for fleet dispatch`;
	const chatWhere = workerTarget === target ? "for chat and fleet dispatch" : "for chat";
	printOk(
		`using target ${target.id} ${chatWhere}${dispatchWhere}${backgroundModel === undefined ? "" : ", and background memory"}`,
	);
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
				throw new Error("--thinking must be one of: off|minimal|low|medium|high|xhigh|max");
			}
			parsed.thinkingLevel = value as WorkerThinkingLevel;
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		throw new Error(`unknown targets profile argument: ${arg}`);
	}
	return parsed;
}

function requireTrimmed(value: string | undefined, label: string): string {
	const trimmed = value?.trim() ?? "";
	if (trimmed.length === 0) throw new Error(`${label} must be non-empty`);
	return trimmed;
}

function parseProfileRemoveArgs(args: ReadonlyArray<string>): ProfileRemoveArgs | null {
	const name = args[0];
	if (!name) return null;
	const parsed: ProfileRemoveArgs = { name: name.trim(), force: false };
	if (parsed.name.length === 0) throw new Error("profile name must be non-empty");
	for (let i = 1; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--force") {
			parsed.force = true;
			continue;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		throw new Error(`unknown targets profile remove argument: ${arg}`);
	}
	return parsed;
}

function parseProfileRenameArgs(args: ReadonlyArray<string>): ProfileRenameArgs | null {
	if (args.length !== 2) return null;
	const oldName = requireTrimmed(args[0], "old profile name");
	const newName = requireTrimmed(args[1], "new profile name");
	return { oldName, newName };
}

function parseProfileBindArgs(args: ReadonlyArray<string>): ProfileBindArgs | null {
	if (args.length !== 2) return null;
	return {
		agentId: requireTrimmed(args[0], "agent id"),
		profileName: requireTrimmed(args[1], "profile name"),
	};
}

function resolveDispatchProfileTarget(
	settings: ClioSettings,
	targetId: string,
	role = "fleet profile target",
): { target: ClioSettings["targets"][number] } | { exitCode: number } {
	const target = settings.targets.find((entry) => entry.id === targetId);
	if (!target) {
		printError(`no target with id ${targetId}`);
		return { exitCode: 2 };
	}
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const runtime = registry.get(target.runtime);
	if (!runtime) {
		printError(`cannot use target '${target.id}' as ${role} because runtime '${target.runtime}' is not registered`);
		return { exitCode: 1 };
	}
	if (!isDispatchEligibleRuntime(runtime)) {
		printError(
			`cannot use target '${target.id}' as ${role} because runtime '${runtime.id}' is not a fleet-dispatch target`,
		);
		return { exitCode: 1 };
	}
	return { target };
}

function runProfileSet(
	args: ReadonlyArray<string>,
	usage = "clio-coder targets profile <name> <id> [--model <id>] [--thinking <level>]",
): number {
	if (wantsHelp(args)) return printUsage(usage);
	let parsed: WorkerProfileArgs | null;
	try {
		parsed = parseWorkerArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError(`usage: ${usage}`);
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const resolved = resolveDispatchProfileTarget(settings, parsed.targetId);
	if ("exitCode" in resolved) return resolved.exitCode;
	const { target } = resolved;
	updateSettings((fresh) => {
		setFleetProfileInSettings(fresh, parsed.name, target.id, {
			...(parsed.model !== undefined ? { model: parsed.model } : {}),
			...(parsed.thinkingLevel !== undefined ? { thinkingLevel: parsed.thinkingLevel } : {}),
		});
	});
	printOk(`fleet profile ${parsed.name} -> ${target.id}`);
	return 0;
}

function runProfileRemove(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage("clio-coder targets profile remove <name> [--force]");
	let parsed: ProfileRemoveArgs | null;
	try {
		parsed = parseProfileRemoveArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError("usage: clio-coder targets profile remove <name> [--force]");
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	if (!settings.fleet.profiles[parsed.name]) {
		printError(`no fleet profile named ${parsed.name}`);
		return 1;
	}
	const boundAgents = Object.entries(settings.fleet.agentProfiles)
		.filter(([, profileName]) => profileName === parsed.name)
		.map(([agentId]) => agentId);
	if (boundAgents.length > 0 && !parsed.force) {
		printError(
			`fleet profile ${parsed.name} is bound to ${boundAgents.length} agent${boundAgents.length === 1 ? "" : "s"}; use --force to remove profile and bindings`,
			boundAgents.join(", "),
		);
		return 1;
	}
	let removedBindings = 0;
	updateSettings((fresh) => {
		removedBindings = removeFleetProfileFromSettings(fresh, parsed.name);
	});
	printOk(
		`removed fleet profile ${parsed.name} (${removedBindings} binding${removedBindings === 1 ? "" : "s"} removed)`,
	);
	return 0;
}

function runProfileRename(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage("clio-coder targets profile rename <old> <new>");
	let parsed: ProfileRenameArgs | null;
	try {
		parsed = parseProfileRenameArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError("usage: clio-coder targets profile rename <old> <new>");
		return 2;
	}
	if (parsed.oldName === parsed.newName) {
		printError("old and new profile names are identical");
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	if (!settings.fleet.profiles[parsed.oldName]) {
		printError(`no fleet profile named ${parsed.oldName}`);
		return 1;
	}
	if (settings.fleet.profiles[parsed.newName]) {
		printError(`fleet profile already exists: ${parsed.newName}`);
		return 2;
	}
	let updatedBindings = 0;
	updateSettings((fresh) => {
		const profile = fresh.fleet.profiles[parsed.oldName];
		if (!profile) return;
		fresh.fleet.profiles[parsed.newName] = profile;
		delete fresh.fleet.profiles[parsed.oldName];
		for (const [agentId, profileName] of Object.entries(fresh.fleet.agentProfiles)) {
			if (profileName !== parsed.oldName) continue;
			fresh.fleet.agentProfiles[agentId] = parsed.newName;
			updatedBindings += 1;
		}
	});
	printOk(
		`renamed fleet profile ${parsed.oldName} to ${parsed.newName} (${updatedBindings} binding${updatedBindings === 1 ? "" : "s"} updated)`,
	);
	return 0;
}

function runProfileBind(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage("clio-coder targets profile bind <agentId> <profileName>");
	let parsed: ProfileBindArgs | null;
	try {
		parsed = parseProfileBindArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (!parsed) {
		printError("usage: clio-coder targets profile bind <agentId> <profileName>");
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	if (settings.integrations.externalAgents.entries.some((agent) => agent.id === parsed.agentId)) {
		printError(
			`cannot bind ACP delegation agent '${parsed.agentId}' to a fleet profile; ACP agents use their own runner and ignore native target routing`,
		);
		return 1;
	}
	if (!settings.fleet.profiles[parsed.profileName]) {
		process.stderr.write(
			`${chalk.yellow("warning:")} fleet profile '${parsed.profileName}' is not configured; binding will resolve after the profile exists\n`,
		);
	}
	updateSettings((fresh) => {
		bindAgentProfileInSettings(fresh, parsed.agentId, parsed.profileName);
	});
	printOk(`bound agent ${parsed.agentId} -> fleet profile ${parsed.profileName}`);
	return 0;
}

function runProfileUnbind(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage("clio-coder targets profile unbind <agentId>");
	let parsed: string;
	try {
		if (args.length !== 1) throw new Error("usage: clio-coder targets profile unbind <agentId>");
		parsed = requireTrimmed(args[0], "agent id");
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	if (!settings.fleet.agentProfiles[parsed]) {
		printError(`agent ${parsed} is not bound to a fleet profile`);
		return 1;
	}
	updateSettings((fresh) => {
		delete fresh.fleet.agentProfiles[parsed];
	});
	printOk(`unbound agent ${parsed}`);
	return 0;
}

function runProfileBindings(args: ReadonlyArray<string>): number {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write("usage: clio-coder targets profile bindings [--json]\n");
			return 0;
		}
		printError(`unknown targets profile bindings argument: ${arg}`);
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const rows = Object.entries(settings.fleet.agentProfiles)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([agentId, profileName]) => {
			const profile = settings.fleet.profiles[profileName];
			return {
				agentId,
				profile: profileName,
				target: profile?.target ?? null,
				model: profile?.model ?? null,
				warning: profile ? null : "missing profile",
			};
		});
	if (json) {
		process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		return 0;
	}
	if (rows.length === 0) {
		process.stdout.write(
			"no agent profile bindings configured. run `clio-coder targets profile bind <agentId> <profile>` to add one.\n",
		);
		return 0;
	}
	process.stdout.write(
		`${column("agent", 18)}${column("profile", 20)}${column("target", 16)}${column("model", 30)}warning\n`,
	);
	for (const row of rows) {
		process.stdout.write(
			`${column(row.agentId, 18)}${column(row.profile, 20)}${column(row.target ?? "-", 16)}${column(row.model ?? "-", 30)}${row.warning ?? "-"}\n`,
		);
	}
	return 0;
}

function runProfile(args: ReadonlyArray<string>): number {
	const subcommand = args[0];
	// Ambiguity: a profile literally named like a subcommand must use
	// `clio-coder targets profile set <name> ...`.
	if (subcommand && PROFILE_SUBCOMMANDS.has(subcommand)) {
		switch (subcommand) {
			case "list":
				return runFleet(args.slice(1), "clio-coder targets profile list [--json]");
			case "set":
				return runProfileSet(
					args.slice(1),
					"clio-coder targets profile set <name> <id> [--model <id>] [--thinking <level>]",
				);
			case "remove":
				return runProfileRemove(args.slice(1));
			case "rename":
				return runProfileRename(args.slice(1));
			case "bind":
				return runProfileBind(args.slice(1));
			case "unbind":
				return runProfileUnbind(args.slice(1));
			case "bindings":
				return runProfileBindings(args.slice(1));
		}
	}
	return runProfileSet(args);
}

function runFleet(args: ReadonlyArray<string>, usage = "clio-coder targets fleet [--json]"): number {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(`usage: ${usage}\n`);
			return 0;
		}
		printError(`unknown targets fleet argument: ${arg}`);
		return 2;
	}
	ensureClioState();
	const settings = readSettings();
	const byId = new Map(settings.targets.map((target) => [target.id, target] as const));
	const rows = Object.entries(settings.fleet.profiles).map(([name, profile]) => {
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
		process.stdout.write("no fleet profiles configured. run `clio-coder targets profile <name> <id>` to add one.\n");
		return 0;
	}
	process.stdout.write(
		`${column("profile", 18)}${column("target", 16)}${column("runtime", 20)}${column("model", 30)}thinking\n`,
	);
	for (const row of rows) {
		process.stdout.write(
			`${column(row.name, 18)}${column(row.target ?? "-", 16)}${column(row.runtime ?? "-", 20)}${column(row.model ?? "-", 30)}${row.thinkingLevel}\n`,
		);
	}
	return 0;
}

function runRemove(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage("clio-coder targets remove <id>");
	if (args.length !== 1 || !args[0]) {
		printError("usage: clio-coder targets remove <id>");
		return 2;
	}
	ensureClioState();
	return runTargetRemove(args[0]);
}

function runRename(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage("clio-coder targets rename <old> <new>");
	if (args.length !== 2 || !args[0] || !args[1]) {
		printError("usage: clio-coder targets rename <old> <new>");
		return 2;
	}
	ensureClioState();
	return runTargetRename(args[0], args[1]);
}

const CONVERT_USAGE = "clio-coder targets convert <id> --runtime <runtimeId>";

function runConvert(args: ReadonlyArray<string>): number {
	if (wantsHelp(args)) return printUsage(CONVERT_USAGE);
	const id = args[0];
	if (!id || id.startsWith("-")) {
		printError(`usage: ${CONVERT_USAGE}`);
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
		printError(`unknown runtime id: ${runtimeId} (run \`clio-coder configure --list\` to see registered runtimes)`);
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
	if (settings.chat.target === id && !isOrchestratorEligibleRuntime(runtime)) {
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

/** One row's cells as plain text, before any width has been applied. */
export interface TargetTableRow {
	id: string;
	tier: string;
	runtime: string;
	auth: string;
	url: string;
	model: string;
	health: string;
	caps: string;
	notes: string;
	/** Full degraded-health reason, kept separately so a narrow table can repeat it below the row. */
	diagnostic?: string;
}

type TargetTableColumn = Exclude<keyof TargetTableRow, "diagnostic">;
type TargetTableWidths = Record<TargetTableColumn, number>;

const TABLE_COLUMNS: ReadonlyArray<TargetTableColumn> = [
	"id",
	"tier",
	"runtime",
	"auth",
	"url",
	"model",
	"health",
	"caps",
	"notes",
];
const TABLE_GAP = 1;

/**
 * The order the columns give room back in, each down to the floor beside it.
 *
 * `id` and `caps` are absent on purpose. A cut id is not an id: it cannot be
 * passed back to `clio-coder targets use`, so shortening it turns the column into
 * something that reads like an identifier and is not one. The badges are one
 * letter per capability and mean nothing partially printed.
 *
 * `notes` appears twice. It is free-form and the widest column, so it gives up
 * everything above a readable remainder before url and model are touched at
 * all, and gives up the rest only once both of those are at their floors.
 */
const TABLE_SHRINK_ORDER: ReadonlyArray<readonly [TargetTableColumn, number]> = [
	["notes", 16],
	["url", 12],
	["model", 12],
	["notes", 0],
	["auth", 6],
	["runtime", 6],
	["tier", 4],
];

/**
 * The order width above the minimum layout is handed back in, each up to what
 * its own content needs.
 *
 * Shrinking in {@link TABLE_SHRINK_ORDER} until the row fits stops at the first
 * width that happens to work, and where it stopped was wrong. At 120 columns it
 * had taken url and model down to their floors and had not yet asked auth,
 * runtime, or tier for anything, so four targets on different hosts all printed
 * `http://127.…` while the auth column spent 20 columns on one env var name. A
 * url that cannot be told from the next url is not a url.
 *
 * So the layout is built the other way around: every column drops to its floor,
 * and whatever the terminal has above that minimum is given back here. url and
 * model lead because they are the two columns whose whole job is to be told
 * apart. `notes` appears twice for the same reason it does above: it takes a
 * readable remainder before the categorical columns are restored, and the rest
 * only once they are whole.
 */
const TABLE_GROW_ORDER: ReadonlyArray<readonly [TargetTableColumn, number]> = [
	["url", Number.POSITIVE_INFINITY],
	["model", Number.POSITIVE_INFINITY],
	["notes", 16],
	["auth", Number.POSITIVE_INFINITY],
	["runtime", Number.POSITIVE_INFINITY],
	["tier", Number.POSITIVE_INFINITY],
	["notes", Number.POSITIVE_INFINITY],
];

function tableWidths(rows: ReadonlyArray<TargetTableRow>, width: number): TargetTableWidths {
	const natural = {} as TargetTableWidths;
	for (const [index, key] of TABLE_COLUMNS.entries()) {
		natural[key] = rows.reduce((widest, row) => Math.max(widest, row[key].length), (HEADER[index] ?? key).length);
	}
	// The minimum layout: every shrinkable column at the lowest floor it is
	// given, which for `notes` is the second of its two entries.
	const widths = { ...natural };
	for (const [key, floor] of TABLE_SHRINK_ORDER) widths[key] = Math.min(widths[key], floor);
	const total = (): number =>
		TABLE_COLUMNS.reduce((sum, key) => sum + widths[key], 0) + TABLE_GAP * (TABLE_COLUMNS.length - 1);
	// A terminal too narrow for even the minimum keeps it and takes the row cut
	// that formatTargetTable applies; there is nothing left to give back.
	let surplus = width - total();
	for (const [key, ceiling] of TABLE_GROW_ORDER) {
		if (surplus <= 0) break;
		const take = Math.min(surplus, Math.max(0, Math.min(natural[key], ceiling) - widths[key]));
		widths[key] += take;
		surplus -= take;
	}
	return widths;
}

/**
 * The probe table sized to the terminal it is being written to.
 *
 * Every column was a fixed width summing to 164, so the table wrote 141 to 195
 * column rows into whatever terminal it was given and the shell wrapped them
 * into fragments. Worse, the fixed widths cut each cell with a bare `slice`, so
 * a 20-character target id printed as 13 characters and a space: a string that
 * reads like an id, is not one, and cannot be pasted back into any command that
 * takes one.
 *
 * `--json` is the interface for the full values and is left untouched. Only the
 * human table is sized, ids are never cut, and every cell that is cut ends in an
 * ellipsis so a shortened url or model can never be mistaken for a whole one.
 *
 * A terminal too narrow to hold the id beside every floor takes the whole row
 * cut to its width, marked the same way. Colour is dropped on those rows because
 * the ansi bytes would sit inside the cut; a wrapped row costs more than colour.
 */
function formatTargetTable(
	rows: ReadonlyArray<TargetTableRow>,
	width: number,
	paintHealth: (cell: string, row: TargetTableRow) => string = (cell) => cell,
): { header: string; rows: ReadonlyArray<string>; details: ReadonlyArray<ReadonlyArray<string>> } {
	const widths = tableWidths(rows, width);
	const line = (cells: ReadonlyArray<string>): string => cells.join(" ".repeat(TABLE_GAP)).trimEnd();
	const formatted = rows.map((row) => {
		const cells = TABLE_COLUMNS.map((key) => column(row[key], widths[key]));
		const plain = line(cells);
		const rendered =
			plain.length > width
				? truncate(plain, width)
				: line(cells.map((cell, index) => (TABLE_COLUMNS[index] === "health" ? paintHealth(cell, row) : cell)));
		const diagnosticFits = !row.diagnostic || (plain.length <= width && widths.notes >= row.diagnostic.length);
		const details = diagnosticFits ? [] : targetDiagnosticDetails(row.diagnostic ?? "", width);
		return { rendered, details };
	});
	return {
		header: truncate(line(TABLE_COLUMNS.map((key, index) => column(HEADER[index] ?? key, widths[key]))), width),
		rows: formatted.map(({ rendered }) => rendered),
		details: formatted.map(({ details }) => details),
	};
}

/** Indented diagnostic text that retains every word when the table row cannot. */
function targetDiagnosticDetails(diagnostic: string, width: number): string[] {
	const indent = 2;
	return wrapPlain(`reason: ${diagnostic}`, Math.max(8, width - indent), indent).map((line, index) =>
		index === 0 ? `${" ".repeat(indent)}${line}` : line,
	);
}

function renderTable(providers: ProvidersContract, entries: ReadonlyArray<TargetStatus>): void {
	const sorted = [...entries].sort(compareStatusByTier);
	const table = formatTargetTable(
		sorted.map((status) => targetTableRow(providers, status)),
		terminalColumns(),
		// The cell is padded before it is painted, so the ansi bytes land outside
		// the width arithmetic instead of having to be guessed at with slack.
		(cell, row) => healthColor(row.health)(cell),
	);
	let currentTier: ProviderOutputTier | null = null;
	for (const [index, status] of sorted.entries()) {
		const tier = statusTier(status);
		if (tier !== currentTier) {
			currentTier = tier;
			process.stdout.write(`${chalk.bold(tierLabel(tier))}\n`);
			process.stdout.write(`${chalk.bold(table.header)}\n`);
		}
		process.stdout.write(`${table.rows[index] ?? ""}\n`);
		for (const detail of table.details[index] ?? []) process.stdout.write(`${detail}\n`);
	}
}

function targetTableRow(providers: ProvidersContract, status: TargetStatus): TargetTableRow {
	const diagnostic = degradedHealthDiagnostic(status);
	return {
		id: status.target.id,
		tier: statusTier(status),
		runtime: status.runtime ? status.runtime.id : status.target.runtime,
		auth: formatAuth(providers, status),
		url: formatUrl(status),
		model: status.target.defaultModel ?? "-",
		health: status.health.status,
		caps: capabilityBadges(status.capabilities),
		notes: formatNotes(status),
		...(diagnostic ? { diagnostic } : {}),
	};
}

function healthColor(status: string): (text: string) => string {
	switch (status) {
		case "healthy":
			return chalk.green;
		case "degraded":
			return chalk.yellow;
		case "down":
			return chalk.red;
		default:
			return chalk.dim;
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

/**
 * One-word residency summary for the probe notes column, from the per-model
 * load states local runtimes already report. Null when the runtime exposed
 * no states (cloud targets); "resident: none" when states are known and
 * nothing is loaded, so a cold box is distinguishable from an unknown one.
 */
function residentModelsSummary(states: TargetStatus["discoveredModelStates"]): string | null {
	if (!states) return null;
	const entries = Object.entries(states);
	if (entries.length === 0) return null;
	const resident = entries
		.filter(([, status]) => status.state === "loaded" || status.state === "loading")
		.map(([id, status]) => (status.state === "loading" ? `${id} (loading)` : id));
	return resident.length > 0 ? `resident: ${resident.join(", ")}` : "resident: none";
}

/**
 * A window nothing declared is the runtime descriptor's placeholder, not a
 * capability the target reported. Saying so is the difference between a number
 * a user can plan against and one they cannot.
 */
function formatContextWindow(
	status: Pick<TargetStatus, "capabilities" | "contextWindowProvenance"> &
		Partial<Pick<TargetStatus, "target" | "discoveredModelStates">>,
): string {
	const window = status.capabilities.contextWindow;
	if (status.contextWindowProvenance === "runtime-default") return `ctx ${window} (unverified runtime default)`;
	// A llama.cpp window that is one slot's share of `--ctx-size` names the
	// split, so `ctx 196608` is not mistaken for the whole server (issue #187).
	const slots = status.target?.defaultModel
		? status.discoveredModelStates?.[status.target.defaultModel]?.contextSlots
		: undefined;
	return slots && Math.floor(slots.totalContextSize / slots.slots) === window
		? `ctx ${window} (${slots.totalContextSize} / ${slots.slots} slots)`
		: `ctx ${window}`;
}

function formatNotes(status: TargetStatus): string {
	const parts: string[] = [];
	const diagnostic = degradedHealthDiagnostic(status);
	// The health diagnosis leads because gateway, context, and residency facts
	// are supplementary once the target says it cannot serve its default model.
	if (diagnostic) parts.push(diagnostic);
	const endpoint = endpointCapacityForStatus(status);
	if (endpoint) parts.push(`slots ${endpoint.limit}`);
	if (status.target.gateway) parts.push("gateway");
	if (status.runtime?.auth === "oauth") parts.push("oauth");
	if (status.runtime?.auth === "claude-cli") parts.push("claude-cli");
	if (status.capabilities.contextWindow > 0) parts.push(formatContextWindow(status));
	if (!status.available && status.reason) parts.push(status.reason);
	const residency = residentModelsSummary(status.discoveredModelStates);
	if (residency) parts.push(residency);
	if (status.probeNotes && status.probeNotes.length > 0) parts.push(`note: ${status.probeNotes.join("; ")}`);
	return parts.join(" ");
}

function degradedHealthDiagnostic(status: TargetStatus): string | null {
	return status.health.status === "degraded" && status.health.lastError ? status.health.lastError : null;
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
	contextWindowProvenance?: TargetStatus["contextWindowProvenance"];
	probeCapabilities?: TargetStatus["probeCapabilities"];
	probeModelId?: TargetStatus["probeModelId"];
	probeNotes?: TargetStatus["probeNotes"];
	probeSurfaces?: TargetStatus["probeSurfaces"];
	discoveredModels: TargetStatus["discoveredModels"];
	discoveredModelsSource?: TargetStatus["discoveredModelsSource"];
	discoveredModelStates?: TargetStatus["discoveredModelStates"];
	tier: ProviderOutputTier;
	detectedReasoning: boolean | null;
	reasoningCandidateModelId: string | null;
	endpointCapacity?: ReturnType<typeof endpointCapacityForStatus>;
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
	const endpointCapacity = endpointCapacityForStatus(status);
	if (endpointCapacity !== null) out.endpointCapacity = endpointCapacity;
	if (status.contextWindowProvenance !== undefined) {
		out.contextWindowProvenance = status.contextWindowProvenance;
	}
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
	if (status.probeSurfaces !== undefined) {
		out.probeSurfaces = status.probeSurfaces;
	}
	return out;
}
