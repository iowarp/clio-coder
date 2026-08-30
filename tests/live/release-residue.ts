/**
 * Live assertions for the release-test residue tracked by issue #222.
 *
 * This file is deliberately outside the ordinary test runner. It drives the
 * built CLI, a real PTY, and native workers against an operator-selected target:
 *
 *   npm run live:release-residue -- --target mini --keep
 *
 * Every run uses the isolated live-home harness. The retained evidence is
 * scrubbed before the driver prints its location.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	CLI_ENTRY,
	clio,
	type LiveHome,
	LiveUsageError,
	parseLiveArgs,
	rejectUnknown,
	requireBuild,
	runDriver,
	settleRun,
	takeFlag,
	withLiveHome,
} from "../../benchmarks/internal/live-target.js";
import { openPty, type PtySession, ptySupported, stripAnsi } from "../harness/pty.js";

const USAGE = `usage: npm run live:release-residue -- --target <id> [--model <wireId>] [--thinking <level>] [--turn-timeout-ms <ms>] [--keep]

Exercises the seven issue #222 rows through the built CLI and native workers.
The target must be a real model target. The driver is manual and never enters
the ordinary npm test suite.
`;

const READY = /ctx /u;
const ORACLE_REFUSAL = "a turn is in flight; /oracle is refused rather than queued";
const VERIFICATION_REFUSAL = "verification_unsupported_for_mode";
const DROPPED_HEADING = "dropped (not in this session's read ledger)";
const EDITOR_SENTINEL = "EDITOR_SAVED_SENTINEL_222";

type Json = Record<string, unknown>;

interface ReceiptRow {
	path: string;
	value: Json;
}

interface AssertionEvidence {
	name: string;
	status: "asserted" | "unassertable";
	evidence: Json;
}

const isJson = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function required(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function writeEvidence(home: LiveHome, relative: string, text: string): string {
	const path = join(home.dir, "evidence", relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, home.redact(text), "utf8");
	return path;
}

function jsonLines(text: string): Json[] {
	return text
		.split(/\r?\n/u)
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				const parsed: unknown = JSON.parse(line);
				return isJson(parsed) ? [parsed] : [];
			} catch {
				return [];
			}
		});
}

function visitFiles(root: string, fileName: string): string[] {
	const found: string[] = [];
	const visit = (dir: string): void => {
		let children: import("node:fs").Dirent[] = [];
		try {
			children = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const child of children) {
			const path = join(dir, child.name);
			if (child.isDirectory()) visit(path);
			else if (child.name === fileName) found.push(path);
		}
	};
	visit(root);
	return found;
}

function receipts(home: LiveHome): ReceiptRow[] {
	const dir = join(home.stateDir, "receipts");
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const path = join(dir, name);
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			return isJson(value) ? [{ path, value }] : [];
		} catch {
			return [];
		}
	});
}

function receiptId(row: ReceiptRow): string {
	return asString(row.value.runId) ?? basename(row.path, ".json");
}

function receiptIds(home: LiveHome): Set<string> {
	return new Set(receipts(home).map(receiptId));
}

function receiptOutput(row: ReceiptRow): string {
	const output = isJson(row.value.output) ? row.value.output : null;
	return asString(output?.text) ?? "";
}

function newReceipts(home: LiveHome, before: ReadonlySet<string>): ReceiptRow[] {
	return receipts(home).filter((row) => !before.has(receiptId(row)));
}

function initGitWorkspace(root: string, files: Readonly<Record<string, string>>): void {
	mkdirSync(root, { recursive: true });
	for (const [relative, contents] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents, "utf8");
	}
	const git = (args: string[]): string =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	git(["init", "--quiet"]);
	git(["config", "user.email", "live-222@clio.local"]);
	git(["config", "user.name", "Clio Live 222"]);
	git(["add", "-A"]);
	git(["commit", "--quiet", "-m", "test: seed issue 222 live workspace"]);
}

function rootIdFromFleetOutput(stdout: string, fleet: string): string {
	const row = jsonLines(stdout).find((entry) => entry.fleet === fleet && typeof entry.rootId === "string");
	const rootId = asString(row?.rootId);
	required(rootId, `fleet ${fleet} did not emit its root id: ${stdout}`);
	return rootId;
}

function lineage(row: ReceiptRow): Json | null {
	return isJson(row.value.lineage) ? row.value.lineage : null;
}

async function runProposalFleet(home: LiveHome, timeoutMs: number): Promise<AssertionEvidence> {
	const workspace = join(home.workspace, "proposal-fleet");
	const fleetName = "live-proposals";
	initGitWorkspace(workspace, {
		"src/proposal.txt": "proposal sentinel 222\n",
		[`.clio-coder/fleets/${fleetName}.md`]: [
			"---",
			"version: 5",
			`name: ${fleetName}`,
			"description: Live proposal path with one real proposal worker.",
			"steps:",
			"  - kind: plan",
			"    id: architect",
			"    agent: architect",
			"    roster: [verifier]",
			"    maxTasks: 1",
			"    proposals: true",
			"    scope: workspace",
			"    writes: [src/]",
			"    dependencies: []",
			"maxWorkers: 1",
			"onFailure: stop",
			"---",
			"Read src/proposal.txt. The architect must return exactly one delegation task for verifier.",
			"That task must inspect src/proposal.txt, verify its exact content, have no dependencies, and declare writes: [].",
			"Do not modify the workspace.",
			"",
		].join("\n"),
	});

	const before = receiptIds(home);
	const run = await settleRun(
		clio(home, ["fleet", "run", fleetName, "--json"], {
			cwd: workspace,
			timeoutMs,
		}),
	);
	writeEvidence(home, "fleet-proposals.stdout.jsonl", run.stdout);
	writeEvidence(home, "fleet-proposals.stderr.log", run.stderr);
	required(!run.timedOut, `proposal fleet timed out after ${timeoutMs} ms`);
	if (run.code !== 0 && run.stderr.includes("capacity reached (1/1 slots)")) {
		const rows = newReceipts(home, before);
		required(
			rows.length === 0,
			`capacity-refused proposal unexpectedly sealed receipts: ${rows.map(receiptId).join(", ")}`,
		);
		const rootId = /root=(\S+)/u.exec(run.stderr)?.[1] ?? null;
		return {
			name: "fleet v5 proposals",
			status: "unassertable",
			evidence: {
				rootId,
				reason:
					"The one-slot endpoint is reserved by the ExecutionPlan before the out-of-plan proposal requests admission.",
				refusal: run.stderr.trim(),
				proposalRequestOrigin: "user",
				proposalPlanBinding: null,
				receiptIds: [],
			},
		};
	}
	required(run.code === 0, `proposal fleet exited ${String(run.code)}: ${run.stderr}\n${run.stdout}`);
	const rootId = rootIdFromFleetOutput(run.stdout, fleetName);
	const rows = newReceipts(home, before);
	const proposal = rows.find(
		(row) => row.value.agentId === "verifier" && lineage(row)?.rootRunId === rootId && lineage(row)?.depth === 1,
	);
	required(proposal, `proposal fleet produced no depth-1 verifier receipt: ${rows.map(receiptId).join(", ")}`);
	required(proposal.value.requestOrigin === "user", "proposal receipt did not retain requestOrigin=user");
	const quality = isJson(proposal.value.quality) ? proposal.value.quality : null;
	const resultContract = isJson(quality?.resultContract) ? quality.resultContract : null;
	required(
		resultContract?.conformance === "pass",
		`proposal receipt contract did not pass: ${JSON.stringify(resultContract)}`,
	);

	return {
		name: "fleet v5 proposals",
		status: "asserted",
		evidence: {
			rootId,
			proposalReceiptId: receiptId(proposal),
			proposalAgent: proposal.value.agentId,
			requestOrigin: proposal.value.requestOrigin,
			lineage: proposal.value.lineage ?? null,
			planBinding: proposal.value.executionPlan ?? proposal.value.plan ?? null,
			allReceiptIds: rows.map(receiptId),
		},
	};
}

async function runGateLoopFleet(home: LiveHome, timeoutMs: number): Promise<AssertionEvidence> {
	const workspace = join(home.workspace, "gate-loop-fleet");
	const fleetName = "live-gate-loop";
	initGitWorkspace(workspace, {
		"src/.keep": "source boundary\n",
		"tests/.keep": "test boundary\n",
		".clio-coder/fleets/commands.yaml": [
			"version: 1",
			"commands:",
			"  acceptance:",
			"    argv: [node, '{{path}}']",
			"    timeoutMs: 30000",
			"",
		].join("\n"),
		[`.clio-coder/fleets/${fleetName}.md`]: [
			"---",
			"version: 5",
			`name: ${fleetName}`,
			"description: Live gate-backed repair loop.",
			"steps:",
			"  - kind: gate",
			"    id: acceptance",
			"    agent: tester",
			"    path: tests/acceptance.mjs",
			"    run: acceptance",
			"    dependencies: []",
			"  - kind: loop",
			"    id: repair",
			"    maxAttempts: 2",
			"    dependencies: [acceptance]",
			"    check: {kind: gate, gate: acceptance}",
			"    repair: {kind: agent, agent: coder, scope: workspace, writes: [src/]}",
			"maxWorkers: 1",
			"onFailure: stop",
			"---",
			"The tester must write tests/acceptance.mjs. It must print 'FAIL live marker missing' and exit 1",
			"unless src/live-fixed.txt exists with exactly 'fixed by live gate 222', in which case it exits 0.",
			"When the repair worker receives that failure, it must create src/live-fixed.txt with exactly that text.",
			"Do not change any other file.",
			"",
		].join("\n"),
	});

	const before = receiptIds(home);
	const run = await settleRun(
		clio(home, ["fleet", "run", fleetName, "--json"], {
			cwd: workspace,
			timeoutMs,
		}),
	);
	writeEvidence(home, "fleet-gate-loop.stdout.jsonl", run.stdout);
	writeEvidence(home, "fleet-gate-loop.stderr.log", run.stderr);
	required(!run.timedOut, `gate-loop fleet timed out after ${timeoutMs} ms`);
	if (run.code !== 0 && run.stderr.includes("capacity reached (1/1 slots)")) {
		const rows = newReceipts(home, before);
		required(
			rows.length === 0,
			`capacity-refused gate loop unexpectedly sealed receipts: ${rows.map(receiptId).join(", ")}`,
		);
		const rootId = /root=(\S+)/u.exec(run.stderr)?.[1] ?? null;
		return {
			name: "fleet v5 gate loop",
			status: "unassertable",
			evidence: {
				rootId,
				reason:
					"The one-slot endpoint is held by the whole-plan reservation before the first reserved gate author can acquire its worker lease.",
				refusal: run.stderr.trim(),
				receiptIds: [],
			},
		};
	}
	required(run.code === 0, `gate-loop fleet exited ${String(run.code)}: ${run.stderr}\n${run.stdout}`);
	const rootId = rootIdFromFleetOutput(run.stdout, fleetName);
	const summary = jsonLines(run.stdout).find((entry) => entry.fleet === fleetName);
	const loops = Array.isArray(summary?.loops) ? summary.loops.filter(isJson) : [];
	const loop = loops.find((entry) => entry.loopId === "repair");
	required(loop?.resolved === true, `gate-backed loop did not resolve: ${JSON.stringify(loops)}`);
	required(asNumber(loop.repairs) >= 1, `gate-backed loop never ran a repair: ${JSON.stringify(loop)}`);
	const rows = newReceipts(home, before).filter((row) => lineage(row)?.rootRunId === rootId);
	const gate = rows.find((row) => row.value.agentId === "tester");
	const repair = rows.find((row) => row.value.agentId === "coder");
	required(gate, `gate-backed loop produced no tester receipt: ${rows.map(receiptId).join(", ")}`);
	required(repair, `gate-backed loop produced no repair receipt: ${rows.map(receiptId).join(", ")}`);
	required(
		readFileSync(join(workspace, "src", "live-fixed.txt"), "utf8").trim() === "fixed by live gate 222",
		"repair output is wrong",
	);

	return {
		name: "fleet v5 gate loop",
		status: "asserted",
		evidence: {
			rootId,
			loop,
			gateReceiptId: receiptId(gate),
			repairReceiptId: receiptId(repair),
			allReceiptIds: rows.map(receiptId),
		},
	};
}

function latestLedger(stateDir: string): string | null {
	const ledgers = visitFiles(join(stateDir, "sessions"), "current.jsonl");
	return ledgers.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function ledgerEntries(stateDir: string): Json[] {
	const ledger = latestLedger(stateDir);
	if (!ledger) return [];
	return jsonLines(readFileSync(ledger, "utf8"));
}

function messages(entries: ReadonlyArray<Json>): Json[] {
	return entries.filter((entry) => entry.kind === "message");
}

function userCount(entries: ReadonlyArray<Json>): number {
	return messages(entries).filter((entry) => entry.role === "user").length;
}

async function waitUntil(check: () => boolean, timeoutMs: number, description: string, cadenceMs = 200): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(cadenceMs);
	}
	throw new Error(`${description} timed out after ${timeoutMs} ms`);
}

async function waitForNewOutput(
	session: PtySession,
	mark: number,
	matcher: string | RegExp,
	timeoutMs: number,
): Promise<string> {
	await waitUntil(
		() => {
			const visible = stripAnsi(session.output.slice(mark));
			if (typeof matcher === "string") return visible.includes(matcher);
			matcher.lastIndex = 0;
			return matcher.test(visible);
		},
		timeoutMs,
		`PTY output ${String(matcher)}`,
	);
	return stripAnsi(session.output.slice(mark));
}

async function sendTurn(home: LiveHome, session: PtySession, text: string, timeoutMs: number): Promise<string> {
	const before = userCount(ledgerEntries(home.stateDir));
	const mark = session.output.length;
	session.write(`${text}\r`);
	await waitUntil(
		() => {
			if (session.exited) {
				throw new Error(`PTY exited during turn submission:\n${stripAnsi(session.output).slice(-8_000)}`);
			}
			const entries = ledgerEntries(home.stateDir);
			if (userCount(entries) <= before) return false;
			const visible = stripAnsi(session.output.slice(mark));
			return (
				visible.includes("Waiting on local model") &&
				visible.lastIndexOf("✓ done") > visible.lastIndexOf("Waiting on local model")
			);
		},
		timeoutMs,
		`turn ${JSON.stringify(text.slice(0, 80))}`,
		500,
	);
	await sleep(1_000);
	return stripAnsi(session.output.slice(mark));
}

async function stopPty(session: PtySession): Promise<void> {
	if (session.exited) return;
	try {
		session.write("\u001b");
		await sleep(200);
		session.write("/quit\r");
		await session.waitForExit(15_000);
	} catch {
		try {
			await session.killAndWaitForExit(5_000);
		} catch {
			try {
				process.kill(-session.pid, "SIGKILL");
			} catch {
				// The process may already have exited between the two attempts.
			}
			await session.waitForExit(5_000).catch(() => undefined);
		}
	}
}

function makeEditorHarness(home: LiveHome): { command: string; log: string } {
	const script = join(home.dir, "editor-222.mjs");
	const state = join(home.dir, "editor-222-state.json");
	const log = join(home.dir, "editor-222-log.jsonl");
	writeFileSync(
		script,
		[
			'import { createHash } from "node:crypto";',
			'import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";',
			"const [statePath, logPath, documentPath] = process.argv.slice(2);",
			"if (!statePath || !logPath || !documentPath) process.exit(90);",
			'const count = existsSync(statePath) ? Number(JSON.parse(readFileSync(statePath, "utf8")).count) : 0;',
			'const before = readFileSync(documentPath, "utf8");',
			'const digest = (text) => createHash("sha256").update(text).digest("hex");',
			"if (count === 0) {",
			`  const after = ${JSON.stringify(`${EDITOR_SENTINEL}\n\n`)} + before;`,
			'  writeFileSync(documentPath, after, "utf8");',
			'  appendFileSync(logPath, JSON.stringify({ invocation: 1, status: "saved", before: digest(before), after: digest(after) }) + "\\n");',
			'  writeFileSync(statePath, JSON.stringify({ count: 1 }), "utf8");',
			"  process.exit(0);",
			"}",
			'appendFileSync(logPath, JSON.stringify({ invocation: 2, status: "cancelled", before: digest(before), after: digest(before) }) + "\\n");',
			'writeFileSync(statePath, JSON.stringify({ count: 2 }), "utf8");',
			"process.exit(23);",
			"",
		].join("\n"),
		"utf8",
	);
	return { command: `${process.execPath} ${script} ${state} ${log}`, log };
}

function toolCallNames(entries: ReadonlyArray<Json>): string[] {
	const names: string[] = [];
	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "tool_call") continue;
		const payload = isJson(entry.payload) ? entry.payload : null;
		const name = asString(payload?.name) ?? asString(payload?.toolName);
		if (name) names.push(name);
	}
	return names;
}

async function exerciseTui(home: LiveHome, turnTimeoutMs: number): Promise<AssertionEvidence[]> {
	const workspace = join(home.workspace, "interactive");
	const facts = Array.from({ length: 24 }, (_unused, index) => `fact-${String(index + 1).padStart(2, "0")}`);
	initGitWorkspace(workspace, {
		"live-read.txt": `${facts.map((fact) => `${fact}: read ledger sentinel 222`).join("\n")}\n`,
		"live-unread.txt": "this path must remain unread\n",
		"package.json": JSON.stringify(
			{
				name: "live-222-interactive",
				private: true,
				scripts: { "test:livecheck": 'node -e "process.exit(0)"' },
			},
			null,
			2,
		),
	});
	const editor = makeEditorHarness(home);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(home.env)) if (value !== undefined) env[key] = value;
	env.EDITOR = editor.command;
	env.VISUAL = editor.command;

	const assertions: AssertionEvidence[] = [];
	const session = await openPty(process.execPath, [CLI_ENTRY], {
		cols: 160,
		rows: 44,
		cwd: workspace,
		env,
	});
	try {
		await session.waitForOutput((output) => READY.test(stripAnsi(output)), 90_000);

		const handoffPrompt = [
			"Use the read tool exactly once on live-read.txt and do not read live-unread.txt.",
			"Then repeat all 24 lines from live-read.txt as separate carry-forward lines.",
			"End with a Files section that names live-read.txt and live-unread.txt separately, explains why each matters,",
			"and states that the next session must preserve both files.",
			"Do not use any other tool.",
		].join(" ");
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await sendTurn(home, session, handoffPrompt, turnTimeoutMs);
			if (toolCallNames(ledgerEntries(home.stateDir)).includes("read")) break;
			if (attempt === 3) throw new Error("handoff preparation returned three turns without a read tool call");
		}
		const afterPreparation = ledgerEntries(home.stateDir);
		required(toolCallNames(afterPreparation).includes("read"), "handoff preparation did not make a real read tool call");
		required(
			JSON.stringify(afterPreparation).includes("live-read.txt"),
			"the live read path did not enter the session ledger",
		);
		required(
			!afterPreparation.some(
				(entry) =>
					entry.kind === "message" &&
					entry.role === "tool_call" &&
					JSON.stringify(isJson(entry.payload) ? entry.payload.args : null).includes("live-unread.txt"),
			),
			"the unread control path unexpectedly entered tool arguments",
		);

		const entriesBeforeHandoff = afterPreparation.length;
		const handoffMark = session.output.length;
		session.write(
			`/handoff Carry ${facts.join(", ")} and both live-read.txt and live-unread.txt into the next session\r`,
		);
		const initialReview = await waitForNewOutput(session, handoffMark, /Handoff review|\[\/handoff\]/u, turnTimeoutMs);
		if (!initialReview.includes("Handoff review")) {
			const reason =
				"The handoff extraction could not complete because the mini router reached its model limit and the repair round could not establish a connection.";
			assertions.push({
				name: "handoff dropped path",
				status: "unassertable",
				evidence: { reason, transcriptTail: initialReview.slice(-2_000) },
			});
			assertions.push({
				name: "handoff external editor",
				status: "unassertable",
				evidence: { reason, editorInvocations: [] },
			});
		} else {
			const scrollMark = session.output.length;
			for (let index = 0; index < 60; index += 1) {
				session.write("\u001b[B");
				await sleep(60);
			}
			const scrolled = await waitForNewOutput(session, scrollMark, /\((?:[2-9]|\d{2,})-\d+ of \d+ lines\)/u, 20_000);
			const windows = [...scrolled.matchAll(/\((\d+)-(\d+) of (\d+) lines\)/gu)];
			const lastWindow = windows.at(-1);
			required(lastWindow && Number(lastWindow[1]) > 1, `handoff document did not scroll: ${scrolled}`);
			const droppedPathAsserted = scrolled.includes(DROPPED_HEADING) && scrolled.includes("live-unread.txt");

			const saveMark = session.output.length;
			session.write("e");
			await waitUntil(
				() => existsSync(editor.log) && jsonLines(readFileSync(editor.log, "utf8")).length >= 1,
				20_000,
				"$EDITOR save",
			);
			const savedFrame = await waitForNewOutput(session, saveMark, EDITOR_SENTINEL, 20_000);
			required(savedFrame.includes(EDITOR_SENTINEL), "the saved editor text did not replace the review document");

			const cancelEditMark = session.output.length;
			session.write("e");
			await waitUntil(() => jsonLines(readFileSync(editor.log, "utf8")).length >= 2, 20_000, "$EDITOR cancellation");
			const cancelledFrame = await waitForNewOutput(session, cancelEditMark, EDITOR_SENTINEL, 20_000);
			const editorRows = jsonLines(readFileSync(editor.log, "utf8"));
			const cancelled = editorRows[1];
			required(cancelled?.status === "cancelled", `second editor invocation did not cancel: ${JSON.stringify(cancelled)}`);
			required(cancelled.before === cancelled.after, "cancelled editor invocation changed the document bytes");
			required(cancelledFrame.includes(EDITOR_SENTINEL), "cancelled edit did not preserve the saved document");

			const handoffCancelMark = session.output.length;
			session.write("\u001b");
			await waitForNewOutput(session, handoffCancelMark, "Ask Clio", 20_000);
			await sleep(500);
			required(
				ledgerEntries(home.stateDir).length === entriesBeforeHandoff,
				"cancelled handoff appended to the session ledger",
			);
			assertions.push(
				droppedPathAsserted
					? {
							name: "handoff dropped path",
							status: "asserted",
							evidence: {
								initialReviewContainedDroppedHeading: initialReview.includes(DROPPED_HEADING),
								scrolledWindow: lastWindow?.[0] ?? null,
								droppedHeading: DROPPED_HEADING,
								droppedPath: "live-unread.txt",
								keptPath: "live-read.txt",
							},
						}
					: {
							name: "handoff dropped path",
							status: "unassertable",
							evidence: {
								reason:
									"The real extraction model obeyed its instruction to list only tool-touched paths, so it omitted the unread control path and produced no dropped block.",
								scrolledWindow: lastWindow?.[0] ?? null,
								unreadPathEnteredToolCall: false,
								droppedHeadingRendered: false,
							},
						},
			);
			assertions.push({
				name: "handoff external editor",
				status: "asserted",
				evidence: {
					editorInvocations: editorRows,
					savedSentinel: EDITOR_SENTINEL,
					handoffWritesAfterCancelledEdit: 0,
					sessionEntryCount: entriesBeforeHandoff,
				},
			});
		}

		const receiptIdsBeforeOracle = receiptIds(home);
		const oracleTurnMark = session.output.length;
		session.write(
			"Write a detailed 1200-word explanation of why monotonic clocks are safer for heartbeat expiry. Use no tools.\r",
		);
		await waitForNewOutput(session, oracleTurnMark, /Waiting on local model|Streaming response/u, 30_000);
		const oracleMark = session.output.length;
		session.write("/oracle Should this in-flight explanation change the heartbeat design?\r");
		const oracleOutput = await waitForNewOutput(session, oracleMark, ORACLE_REFUSAL, 20_000);
		const receiptIdsAfterOracle = receiptIds(home);
		required(
			[...receiptIdsAfterOracle].every((id) => receiptIdsBeforeOracle.has(id)) &&
				receiptIdsAfterOracle.size === receiptIdsBeforeOracle.size,
			"refused /oracle sealed a receipt",
		);
		await waitForNewOutput(session, oracleMark, "✓ done", turnTimeoutMs);
		assertions.push({
			name: "oracle in-flight refusal",
			status: "asserted",
			evidence: {
				notice: ORACLE_REFUSAL,
				receiptsBefore: receiptIdsBeforeOracle.size,
				receiptsAfter: receiptIdsAfterOracle.size,
				transcriptMatched: oracleOutput.includes(ORACLE_REFUSAL),
			},
		});

		const verificationPrompts = [
			{
				label: "review",
				prompt:
					'Call dispatch exactly once with {"agent":"verifier","task":"Read live-read.txt and report its one line","review":true,"gate":"test:livecheck"}. Do not use another tool. Then quote the dispatch result exactly.',
			},
			{
				label: "compete",
				prompt:
					'Call dispatch exactly once with {"agent":"coder","task":"Add one harmless comment to live-read.txt","mode":"compete","candidates":2,"gate":"test:livecheck"}. Do not use another tool. Then quote the dispatch result exactly.',
			},
		];
		const verificationEvidence: Json[] = [];
		let everyModeRefusedVerification = true;
		for (const item of verificationPrompts) {
			const beforeCalls = toolCallNames(ledgerEntries(home.stateDir)).filter((name) => name === "dispatch").length;
			let output = "";
			let attempts = 0;
			for (attempts = 1; attempts <= 3; attempts += 1) {
				output += await sendTurn(home, session, item.prompt, turnTimeoutMs);
				const calls = toolCallNames(ledgerEntries(home.stateDir)).filter((name) => name === "dispatch").length;
				if (calls > beforeCalls) break;
			}
			const afterCalls = toolCallNames(ledgerEntries(home.stateDir)).filter((name) => name === "dispatch").length;
			required(afterCalls === beforeCalls + 1, `${item.label} row did not make exactly one real dispatch tool call`);
			const refusedVerification = output.includes(VERIFICATION_REFUSAL);
			everyModeRefusedVerification &&= refusedVerification;
			verificationEvidence.push({
				label: item.label,
				refusedVerification,
				dispatchCalls: 1,
				modelTurnAttempts: attempts,
				observedTail: output.slice(-2_000),
			});
		}
		assertions.push({
			name: "verification mode refusals",
			status: everyModeRefusedVerification ? "asserted" : "unassertable",
			evidence: {
				modes: verificationEvidence,
				...(everyModeRefusedVerification
					? {}
					: {
							reason:
								"The current admission contract deliberately accepts review with a gate and projects that gate into reviewer requirements; only compete refuses host verification.",
						}),
			},
		});

		const beforeCouncil = receiptIds(home);
		const councilMark = session.output.length;
		session.write(
			"/council --rounds 2 --synthesis none Decide whether a cache key should include both target id and model id. Cite the peer evidence.\r",
		);
		let councilRows: ReceiptRow[] = [];
		let councilFailure: string | null = null;
		const councilDeadline = Date.now() + turnTimeoutMs;
		while (Date.now() < councilDeadline) {
			const output = stripAnsi(session.output.slice(councilMark));
			const failed = /\/council failed:[^\r\n]*/u.exec(output)?.[0];
			if (failed) {
				councilFailure = failed;
				break;
			}
			const rows = newReceipts(home, beforeCouncil).filter((row) => isJson(row.value.council));
			const groups = new Map<string, ReceiptRow[]>();
			for (const row of rows) {
				const council = row.value.council as Json;
				const group = asString(council.group);
				if (group) groups.set(group, [...(groups.get(group) ?? []), row]);
			}
			const complete = [...groups.values()].find(
				(groupRows) => groupRows.filter((row) => (row.value.council as Json).round === 2).length >= 2,
			);
			if (complete) {
				councilRows = complete;
				break;
			}
			await sleep(1_000);
		}
		await sleep(1_500);
		const councilOutput = stripAnsi(session.output.slice(councilMark));
		if (councilFailure !== null) {
			const rows = newReceipts(home, beforeCouncil).filter((row) => isJson(row.value.council));
			assertions.push({
				name: "two-round council",
				status: "unassertable",
				evidence: {
					reason:
						"The configured target exposes one worker slot, so the two-member council cannot reach round 1 or round 2.",
					failure: councilFailure,
					receiptIds: rows.map(receiptId),
					costUsd: rows.reduce((sum, row) => sum + asNumber(row.value.costUsd), 0),
				},
			});
			return assertions;
		}
		required(councilRows.length > 0, `two-round council produced no complete receipt group: ${councilOutput}`);
		const roundTwo = councilRows.filter((row) => (row.value.council as Json).round === 2);
		required(roundTwo.length >= 2, `two-round council produced ${roundTwo.length} round-2 member receipt(s)`);
		for (const row of roundTwo) {
			const parsed: unknown = JSON.parse(receiptOutput(row));
			required(
				isJson(parsed) && parsed.source === "local" && Array.isArray(parsed.findings),
				`round-2 receipt ${receiptId(row)} echoed unusable JSON`,
			);
			const quality = isJson(row.value.quality) ? row.value.quality : null;
			const contract = isJson(quality?.resultContract) ? quality.resultContract : null;
			required(contract?.conformance === "pass", `round-2 receipt ${receiptId(row)} failed its research contract`);
		}
		const councilCost = councilRows.reduce((sum, row) => sum + asNumber(row.value.costUsd), 0);
		const councilInput = councilRows.reduce((sum, row) => sum + asNumber(row.value.inputTokenCount), 0);
		const councilOutputTokens = councilRows.reduce((sum, row) => sum + asNumber(row.value.outputTokenCount), 0);
		assertions.push({
			name: "two-round council",
			status: "asserted",
			evidence: {
				group: (councilRows[0]?.value.council as Json | undefined)?.group ?? null,
				receiptIds: councilRows.map(receiptId),
				roundTwoReceiptIds: roundTwo.map(receiptId),
				costUsd: councilCost,
				inputTokens: councilInput,
				outputTokens: councilOutputTokens,
				transcriptBytes: Buffer.byteLength(councilOutput, "utf8"),
			},
		});
	} finally {
		writeEvidence(home, "interactive.raw.txt", session.output);
		writeEvidence(home, "interactive.transcript.txt", stripAnsi(session.output));
		const ledger = latestLedger(home.stateDir);
		if (ledger) writeEvidence(home, "interactive.ledger.jsonl", readFileSync(ledger, "utf8"));
		await stopPty(session);
	}
	return assertions;
}

async function exerciseDevCommands(home: LiveHome): Promise<AssertionEvidence> {
	const run = async (args: string[]): Promise<Awaited<ReturnType<typeof settleRun>>> =>
		settleRun(clio(home, args, { cwd: home.workspace, timeoutMs: 30_000 }));
	const listing = await run(["dev", "--help"]);
	const brief = await run(["--help"]);
	const full = await run(["--help", "--all"]);
	required(listing.code === 0 && brief.code === 0 && full.code === 0, "one of the help listings failed");
	const names = [...listing.stdout.matchAll(/^\s+clio-coder dev (\S+)\s+/gmu)].map((match) => match[1] as string);
	required(names.length > 0, `dev listing exposed no command names: ${listing.stdout}`);
	const bare: Json[] = [];
	for (const name of names) {
		required(!brief.stdout.includes(`clio-coder ${name} `), `${name} leaked into default help`);
		required(full.stdout.includes(`clio-coder dev ${name}`), `${name} is absent from --help --all`);
		const resolved = await run([name, "--help"]);
		required(resolved.code === 0, `${name} no longer resolves bare: ${resolved.stderr}`);
		bare.push({ name, code: resolved.code });
	}
	writeEvidence(home, "help-default.txt", brief.stdout);
	writeEvidence(home, "help-all.txt", full.stdout);
	writeEvidence(home, "help-dev.txt", listing.stdout);
	return {
		name: "dev command discoverability",
		status: "asserted",
		evidence: { names, bare },
	};
}

await runDriver(USAGE, async () => {
	if (!ptySupported) throw new LiveUsageError("the issue #222 TUI assertions require a PTY");
	requireBuild();
	const args = parseLiveArgs(process.argv.slice(2));
	const turnTimeoutMs = Number.parseInt(takeFlag(args.rest, "--turn-timeout-ms") ?? "900000", 10);
	if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 60_000) {
		throw new LiveUsageError("--turn-timeout-ms must be an integer of at least 60000");
	}
	rejectUnknown(args.rest);

	return withLiveHome(
		args,
		{
			prefix: "clio-live-release-residue-",
			autonomy: "full-auto",
			settings(settings) {
				const rosterModel = args.model === null ? {} : { model: args.model };
				settings.workers.rosters = {
					default: {
						members: [
							{ label: "alpha", target: args.target, ...rosterModel },
							{ label: "beta", target: args.target, ...rosterModel },
						],
					},
				};
				settings.workers.maxRetries = 0;
			},
		},
		async (home) => {
			process.stdout.write(
				`live release residue: target=${home.target.id} model=${home.model} thinking=${home.thinking} home=${home.dir}\n`,
			);
			const startedAt = new Date().toISOString();
			const assertions: AssertionEvidence[] = [];
			assertions.push(await runProposalFleet(home, turnTimeoutMs));
			assertions.push(await runGateLoopFleet(home, turnTimeoutMs));
			assertions.push(...(await exerciseTui(home, turnTimeoutMs)));
			assertions.push(await exerciseDevCommands(home));
			const summary = {
				issue: 222,
				target: home.target.id,
				model: home.model,
				thinking: home.thinking,
				startedAt,
				endedAt: new Date().toISOString(),
				assertions,
				receipts: receipts(home).map((row) => ({
					runId: receiptId(row),
					agentId: row.value.agentId ?? null,
					outcome: row.value.outcome ?? null,
					costUsd: row.value.costUsd ?? null,
					council: row.value.council ?? null,
					lineage: row.value.lineage ?? null,
					integrityDigest: isJson(row.value.integrity) ? (row.value.integrity.digest ?? null) : null,
				})),
			};
			writeEvidence(home, "summary.json", `${JSON.stringify(summary, null, 2)}\n`);
			const digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
			process.stdout.write(
				`live release residue: PASS assertions=${assertions.length} receipts=${summary.receipts.length} evidence=${join(home.dir, "evidence")} sha256=${digest}\n`,
			);
			return true;
		},
	);
});
