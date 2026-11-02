/**
 * Outer-loop feedback latency: a real Clio in a real PTY against a fake provider.
 * Every stamp is taken at a process boundary. A key is stamped when the driver
 * writes it, a paint when the PTY master first carries its text, a dispatch when
 * the provider receives the request. Terminal emulator painting is still excluded.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";

const { values } = parseArgs({
	options: {
		scratch: { type: "string" },
		smooth: { type: "string", default: "off" },
		mode: { type: "string", default: "regular" },
		repeats: { type: "string", default: "12" },
		"tokens-per-second": { type: "string", default: "60" },
		"token-chars": { type: "string", default: "5" },
		"stream-seconds": { type: "string", default: "6" },
		"attachment-kb": { type: "string", default: "2048" },
		scenario: { type: "string" },
	},
});
if (!values.scratch) throw new Error("--scratch <directory> is required; this bench never runs against a real home");
const scratch = resolve(values.scratch);
const home = join(scratch, `home-${process.pid}`);
const project = join(scratch, `project-${process.pid}`);
const tracePath = join(home, "render.jsonl");
mkdirSync(join(home, "config"), { recursive: true });
mkdirSync(project, { recursive: true });
const repeats = Number(values.repeats);
const tokensPerSecond = Number(values["tokens-per-second"]);
const tokenChars = Number(values["token-chars"]);
const streamSeconds = Number(values["stream-seconds"]);

/**
 * The prose filter (`createAssistantProseFilter`) holds a chunk's last grapheme
 * and trailing space until the next chunk, so a cue must not end a chunk or the
 * bench would time that hold instead of the scheduler.
 */
const HELD_TAIL = " .. ";
const PARAGRAPH =
	"The render loop keeps **settled output** stable while the live tail grows, and each frame re-lexes this reply.\n\n- Preserve input responsiveness.\n- Keep tool events ordered.\n\n";

const clock = (): number => performance.timeOrigin + performance.now();
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function summary(samples: number[]): Record<string, number> {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number): number => Number((sorted[Math.ceil(sorted.length * p) - 1] ?? 0).toFixed(2));
	return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

type Script = (response: ServerResponse, send: (text: string) => void, finish: () => void) => void | Promise<void>;
const scripts = new Map<string, Script>();
const dispatches = new Map<string, number>();

const server = createServer((request, response) => {
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (chunk) => {
		body += chunk;
	});
	request.on("end", () => {
		if (request.method === "GET" || !request.url?.includes("/chat/completions")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: "bench-model", object: "model" }] }));
			return;
		}
		const at = clock();
		const key = [...scripts.keys()].find((candidate) => body.includes(candidate));
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
			`data: ${JSON.stringify({
				id: "bench",
				object: "chat.completion.chunk",
				model: "bench-model",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
		const send = (text: string): void => {
			response.write(chunk({ content: text }));
		};
		const finish = (): void => {
			response.write(chunk({}, "stop"));
			response.end("data: [DONE]\n\n");
		};
		if (key === undefined) {
			send("ok");
			finish();
			return;
		}
		dispatches.set(key, at);
		void scripts.get(key)?.(response, send, finish);
	});
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const port = (server.address() as AddressInfo).port;

writeFileSync(
	join(home, "config", "settings.yaml"),
	`version: 2
targets:
  - id: bench
    runtime: openai-compat
    url: http://127.0.0.1:${port}/v1
    defaultModel: bench-model
    auth:
      apiKeyEnvVar: CLIO_CODER_BENCH_KEY
    capabilities:
      chat: true
      tools: true
      toolCallFormat: openai
      contextWindow: 1000000
      maxTokens: 4096
    wireModels:
      - bench-model
    lifecycle: user-managed
chat:
  target: bench
  model: bench-model
interface:
  mode: ${values.mode}
  smoothStreaming: ${values.smooth}
  panes:
    enabled: off
`,
);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
	if (
		value === undefined ||
		key.startsWith("CLIO_CODER_") ||
		["TMUX", "STY", "SSH_CONNECTION", "SSH_TTY", "CI", "HERDR_ENV"].includes(key)
	)
		continue;
	env[key] = value;
}
Object.assign(env, {
	HOME: home,
	TERM: "xterm-256color",
	CLIO_CODER_HOME: home,
	CLIO_CODER_INTEROP_HOME: "none",
	CLIO_CODER_RENDER_TRACE: tracePath,
	CLIO_CODER_BENCH_KEY: "bench",
	CLIO_CODER_INTERACTIVE: "1",
	CLIO_CODER_INSTANT_SHELL: "1",
});
const cli = resolve("src/cli/index.ts");
const child = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), cli], {
	cols: 120,
	rows: 40,
	cwd: project,
	env,
	name: "xterm-256color",
});

let visible = "";
let raw = "";
const commits: Array<{ at: number; bytes: number }> = [];
const cues: Array<{ cue: string; from: number; resolve: (at: number) => void }> = [];
child.onData((data) => {
	const at = clock();
	raw += data;
	if (raw.length > 4_000_000) raw = raw.slice(-1_000_000);
	visible += stripVTControlCharacters(data);
	if (visible.length > 4_000_000) {
		const dropped = visible.length - 1_000_000;
		visible = visible.slice(dropped);
		for (const cue of cues) cue.from = Math.max(0, cue.from - dropped);
	}
	commits.push({ at, bytes: Buffer.byteLength(data) });
	for (const entry of [...cues]) {
		if (visible.indexOf(entry.cue, entry.from) < 0) continue;
		cues.splice(cues.indexOf(entry), 1);
		entry.resolve(at);
	}
});
function waitFor(cue: string, timeoutMs = 30_000, from = visible.length): Promise<number> {
	const found = visible.indexOf(cue, from);
	if (found >= 0) return Promise.resolve(clock());
	return new Promise((done, fail) => {
		const entry = {
			cue,
			from,
			resolve: (at: number) => {
				clearTimeout(timer);
				done(at);
			},
		};
		const timer = setTimeout(() => {
			cues.splice(cues.indexOf(entry), 1);
			fail(
				new Error(
					`timed out waiting for ${JSON.stringify(cue)}; tail: ${JSON.stringify(visible.slice(-5000).replace(/ {3,}/g, "  "))}`,
				),
			);
		}, timeoutMs);
		cues.push(entry);
	});
}

interface PromptStamps {
	enter: number;
	firstBytes: number;
	prompt: number;
	dispatch: number;
	token: number;
}

/** Stamps one idle submit from Enter through its first token. */
async function promptTurn(id: string, suffix = "", serverDelayMs = 0): Promise<PromptStamps> {
	const prompt = `bench${id}x`;
	const token = `Tok${id}en`;
	scripts.set(prompt, async (_response, send, finish) => {
		if (serverDelayMs > 0) await pause(serverDelayMs);
		send(`${token}${HELD_TAIL}`);
		await pause(10);
		finish();
	});
	child.write(`${prompt}${suffix}`);
	await waitFor(prompt);
	await pause(50);
	if (suffix.length > 0) {
		// An `@` opens the file popup, which would take Enter as a completion.
		await pause(300);
		child.write("\x1b");
		await pause(100);
	}
	const from = visible.length;
	const byteMark = commits.length;
	const shownPrompt = waitFor(prompt, 60_000, from);
	const shownToken = waitFor(token, 60_000, from);
	const enter = clock();
	child.write("\r");
	const [promptAt, tokenAt] = await Promise.all([shownPrompt, shownToken]);
	const firstBytes = commits.slice(byteMark).find((commit) => commit.at >= enter)?.at ?? promptAt;
	await pause(200);
	scripts.delete(prompt);
	return { enter, firstBytes, prompt: promptAt, dispatch: dispatches.get(prompt) ?? Number.NaN, token: tokenAt };
}

const results: Record<string, unknown> = {
	smooth: values.smooth,
	mode: values.mode,
	tokensPerSecond,
	tokenChars,
	node: process.version,
};
const selected = (name: string): boolean => !values.scenario || values.scenario.split(",").includes(name);

async function scenarioSubmit(name: string, suffix: string, count: number): Promise<void> {
	const turns: PromptStamps[] = [];
	for (let index = 0; index < count; index++) turns.push(await promptTurn(`${name}${index}q`, suffix));
	const span = (pick: (turn: PromptStamps) => number): Record<string, number> =>
		summary(turns.map((turn) => pick(turn) - turn.enter));
	results[`submit:${name}`] = {
		enterToFirstBytes: span((turn) => turn.firstBytes),
		enterToPrompt: span((turn) => turn.prompt),
		enterToDispatch: span((turn) => turn.dispatch),
		enterToToken: span((turn) => turn.token),
		dispatchToToken: summary(turns.map((turn) => turn.token - turn.dispatch)),
	};
}

/** One write holding text and Enter reads as pasted input, so the key arrives on its own. */
async function typeAndSubmit(prompt: string): Promise<void> {
	child.write(prompt);
	await waitFor(prompt);
	await pause(50);
	child.write("\r");
}

/** Tokens separated by a long quiet gap: each should paint in one frame from an idle screen. */
async function scenarioIdleToken(): Promise<void> {
	const prompt = "benchidletokens";
	const latencies: number[] = [];
	const finished = new Promise<void>((done) => {
		scripts.set(prompt, async (_response, send, finish) => {
			send("start ");
			await pause(500);
			for (let index = 0; index < repeats; index++) {
				const token = `Idle${index}tok`;
				const shown = waitFor(token, 5_000);
				const sent = clock();
				send(`${token}${HELD_TAIL}`);
				latencies.push((await shown) - sent);
				await pause(350);
			}
			finish();
			done();
		});
	});
	await typeAndSubmit(prompt);
	await finished;
	scripts.delete(prompt);
	await pause(300);
	results.idleToken = summary(latencies);
}

/** A provider that sends blocks: how many steps each block lands in, and over how long. */
async function scenarioBursts(): Promise<void> {
	const prompt = "benchblockstream";
	const steps: number[] = [];
	const spreads: number[] = [];
	const firstPaints: number[] = [];
	const finished = new Promise<void>((done) => {
		scripts.set(prompt, async (_response, send, finish) => {
			send(`start${HELD_TAIL}`);
			await pause(300);
			for (let burst = 0; burst < repeats; burst++) {
				const words = Array.from({ length: 12 }, (_, word) => `b${burst}w${word}x`);
				const sent = clock();
				const shown = words.map((word) => waitFor(word, 5_000));
				send(`${words.map((word) => word.padEnd(50, "y")).join(" ")}\n\n${HELD_TAIL}`);
				const stamps = await Promise.all(shown);
				steps.push(new Set(stamps).size);
				spreads.push(Math.max(...stamps) - Math.min(...stamps));
				firstPaints.push(Math.min(...stamps) - sent);
				const wait = sent + 300 - clock();
				if (wait > 0) await pause(wait);
			}
			finish();
			done();
		});
	});
	await typeAndSubmit(prompt);
	await finished;
	scripts.delete(prompt);
	await pause(300);
	results.bursts = { paintsPerBurst: summary(steps), spreadMs: summary(spreads), firstPaint: summary(firstPaints) };
}

/** A steady stream: arrival-to-paint latency, keystroke echo, and how evenly the bytes land. */
async function scenarioStream(label: string, prefillKb: number): Promise<void> {
	const prompt = `benchsteadystream${label}`;
	const paints = new Set<number>();
	const keyLatencies: number[] = [];
	const tokenLatencies: number[] = [];
	const gaps: number[] = [];
	let streamStart = 0;
	let streamEnd = 0;
	const finished = new Promise<void>((done) => {
		scripts.set(prompt, async (_response, send, finish) => {
			const prefillDone = "PrefillDoneMark";
			const prefilled = waitFor(prefillDone, 120_000);
			for (let sent = 0; sent < prefillKb * 1024; sent += PARAGRAPH.length * 40) {
				send(PARAGRAPH.repeat(40));
				await pause(5);
			}
			send(`${prefillDone}${HELD_TAIL}\n\n`);
			await prefilled;
			const interval = 1_000 / tokensPerSecond;
			const total = Math.round(streamSeconds * tokensPerSecond);
			streamStart = clock();
			for (let index = 0; index < total; index++) {
				const marker = `s${index.toString(36).padStart(3, "0")}`.padEnd(tokenChars, "e");
				const due = streamStart + index * interval;
				const wait = due - clock();
				if (wait > 0) await pause(wait);
				const sent = clock();
				const from = visible.length;
				void waitFor(marker, 10_000, from).then(
					(at) => {
						tokenLatencies.push(at - sent);
						paints.add(at);
					},
					() => {},
				);
				send(`${marker}${index % 12 === 11 ? "\n\n" : ""}${HELD_TAIL}`);
			}
			streamEnd = clock();
			finish();
			done();
		});
	});
	await typeAndSubmit(prompt);
	while (streamStart === 0) await pause(20);
	await pause(300);
	const alphabet = "qzjxkv";
	let draft = "";
	for (let index = 0; index < 40 && clock() < streamStart + streamSeconds * 1_000 - 300; index++) {
		draft += alphabet[index % alphabet.length];
		const shown = waitFor(draft, 5_000);
		const sent = clock();
		child.write(draft.at(-1) ?? "");
		keyLatencies.push((await shown) - sent);
		// A fixed cadence phase-locks with the repaint interval and reads as bimodal.
		await pause(40 + Math.random() * 120);
	}
	await finished;
	scripts.delete(prompt);
	await pause(500);
	for (let index = 0; index < draft.length; index++) child.write("\x7f");
	await pause(200);
	const window = commits.filter((commit) => commit.at >= streamStart + 500 && commit.at <= streamEnd);
	for (let index = 1; index < window.length; index++) {
		const previous = window[index - 1];
		const current = window[index];
		if (previous && current) gaps.push(current.at - previous.at);
	}
	results[`stream:${label}`] = {
		textPaintsPerSecond: Number((paints.size / Math.max(0.001, (streamEnd - streamStart) / 1_000)).toFixed(1)),
		tokenToPaint: summary(tokenLatencies),
		keystrokeEcho: summary(keyLatencies),
		commitGap: summary(gaps),
		commitsPerSecond: Number((window.length / Math.max(0.001, (streamEnd - streamStart - 500) / 1_000)).toFixed(1)),
	};
}

try {
	await waitFor("no Git branch", 60_000, 0);
	await pause(1_500);
	if (selected("plain")) await scenarioSubmit("plain", "", repeats);
	if (selected("attachment")) {
		const body = `${"attachment line of ordinary text\n".repeat(Math.ceil((Number(values["attachment-kb"]) * 1024) / 33))}`;
		writeFileSync(join(project, "big.txt"), body);
		await scenarioSubmit("attach", " @big.txt ", Math.min(repeats, 4));
	}
	if (selected("idle-token")) await scenarioIdleToken();
	if (selected("bursts")) await scenarioBursts();
	if (selected("stream")) await scenarioStream("0kb", 0);
	if (selected("stream20")) await scenarioStream("20kb", 15);
	if (selected("stream100")) await scenarioStream("100kb", 100);
	if (selected("stream500")) await scenarioStream("500kb", 500);
} finally {
	child.write("\x03");
	await pause(150);
	child.kill();
	server.closeAllConnections();
	server.close();
}

const phases = new Map<number, Record<string, number>>();
const trace = readFileSync(tracePath, "utf8")
	.split("\n")
	.filter((line) => line.length > 0)
	.map((line) => JSON.parse(line) as Record<string, unknown>);
for (const record of trace) {
	if (record.type !== "submit_phase") continue;
	const entry = phases.get(record.submitSeq as number) ?? {};
	entry[record.phase as string] = record.at as number;
	phases.set(record.submitSeq as number, entry);
}
const fromEnter = (phase: string): Record<string, number> =>
	summary(
		[...phases.values()]
			.filter((entry) => entry.enter !== undefined && entry[phase] !== undefined)
			.map((entry) => (entry[phase] as number) - (entry.enter as number)),
	);
results.tracePhasesFromEnter = Object.fromEntries(
	["expansion-start", "expansion-end", "prompt-appended", "preparation-start", "preparation-commit", "admission"].map(
		(phase) => [phase, fromEnter(phase)],
	),
);
console.log(JSON.stringify(results, null, 2));
process.exit(0);
