import { registerAllTools } from "../src/tools/bootstrap.js";
import { createToolIndex } from "../src/tools/registry.js";
import { webFetchTool } from "../src/tools/web-fetch.js";

/**
 * Phase 5 slice 3 diag harness. Exercises web-fetch argument validation and
 * confirms that web_search is absent from the shipped tool registry. CI must
 * never hit the network from this script.
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-tools-web] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-tools-web] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
	const badUrl = await webFetchTool.run({ url: "not-a-url" });
	check(
		"web_fetch:bad-scheme-error",
		badUrl.kind === "error" && /invalid url|unsupported scheme/.test(badUrl.message),
		`got ${JSON.stringify(badUrl)}`,
	);

	const missingUrl = await webFetchTool.run({});
	check(
		"web_fetch:missing-url-error",
		missingUrl.kind === "error" && missingUrl.message.includes("missing url"),
		`got ${JSON.stringify(missingUrl)}`,
	);

	const index = createToolIndex();
	registerAllTools(index);
	check(
		"web_search:not-registered",
		index.listAll().every((tool) => tool.name !== "web_search"),
		JSON.stringify(index.listAll().map((tool) => tool.name)),
	);

	if (failures.length > 0) {
		process.stderr.write(`[diag-tools-web] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-tools-web] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-tools-web] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
