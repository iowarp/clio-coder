import { registerAllTools } from "../src/tools/bootstrap.js";
import { createToolIndex } from "../src/tools/registry.js";

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
	const index = createToolIndex();
	registerAllTools(index);
	check(
		"dispatch_agent:not-registered",
		index.listAll().every((tool) => tool.name !== "dispatch_agent"),
		JSON.stringify(index.listAll().map((tool) => tool.name)),
	);
	check(
		"batch_dispatch:not-registered",
		index.listAll().every((tool) => tool.name !== "batch_dispatch"),
		JSON.stringify(index.listAll().map((tool) => tool.name)),
	);
	check(
		"chain_dispatch:not-registered",
		index.listAll().every((tool) => tool.name !== "chain_dispatch"),
		JSON.stringify(index.listAll().map((tool) => tool.name)),
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
