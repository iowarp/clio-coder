/**
 * Development-only CLI: measure one arm's first-turn wire burden per profile.
 *
 *   node --import tsx scripts/prompt-optimization/envelope-run.ts \
 *     --arm /tmp/clio-ab-arm-base --label d7a7fc69 \
 *     --target dynamo --model qwen3.8-27b --url http://192.168.86.143:1234 \
 *     --out /tmp/clio-prompt-ab-runs/envelope
 *
 * `--runtime llamacpp` pins a llama.cpp target instead of LM Studio; the
 * sandbox settings must name the runtime that actually answers, because the
 * adapter decides the request shape and the timing fields it reads back.
 *
 * Three frozen profiles are measured, because the budget is stated separately
 * for each and a single main-agent number would hide the fact that a worker's
 * admitted surface is supposed to be narrower:
 *
 *   main-full     the documented full-capability main agent
 *   worker        an ordinary dispatched worker with no bound skill
 *   bound-worker  a dispatched worker whose recipe binds skills
 *
 * The turn is deliberately a question no tool can help with, so the measurement
 * is the attached surface rather than a trajectory. What the model answers is
 * irrelevant and is not scored here.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePromptAbArm } from "./arms.js";
import type { PromptAbPinnedConfig, PromptAbScenario } from "./contract.js";
import { PROMPT_AB_SCENARIO_SCHEMA_V1 } from "./contract.js";
import {
	attributeExact,
	firstTurnRequest,
	inventoryFrom,
	startRecordingProxy,
	writeEnvelopeArtifact,
} from "./envelope.js";
import { createPromptAbSandbox } from "./isolation.js";

/** A profile is a frozen `run` invocation, named so a number can be compared to itself later. */
interface EnvelopeProfile {
	id: string;
	description: string;
	autonomy: "read-only" | "suggest" | "auto-edit" | "full-auto";
	agent: string | null;
	noSkills: boolean;
}

const PROBE_PROMPT = "Reply with the single word: ok. Do not call any tool.";

const PROFILES: readonly EnvelopeProfile[] = [
	{
		id: "main-full",
		description: "full-capability main agent, skills discoverable, highest autonomy",
		autonomy: "full-auto",
		agent: null,
		noSkills: false,
	},
	{
		id: "worker",
		description: "ordinary dispatched worker (debugger recipe: no bound skill)",
		autonomy: "full-auto",
		agent: "debugger",
		noSkills: false,
	},
	{
		id: "bound-worker",
		description: "recipe-bound dispatched worker (coder recipe: binds fix-issue, ship)",
		autonomy: "full-auto",
		agent: "coder",
		noSkills: false,
	},
];

function probeScenario(profile: EnvelopeProfile): PromptAbScenario {
	return {
		schema: PROMPT_AB_SCENARIO_SCHEMA_V1,
		id: `envelope.${profile.id}`,
		corpus: "development",
		family: "envelope-probe",
		title: profile.description,
		source: "mandate: first-turn envelope probe",
		runner: {
			prompt: PROBE_PROMPT,
			autonomy: profile.autonomy,
			agent: profile.agent,
			skills: [],
			noSkills: profile.noSkills,
			requiredSkills: [],
		},
		workspace: { kind: "fixture", files: [], writable: [], forbidState: [] },
		invariants: [],
		reviewQuestions: [],
		timeoutMs: 300_000,
	};
}

interface Args {
	arm: string;
	label: string;
	entry: string;
	target: string;
	model: string;
	url: string;
	/** Target runtime id (`lmstudio`, `llamacpp`, ...); the pinned settings must name the real one. */
	runtime: "lmstudio" | "llamacpp";
	out: string;
	thinking: string;
	maxContextTokens: number;
	deep: boolean;
	only: string | null;
}

function parseArgs(argv: readonly string[]): Args {
	const get = (flag: string, fallback: string): string => {
		const at = argv.indexOf(flag);
		return at >= 0 && at + 1 < argv.length ? (argv[at + 1] as string) : fallback;
	};
	return {
		arm: get("--arm", "/tmp/clio-ab-arm-base"),
		label: get("--label", "unlabelled"),
		entry: get("--entry", "dist/cli/index.js"),
		target: get("--target", "dynamo"),
		model: get("--model", "qwen3.8-27b"),
		url: get("--url", "http://192.168.86.143:1234"),
		runtime: get("--runtime", "lmstudio") === "llamacpp" ? "llamacpp" : "lmstudio",
		out: get("--out", "/tmp/clio-prompt-ab-runs/envelope"),
		thinking: get("--thinking", "medium"),
		maxContextTokens: Number(get("--max-context-tokens", "262144")),
		deep: argv.includes("--deep"),
		only: argv.includes("--only") ? get("--only", "") : null,
	};
}

function pinnedFor(args: Args, proxyUrl: string): PromptAbPinnedConfig {
	return {
		target: args.target,
		model: args.model,
		runtime: args.runtime,
		thinking: args.thinking,
		autonomy: "full-auto",
		toolProfile: null,
		maxContextTokens: args.maxContextTokens,
		kvCacheMode: null,
		sampling: {
			temperature: 0,
			topP: 1,
			topK: 0,
			minP: 0,
			repeatPenalty: 1,
			presencePenalty: 0,
			frequencyPenalty: 0,
		},
		serverConcurrency: 1,
		targetUrl: proxyUrl,
	};
}

function runArm(entry: string, argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
	return new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>((done) => {
		const child = spawn(process.execPath, [entry, ...argv], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ stdout, stderr, exitCode: code ?? -1, timedOut });
		});
		child.on("error", () => {
			clearTimeout(timer);
			done({ stdout, stderr: `${stderr}\nspawn failed`, exitCode: -1, timedOut });
		});
	});
}

/** The compiled-prose estimate and fragment inventory Clio recorded for this very session. */
function readManifestRecord(stateDir: string): Record<string, unknown> | null {
	const files: string[] = [];
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			const stats = statSync(full, { throwIfNoEntry: false });
			if (stats?.isDirectory()) walk(full);
			else if (name === "prompt-manifest.jsonl") files.push(full);
		}
	};
	walk(stateDir);
	let first: Record<string, unknown> | null = null;
	for (const file of files) {
		for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
			if (line.trim().length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed === "object" && parsed !== null && first === null) {
					first = parsed as Record<string, unknown>;
				}
			} catch {
				// A torn manifest line contributes nothing.
			}
		}
	}
	return first;
}

/** First-turn usage the arm itself reported, kept next to the probe number as a cross-check. */
function firstTurnUsageFromStream(stdout: string): Record<string, number> | null {
	for (const line of stdout.split(/\r?\n/u)) {
		if (line.trim().length === 0) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof record !== "object" || record === null) continue;
		const typed = record as Record<string, unknown>;
		if (typed.type !== "message_end") continue;
		const message = typed.message as Record<string, unknown> | undefined;
		const usage = message?.usage as Record<string, unknown> | undefined;
		if (usage === undefined) continue;
		const out: Record<string, number> = {};
		for (const [key, value] of Object.entries(usage)) {
			if (typeof value === "number") out[key] = value;
		}
		return out;
	}
	return null;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const arm = resolvePromptAbArm(
		{ id: "A", label: args.label, checkout: args.arm, entry: args.entry, commit: null },
		{ allowDirty: true },
	);
	const selected = args.only === null ? PROFILES : PROFILES.filter((p) => args.only?.split(",").includes(p.id));
	if (selected.length === 0) throw new Error(`no profile matched --only ${String(args.only)}`);

	const reports: Array<Record<string, unknown>> = [];
	for (const profile of selected) {
		process.stderr.write(`\n=== ${args.label} / ${profile.id} ===\n`);
		const proxy = await startRecordingProxy(args.url);
		const pinned = pinnedFor(args, proxy.url);
		const scenario = probeScenario(profile);
		const sandbox = createPromptAbSandbox(scenario, pinned, { armCheckout: arm.checkout, installSkills: [] });
		let run: Awaited<ReturnType<typeof runArm>>;
		try {
			const argv = [
				"run",
				"--json",
				"--target",
				pinned.target,
				"--model",
				pinned.model,
				"--thinking",
				pinned.thinking,
				"--autonomy",
				profile.autonomy,
				"--temperature",
				"0",
				"--max-context-tokens",
				String(pinned.maxContextTokens),
			];
			if (profile.agent !== null) argv.push("--agent", profile.agent);
			if (profile.noSkills) argv.push("--no-skills");
			argv.push(PROBE_PROMPT);
			run = await runArm(arm.entry, argv, sandbox.workspace, sandbox.env, scenario.timeoutMs);
			process.stderr.write(`  run exit=${run.exitCode} timedOut=${run.timedOut} requests=${proxy.requests.length}\n`);

			const captured = firstTurnRequest(proxy.requests);
			const manifest = readManifestRecord(join(sandbox.home, "state"));
			if (captured === null) {
				reports.push({
					profile: profile.id,
					description: profile.description,
					status: "no-capture",
					exitCode: run.exitCode,
					timedOut: run.timedOut,
					requestsSeen: proxy.requests.map((r) => `${r.method} ${r.path}`),
					stderrTail: run.stderr.slice(-2000),
					manifest,
				});
				continue;
			}

			const body = captured.body as Record<string, unknown>;
			const inventory = inventoryFrom(body, args.deep);
			process.stderr.write(`  captured first turn: ${inventory.toolCount} tools, ${inventory.payloadBytes} bytes\n`);
			writeEnvelopeArtifact(args.out, `${args.label}.${profile.id}.request.json`, body);

			const attribution = await attributeExact(args.url, body, inventory, (done, total, id) => {
				if (done % 5 === 0 || done === total) process.stderr.write(`  probe ${done}/${total} (${id})\n`);
			});

			reports.push({
				profile: profile.id,
				description: profile.description,
				status: "measured",
				arm: { label: args.label, commit: arm.commit, buildHash: arm.buildHash, checkout: arm.checkout },
				invocation: { autonomy: profile.autonomy, agent: profile.agent, noSkills: profile.noSkills },
				providerFirstTurnInputTokens: attribution.totalTokens,
				providerFirstTurnWithoutToolsTokens: attribution.noToolsTokens,
				toolBlockTokens:
					attribution.totalTokens !== null && attribution.noToolsTokens !== null
						? attribution.totalTokens - attribution.noToolsTokens
						: null,
				toolScaffoldTokens: attribution.toolScaffoldTokens,
				clioTokenEstimate: manifest?.tokenEstimate ?? null,
				clioSystemPromptHash: manifest?.systemPromptHash ?? null,
				clioSections: manifest?.sections ?? null,
				clioFragments: manifest?.fragments ?? null,
				wire: {
					toolCount: inventory.toolCount,
					toolNames: inventory.toolNames,
					systemChars: inventory.systemChars,
					payloadBytes: inventory.payloadBytes,
				},
				armReportedFirstTurnUsage: firstTurnUsageFromStream(run.stdout),
				components: attribution.components,
				unmeasured: attribution.unmeasured,
			});
		} finally {
			sandbox.dispose();
			await proxy.close();
		}
	}

	const path = writeEnvelopeArtifact(args.out, `${args.label}.envelope.json`, {
		schema: "clio.eval.prompt-ab.envelope.v1",
		label: args.label,
		arm: { checkout: arm.checkout, commit: arm.commit, buildHash: arm.buildHash },
		target: args.target,
		model: args.model,
		url: args.url,
		deep: args.deep,
		measuredAt: new Date().toISOString(),
		profiles: reports,
	});
	process.stderr.write(`\nwrote ${path}\n`);
	for (const report of reports) {
		process.stdout.write(
			`${String(report.profile).padEnd(14)} provider=${String(report.providerFirstTurnInputTokens ?? "n/a").padStart(7)}  ` +
				`prose=${String(report.clioTokenEstimate ?? "n/a").padStart(6)}  tools=${String(report.toolBlockTokens ?? "n/a").padStart(6)}  ` +
				`toolCount=${String((report.wire as Record<string, unknown> | undefined)?.toolCount ?? "n/a")}\n`,
		);
	}
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exitCode = 1;
});
