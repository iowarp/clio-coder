import { webFetchTool } from "../src/tools/web-fetch.js";
import { webSearchTool } from "../src/tools/web-search.js";

/**
 * Phase 5 Slice 3 diag harness. Exercises web-fetch + web-search argument
 * validation without making any network calls. Real provider integration
 * lands later; CI must never hit the network from this script.
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

	const searchOk = await webSearchTool.run({ query: "hello" });
	check(
		"web_search:stub-ok",
		searchOk.kind === "ok" && searchOk.output.includes("web_search stub for query: hello"),
		`got ${JSON.stringify(searchOk)}`,
	);

	const searchMissing = await webSearchTool.run({});
	check(
		"web_search:missing-query-error",
		searchMissing.kind === "error" && searchMissing.message.includes("missing query"),
		`got ${JSON.stringify(searchMissing)}`,
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
