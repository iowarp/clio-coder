import { loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import { LifecycleDomainModule, ensureInstalled } from "../domains/lifecycle/index.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import { PromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SessionDomainModule } from "../domains/session/index.js";

const USAGE =
	"usage: clio run [--endpoint <id>] [--model <wireId>] [--thinking <level>] [--agent <recipe-id>] [--require <capability>] \"<task>\"\n";

const VALID_THINKING: ReadonlyArray<JobThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];

interface ParsedArgs {
	endpoint?: string;
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
		if (a === "--endpoint") {
			const v = need();
			if (v === null) return null;
			out.endpoint = v;
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
		} else if (typeof a === "string") {
			taskParts.push(a);
		}
	}
	out.task = taskParts.join(" ").trim();
	return out;
}

export async function runClioRun(args: ReadonlyArray<string>): Promise<number> {
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

	ensureInstalled();
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

	const dispatchReq: DispatchRequest = {
		agentId: parsed.agentId ?? "scout",
		task: parsed.task,
	};
	if (parsed.endpoint) dispatchReq.endpoint = parsed.endpoint;
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
		if (msg.includes("admission") || msg.includes("capability") || msg.includes("budget")) return 2;
		return 1;
	}
}

function formatReceipt(r: RunReceipt): string {
	return `receipt: ${r.runId} agent=${r.agentId} exit=${r.exitCode} endpoint=${r.endpointId} model=${r.wireModelId} start=${r.startedAt} end=${r.endedAt}`;
}

function mapExitCode(r: RunReceipt): number {
	if (r.exitCode === 0) return 0;
	return r.exitCode === 2 ? 2 : 1;
}
