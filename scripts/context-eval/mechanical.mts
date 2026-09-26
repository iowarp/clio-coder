import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [root, cwd, out] = process.argv.slice(2);
if (!root || !cwd || !out || !existsSync(join(cwd, ".context-benchmark-workspace")))
	throw new Error(
		"Usage: mechanical.mts IMPLEMENTATION DISPOSABLE_WORKSPACE OUT; workspace requires .context-benchmark-workspace marker",
	);
const load = async (p: string) => import(pathToFileURL(join(root, p)).href);
const { coordinateCodewikiWrite } = await load("src/domains/context/codewiki/coordinator.ts");
const { readClioState, writeClioState } = await load("src/domains/context/state.ts");
const { serializeCodewiki } = await load("src/domains/context/codewiki/artifact.ts");
const { renderPromptContext } = await load("src/domains/context/prompt-context.ts");
const { codeNavTool } = await load("src/tools/codewiki/code-nav.ts");
process.chdir(cwd);
mkdirSync(out, { recursive: true });
const results: {
	node: string;
	root: string;
	cwd: string;
	runs: Array<{ name: string; ms: number; cpu: NodeJS.CpuUsage; maxEventLoopDelayMs: number; rss: number }>;
	indexBytes?: number;
	files?: number;
	symbols?: number;
	promptBytes?: number;
	retrievalBytes?: number;
} = { node: process.version, root, cwd, runs: [] };
async function timed<T>(name: string, op: () => T | Promise<T>) {
	let last = performance.now(),
		delay = 0;
	const interval = setInterval(() => {
		const now = performance.now();
		delay = Math.max(delay, now - last - 5);
		last = now;
	}, 5);
	const cpu = process.cpuUsage(),
		start = performance.now();
	const value = await op();
	await new Promise((r) => setImmediate(r));
	clearInterval(interval);
	results.runs.push({
		name,
		ms: performance.now() - start,
		cpu: process.cpuUsage(cpu),
		maxEventLoopDelayMs: Math.max(0, delay),
		rss: process.memoryUsage().rss,
	});
	return value;
}
const commit = (
	{
		codewiki,
		fingerprint,
	}: {
		codewiki: import("../../src/domains/context/codewiki/schema.js").Codewiki;
		fingerprint: import("../../src/domains/context/fingerprint.js").Fingerprint;
	},
	w: string,
) =>
	writeClioState(
		w,
		{
			...readClioState(w),
			version: 1,
			projectType: codewiki.language,
			fingerprint,
			codewikiVersion: codewiki.version,
			lastIndexedAt: new Date().toISOString(),
		},
		codewiki,
	);
const built = await timed("generate", () =>
	coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "polyglot" }), { afterCommit: commit }),
);
const raw = serializeCodewiki(built.codewiki);
writeFileSync(join(out, "index.json"), raw);
results.indexBytes = Buffer.byteLength(raw);
results.files = built.codewiki.files.length;
results.symbols = built.codewiki.symbols.length;
const prompt = await timed("prompt-cold", () => renderPromptContext(cwd));
writeFileSync(join(out, "prompt.txt"), prompt.text);
results.promptBytes = Buffer.byteLength(prompt.text);
for (let i = 0; i < 5; i++) await timed("prompt-warm", () => renderPromptContext(cwd));
for (let i = 0; i < 3; i++)
	await timed("ensure", () =>
		coordinateCodewikiWrite(
			cwd,
			(current) => ({ kind: "ensure", cwd, current, previous: readClioState(cwd)?.fingerprint }),
			{ afterCommit: commit },
		),
	);
for (let i = 0; i < 3; i++) {
	const result = await timed("retrieve-symbol", () =>
		codeNavTool.run({ mode: "symbol", query: "renderPromptContext", limit: 10 }),
	);
	if (i === 0) {
		writeFileSync(join(out, "retrieval.json"), result.output ?? JSON.stringify(result));
		results.retrievalBytes = Buffer.byteLength(result.output ?? "");
	}
}
const added = join(cwd, "context-benchmark-probe.ts");
writeFileSync(added, "export function benchmarkProbe() { return 42; }\n");
await timed("incremental-add", () =>
	coordinateCodewikiWrite(
		cwd,
		(current) => ({
			kind: "incremental",
			cwd,
			current,
			paths: ["context-benchmark-probe.ts"],
			previous: readClioState(cwd)?.fingerprint,
		}),
		{ afterCommit: commit },
	),
);
writeFileSync(join(out, "state.json"), readFileSync(join(cwd, ".clio-coder/state.json")));
writeFileSync(join(out, "metrics.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
