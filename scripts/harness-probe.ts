/**
 * Drive natural operator requests through the built ACP harness, live.
 *
 * This calls live models using the operator's own settings and credentials and
 * is never part of CI. Each case/run copies only settings.yaml and credentials.yaml
 * into a fresh scratch home, so OAuth refreshes cannot write to the real home.
 *
 * node --import tsx scripts/harness-probe.ts <fixture.json> --condition <name> [--runs 3] [--out <dir>] [--only <caseId>] [--chat-target <id>] [--chat-model <model>] [--bind-turn <engine>]
 * Route and System One binding overrides rewrite only the scratch settings copy.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { safeResourceWrite } from "../src/core/safe-resource-write.js";
import { resolveClioDirs } from "../src/core/xdg.js";

export interface ProbeTurn {
	text: string;
	expect: { control: "orientation" | "direction" | "none"; dispatch: boolean | null };
}

export interface ProbeFixture {
	description: string;
	project: string;
	cases: Array<{ id: string; turns: ProbeTurn[] }>;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ProbeSettingsOptions {
	chatTarget?: string;
	chatModel?: string;
	/** A `systemOne.engines` name to bind to the `turn` site in the scratch copy. */
	bindTurn?: string;
}

export function rewriteProbeSettings(text: string, options: ProbeSettingsOptions) {
	const document = parseDocument(text);
	if (document.errors.length > 0) throw document.errors[0];
	const settings: unknown = document.toJS();
	if (!record(settings)) throw new Error("probe settings must be a YAML map");
	const targets = Array.isArray(settings.targets) ? settings.targets.filter(record) : [];
	if (options.chatTarget !== undefined && !targets.some((target) => target.id === options.chatTarget))
		throw new Error(`chat target '${options.chatTarget}' is not defined in copied settings.targets`);
	if (options.bindTurn !== undefined) {
		const engines = record(settings.systemOne) ? settings.systemOne.engines : undefined;
		if (!record(engines) || !Object.hasOwn(engines, options.bindTurn))
			throw new Error(`turn-site engine '${options.bindTurn}' is not defined in copied systemOne.engines`);
		document.setIn(["systemOne", "sites", "turn"], options.bindTurn);
	}
	if (options.chatTarget !== undefined) document.setIn(["chat", "target"], options.chatTarget);
	if (options.chatModel !== undefined) document.setIn(["chat", "model"], options.chatModel);
	const rewritten: unknown = document.toJS();
	const chat = record(rewritten) ? rewritten.chat : undefined;
	const chatTarget = record(chat) && typeof chat.target === "string" ? chat.target : null;
	const target = targets.find((entry) => entry.id === chatTarget);
	const chatModel =
		chatTarget === null
			? null
			: record(chat) && typeof chat.model === "string"
				? chat.model
				: typeof target?.defaultModel === "string"
					? target.defaultModel
					: Array.isArray(target?.wireModels) && typeof target.wireModels[0] === "string"
						? target.wireModels[0]
						: null;
	return { settingsYaml: document.toString(), chatTarget, chatModel };
}

export function loadProbeFixture(text: string): ProbeFixture {
	const value: unknown = JSON.parse(text);
	if (!record(value) || typeof value.description !== "string" || typeof value.project !== "string" || !value.project)
		throw new Error("fixture needs description, project, and cases");
	if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error("fixture needs nonempty cases");
	const ids = new Set<string>();
	for (const entry of value.cases) {
		if (!record(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id))
			throw new Error("fixture case ids must be unique nonempty strings");
		ids.add(entry.id);
		if (!Array.isArray(entry.turns) || entry.turns.length === 0) throw new Error(`case ${entry.id} needs turns`);
		for (const turn of entry.turns) {
			if (
				!record(turn) ||
				typeof turn.text !== "string" ||
				!record(turn.expect) ||
				!["orientation", "direction", "none"].includes(String(turn.expect.control)) ||
				!(turn.expect.dispatch === null || typeof turn.expect.dispatch === "boolean")
			)
				throw new Error(`case ${entry.id} has an invalid turn`);
		}
	}
	return value as unknown as ProbeFixture;
}

/** Associate by user identity/ancestry, so a missing middle outcome cannot shift later turns. */
export function pairProbeTurns(turns: ReadonlyArray<ProbeTurn>, ledgerText: string) {
	const users: Array<{ id: string; turnOutcome: unknown; turnControl: unknown }> = [];
	const owners = new Map<string, (typeof users)[number]>();
	let current: (typeof users)[number] | undefined;
	for (const line of ledgerText.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const entry: unknown = JSON.parse(line);
		if (!record(entry)) continue;
		const synthetic = record(entry.payload) && entry.payload.synthetic === true;
		if (entry.kind === "message" && entry.role === "user" && !synthetic && typeof entry.turnId === "string") {
			current = { id: entry.turnId, turnOutcome: null, turnControl: null };
			users.push(current);
		}
		const owner =
			entry.kind === "message" && entry.role === "user"
				? current
				: ((typeof entry.parentTurnId === "string" ? owners.get(entry.parentTurnId) : undefined) ?? current);
		if (typeof entry.turnId === "string" && owner) owners.set(entry.turnId, owner);
		if (entry.kind !== "custom" || (entry.customType !== "turnOutcome" && entry.customType !== "turnControl")) continue;
		const userId = record(entry.data) && typeof entry.data.turnId === "string" ? entry.data.turnId : undefined;
		const target = userId === undefined ? owner : users.find((user) => user.id === userId);
		if (target) target[entry.customType] = entry.data ?? null;
	}
	return turns.map((turn, turnIndex) => ({
		turnIndex,
		text: turn.text,
		expect: turn.expect,
		turnOutcome: users[turnIndex]?.turnOutcome ?? null,
		turnControl: users[turnIndex]?.turnControl ?? null,
	}));
}

interface Intervention {
	tool?: string;
	actionClass?: string;
}

interface ObservedTurn {
	stopReason: string | null;
	answer: string;
	interventions: Intervention[];
	wallMs: number;
}

class AcpClient {
	private nextId = 1;
	private buffer = "";
	private stderr = "";
	private ended = false;
	private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly exit: Promise<void>;
	readonly turn: ObservedTurn = { stopReason: null, answer: "", interventions: [], wallMs: 0 };

	constructor(private readonly child: ChildProcessWithoutNullStreams) {
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (text: string) => {
			try {
				this.consume(text);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		child.stderr.on("data", (text: string) => {
			this.stderr = (this.stderr + text).slice(-16_000);
		});
		child.on("error", (error) => this.fail(error));
		child.stdin.on("error", (error) => this.fail(error));
		this.exit = new Promise((done) => {
			child.once("close", (code, signal) => {
				this.ended = true;
				this.fail(new Error(`ACP exited (${code ?? signal}); ${this.stderr}`));
				done();
			});
		});
	}

	private fail(error: Error): void {
		for (const waiter of this.pending.values()) waiter.reject(error);
		this.pending.clear();
	}

	private consume(text: string): void {
		this.buffer += text;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) continue;
			const frame: unknown = JSON.parse(line);
			if (!record(frame)) throw new Error("invalid ACP frame");
			if (typeof frame.id === "number" && ("result" in frame || "error" in frame)) {
				const waiter = this.pending.get(frame.id);
				this.pending.delete(frame.id);
				if (frame.error) waiter?.reject(new Error(JSON.stringify(frame.error)));
				else waiter?.resolve(frame.result);
			} else if ((typeof frame.id === "number" || typeof frame.id === "string") && typeof frame.method === "string") {
				const params = record(frame.params) ? frame.params : {};
				if (frame.method !== "session/request_permission") {
					this.child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unsupported client method" } })}\n`,
					);
					continue;
				}
				const call = record(params.toolCall) ? params.toolCall : {};
				const meta = record(params._meta) ? params._meta : {};
				const decision = record(meta["clio-coder/decision"]) ? meta["clio-coder/decision"] : {};
				const tool = params.tool ?? decision.tool ?? call.title;
				const actionClass = params.actionClass ?? decision.actionClass;
				this.turn.interventions.push({
					...(typeof tool === "string" ? { tool } : {}),
					...(typeof actionClass === "string" ? { actionClass } : {}),
				});
				const option = Array.isArray(params.options)
					? params.options.find((value: unknown) => record(value) && value.kind === "allow_once")
					: undefined;
				const outcome =
					record(option) && typeof option.optionId === "string"
						? { outcome: "selected", optionId: option.optionId }
						: { outcome: "cancelled" };
				this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { outcome } })}\n`);
			} else if (frame.method === "session/update" && record(frame.params) && record(frame.params.update)) {
				const update = frame.params.update;
				if (
					update.sessionUpdate === "agent_message_chunk" &&
					record(update.content) &&
					typeof update.content.text === "string"
				)
					this.turn.answer += update.content.text;
			}
		}
	}

	request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
		if (this.ended) return Promise.reject(new Error(`ACP already exited; ${this.stderr}`));
		const id = this.nextId++;
		return new Promise<T>((done, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out; ${this.stderr}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					done(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	async prompt(sessionId: string, text: string): Promise<ObservedTurn> {
		this.turn.answer = "";
		this.turn.interventions = [];
		this.turn.stopReason = null;
		const started = performance.now();
		try {
			const result = await this.request<{ stopReason: string }>(
				"session/prompt",
				{
					sessionId,
					prompt: [{ type: "text", text }],
				},
				600_000,
			);
			this.turn.stopReason = result.stopReason;
			return this.turn;
		} finally {
			this.turn.wallMs = performance.now() - started;
		}
	}

	async dispose(): Promise<void> {
		this.child.stdin.end();
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
		try {
			await this.exit;
		} finally {
			clearTimeout(timer);
		}
	}
}

function scratchHome(configDir: string, options: ProbeSettingsOptions) {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-harness-probe-"));
	try {
		for (const role of ["config", "data", "state", "cache"]) mkdirSync(join(root, role));
		for (const name of ["settings.yaml", "credentials.yaml"]) {
			const source = join(configDir, name);
			if (existsSync(source)) {
				const target = join(root, "config", name);
				copyFileSync(source, target);
				chmodSync(target, 0o600);
			}
		}
		const settingsPath = join(root, "config", "settings.yaml");
		const route = rewriteProbeSettings(readFileSync(settingsPath, "utf8"), options);
		if (options.chatTarget !== undefined || options.chatModel !== undefined || options.bindTurn !== undefined)
			safeResourceWrite(settingsPath, route.settingsYaml, { mode: 0o600 });
		return {
			root,
			route,
			state: join(root, "state"),
			env: {
				...process.env,
				CLIO_CODER_HOME: root,
				CLIO_CODER_CONFIG_DIR: join(root, "config"),
				CLIO_CODER_DATA_DIR: join(root, "data"),
				CLIO_CODER_STATE_DIR: join(root, "state"),
				CLIO_CODER_CACHE_DIR: join(root, "cache"),
				NODE_ENV: "test",
				NO_COLOR: "1",
			},
		};
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function ledger(state: string, sessionId: string): string {
	const sessions = join(state, "sessions");
	if (!existsSync(sessions)) return "";
	for (const dir of readdirSync(sessions, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const path = join(sessions, dir.name, sessionId, "current.jsonl");
		if (existsSync(path)) return readFileSync(path, "utf8");
	}
	return "";
}

function mean(values: number[]): string {
	return values.length === 0 ? "n/a" : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2);
}

function outcomeNumber(outcome: unknown, field: "calls" | "tokens"): number | undefined {
	if (!record(outcome)) return undefined;
	if (field === "calls")
		return record(outcome.coordinator) && typeof outcome.coordinator.toolCalls === "number"
			? outcome.coordinator.toolCalls
			: undefined;
	if (!record(outcome.tokens)) return undefined;
	const splits = [outcome.tokens.coordinator, outcome.tokens.decisionModel, outcome.tokens.workers];
	return splits.every((split) => record(split) && typeof split.totalTokens === "number")
		? splits.reduce((sum: number, split) => sum + (split as { totalTokens: number }).totalTokens, 0)
		: undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const fixturePath = args[0];
	const options = new Map<string, string>();
	for (let index = 1; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (
			!flag ||
			!["--condition", "--runs", "--out", "--only", "--chat-target", "--chat-model", "--bind-turn"].includes(flag) ||
			!value ||
			value.startsWith("--")
		)
			throw new Error(
				"usage: harness-probe.ts <fixture.json> --condition <name> [--runs 3] [--out <dir>] [--only <caseId>] [--chat-target <id>] [--chat-model <model>] [--bind-turn <engine>]",
			);
		options.set(flag, value);
	}
	const condition = options.get("--condition");
	const runs = Number(options.get("--runs") ?? 3);
	if (
		!fixturePath ||
		fixturePath.startsWith("--") ||
		!condition ||
		!/^[\w-]+$/.test(condition) ||
		!Number.isSafeInteger(runs) ||
		runs < 1
	)
		throw new Error("provide a fixture, a filename-safe condition, and a positive integer run count");
	const fixture = loadProbeFixture(readFileSync(fixturePath, "utf8"));
	const cases = fixture.cases.filter(
		(entry) => options.get("--only") === undefined || entry.id === options.get("--only"),
	);
	if (cases.length === 0) throw new Error("--only does not match a fixture case");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const cli = join(root, "dist", "cli", "index.js");
	if (!existsSync(cli)) throw new Error("build the worktree before running the live probe");
	const project = fixture.project === "self" ? root : resolve(root, fixture.project);
	const fixtureName = basename(fixturePath, ".json");
	const out = options.get("--out") ?? join(tmpdir(), "clio-coder-harness-probe");
	const output = join(out, `${new Date().toISOString().slice(0, 10)}-${condition}-${fixtureName}.jsonl`);
	let contents = existsSync(output) ? readFileSync(output, "utf8") : "";
	const configDir = resolveClioDirs().config;
	const chatTarget = options.get("--chat-target");
	const chatModel = options.get("--chat-model");
	const bindTurn = options.get("--bind-turn");
	const settingsOptions: ProbeSettingsOptions = {
		...(chatTarget !== undefined ? { chatTarget } : {}),
		...(chatModel !== undefined ? { chatModel } : {}),
		...(bindTurn !== undefined ? { bindTurn } : {}),
	};
	// Refuse unknown routes or profiles before starting any case, not as repeated live-run failures.
	const effectiveRoute = rewriteProbeSettings(readFileSync(join(configDir, "settings.yaml"), "utf8"), settingsOptions);
	const summary: string[] = [
		`chatTarget: ${JSON.stringify(effectiveRoute.chatTarget)} | chatModel: ${JSON.stringify(effectiveRoute.chatModel)}`,
		"case | runs | turns | mean interventions | mean coordinator tool calls | mean total tokens",
		"--- | --- | --- | --- | --- | ---",
	];
	for (const entry of cases) {
		const interventions: number[] = [];
		const calls: number[] = [];
		const tokens: number[] = [];
		for (let runIndex = 0; runIndex < runs; runIndex += 1) {
			let home: ReturnType<typeof scratchHome> | undefined;
			let client: AcpClient | undefined;
			let sessionId: string | null = null;
			const observed: ObservedTurn[] = [];
			let error: string | undefined;
			let ledgerText = "";
			try {
				home = scratchHome(configDir, settingsOptions);
				client = new AcpClient(
					spawn(process.execPath, [cli, "acp", "--cwd", project], {
						cwd: root,
						env: home.env,
						stdio: ["pipe", "pipe", "pipe"],
					}),
				);
				await client.request("initialize", { protocolVersion: 1 });
				const session = await client.request<{ sessionId: string }>("session/new", { cwd: project, mcpServers: [] });
				sessionId = session.sessionId;
				for (const turn of entry.turns) {
					try {
						await client.prompt(sessionId, turn.text);
					} finally {
						observed.push({ ...client.turn, interventions: [...client.turn.interventions] });
					}
				}
			} catch (failure) {
				error = failure instanceof Error ? failure.message : String(failure);
			} finally {
				try {
					if (client && sessionId) await client.request("session/close", { sessionId });
				} catch (failure) {
					error ??= failure instanceof Error ? failure.message : String(failure);
				}
				try {
					await client?.dispose();
					if (home && sessionId) ledgerText = ledger(home.state, sessionId);
				} catch (failure) {
					error ??= failure instanceof Error ? failure.message : String(failure);
				} finally {
					if (home) rmSync(home.root, { recursive: true, force: true });
				}
			}
			let paired: ReturnType<typeof pairProbeTurns>;
			try {
				paired = pairProbeTurns(entry.turns, ledgerText);
			} catch (failure) {
				error ??= failure instanceof Error ? failure.message : String(failure);
				paired = pairProbeTurns(entry.turns, "");
			}
			for (const turn of paired) {
				const observation = observed[turn.turnIndex];
				const row = {
					condition,
					chatTarget: (home?.route ?? effectiveRoute).chatTarget,
					chatModel: (home?.route ?? effectiveRoute).chatModel,
					fixture: fixtureName,
					caseId: entry.id,
					runIndex,
					...turn,
					stopReason: observation?.stopReason ?? null,
					answer: Array.from(observation?.answer ?? "")
						.slice(0, 2000)
						.join(""),
					interventions: observation?.interventions ?? [],
					wallMs: observation?.wallMs ?? null,
					sessionId,
					...(error !== undefined ? { error } : {}),
				};
				contents += `${JSON.stringify(row)}\n`;
				if (observation) interventions.push(observation.interventions.length);
				const toolCalls = outcomeNumber(turn.turnOutcome, "calls");
				const totalTokens = outcomeNumber(turn.turnOutcome, "tokens");
				if (toolCalls !== undefined) calls.push(toolCalls);
				if (totalTokens !== undefined) tokens.push(totalTokens);
			}
			safeResourceWrite(output, contents);
		}
		summary.push(
			`${entry.id} | ${runs} | ${entry.turns.length * runs} | ${mean(interventions)} | ${mean(calls)} | ${mean(tokens)}`,
		);
	}
	process.stdout.write(`${summary.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
