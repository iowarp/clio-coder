import { readSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import { PromptsDomainModule } from "../domains/prompts/index.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SessionDomainModule } from "../domains/session/index.js";

const USAGE =
	'usage: clio run [--worker-profile <name>] [--worker-runtime <runtimeId>] [--target <id>] [--model <wireId>] [--thinking <level>] [--agent <recipe-id>] [--require <capability>] "<task>"\n';

const VALID_THINKING: ReadonlyArray<JobThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface ParsedArgs {
	workerProfile?: string;
	workerRuntime?: string;
	target?: string;
	model?: string;
	thinking?: JobThinkingLevel;
	agentId?: string;
	required: string[];
	task: string;
	json: boolean;
}

function parseArgs(args: ReadonlyArray<string>): ParsedArgs | null {
	const out: ParsedArgs = { required: [], task: "", json: false };
	const taskParts: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const need = (): string | null => {
			const v = args[i + 1];
			if (v === undefined) return null;
			i += 1;
			return v;
		};
		if (a === "--help" || a === "-h") {
			return null;
		}
		if (a === "--worker-profile" || a === "--worker") {
			const v = need();
			if (v === null) return null;
			out.workerProfile = v;
		} else if (a === "--worker-runtime" || a === "--runtime") {
			const v = need();
			if (v === null) return null;
			out.workerRuntime = v;
		} else if (a === "--target") {
			const v = need();
			if (v === null) return null;
			out.target = v;
		} else if (a === "--model") {
			const v = need();
			if (v === null) return null;
			out.model = v;
		} else if (a === "--thinking") {
			const v = need();
			if (v === null) return null;
			if (!VALID_THINKING.includes(v as JobThinkingLevel)) return null;
			out.thinking = v as JobThinkingLevel;
		} else if (a === "--agent") {
			const v = need();
			if (v === null) return null;
			out.agentId = v;
		} else if (a === "--require") {
			const v = need();
			if (v === null) return null;
			out.required.push(v);
		} else if (a === "--json") {
			out.json = true;
		} else if (a?.startsWith("-")) {
			return null;
		} else if (typeof a === "string") {
			taskParts.push(a);
		}
	}
	out.task = taskParts.join(" ").trim();
	return out;
}

export async function runClioRun(args: ReadonlyArray<string>, options: { apiKey?: string } = {}): Promise<number> {
	const parsed = parseArgs(args);
	if (parsed === null) {
		process.stderr.write(USAGE);
		return 2;
	}
	if (parsed.task.length === 0) {
		process.stderr.write("clio run: empty task\n");
		process.stderr.write(USAGE);
		return 2;
	}

	if (parsed.target && parsed.workerProfile) {
		process.stderr.write(
			`clio run: --target ${parsed.target} takes precedence; --worker-profile ${parsed.workerProfile} will be ignored\n`,
		);
	}
	if (parsed.target && parsed.workerRuntime) {
		process.stderr.write(
			`clio run: --target ${parsed.target} takes precedence; --worker-runtime ${parsed.workerRuntime} will be ignored\n`,
		);
	}

	ensureClioState();
	const loaded = await loadDomains([
		ConfigDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		ModesDomainModule,
		PromptsDomainModule,
		AgentsDomainModule,
		DispatchDomainModule,
		SessionDomainModule,
		LifecycleDomainModule,
	]);
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	if (!dispatch) {
		process.stderr.write("dispatch domain unavailable\n");
		await loaded.stop();
		return 1;
	}

	if (options.apiKey) {
		const providers = loaded.getContract<ProvidersContract>("providers");
		if (!providers) {
			process.stderr.write("clio run: --api-key supplied but providers domain unavailable\n");
			await loaded.stop();
			return 1;
		}
		const settings = readSettings();
		const profileEndpointId = parsed.workerProfile
			? settings.workers?.profiles?.[parsed.workerProfile]?.endpoint
			: undefined;
		const runtimeByEndpoint = new Map(settings.endpoints.map((endpoint) => [endpoint.id, endpoint.runtime] as const));
		const runtimeEndpointId = parsed.workerRuntime
			? [settings.workers?.default, ...Object.values(settings.workers?.profiles ?? {})].find(
					(profile) => profile?.endpoint && runtimeByEndpoint.get(profile.endpoint) === parsed.workerRuntime,
				)?.endpoint
			: undefined;
		const targetEndpointId =
			parsed.target ??
			profileEndpointId ??
			runtimeEndpointId ??
			settings.workers?.default?.endpoint ??
			settings.orchestrator?.endpoint;
		const endpoint = targetEndpointId ? providers.getEndpoint(targetEndpointId) : null;
		const runtime = endpoint ? providers.getRuntime(endpoint.runtime) : null;
		if (!endpoint || !runtime) {
			process.stderr.write("clio run: --api-key supplied but no target resolved; pass --target <id>\n");
			await loaded.stop();
			return 2;
		}
		providers.auth.setRuntimeOverrideForTarget(endpoint, runtime, options.apiKey);
	}

	const dispatchReq: DispatchRequest = {
		agentId: parsed.agentId ?? "scout",
		task: parsed.task,
	};
	if (parsed.workerProfile) dispatchReq.workerProfile = parsed.workerProfile;
	if (parsed.workerRuntime) dispatchReq.workerRuntime = parsed.workerRuntime;
	if (parsed.target) dispatchReq.endpoint = parsed.target;
	if (parsed.model) dispatchReq.model = parsed.model;
	if (parsed.thinking) dispatchReq.thinkingLevel = parsed.thinking;
	if (parsed.required.length > 0) dispatchReq.requiredCapabilities = parsed.required;

	try {
		const handle = await dispatch.dispatch(dispatchReq);
		const onSignal = (): void => dispatch.abort(handle.runId);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);

		for await (const event of handle.events) {
			if (parsed.json) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
				continue;
			}
			const e = event as { type?: string };
			if (e.type && e.type !== "heartbeat") process.stderr.write(`${e.type}\n`);
		}

		const receipt = await handle.finalPromise;
		process.stdout.write(`\n${parsed.json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt)}\n`);

		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);

		await dispatch.drain();
		await loaded.stop();
		return mapExitCode(receipt);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`clio run failed: ${msg}\n`);
		await loaded.stop();
		if (/target '.+' not found/.test(msg)) return 2;
		if (msg.includes("admission") || msg.includes("capability") || msg.includes("budget")) return 2;
		return 1;
	}
}

function formatReceipt(r: RunReceipt): string {
	return `receipt: ${r.runId} agent=${r.agentId} exit=${r.exitCode} target=${r.endpointId} model=${r.wireModelId} start=${r.startedAt} end=${r.endedAt}`;
}

function mapExitCode(r: RunReceipt): number {
	if (r.exitCode === 0) return 0;
	return r.exitCode === 2 ? 2 : 1;
}
