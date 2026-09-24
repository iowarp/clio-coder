/**
 * Boot interactivity bench for the built CLI.
 *
 * Launches `dist/cli/index.js` in a real pseudo-terminal against an isolated
 * home and a local stub target, starts typing the moment the Stage 0 editor
 * paints, and times each keystroke's echo. Stage 0 paints before hydration, but
 * a key echoes only when the event loop turns, so echo latency is what an
 * operator typing into a fresh session waits. The deferred boot trace supplies
 * the Stage 0 commit, the Stage 1 hydrated frame, and the longest loop block
 * between them.
 *
 * Timings are observations for a measurement campaign, never CI thresholds.
 * The deterministic fs-call gate lives in
 * tests/contracts/plugin-discovery-fs-scaling.test.ts.
 *
 *   pnpm build && pnpm bench:boot -- --runs 5 --cwd . --user-plugins ~/.config/clio-coder/plugins
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli", "index.js");
const MARKER = "Z";

const argv = process.argv.slice(2);
const { values } = parseArgs({
	// `pnpm bench:boot -- --runs 5` forwards the separator itself.
	args: argv[0] === "--" ? argv.slice(1) : argv,
	options: {
		runs: { type: "string", default: "5" },
		keys: { type: "string", default: "40" },
		interval: { type: "string", default: "20" },
		cwd: { type: "string", default: process.cwd() },
		"user-plugins": { type: "string" },
		"no-compile-cache": { type: "boolean", default: false },
	},
});
const RUNS = Number(values.runs);
const KEYS = Number(values.keys);
const INTERVAL_MS = Number(values.interval);
const CWD = resolve(values.cwd);

interface Run {
	stage0Ms: number | undefined;
	hydratedMs: number | undefined;
	inputBlockedMaxMs: number | undefined;
	/** Echo latency of the first key, typed as Stage 0 appeared. */
	firstEchoMs: number | undefined;
	maxEchoMs: number | undefined;
	echoed: number;
}

function median(values: ReadonlyArray<number | undefined>): string {
	const present = values.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
	if (present.length === 0) return "-";
	return (present[Math.floor(present.length / 2)] as number).toFixed(0);
}

function prepareHome(endpoint: string): string {
	const home = mkdtempSync(join(tmpdir(), "clio-coder-bench-boot-"));
	mkdirSync(join(home, "config"), { recursive: true });
	if (values["user-plugins"])
		cpSync(resolve(values["user-plugins"]), join(home, "config", "plugins"), { recursive: true });
	writeFileSync(
		join(home, "config", "settings.yaml"),
		`version: 1
targets:
  - id: bench-local
    runtime: lmstudio
    url: ${endpoint}
    defaultModel: bench-model
    lifecycle: user-managed
orchestrator:
  target: bench-local
  model: bench-model
panes:
  enabled: off
`,
	);
	execFileSync(process.execPath, [CLI, "upgrade"], { env: homeEnv(home), stdio: ["ignore", "ignore", "inherit"] });
	return home;
}

function homeEnv(home: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		TERM: "xterm-256color",
		CLIO_CODER_HOME: home,
		CLIO_CODER_CONFIG_DIR: join(home, "config"),
		CLIO_CODER_DATA_DIR: join(home, "data"),
		CLIO_CODER_STATE_DIR: join(home, "state"),
		CLIO_CODER_CACHE_DIR: join(home, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		...(values["no-compile-cache"] ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
	};
}

function runOnce(home: string): Promise<Run> {
	return new Promise((settle) => {
		const started = performance.now();
		const child = spawn(process.execPath, [CLI], {
			cols: 100,
			rows: 30,
			cwd: CWD,
			name: "xterm-256color",
			env: { ...homeEnv(home), CLIO_CODER_INTERACTIVE: "1", CLIO_CODER_TRACE_BOOT: "1" },
		});
		let output = "";
		const typedAt: number[] = [];
		const echoedAt: number[] = [];
		let typing: NodeJS.Timeout | undefined;
		let stopping = false;
		child.onData((data) => {
			const now = performance.now() - started;
			output += data;
			if (!typing && /Ask Clio/u.test(output)) {
				typing = setInterval(() => {
					if (typedAt.length >= KEYS) return clearInterval(typing);
					typedAt.push(performance.now() - started);
					child.write(MARKER);
				}, INTERVAL_MS);
			}
			if (!typing) return;
			// The editor redraws its whole line, so the longest marker run is the
			// number of keys echoed so far.
			const visible = stripVTControlCharacters(output.slice(-4000));
			const longest = Math.max(0, ...(visible.match(new RegExp(`${MARKER}+`, "gu")) ?? []).map((run) => run.length));
			while (echoedAt.length < Math.min(longest, typedAt.length)) echoedAt.push(now);
			if (echoedAt.length >= KEYS && !stopping) {
				stopping = true;
				setTimeout(() => child.kill("SIGTERM"), 300);
			}
		});
		const watchdog = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.onExit(() => {
			clearTimeout(watchdog);
			clearInterval(typing);
			const trace = (phase: string) => {
				const match = output.match(new RegExp(`\\[clio-coder:boot\\] \\+([\\d.]+)ms ${phase}(?: \\(([^)]*)\\))?`, "u"));
				return match ? { at: Number(match[1]), detail: match[2] } : undefined;
			};
			const latencies = echoedAt.map((at, index) => at - (typedAt[index] as number));
			const blocked = trace("Stage 0 input blocked")?.detail?.match(/max=([\d.]+)ms/u)?.[1];
			settle({
				stage0Ms: trace("Stage 0 shell commit")?.at,
				hydratedMs: trace("Stage 1 hydration")?.at,
				inputBlockedMaxMs: blocked === undefined ? undefined : Number(blocked),
				firstEchoMs: latencies[0],
				maxEchoMs: latencies.length > 0 ? Math.max(...latencies) : undefined,
				echoed: echoedAt.length,
			});
		});
	});
}

if (!existsSync(CLI)) throw new Error("dist/cli/index.js is missing; run pnpm build first");
const server = createServer((request, response) => {
	response.setHeader("content-type", "application/json");
	if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "bench-model" }] }));
	else if (request.url === "/lmstudio-greeting") response.end(JSON.stringify({ lmstudio: true }));
	else {
		response.statusCode = 404;
		response.end("{}");
	}
});
await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
const home = prepareHome(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
try {
	console.log(
		`node ${process.version} ${process.platform}-${process.arch} cwd=${CWD} runs=${RUNS} keys=${KEYS}@${INTERVAL_MS}ms` +
			` compile-cache=${values["no-compile-cache"] ? "disabled" : "default"}`,
	);
	// The first boot fills the compile cache and migrates settings; it is not reported.
	await runOnce(home);
	const runs: Run[] = [];
	for (let index = 0; index < RUNS; index++) {
		const run = await runOnce(home);
		runs.push(run);
		console.log(
			`run ${index + 1}: stage0=${run.stage0Ms ?? "-"}ms hydrated=${run.hydratedMs ?? "-"}ms` +
				` input-blocked-max=${run.inputBlockedMaxMs ?? "-"}ms first-echo=${run.firstEchoMs?.toFixed(0) ?? "-"}ms` +
				` max-echo=${run.maxEchoMs?.toFixed(0) ?? "-"}ms echoed=${run.echoed}/${KEYS}`,
		);
	}
	console.log(
		`median: stage0=${median(runs.map((run) => run.stage0Ms))}ms hydrated=${median(runs.map((run) => run.hydratedMs))}ms` +
			` input-blocked-max=${median(runs.map((run) => run.inputBlockedMaxMs))}ms` +
			` first-echo=${median(runs.map((run) => run.firstEchoMs))}ms max-echo=${median(runs.map((run) => run.maxEchoMs))}ms`,
	);
} finally {
	server.close();
	rmSync(home, { recursive: true, force: true });
}
