import { batchDispatchTool } from "../src/tools/batch-dispatch.js";
import { chainDispatchTool } from "../src/tools/chain-dispatch.js";
import { dispatchAgentTool } from "../src/tools/dispatch-agent.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-tools-dispatch] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-tools-dispatch] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
	const daOk = await dispatchAgentTool.run({ agent: "scout", task: "hello" });
	check(
		"dispatch_agent:stub-ok",
		daOk.kind === "ok" && daOk.output.includes("dispatch_agent stub") && daOk.output.includes("scout"),
		`got ${JSON.stringify(daOk)}`,
	);

	const daMissing = await dispatchAgentTool.run({});
	check(
		"dispatch_agent:missing-args",
		daMissing.kind === "error" && /missing (agent|task)/.test(daMissing.message),
		`got ${JSON.stringify(daMissing)}`,
	);

	const bdOk = await batchDispatchTool.run({
		dispatches: [
			{ agent: "scout", task: "a" },
			{ agent: "worker", task: "b" },
		],
	});
	check(
		"batch_dispatch:stub-ok",
		bdOk.kind === "ok" &&
			bdOk.output.includes("batch_dispatch stub") &&
			bdOk.output.includes("scout") &&
			bdOk.output.includes("worker"),
		`got ${JSON.stringify(bdOk)}`,
	);

	const cdOk = await chainDispatchTool.run({ fleet: "scout -> worker" });
	check(
		"chain_dispatch:stub-ok-2-steps",
		cdOk.kind === "ok" && cdOk.output.includes("chain_dispatch stub") && cdOk.output.includes("2 steps"),
		`got ${JSON.stringify(cdOk)}`,
	);

	const cdBad = await chainDispatchTool.run({ fleet: "invalid -> " });
	check(
		"chain_dispatch:bad-fleet-error",
		cdBad.kind === "error" && cdBad.message.startsWith("chain_dispatch:"),
		`got ${JSON.stringify(cdBad)}`,
	);

	if (failures.length > 0) {
		process.stderr.write(`[diag-tools-dispatch] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-tools-dispatch] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-tools-dispatch] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
