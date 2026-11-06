import type { ClioSettings } from "../core/config.js";
import { readLayeredSettings, settingsSourceFor } from "../core/settings-layers.js";
import type { OneShotPort } from "../domains/providers/one-shot.js";
import { printError } from "./shared.js";

export const SYSTEM_ONE_HELP = `clio-coder systemone status
clio-coder systemone use <route>[,<route>...] [--scope user|project]
clio-coder systemone off [--scope user|project]
clio-coder systemone check <engine> --live

System One is experimental and off until you name a route or an ordered list of
them: jev, memory, main, a declared engine or a target. From the next start a named
route answers the consult tool. A route that declares real probabilities also reads
web and MCP results when the safety judge reviews a call, and a route answers steering
triage when chat.steering.triage is on. On a hosted route, what these send leaves the
machine: file digests and heads, web and MCP result text and queued messages. Keys may
change between releases.

status   whether System One is on, and why not when it cannot run
use      name the routes; the default scope is user, and a project write goes to
         .clio-coder/settings.local.yaml. run --systemone sets one run
off      turn System One off
check    send one content-free decision to an engine and report the build that answered

Flags:
  --scope <scope>     user or project
  --live              required by check, because it sends a request
`;

interface ParsedArgs {
	command?: string;
	name?: string;
	scope?: "user" | "project";
	live?: boolean;
	help: boolean;
}

function flagValue(argv: ReadonlyArray<string>, index: number, flag: string, what: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires ${what}`);
	return value;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (out.command === undefined && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		if ((out.command === "use" || out.command === "check") && out.name === undefined && !arg.startsWith("-")) {
			out.name = arg;
			continue;
		}
		switch (arg) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--live":
				out.live = true;
				break;
			case "--scope": {
				const scope = flagValue(argv, i, arg, "user or project");
				if (scope === "task" || scope === "session")
					throw new Error(`${scope} scope is gone: run --systemone sets one run`);
				if (scope !== "user" && scope !== "project") throw new Error(`--scope expects user or project, got ${scope}`);
				out.scope = scope;
				i += 1;
				break;
			}
			default:
				throw new Error(arg.startsWith("-") ? `unknown flag: ${arg}` : `unexpected argument: ${arg}`);
		}
	}
	return out;
}

async function runStatus(): Promise<number> {
	const layered = readLayeredSettings(process.cwd());
	const { settings } = layered;
	const { describeStatus, formatStatus } = await import("../domains/system-one/status.js");
	const { credentialAvailable } = await import("../domains/providers/credentials.js");
	const lines = formatStatus(
		describeStatus({
			settings,
			settingsOrigin: settingsSourceFor(layered.sources, "systemOne.use"),
			hasCredential: credentialAvailable,
		}),
	);
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

async function runUse(text: string, scope: "user" | "project"): Promise<number> {
	const { writeSystemOneUse } = await import("../entry/system-one-settings.js");
	const { parseRouteList } = await import("../domains/system-one/selection.js");
	const use = parseRouteList(text);
	writeSystemOneUse(process.cwd(), scope, use);
	process.stdout.write(`System One ${Array.isArray(use) ? use.join(", then ") : use} at ${scope} scope\n`);
	return runStatus();
}

/** The deps a process with no running session builds a System One from: settings in hand, no registered runtimes. */
async function offlineSystemOneDeps(live: Readonly<ClioSettings>) {
	const { BUILTIN_RUNTIMES } = await import("../domains/providers/runtimes/builtins.js");
	const { openAuthStorage, resolveAuthTarget } = await import("../domains/providers/auth/index.js");
	const { credentialAvailable } = await import("../domains/providers/credentials.js");
	const { resolveSideCallAuth } = await import("../domains/providers/side-call-auth.js");
	const { oneShotTokens } = await import("../domains/providers/one-shot.js");
	const { runOutOfTurnRound } = await import("../session-control/side-question.js");
	const auth = openAuthStorage();
	const getTarget = (id: string) => live.targets.find((entry) => entry.id === id) ?? null;
	const getRuntime = (id: string) => BUILTIN_RUNTIMES.find((runtime) => runtime.id === id) ?? null;
	const authPort = {
		resolveForTarget: (
			target: Parameters<typeof resolveAuthTarget>[0],
			runtime: Parameters<typeof resolveAuthTarget>[1],
			options?: { signal?: AbortSignal },
		) => auth.resolveForTarget(resolveAuthTarget(target, runtime), options ?? {}),
	};
	// A subscription target has no chat wire, so a check reaches it the way a session's engine does.
	const oneShot: OneShotPort = async (request) => {
		const target = getTarget(request.targetId);
		const runtime = target === null ? null : getRuntime(target.runtime);
		const wireModelId = request.model ?? target?.defaultModel ?? null;
		if (target === null || runtime === null || wireModelId === null) {
			throw new Error(`target '${request.targetId}' names no model to ask`);
		}
		const result = await runOutOfTurnRound({
			model: runtime.synthesizeModel(target, wireModelId, null),
			messages: [],
			systemPrompt: request.system,
			userText: request.user,
			maxTokens: request.maxTokens,
			thinkingLevel: "off",
			signal: request.signal,
			runtimeId: runtime.id,
			...(await resolveSideCallAuth(authPort as never, target, runtime, "clio-coder-local-target", request.signal)),
		});
		if (result.aborted) throw new Error("the one-shot round was aborted");
		return {
			text: result.text,
			...(result.usage !== null ? { usage: oneShotTokens(result.usage) } : {}),
			...(result.reportedModel !== undefined ? { model: result.reportedModel } : {}),
		};
	};
	return {
		settings: () => live,
		providers: { getTarget, getRuntime, auth: authPort } as never,
		oneShot,
		// This process registers no runtime, so the set holds exactly the keys this runtime declares.
		credentialsPresent: () =>
			new Set(
				BUILTIN_RUNTIMES.flatMap((runtime) =>
					runtime.credentialsEnvVar !== undefined && credentialAvailable(runtime.id, runtime.credentialsEnvVar)
						? [runtime.credentialsEnvVar]
						: [],
				),
			),
	};
}

/** One content-free decision. A passive check proves an endpoint answers, never which build would answer. */
async function runCheck(name: string): Promise<number> {
	const settings = readLayeredSettings(process.cwd()).settings;
	const { resolveChoice } = await import("../domains/system-one/selection.js");
	const resolved = resolveChoice(settings, name);
	if (resolved.kind !== "engine") {
		printError(resolved.kind === "unavailable" ? resolved.problem : `'${name}' is not an engine`);
		return 1;
	}
	const live = { ...settings, systemOne: { ...settings.systemOne, use: name } };
	const { createSystemOne, pointQuestion, yesNo } = await import("../domains/system-one/index.js");
	const { consultPoint } = await import("../domains/system-one/points/index.js");
	const systemOne = createSystemOne(await offlineSystemOneDeps(live));
	let failure = "the engine gave no answer";
	const verdict = await systemOne.ask(
		// The state settles the question, because an engine told to read only the state abstains otherwise.
		consultPoint({ check: pointQuestion(yesNo("Is left greater than right?", "It is greater", "It is not greater")) }),
		{ state: { left: 2, right: 1 }, files: {} },
		{ onFailure: (reason) => (failure = reason) },
	);
	const requested = resolved.engine.model ?? "target default";
	if (verdict === null) {
		printError(`${name} (${requested}): ${failure}; nothing is verified`);
		return 1;
	}
	process.stdout.write(`${name}: requested ${requested}, answered as ${verdict.build} in ${verdict.latencyMs} ms\n`);
	return 0;
}

export async function runSystemOneCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(SYSTEM_ONE_HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(SYSTEM_ONE_HELP);
		return 0;
	}
	const known = ["status", "use", "off", "check"];
	if (parsed.command === undefined || !known.includes(parsed.command)) {
		if (parsed.command !== undefined) printError(`unknown systemone command: ${parsed.command}`);
		process.stderr.write(SYSTEM_ONE_HELP);
		return 2;
	}
	if ((parsed.command === "use" || parsed.command === "check") && parsed.name === undefined) {
		printError(parsed.command === "use" ? "use requires a route" : "check requires an engine");
		process.stderr.write(SYSTEM_ONE_HELP);
		return 2;
	}
	if (parsed.command === "check" && parsed.live !== true) {
		printError("check sends a request, so it requires --live");
		return 2;
	}
	try {
		if (parsed.command === "use") return await runUse(parsed.name as string, parsed.scope ?? "user");
		if (parsed.command === "off") return await runUse("off", parsed.scope ?? "user");
		if (parsed.command === "check") return await runCheck(parsed.name as string);
		return await runStatus();
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
