import { loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import { LifecycleDomainModule, ensureInstalled } from "../domains/lifecycle/index.js";
import { ModesDomainModule } from "../domains/modes/index.js";
import { PromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { SessionDomainModule } from "../domains/session/index.js";

export async function runClioRun(args: ReadonlyArray<string>): Promise<number> {
	if (args.length < 2) {
		process.stderr.write("usage: clio run <agent> <task> [--provider <id>] [--model <id>] [--faux] [--json]\n");
		return 2;
	}

	const [agentId, ...rest] = args;
	const taskParts: string[] = [];
	let providerId: string | undefined;
	let modelId: string | undefined;
	let faux = false;
	let json = false;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--provider") providerId = rest[++i];
		else if (a === "--model") modelId = rest[++i];
		else if (a === "--faux") faux = true;
		else if (a === "--json") json = true;
		else if (typeof a === "string") taskParts.push(a);
	}
	const task = taskParts.join(" ").trim();
	if (!task) {
		process.stderr.write("clio run: empty task\n");
		return 2;
	}

	if (faux) {
		process.env.CLIO_WORKER_FAUX = "1";
		providerId ??= "faux";
		modelId ??= "faux-model";
	}

	ensureInstalled();
	const result = await loadDomains([
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
	const dispatch = result.getContract<DispatchContract>("dispatch");
	if (!dispatch) {
		process.stderr.write("dispatch domain unavailable\n");
		await result.stop();
		return 1;
	}

	try {
		const handle = await dispatch.dispatch({
			agentId: agentId as string,
			task,
			providerId: providerId ?? "faux",
			modelId: modelId ?? "faux-model",
			runtime: "native",
		});

		const onSignal = (): void => dispatch.abort(handle.runId);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);

		for await (const event of handle.events) {
			if (json) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			} else {
				const e = event as { type?: string };
				if (e.type && e.type !== "heartbeat") {
					process.stdout.write(`${e.type}\n`);
				}
			}
		}

		const receipt = await handle.finalPromise;
		process.stdout.write(`\n${json ? JSON.stringify(receipt, null, 2) : formatReceipt(receipt)}\n`);

		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);

		await dispatch.drain();
		await result.stop();
		return receipt.exitCode;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`clio run failed: ${msg}\n`);
		await result.stop();
		return 1;
	}
}

interface ReceiptSummary {
	runId: string;
	agentId: string;
	exitCode: number;
	providerId: string;
	modelId: string;
	startedAt: string;
	endedAt: string;
}

function formatReceipt(r: ReceiptSummary): string {
	return `receipt: ${r.runId} agent=${r.agentId} exit=${r.exitCode} provider=${r.providerId}/${r.modelId} start=${r.startedAt} end=${r.endedAt}`;
}
