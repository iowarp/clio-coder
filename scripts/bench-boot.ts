/**
 * Boot interactivity bench for the built CLI.
 *
 * Launches `dist/cli/index.js` in a real pseudo-terminal against an isolated
 * home and a local stub target, starts typing the moment the Stage 0 editor
 * paints, and times each keystroke's echo. Stage 0 paints before hydration, but
 * a key echoes only when the event loop turns, so echo latency is what an
 * operator typing into a fresh session waits. Typing continues until the
 * hydrated footer has been on screen for the settle window, so work deferred
 * past the first hydrated frame still shows up in the echo numbers. The
 * deferred boot trace supplies the Stage 0 commit, the Stage 1 hydrated frame,
 * and the longest loop block between them.
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
const MARKER = "Z";
/** Only the hydrated footer paints a parenthesized context percentage (known or unknown).
 * Boot trace lines are deferred until exit and cannot drive the settle window. */
const HYDRATED = /\([^\r\n()]*%\)/u;
/** Wide enough that the whole marker run stays on one editor line. */
const COLUMNS = 180;

const argv = process.argv.slice(2);
const { values } = parseArgs({
	// `pnpm bench:boot -- --runs 5` forwards the separator itself.
	args: argv[0] === "--" ? argv.slice(1) : argv,
	options: {
		runs: { type: "string", default: "5" },
		keys: { type: "string", default: "160" },
		interval: { type: "string", default: "20" },
		settle: { type: "string", default: "500" },
		cwd: { type: "string", default: process.cwd() },
		// Another build's entry, to compare two builds in one sitting.
		cli: { type: "string", default: join(ROOT, "dist", "cli", "index.js") },
		"user-plugins": { type: "string" },
		"no-compile-cache": { type: "boolean", default: false },
		profile: { type: "string", default: "all" },
		mode: { type: "string", default: "fullscreen" },
		json: { type: "string" },
		"cpu-profile-dir": { type: "string" },
	},
});
const RUNS = Number(values.runs);
/** A cap. Typing normally stops `SETTLE_MS` after the hydrated footer appears. */
const KEYS = Number(values.keys);
const INTERVAL_MS = Number(values.interval);
const SETTLE_MS = Number(values.settle);
const CWD = resolve(values.cwd);
const CLI = resolve(values.cli);
const cpuProfileDir = values["cpu-profile-dir"] ? resolve(values["cpu-profile-dir"]) : undefined;
if (cpuProfileDir) mkdirSync(cpuProfileDir, { recursive: true });

type Profile = "full" | "normal" | "portable";
const PROFILES: Profile[] = values.profile === "all" ? ["full", "normal", "portable"] : [values.profile as Profile];
if (PROFILES.some((profile) => !["full", "normal", "portable"].includes(profile)))
	throw new Error("profile must be full, normal, portable, or all");
if (!["regular", "fullscreen"].includes(values.mode)) throw new Error("mode must be regular or fullscreen");
for (const [label, value] of Object.entries({ runs: RUNS, keys: KEYS, interval: INTERVAL_MS, settle: SETTLE_MS })) {
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

interface Run {
	profile: Profile;
	firstPaintMs: number | undefined;
	outputBytes: number;
	hydratedBytes: number | undefined;
	complete: boolean;
	stage0Ms: number | undefined;
	hydratedMs: number | undefined;
	inputBlockedMaxMs: number | undefined;
	/** Echo latency of the first key, typed as Stage 0 appeared. */
	firstEchoMs: number | undefined;
	maxEchoMs: number | undefined;
	echoed: number;
	typed: number;
}

function median(values: ReadonlyArray<number | undefined>): string {
	const present = values.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
	if (present.length === 0) return "-";
	return (present[Math.floor(present.length / 2)] as number).toFixed(0);
}

function prepareHome(endpoint: string, profile: Profile): string {
	const home = mkdtempSync(join(tmpdir(), "clio-coder-bench-boot-"));
	mkdirSync(join(home, "config"), { recursive: true });
	if (values["user-plugins"])
		cpSync(resolve(values["user-plugins"]), join(home, "config", "plugins"), { recursive: true });
	writeFileSync(
		join(home, "config", "settings.yaml"),
		`version: 2
targets:
  - id: bench-local
    runtime: lmstudio
    url: ${endpoint}
    defaultModel: bench-model
    lifecycle: user-managed
chat:
  target: bench-local
  model: bench-model
interface:
  demo: ${profile === "full"}
  mode: ${values.mode}
  panes:
    enabled: off
`,
	);
	execFileSync(process.execPath, [CLI, "upgrade"], {
		env: homeEnv(home, profile),
		stdio: ["ignore", "ignore", "inherit"],
	});
	return home;
}

function homeEnv(home: string, profile: Profile): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		SSH_CONNECTION: "",
		SSH_TTY: "",
		TMUX: "",
		STY: "",
		CI: "",
		CLIO_CODER_THEME: "dark",
		NO_COLOR: profile === "portable" ? "1" : "",
		FORCE_COLOR: profile === "portable" ? "0" : "1",
		CLIO_CODER_SCREEN_READER: "0",
		CLIO_CODER_REDUCE_MOTION: "0",
		CLIO_CODER_NERD_FONT: "0",
		CLIO_CODER_INSTANT_SHELL: "1",
		CLIO_CODER_RENDER_TRACE: "",
		CLIO_CODER_HOME: home,
		CLIO_CODER_CONFIG_DIR: join(home, "config"),
		CLIO_CODER_DATA_DIR: join(home, "data"),
		CLIO_CODER_STATE_DIR: join(home, "state"),
		CLIO_CODER_CACHE_DIR: join(home, "cache"),
		CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		...(values["no-compile-cache"] ? { NODE_DISABLE_COMPILE_CACHE: "1" } : {}),
	};
	if (!values["no-compile-cache"]) delete env.NODE_DISABLE_COMPILE_CACHE;
	return env;
}

function runOnce(home: string, profile: Profile): Promise<Run> {
	return new Promise((settle) => {
		const started = performance.now();
		const child = spawn(
			process.execPath,
			[...(cpuProfileDir ? ["--cpu-prof", `--cpu-prof-dir=${cpuProfileDir}`] : []), CLI],
			{
				cols: COLUMNS,
				rows: 30,
				cwd: CWD,
				name: "xterm-256color",
				env: { ...homeEnv(home, profile), CLIO_CODER_INTERACTIVE: "1", CLIO_CODER_TRACE_BOOT: "1" },
			},
		);
		let output = "";
		let outputBytes = 0;
		let firstPaintMs: number | undefined;
		let hydratedBytes: number | undefined;
		const typedAt: number[] = [];
		const echoedAt: number[] = [];
		let typing: NodeJS.Timeout | undefined;
		let typingDone = false;
		let settledHydration = false;
		let hydratedSeenAt: number | undefined;
		let stopping = false;
		const stopWhenEchoed = (): void => {
			if (!typingDone || stopping || echoedAt.length < typedAt.length) return;
			stopping = true;
			setTimeout(() => child.kill("SIGTERM"), 300);
		};
		child.onData((data) => {
			const now = performance.now() - started;
			output += data;
			outputBytes += Buffer.byteLength(data);
			const visible = stripVTControlCharacters(output.slice(-8000));
			if (hydratedSeenAt === undefined && HYDRATED.test(visible)) {
				hydratedSeenAt = now;
				hydratedBytes = outputBytes;
			}
			if (!typing && /Ask Clio/u.test(output)) {
				firstPaintMs = now;
				typing = setInterval(() => {
					const at = performance.now() - started;
					settledHydration = hydratedSeenAt !== undefined && at - hydratedSeenAt >= SETTLE_MS;
					if (typedAt.length >= KEYS || settledHydration) {
						clearInterval(typing);
						typingDone = true;
						stopWhenEchoed();
						return;
					}
					typedAt.push(at);
					child.write(MARKER);
				}, INTERVAL_MS);
			}
			if (!typing) return;
			// The editor redraws its whole line, so the longest marker run is the
			// number of keys echoed so far.
			const longest = Math.max(0, ...(visible.match(new RegExp(`${MARKER}+`, "gu")) ?? []).map((run) => run.length));
			while (echoedAt.length < Math.min(longest, typedAt.length)) echoedAt.push(now);
			stopWhenEchoed();
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
				profile,
				firstPaintMs,
				outputBytes,
				hydratedBytes,
				complete:
					hydratedSeenAt !== undefined && typedAt.length > 0 && echoedAt.length === typedAt.length && settledHydration,
				stage0Ms: trace("Stage 0 shell commit")?.at,
				hydratedMs: trace("Stage 1 hydration")?.at,
				inputBlockedMaxMs: blocked === undefined ? undefined : Number(blocked),
				firstEchoMs: latencies[0],
				maxEchoMs: latencies.length > 0 ? Math.max(...latencies) : undefined,
				echoed: echoedAt.length,
				typed: typedAt.length,
			});
		});
	});
}

if (!existsSync(CLI)) throw new Error(`${CLI} is missing; run pnpm build first`);
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
const homes = new Map<Profile, string>();
try {
	for (const profile of PROFILES)
		homes.set(profile, prepareHome(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, profile));
	console.log(
		`node ${process.version} ${process.platform}-${process.arch} cwd=${CWD} runs=${RUNS} mode=${values.mode}` +
			` keys<=${KEYS}@${INTERVAL_MS}ms settle=${SETTLE_MS}ms compile-cache=${values["no-compile-cache"] ? "disabled" : "default"}`,
	);
	const cold: Run[] = [];
	for (const profile of PROFILES) cold.push(await runOnce(homes.get(profile) as string, profile));
	const runs: Run[] = [];
	// Interleave profiles, rotating which goes first to reduce cache/order bias.
	for (let index = 0; index < RUNS; index++) {
		for (let offset = 0; offset < PROFILES.length; offset++) {
			const profile = PROFILES[(index + offset) % PROFILES.length] as Profile;
			const run = await runOnce(homes.get(profile) as string, profile);
			runs.push(run);
			console.log(
				`${profile} run ${index + 1}: stage0=${run.stage0Ms ?? "-"}ms hydrated=${run.hydratedMs ?? "-"}ms` +
					` input-blocked-max=${run.inputBlockedMaxMs ?? "-"}ms first-echo=${run.firstEchoMs?.toFixed(0) ?? "-"}ms` +
					` max-echo=${run.maxEchoMs?.toFixed(0) ?? "-"}ms bytes-to-hydration=${run.hydratedBytes ?? "-"} echoed=${run.echoed}/${run.typed} complete=${run.complete}`,
			);
		}
	}
	for (const profile of PROFILES) {
		const group = runs.filter((run) => run.profile === profile);
		console.log(
			`${profile} median: stage0=${median(group.map((run) => run.stage0Ms))}ms hydrated=${median(group.map((run) => run.hydratedMs))}ms` +
				` input-blocked-max=${median(group.map((run) => run.inputBlockedMaxMs))}ms` +
				` first-echo=${median(group.map((run) => run.firstEchoMs))}ms max-echo=${median(group.map((run) => run.maxEchoMs))}ms` +
				` bytes-to-hydration=${median(group.map((run) => run.hydratedBytes))}`,
		);
	}
	if (values.json)
		writeFileSync(
			resolve(values.json),
			`${JSON.stringify(
				{
					node: process.version,
					platform: process.platform,
					arch: process.arch,
					cwd: CWD,
					cli: CLI,
					mode: values.mode,
					runsPerProfile: RUNS,
					compileCache: !values["no-compile-cache"],
					cpuProfileDir,
					cold,
					runs,
				},
				null,
				2,
			)}\n`,
		);
	if ([...cold, ...runs].some((run) => !run.complete || run.stage0Ms === undefined || run.hydratedMs === undefined)) {
		console.error("Incomplete boot or input echo: do not treat these results as a valid comparison.");
		process.exitCode = 1;
	}
} finally {
	server.close();
	for (const home of homes.values()) rmSync(home, { recursive: true, force: true });
}
