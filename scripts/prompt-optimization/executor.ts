/**
 * Turning one `clio-coder run --json` invocation into a scored observation.
 *
 * Two executors implement the same interface. The live one spawns an arm's
 * built CLI inside a fresh sandbox with every pinned flag on the command line;
 * the offline one replays recorded observations. Scoring, comparison, and
 * promotion never know which produced their input, so the offline tests
 * exercise the real code paths rather than a parallel fake.
 *
 * Origin attribution is explained at `toolCallsFrom`. The short version is that
 * the event family alone is not enough, because a dispatching run emits both
 * families for every call.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EvalServingConfigurationV1 } from "../../src/domains/eval/schema/serving.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import type {
	PromptAbArmIdentity,
	PromptAbPinnedConfig,
	PromptAbScenario,
	PromptAbStratum,
	PromptAbToolCallObservation,
	PromptAbTrialObservation,
} from "./contract.js";
import { createPromptAbSandbox, forbiddenStatePaths, workspaceMutations } from "./isolation.js";

export interface PromptAbTrialRequest {
	trialId: string;
	scenario: PromptAbScenario;
	arm: PromptAbArmIdentity;
	pinned: PromptAbPinnedConfig;
	stratum: PromptAbStratum;
	/** Fixed conversation prefix replayed before the scenario turn in the warm stratum. */
	warmPrefix: readonly string[];
}

export interface PromptAbTrialExecutor {
	execute(request: PromptAbTrialRequest): Promise<PromptAbTrialObservation>;
}

/** Replays recorded observations. Used by the offline tests and by `run.ts --dry-run`. */
export function createOfflineExecutor(
	observations: ReadonlyMap<string, PromptAbTrialObservation>,
): PromptAbTrialExecutor {
	return {
		async execute(request) {
			const observation = observations.get(request.trialId);
			if (observation === undefined) {
				throw new Error(`offline executor has no observation for trial ${request.trialId}`);
			}
			return observation;
		},
	};
}

export interface LiveExecutorOptions {
	/** Reset the serving cache before a cold trial. Null means the operator handles it out of band. */
	coldResetCommand: string | null;
	coldResetSettleMs: number;
	/** Capability names the arm actually has, used to detect an invented capability in the answer. */
	knownCapabilities: readonly string[];
}

export function createLiveExecutor(options: LiveExecutorOptions): PromptAbTrialExecutor {
	return {
		async execute(request) {
			const sandbox = createPromptAbSandbox(request.scenario, request.pinned, {
				armCheckout: request.arm.checkout,
				installSkills: request.scenario.runner.requiredSkills,
			});
			try {
				if (request.stratum === "cold" && options.coldResetCommand !== null) {
					await runShell(options.coldResetCommand, sandbox.workspace, 60_000);
					if (options.coldResetSettleMs > 0) await delay(options.coldResetSettleMs);
				}
				const turns =
					request.stratum === "warm"
						? [...request.warmPrefix, request.scenario.runner.prompt]
						: [request.scenario.runner.prompt];

				let stdout = "";
				let stderr = "";
				let exitCode = 0;
				let timedOut = false;
				let sessionId: string | null = null;
				const startedAt = Date.now();
				for (const [index, turn] of turns.entries()) {
					const args = buildArgs(request, turn, sessionId, index > 0);
					const result = await runNode(request.arm.entry, args, sandbox.workspace, sandbox.env, request.scenario.timeoutMs);
					stdout += result.stdout;
					stderr += result.stderr;
					exitCode = result.exitCode;
					timedOut = timedOut || result.timedOut;
					sessionId = sessionId ?? readSessionId(result.stderr, result.stdout);
					if (result.timedOut) break;
				}

				const stateDir = join(sandbox.home, "state");
				const calls = toolCallsFrom(stdout, sandbox.workspace, request.scenario.runner.agent !== null);
				const answerText = answerFrom(stdout);
				// Read before the sandbox is disposed: the prompt manifest is the
				// only place the compiled system prompt's hash and deterministic
				// token estimate exist, and both are the experiment's subject.
				const manifest = readPromptManifest(stateDir);
				return {
					exitCode,
					timedOut,
					wallTimeMs: Date.now() - startedAt,
					metrics: {
						...metricsFrom(stdout, calls, stateDir),
						...(manifest === null
							? {}
							: { "prompt.systemTokenEstimate": manifest.tokenEstimate, "prompt.contextWindow": manifest.contextWindow }),
					},
					toolCalls: calls,
					answerText,
					workspaceMutations: workspaceMutations(sandbox),
					foreignStatePaths: forbiddenStatePaths(sandbox, request.scenario),
					inventedCapabilities: inventedCapabilities(answerText, options.knownCapabilities),
					skills: {
						...skillsFrom(stdout, answerText),
						recipeBound: recipeBoundSkills(request.arm, request.scenario.runner.agent),
					},
					receipt: receiptFrom(stdout, stateDir),
					serving: servingFrom(request, manifest?.systemPromptHash ?? compiledPromptHashFrom(stdout)),
					transcript: `${stdout}\n--- stderr ---\n${stderr}`,
				};
			} finally {
				sandbox.dispose();
			}
		},
	};
}

function buildArgs(
	request: PromptAbTrialRequest,
	prompt: string,
	sessionId: string | null,
	continueSession: boolean,
): string[] {
	const { pinned, scenario } = request;
	const args = [
		"run",
		"--json",
		"--target",
		pinned.target,
		"--model",
		pinned.model,
		"--thinking",
		pinned.thinking,
		"--autonomy",
		scenario.runner.autonomy,
		"--temperature",
		String(pinned.sampling.temperature),
		"--top-p",
		String(pinned.sampling.topP),
		"--top-k",
		String(pinned.sampling.topK),
		"--min-p",
		String(pinned.sampling.minP),
		"--repeat-penalty",
		String(pinned.sampling.repeatPenalty),
		"--presence-penalty",
		String(pinned.sampling.presencePenalty),
		"--frequency-penalty",
		String(pinned.sampling.frequencyPenalty),
		"--max-context-tokens",
		String(pinned.maxContextTokens),
	];
	if (pinned.kvCacheMode !== null) args.push("--kv-cache-mode", pinned.kvCacheMode);
	if (pinned.toolProfile !== null) args.push("--tool-profile", pinned.toolProfile);
	if (scenario.runner.agent !== null) args.push("--agent", scenario.runner.agent);
	if (scenario.runner.noSkills) args.push("--no-skills");
	for (const skill of scenario.runner.skills) args.push("--skill", skill);
	if (continueSession && sessionId !== null) args.push("--session", sessionId);
	args.push(prompt);
	return args;
}

interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

function runNode(
	entry: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<ProcessResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [entry, ...args], {
			cwd,
			// A trial inherits PATH and the like but never the operator's Clio
			// state: the sandbox's five roots are the only CLIO_CODER_* values set.
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
			resolvePromise({ stdout, stderr, exitCode: code ?? -1, timedOut });
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolvePromise({ stdout, stderr: `${stderr}\nspawn failed`, exitCode: -1, timedOut });
		});
	});
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ProcessResult> {
	return new Promise((resolvePromise) => {
		const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ stdout, stderr, exitCode: code ?? -1, timedOut: false });
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolvePromise({ stdout, stderr, exitCode: -1, timedOut: false });
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/** Every JSON object on the stream, in order. Non-JSON lines are operator prose and are skipped. */
export function streamRecords(stdout: string): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];
	for (const line of stdout.split(/\r?\n/u)) {
		if (line.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				records.push(parsed as Record<string, unknown>);
			}
		} catch {
			// Not an event line.
		}
	}
	return records;
}

/**
 * Reduce the event stream to bounded call facts.
 *
 * `runIsWorker` is the scenario's own `--agent` setting. It is needed because
 * both event families are emitted for the same call - a dispatching run shows
 * 15 `tool_execution_*` and 15 `clio_coder_tool_*` events for 15 calls - so
 * deciding origin from the family alone collapses everything to "parent" and no
 * worker-origin gate ever fires. When the run *is* a dispatched agent, every
 * call is the worker's by construction. Otherwise a call seen on pi's stream is
 * the parent's, and one seen only on Clio's is a dispatched worker's.
 */
export function toolCallsFrom(stdout: string, cwd: string, runIsWorker = false): PromptAbToolCallObservation[] {
	const records = streamRecords(stdout);
	const starts = new Map<string, { tool: string; path: string | null; shapeKey: string }>();
	const calls: PromptAbToolCallObservation[] = [];
	const seen = new Set<string>();

	for (const record of records) {
		const type = record.type;
		if (type === "tool_execution_start" || type === "clio_coder_tool_start") {
			const payload = isRecord(record.payload) ? record.payload : record;
			const id = str(payload.toolCallId) ?? str(record.toolCallId);
			const tool = str(payload.toolName) ?? str(payload.tool);
			if (id === undefined || tool === undefined) continue;
			const args = isRecord(payload.args) ? payload.args : {};
			starts.set(id, { tool, path: normalizePath(cwd, args), shapeKey: `${tool}:${sha256(stableArgs(args))}` });
			continue;
		}
		const isPiEnd = type === "tool_execution_end";
		const isClioEnd = type === "clio_coder_tool_finish";
		if (!isPiEnd && !isClioEnd) continue;
		const payload = isRecord(record.payload) ? record.payload : record;
		const id = str(payload.toolCallId) ?? str(record.toolCallId);
		const started = id === undefined ? undefined : starts.get(id);
		const tool = str(payload.toolName) ?? str(payload.tool) ?? started?.tool;
		if (tool === undefined) continue;
		const key = id ?? `${tool}:${calls.length}`;
		if (seen.has(key)) continue;
		seen.add(key);
		calls.push({
			tool,
			outcome: outcomeOf(payload),
			origin: runIsWorker ? "worker" : isPiEnd ? "parent" : "worker",
			path: started?.path ?? null,
			shapeKey: started?.shapeKey ?? `${tool}:unknown`,
		});
	}
	return calls;
}

function outcomeOf(payload: Record<string, unknown>): "ok" | "error" | "blocked" {
	const outcome = payload.outcome;
	if (outcome === "ok" || outcome === "error" || outcome === "blocked") return outcome;
	return payload.isError === true ? "error" : "ok";
}

/**
 * The operator-facing answer text.
 *
 * It has to be folded from `text_delta` events, not read off `message_end`:
 * that event's content parts are *summaries* (`{type:"text", textLength:4}`)
 * with the prose stripped, so reading them yields an empty string and every
 * answer-matching gate silently passes or fails on nothing. `thinking_delta`
 * is deliberately excluded — reasoning is not the answer, and a gate that
 * matched against it would be reading the model's scratchpad.
 */
export function answerFrom(stdout: string): string {
	const texts: string[] = [];
	for (const record of streamRecords(stdout)) {
		if (record.type === "text_delta") {
			if (typeof record.delta === "string") texts.push(record.delta);
			continue;
		}
		if (record.type !== "message_end") continue;
		const message = isRecord(record.message) ? record.message : undefined;
		if (message === undefined || message.role !== "assistant") continue;
		// A non-streaming surface still carries the whole string here.
		if (typeof message.content === "string") texts.push(message.content);
	}
	return texts.join("");
}

function metricsFrom(
	stdout: string,
	calls: readonly PromptAbToolCallObservation[],
	stateDir: string,
): Record<string, number> {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let measured = 0;
	for (const record of streamRecords(stdout)) {
		if (record.type !== "message_end") continue;
		const message = isRecord(record.message) ? record.message : undefined;
		const usage = message !== undefined && isRecord(message.usage) ? message.usage : undefined;
		if (usage === undefined) continue;
		measured = 1;
		input += num(usage.input) ?? 0;
		output += num(usage.output) ?? 0;
		cacheRead += num(usage.cacheRead) ?? num(usage.cache_read_input_tokens) ?? 0;
		cacheWrite += num(usage.cacheWrite) ?? num(usage.cache_creation_input_tokens) ?? 0;
	}
	const total = input + output;
	return {
		"tokens.input": input,
		"tokens.output": output,
		"tokens.total": total,
		"tokens.cacheRead": cacheRead,
		"tokens.cacheWrite": cacheWrite,
		"tokens.measured": measured,
		"tokens.cacheReadRatio": input > 0 ? cacheRead / input : 0,
		"tools.totalCalls": calls.length,
		"tools.failed": calls.filter((call) => call.outcome === "error").length,
		"tools.blocked": calls.filter((call) => call.outcome === "blocked").length,
		// Claim auditing needs a sealed receipt; with none, this stays absent so
		// a gate on it fails closed rather than reading silence as clean.
		...claimsMetric(stdout, stateDir),
	};
}

/**
 * `claims.unsupported` counts sealed receipts that reported success with no
 * typed validation behind them. It is emitted only when a receipt exists, so a
 * gate on it stays unresolved - and therefore fails closed - rather than
 * reading "no receipt" as "no unsupported claim".
 */
function claimsMetric(stdout: string, stateDir: string): Record<string, number> {
	const receipt = receiptFrom(stdout, stateDir);
	if (receipt === null) return {};
	return { "claims.unsupported": receipt.claimedVerifiedWithoutEvidence ? 1 : 0 };
}

/**
 * Skill activity, read from `context` tool-call arguments and the answer text.
 *
 * There are no skill-typed stream events; looking for them found nothing and
 * `loads-exactly-the-named-skill` read 0-pass in both arms on trials where the
 * model had in fact loaded the skill correctly. The real signals are:
 *
 *   - loaded:    context({scope:"skills", name:<skill>})
 *   - listed:    context({scope:"skills"}) with no name
 *   - suggested: the answer proposing `/skill <name>` to the operator
 *   - offered:   a `[Marketplace]` offer surfaced in the answer
 *   - install:   a context call carrying an install action
 */
export function skillsFrom(
	stdout: string,
	answerText: string,
): Omit<PromptAbTrialObservation["skills"], "recipeBound"> {
	const loaded = new Set<string>();
	let installAttempts = 0;
	for (const record of streamRecords(stdout)) {
		if (record.type !== "tool_execution_start" && record.type !== "clio_coder_tool_start") continue;
		const payload = isRecord(record.payload) ? record.payload : record;
		const tool = str(payload.toolName) ?? str(payload.tool);
		if (tool !== "context") continue;
		const args = isRecord(payload.args) ? payload.args : {};
		if (args.scope !== "skills") continue;
		const name = str(args.name);
		if (name !== undefined) loaded.add(name);
		const action = str(args.action);
		if (action !== undefined && /install/iu.test(action)) installAttempts += 1;
	}
	const suggested = new Set<string>();
	for (const match of answerText.matchAll(/\/skill\s+([a-z0-9][a-z0-9-]{1,63})/giu)) {
		const name = match[1];
		// A suggestion the run also loaded is the operator's own request echoed
		// back, not an unsolicited proposal.
		if (name !== undefined && !loaded.has(name)) suggested.add(name);
	}
	return {
		loaded: [...loaded].sort(),
		suggested: [...suggested].sort(),
		marketplaceOffers: [...answerText.matchAll(/\[Marketplace\]/gu)].length,
		installAttempts,
	};
}

function receiptFromStream(stdout: string): Record<string, unknown> | null {
	for (const record of [...streamRecords(stdout)].reverse()) {
		if (isRecord(record.receipt)) return record.receipt;
		if (isRecord(record.integrity) && typeof record.runId === "string") return record;
	}
	return null;
}

/**
 * Sealed receipts for this trial, read from the sandbox's own state directory.
 *
 * They are not on stdout. A `--agent` run prints its terminal receipt there in
 * some surfaces, but a main-agent run that dispatches does not, and the trial
 * scenarios that care about receipts are mostly the second kind. Reading
 * `<state>/receipts/*.json` — where dispatch actually seals them — is what makes
 * the receipt gates resolve at all instead of failing closed on every trial in
 * both arms.
 */
function readSealedReceipts(stateDir: string): Array<Record<string, unknown>> {
	const dir = join(stateDir, "receipts");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const receipts: Array<Record<string, unknown>> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (isRecord(parsed)) receipts.push(parsed);
		} catch {
			// An unreadable receipt contributes no invented measurement.
		}
	}
	return receipts;
}

function receiptFrom(stdout: string, stateDir: string): PromptAbTrialObservation["receipt"] {
	const sealed = readSealedReceipts(stateDir);
	const fromStdout = receiptFromStream(stdout);
	const receipts = sealed.length > 0 ? sealed : fromStdout === null ? [] : [fromStdout];
	if (receipts.length === 0) return null;

	let allSealed = true;
	let allValid = true;
	let anyValidation = false;
	let claimedWithoutEvidence = false;
	let contractValid = true;
	let spotChecks = 0;
	for (const receipt of receipts) {
		const integrity = isRecord(receipt.integrity) ? receipt.integrity : {};
		const quality = isRecord(receipt.quality) ? receipt.quality : {};
		const validations = Array.isArray(quality.typedValidations) ? quality.typedValidations : [];
		const digest = integrity.digest;
		if (typeof digest !== "string" || digest.length === 0) allSealed = false;
		if (integrity.valid === false) allValid = false;
		if (validations.length > 0) anyValidation = true;
		// A success outcome with no typed validation behind it is a claim the run
		// did not evidence. `quality: "unmeasured"` says the same thing directly.
		if (validations.length === 0 && (receipt.outcome === "success" || quality.quality === "unmeasured")) {
			claimedWithoutEvidence = true;
		}
		if (receipt.resultContractValid === false) contractValid = false;
		spotChecks += num(receipt.parentSpotChecks) ?? 0;
	}
	return {
		count: receipts.length,
		sealed: allSealed,
		integrityValid: allValid,
		evidenceStatus: anyValidation ? "verified" : "unverified",
		claimedVerifiedWithoutEvidence: claimedWithoutEvidence,
		parentSpotChecks: spotChecks,
		resultContractValid: contractValid,
	};
}

/**
 * The compiled system prompt's identity and deterministic size, read from the
 * session's prompt manifest.
 *
 * This is the experiment's actual subject. `tokens.input` confounds the prompt
 * with how many turns and tool results a run accumulated, so a run that made
 * more calls looks more expensive even under a smaller prompt. The manifest's
 * `tokenEstimate` is the per-turn system-prompt size on its own, which is the
 * quantity the audit's 13.3% main / 10.7% worker predictions are about.
 */
function readPromptManifest(
	stateDir: string,
): { systemPromptHash: string; tokenEstimate: number; contextWindow: number } | null {
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
	let latest: { systemPromptHash: string; tokenEstimate: number; contextWindow: number } | null = null;
	for (const file of files) {
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split(/\r?\n/u)) {
			if (line.trim().length === 0) continue;
			try {
				const record: unknown = JSON.parse(line);
				if (!isRecord(record)) continue;
				const hash = record.systemPromptHash;
				const estimate = record.tokenEstimate;
				if (typeof hash !== "string" || typeof estimate !== "number") continue;
				latest = {
					systemPromptHash: hash,
					tokenEstimate: estimate,
					contextWindow: num(record.contextWindow) ?? 0,
				};
			} catch {
				// A torn manifest line contributes nothing.
			}
		}
	}
	return latest;
}

function servingFrom(request: PromptAbTrialRequest, compiled: string | null): EvalServingConfigurationV1 {
	return {
		targetId: request.pinned.target,
		runtimeId: request.pinned.runtime,
		modelId: request.pinned.model,
		serverBuild: null,
		total_slots: request.pinned.serverConcurrency,
		thinkingLevel: request.pinned.thinking,
		compiledPromptHash: compiled,
	};
}

function compiledPromptHashFrom(stdout: string): string | null {
	for (const record of streamRecords(stdout)) {
		const payload = isRecord(record.payload) ? record.payload : record;
		for (const field of ["systemPromptHash", "compiledPromptHash", "staticCompositionHash", "promptHash"]) {
			const value = payload[field];
			if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) return value;
		}
	}
	return null;
}

/**
 * Capability names the answer presents as available that the arm does not have.
 *
 * The match is deliberately narrow: a backticked or bare identifier that looks
 * like a tool name and is not in the inventory. Anything looser starts flagging
 * ordinary prose, and a gate that fires on prose is worse than no gate.
 */
export function inventedCapabilities(answerText: string, known: readonly string[]): string[] {
	const inventory = new Set(known);
	const found = new Set<string>();
	for (const match of answerText.matchAll(/`([a-z][a-z0-9_]{2,31})`/gu)) {
		const name = match[1];
		if (name === undefined) continue;
		// Only names shaped like this codebase's tool ids, and only when the
		// answer is asserting the capability rather than denying it.
		if (!/^[a-z]+(_[a-z0-9]+)+$/u.test(name)) continue;
		if (inventory.has(name)) continue;
		found.add(name);
	}
	return [...found].sort();
}

function normalizePath(cwd: string, args: Record<string, unknown>): string | null {
	for (const field of ["path", "filePath", "file_path", "name"]) {
		const value = args[field];
		if (typeof value !== "string" || value.length === 0 || value.length > 4096) continue;
		const absolute = resolve(cwd, value);
		const local = relative(cwd, absolute);
		if (isAbsolute(value) && (local.startsWith("..") || isAbsolute(local))) return value.split(sep).join("/");
		return (local || ".").split(sep).join("/");
	}
	return null;
}

function stableArgs(args: Record<string, unknown>): string {
	return JSON.stringify(Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right))));
}

function readSessionId(stderr: string, stdout: string): string | null {
	for (const record of streamRecords(stdout)) {
		if (record.type === "session" && typeof record.id === "string") return record.id;
		if (typeof record.sessionId === "string") return record.sessionId;
	}
	const match = stderr.match(/session[:\s]+([0-9a-zA-Z_-]{6,})/u);
	return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Tool ids the arm actually exposes, read from its own `ToolNames` table.
 *
 * The catalog file was the wrong source: it keys entries by the `ToolNames.X`
 * constant and only ever mentions an id inside prose, so scraping it produced
 * an inventory that omitted real tools and the gate then flagged `code_nav` as
 * invented. `src/core/tool-names.ts` is the declaration, so it is what gets
 * read. An empty inventory disables the check rather than failing every answer.
 */
/**
 * Skills the dispatched recipe binds, read from the arm's own recipe file.
 *
 * The corpus used to carry this as a literal and was wrong: it expected
 * `clio-coder-dev` from the `coder` recipe, which binds `fix-issue` and `ship`.
 * Six trials recorded `loads-only-the-bound-skill` as a failure while the
 * transcripts show the worker loading exactly the two skills its recipe names.
 *
 * The arm is the right source twice over. It is where the recipe actually is,
 * and recipe descriptors are themselves under test, so an expectation shared
 * between arms would erase half of any treatment that moved one. A recipe that
 * cannot be read returns null so the gate reports unresolved instead of
 * inventing an expectation, matching how every other unreadable input is
 * handled here.
 */
export function recipeBoundSkills(arm: PromptAbArmIdentity, agent: string | null): string[] | null {
	if (agent === null) return null;
	const candidates = [
		join(arm.checkout, "src/domains/agents/builtins", `${agent}.md`),
		join(arm.checkout, "src/domains/agents/fleets", `${agent}.md`),
	];
	for (const path of candidates) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)?.[1];
		if (frontmatter === undefined) continue;
		// Only the inline `skills: [a, b]` form the builtin recipes use. A block
		// list would need a YAML parser, and guessing at one would be exactly the
		// confident-wrong reading this harness keeps getting caught by.
		const inline = /^skills:\s*\[(.*?)\]\s*$/mu.exec(frontmatter);
		if (inline === null) return null;
		return (inline[1] as string)
			.split(",")
			.map((name) => name.trim().replace(/^["']|["']$/gu, ""))
			.filter((name) => name.length > 0);
	}
	return null;
}

export function knownCapabilities(arm: PromptAbArmIdentity): string[] {
	try {
		const source = readFileSync(join(arm.checkout, "src/core/tool-names.ts"), "utf8");
		const names = [...source.matchAll(/^\s*[A-Za-z]+:\s*"([a-z][a-z0-9_]*)",/gmu)].map((match) => match[1] as string);
		return [...new Set(names)];
	} catch {
		return [];
	}
}
