import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionApiV2,
	ExtensionContextV2,
	ExtensionIsland,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionSkin,
	ExtensionUsage,
	InterviewNext,
	View,
	ViewBoardCard,
} from "@iowarp/clio-coder/extensions";

type TaskStatus = "pending" | "running" | "checkpoint" | "complete";
interface Task {
	id: string;
	name: string;
	type: string;
	status: TaskStatus;
	dependencies: string[];
	gap: boolean;
}
interface Findings {
	task: string;
	runId: string;
	at: string;
	impossible: number;
	notFound: number;
	mismatch: number;
	willNotRun: number;
	warnings: string[];
	details: string[];
	readback: boolean;
	reviewed: boolean;
	fingerprint?: string;
	decision?: string;
	note?: string;
}
const OBSERVATION_INSTANCE = randomUUID();
const PHASES = ["identify", "literature", "lab", "plan", "execute", "paper"] as const;
interface Project {
	workspace: string;
	prompt: string;
	domain: string;
	phase: (typeof PHASES)[number];
	tasks: Task[];
	findings: Findings[];
	indexed: number;
	checkpoint: string;
	present: Set<string>;
}
function taskId(value: string): string {
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
		throw new Error("Task ID must be a positive decimal integer.");
	return String(Number(value)).padStart(2, "0");
}
/** Refuse symlink traversal, including a missing leaf's existing parents. */
function researchPath(workspace: string, relative = ""): string {
	if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
		throw new Error("Path must stay inside .research.");
	let current = workspace;
	for (const part of [".research", ...relative.split("/").filter(Boolean)]) {
		current = path.join(current, part);
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			throw new Error(`Research path is a symlink: ${part}`);
	}
	return current;
}
function readResearch(workspace: string, relative: string): string {
	const file = researchPath(workspace, relative);
	if (!existsSync(file)) return "";
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.size > 1024 * 1024)
		throw new Error(`Research input must be a regular file of at most 1 MiB: ${relative}`);
	return readFileSync(file, "utf8");
}
/** Package-owned atomic publication; the public API does not expose the host's file writer. */
function writeResearch(workspace: string, relative: string, text: string): void {
	const file = researchPath(workspace, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	const staging = `${file}.${randomUUID()}.partial`;
	try {
		writeFileSync(staging, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(staging, file);
	} finally {
		if (existsSync(staging)) unlinkSync(staging);
	}
}
function field(block: string, label: string): string {
	return (
		block
			.split("\n")
			.find((line) => line.startsWith(`- **${label}**:`))
			?.split(`**${label}**:`)[1]
			?.trim() ?? ""
	);
}
function section(text: string, title: string): string {
	const lines = text.split("\n");
	const start = lines.indexOf(`## ${title}`);
	if (start < 0) return "";
	return (
		lines
			.slice(start + 1)
			.join("\n")
			.split(/^## /m)[0]
			?.trim() ?? ""
	);
}
function parseTasks(workflow: string, lab = ""): Task[] {
	const active = workflow.split(/^## Archived Tasks/m)[0] ?? "";
	const matches = [...active.matchAll(/^### Task (\d+):\s*(.+)$/gm)];
	const seen = new Set<string>();
	return matches.map((match, index) => {
		const id = taskId(match[1] ?? "");
		if (seen.has(id)) throw new Error(`Duplicate active Task ${id}.`);
		seen.add(id);
		const block = active.slice(match.index, matches[index + 1]?.index);
		const status = field(block, "Status")
			.replace(/^[^a-z]+/i, "")
			.toLowerCase()
			.split(/\s/)[0];
		const type = field(block, "Type").split(/[\s|]/)[0] ?? "unknown";
		const name = match[2]?.trim() ?? "Untitled";
		const gapRows = lab.split("\n").filter((line) => line.startsWith("|") && /\|\s*(?:no|unavailable|gap)\b/i.test(line));
		return {
			id,
			name,
			type,
			status:
				status === "complete"
					? "complete"
					: status === "checkpoint" || status === "blocked" || status === "paused"
						? "checkpoint"
						: status === "running" || status === "in-progress"
							? "running"
							: "pending",
			dependencies: [...field(block, "Dependencies").matchAll(/Task\s+(\d+)/gi)].map((ref) => taskId(ref[1] ?? "")),
			gap:
				/lab.?gap|⚠|\bBLOCKED\b/i.test(block) ||
				gapRows.some(
					(row) =>
						row.toLowerCase().includes(type.toLowerCase()) ||
						row.includes(`Task ${id}`) ||
						row.toLowerCase().includes(name.toLowerCase()),
				),
		};
	});
}
function changeTaskStatus(workspace: string, id: string, status: TaskStatus): void {
	const file = readResearch(workspace, "WORKFLOW.md");
	const tasks = parseTasks(file);
	if (!tasks.some((task) => task.id === id)) throw new Error(`Task ${id} is no longer active.`);
	const marks = { pending: "☐ pending", running: "◉ in-progress", checkpoint: "◆ checkpoint", complete: "☑ complete" };
	const updated = file.replace(
		/^### Task (\d+):[^\n]*\n[\s\S]*?(?=^### Task |^## |$(?![\s\S]))/gm,
		(block, number: string) => {
			if (taskId(number) !== id) return block;
			return /^- \*\*Status\*\*:/m.test(block)
				? block.replace(/^- \*\*Status\*\*:[^\n]*/m, `- **Status**: ${marks[status]}`)
				: `${block.trimEnd()}\n- **Status**: ${marks[status]}\n\n`;
		},
	);
	if (updated !== file) writeResearch(workspace, "WORKFLOW.md", updated);
}
function loadProject(workspace: string): Project {
	const research = readResearch(workspace, "RESEARCH.md");
	const lab = readResearch(workspace, "VIRTUAL-LAB.md");
	const tasks = parseTasks(readResearch(workspace, "WORKFLOW.md"), lab);
	const findings: Findings[] = [];
	for (const task of tasks) {
		const text = readResearch(workspace, `tasks/task-${task.id}/MATERIO-FINDINGS.json`);
		if (text) {
			const value = JSON.parse(text) as Findings;
			if (value.task !== task.id || typeof value.reviewed !== "boolean")
				throw new Error(`Invalid findings for Task ${task.id}.`);
			findings.push(value);
			if (!value.reviewed || !value.readback || value.decision === "fix") task.status = "checkpoint";
		}
	}
	const present = new Set(
		["RESEARCH.md", "LITERATURE.md", "VIRTUAL-LAB.md", "WORKFLOW.md"].filter((name) =>
			existsSync(researchPath(workspace, name)),
		),
	);
	const phase = !present.has("RESEARCH.md")
		? "identify"
		: !present.has("LITERATURE.md")
			? "literature"
			: !present.has("VIRTUAL-LAB.md")
				? "lab"
				: !present.has("WORKFLOW.md")
					? "plan"
					: tasks.length > 0 && tasks.every((task) => task.status === "complete")
						? "paper"
						: "execute";
	const directory = researchPath(workspace, "checkpoints");
	const checkpoints = existsSync(directory)
		? readdirSync(directory)
				.filter((name) => name.endsWith(".tgz"))
				.sort()
		: [];
	return {
		workspace,
		prompt:
			(section(research, "Selected Prompt") || section(research, "Research Prompt") || "A research question awaits.")
				.split("\n")[0]
				?.slice(0, 300) ?? "",
		domain: [field(research, "Domain"), field(research, "Sub-field")].filter(Boolean).join(" / ") || "Domain not set",
		phase,
		tasks,
		findings,
		present,
		indexed: (readResearch(workspace, "DATA-INDEX.md").match(/^[-*] \*\*Path\*\*:/gm) ?? []).length,
		checkpoint: checkpoints.at(-1) ?? "none",
	};
}
function nextAction(project: Project): { label: string; command: string } {
	const commands = {
		identify: "identify-research",
		literature: "literature-review",
		lab: "define-virtual-lab",
		plan: "define-research-tasks",
	};
	if (project.phase in commands) {
		const command = commands[project.phase as keyof typeof commands];
		return { label: `Next: ${project.phase}`, command: `/materio:${command}` };
	}
	const held = project.tasks.find((task) => task.status === "checkpoint");
	if (held) return { label: `Review Task ${held.id} before continuing`, command: `/ext:materio:status ${held.id}` };
	if (project.phase === "paper")
		return {
			label: "Research ready for a reviewed WTF-P handoff",
			command: `/wtfp:new-paper Materio handoff: ${project.prompt} Materials: .research/RESEARCH.md, LITERATURE.md, VIRTUAL-LAB.md, WORKFLOW.md and tasks/. ${project.tasks.length} tasks complete; inspect actual artifacts, keep prepared work distinct from executed results, and preserve author approval gates.`,
		};
	const ready = project.tasks.find(
		(task) =>
			["pending", "running"].includes(task.status) &&
			task.dependencies.every((id) =>
				project.tasks.some((dependency) => dependency.id === id && dependency.status === "complete"),
			),
	);
	return ready
		? {
				label: `${ready.status === "running" ? "Continue" : "Execute"} Task ${ready.id}: ${ready.name}`,
				command: `/materio:execute-task ${ready.id}`,
			}
		: { label: "Dependencies need attention; inspect the workflow", command: "/materio:progress" };
}

interface StepUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	unpriced: number;
	calls: number;
}
interface UsageLedger {
	steps: Record<string, StepUsage>;
	seen: string[];
}
function ledgerKey(workspace: string): string {
	return `usage:${createHash("sha256").update(workspace).digest("hex")}`;
}
async function ledger(ctx: ExtensionContextV2): Promise<UsageLedger> {
	return (await ctx.store.get<UsageLedger>(ledgerKey(ctx.snapshot.workspace))).value ?? { steps: {}, seen: [] };
}
/** One store per project; compare-and-set retries also protect usage from other sessions. */
async function addUsage(
	ctx: ExtensionContextV2,
	step: string,
	eventId: string,
	usage: ExtensionUsage | null,
): Promise<void> {
	if (!usage) return;
	const key = ledgerKey(ctx.snapshot.workspace);
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await ctx.store.get<UsageLedger>(key);
		const value = current.value ?? { steps: {}, seen: [] };
		if (value.seen.includes(eventId)) return;
		const row = value.steps[step] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, calls: 0 };
		value.steps[step] = {
			input: row.input + usage.inputTokens,
			output: row.output + usage.outputTokens,
			cacheRead: row.cacheRead + usage.cacheReadTokens,
			cacheWrite: row.cacheWrite + usage.cacheWriteTokens,
			cost: row.cost + (usage.costUsd ?? 0),
			unpriced: row.unpriced + Number(usage.costUsd === null),
			calls: row.calls + 1,
		};
		value.seen = [...value.seen, eventId].slice(-512);
		if ((await ctx.store.set(key, value, { ifVersion: current.version })).ok) return;
	}
	throw new Error("Usage store changed repeatedly; this event was not recorded.");
}
function usageText(row: StepUsage): string {
	const tokens = `${row.input + row.output} tokens (in ${row.input}, out ${row.output}, cache ${row.cacheRead}/${row.cacheWrite})`;
	return row.unpriced
		? `${tokens} · cost unavailable${row.cost ? `; priced calls $${row.cost.toFixed(4)}` : ""}`
		: `$${row.cost.toFixed(4)} · ${tokens}`;
}
function totalUsage(value: UsageLedger): StepUsage {
	return Object.values(value.steps).reduce(
		(total, row) => ({
			input: total.input + row.input,
			output: total.output + row.output,
			cacheRead: total.cacheRead + row.cacheRead,
			cacheWrite: total.cacheWrite + row.cacheWrite,
			cost: total.cost + row.cost,
			unpriced: total.unpriced + row.unpriced,
			calls: total.calls + row.calls,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, calls: 0 },
	);
}

const SCRIPTS = fileURLToPath(new URL("../assets/scripts/", import.meta.url));
interface Receipt {
	checkpoint?: string;
	checkpoints?: string[];
	restored?: string;
	errors?: Array<{ file: string; line: number; message: string }>;
	warnings?: Array<{ file: string; line: number; message: string }>;
	coverage?: { files_requested: number; files_read: number; unreadable: unknown[]; candidates?: number };
	summary?: Record<string, number>;
	results?: Array<{ status: string; title: string | null; source: string; detail: { reason?: string } }>;
}
/** Only authored helpers run; generated research scripts are inspected, never executed. No shell expansion. */
function python(
	ctx: ExtensionContextV2,
	script: string,
	args: string[],
	timeout = 800,
): Promise<{ code: number; receipt: Receipt; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			"python3",
			["-B", path.join(SCRIPTS, script), ...args],
			{ cwd: ctx.snapshot.workspace, encoding: "utf8", timeout, maxBuffer: 1024 * 1024, signal: ctx.signal },
			(error, stdout, stderr) => {
				if (error && (typeof error.code !== "number" || error.killed)) {
					reject(new Error(`${script}: ${error.message}`));
					return;
				}
				try {
					resolve({
						code: typeof error?.code === "number" ? error.code : 0,
						receipt: JSON.parse(stdout) as Receipt,
						stderr,
					});
				} catch {
					reject(new Error(`${script}: no JSON receipt; ${stderr || stdout}`));
				}
			},
		);
	});
}
async function checkpoint(ctx: ExtensionContextV2, label: string): Promise<string> {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(label))
		throw new Error("Checkpoint label must be 1–64 path-safe characters.");
	const result = await python(
		ctx,
		"research_state.py",
		["--project", ctx.snapshot.workspace, "checkpoint", "save", label],
		1200,
	);
	const name = result.receipt.checkpoint;
	if (result.code !== 0 || !name || !existsSync(researchPath(ctx.snapshot.workspace, `checkpoints/${name}`)))
		throw new Error(`Checkpoint failed: ${result.stderr}`);
	return name;
}
async function checkpointNames(ctx: ExtensionContextV2): Promise<string[]> {
	const result = await python(ctx, "research_state.py", ["--project", ctx.snapshot.workspace, "checkpoint", "list"]);
	if (result.code !== 0 || !Array.isArray(result.receipt.checkpoints))
		throw new Error(`Checkpoint listing failed: ${result.stderr}`);
	return result.receipt.checkpoints;
}
function filesUnder(ctx: ExtensionContextV2, relative: string): string[] {
	const root = researchPath(ctx.snapshot.workspace, relative);
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Checker refuses symlink: ${entry.name}`);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile() && !entry.name.startsWith("MATERIO-") && /\.(md|bib|py|sh|bash)$/i.test(entry.name))
				files.push(file);
			if (files.length > 128) throw new Error("Task exceeds 128 applicable checker files; review coverage manually.");
		}
	};
	walk(root);
	return files;
}
function taskFingerprint(ctx: ExtensionContextV2, task: string): string {
	const hash = createHash("sha256");
	for (const file of filesUnder(ctx, `tasks/task-${task}`).sort()) {
		hash.update(path.relative(ctx.snapshot.workspace, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}
function saveFindings(ctx: ExtensionContextV2, findings: Findings): void {
	writeResearch(
		ctx.snapshot.workspace,
		`tasks/task-${findings.task}/MATERIO-FINDINGS.json`,
		`${JSON.stringify(findings, null, 2)}\n`,
	);
}
async function checkTask(ctx: ExtensionContextV2, task: string, runId: string): Promise<Findings> {
	const base = `tasks/task-${task}`;
	const findings: Findings = {
		task,
		runId,
		at: new Date().toISOString(),
		impossible: 0,
		notFound: 0,
		mismatch: 0,
		willNotRun: 0,
		warnings: [],
		details: [],
		readback: false,
		reviewed: false,
	};
	// Hold the real workflow entry before checks, so a watcher cannot briefly call it complete.
	changeTaskStatus(ctx.snapshot.workspace, task, "checkpoint");
	try {
		findings.readback = readResearch(ctx.snapshot.workspace, `${base}/task-${task}-SUMMARY.md`).trim().length > 0;
		if (!findings.readback)
			findings.warnings.push(`Readback failed: ${base}/task-${task}-SUMMARY.md is missing or empty.`);
		const files = filesUnder(ctx, base);
		findings.fingerprint = taskFingerprint(ctx, task);
		const checks = [
			{
				script: "check_physics.py",
				args: ["--json"],
				files: files.filter((file) => file.endsWith(".md")),
				kind: "physics",
			},
			{
				script: "verify_citations.py",
				args: ["--json", "--offline"],
				files: files.filter((file) => /\.bib$|summary.*\.md$/i.test(file)),
				kind: "citations",
			},
			{
				script: "check_scripts.py",
				args: ["--json"],
				files: files.filter((file) => /\.(py|sh|bash)$/.test(file)),
				kind: "scripts",
			},
		];
		// Parallel helpers stay inside the host's two-second observation deadline.
		const results = await Promise.allSettled(
			checks.map(async (check) =>
				check.files.length ? python(ctx, check.script, [...check.args, ...check.files]) : undefined,
			),
		);
		for (const [index, result] of results.entries()) {
			const check = checks[index];
			if (!check) continue;
			if (result.status === "rejected") {
				findings.warnings.push(`${check.kind} failed: ${String(result.reason)}`);
				continue;
			}
			if (!result.value) {
				findings.warnings.push(`${check.kind}: skipped; no applicable files.`);
				continue;
			}
			const { receipt, code, stderr } = result.value;
			if (
				!receipt.coverage ||
				receipt.coverage.files_read !== check.files.length ||
				receipt.coverage.unreadable.length > 0 ||
				code === 2
			)
				findings.warnings.push(`${check.kind}: incomplete coverage (exit ${code}).`);
			if (stderr.trim()) findings.warnings.push(`${check.kind}: ${stderr.trim().slice(0, 300)}`);
			if (check.kind === "physics") findings.impossible += receipt.errors?.length ?? 0;
			if (check.kind === "scripts") findings.willNotRun += receipt.errors?.length ?? 0;
			if (check.kind === "citations") {
				findings.notFound += receipt.summary?.NOT_FOUND ?? 0;
				findings.mismatch += receipt.summary?.MISMATCH ?? 0;
				findings.warnings.push(
					`Citations checked offline: ${receipt.summary?.UNVERIFIABLE ?? 0} unverified; identity and support not established.`,
				);
				for (const row of receipt.results ?? [])
					findings.details.push(`${row.status}: ${row.title ?? "placeholder"} (${row.source}): ${row.detail.reason ?? ""}`);
			}
			for (const item of receipt.errors ?? [])
				findings.details.push(`${check.kind}: ${path.basename(item.file)}:${item.line} ${item.message}`);
			for (const item of receipt.warnings ?? [])
				findings.warnings.push(`${path.basename(item.file)}:${item.line} ${item.message}`);
		}
	} catch (error) {
		findings.warnings.push(String(error));
	}
	if (findings.fingerprint && findings.fingerprint !== taskFingerprint(ctx, task))
		findings.warnings.push("Artifacts changed during checks; recheck before accepting.");
	saveFindings(ctx, findings);
	await ctx.state.set(`findings:${task}`, findings);
	return findings;
}
async function completeReviewedTask(ctx: ExtensionContextV2, findings: Findings): Promise<string> {
	// Read back again at acceptance: findings are not proof of a surviving artifact.
	if (!readResearch(ctx.snapshot.workspace, `tasks/task-${findings.task}/task-${findings.task}-SUMMARY.md`).trim())
		return "Readback still failed; Task stays at checkpoint.";
	changeTaskStatus(ctx.snapshot.workspace, findings.task, "complete");
	if (ctx.options.autoCheckpoint !== false) {
		try {
			return `Checkpoint saved: ${await checkpoint(ctx, `after-task-${findings.task}`)}`;
		} catch (error) {
			return `Task reviewed; auto-checkpoint failed: ${String(error)}`;
		}
	}
	return "Task reviewed; autoCheckpoint is off.";
}
function readbackInventory(ctx: ExtensionContextV2): string {
	return ["STATE.md", "WORKFLOW.md"]
		.map((name) => `${name}: ${readResearch(ctx.snapshot.workspace, name).length} bytes`)
		.join(" · ");
}
function checkArchiveName(ctx: ExtensionContextV2, name: string): void {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(name) ||
		!lstatSync(researchPath(ctx.snapshot.workspace, `checkpoints/${name}`)).isFile()
	)
		throw new Error("Choose an exact checkpoint archive from the list.");
}

const SKIN = JSON.parse(readFileSync(new URL("../skins/materio.json", import.meta.url), "utf8")) as ExtensionSkin;
interface RunningAgent {
	agentId: string;
	task: string | null;
	step: string;
	at: number;
}
type Runs = Record<string, RunningAgent>;
const TYPE_GLYPHS: Record<string, string> = {
	literature: "≋",
	experimental: "⚗",
	computational: "⚙",
	"data-analysis": "▥",
	analytical: "∑",
	writing: "✎",
};
function findingsView(findings: Findings): View {
	return {
		t: "box",
		dir: "col",
		title: `Task ${findings.task} · advisory findings`,
		border: "single",
		children: [
			{
				t: "text",
				text: `IMPOSSIBLE ${findings.impossible} · NOT_FOUND ${findings.notFound} · MISMATCH ${findings.mismatch} · WILL NOT RUN ${findings.willNotRun}`,
				tone: findings.impossible + findings.notFound + findings.mismatch + findings.willNotRun > 0 ? "warning" : "neutral",
				wrap: "wrap",
			},
			{
				t: "text",
				text: findings.readback
					? "Summary read back · researcher review required"
					: "WARNING: summary missing or empty · task held",
				tone: findings.readback ? "muted" : "warning",
			},
			{
				t: "text",
				text:
					[...findings.details.slice(0, 4), ...findings.warnings.slice(0, 3)].map((line) => line.slice(0, 180)).join("\n") ||
					"Applicable checkers reported no findings; scientific validation remains the researcher's.",
				wrap: "wrap",
			},
			{ t: "list", action: "findings", items: [{ key: findings.task, label: `Review Task ${findings.task}`, mark: "◎" }] },
		],
	};
}
async function bench(ctx: ExtensionContextV2, message?: string): Promise<ExtensionOutputV2> {
	const project = loadProject(ctx.snapshot.workspace);
	const usage = await ledger(ctx);
	const runs = (await ctx.state.get<Runs>("runs")).value ?? {};
	const done = project.tasks.filter((task) => task.status === "complete").length;
	const next = nextAction(project);
	const activePhase = PHASES.indexOf(project.phase);
	const newest =
		project.findings.filter((item) => !item.reviewed || item.decision === "fix").at(-1) ?? project.findings.at(-1);
	const islands: ExtensionIsland[] = Object.entries(runs)
		.slice(0, newest ? 3 : 4)
		.map(([runId, run]) => {
			const role = SKIN.agents?.[run.agentId];
			return {
				key: runId,
				title: `${role?.glyph ?? "◇"} ${role?.label ?? run.agentId}`,
				meta: run.task ? `Task ${run.task}` : "research",
				view: {
					t: "kv",
					items: [
						{ label: "Run", value: runId.slice(0, 28) },
						{ label: "Step", value: run.step },
						{ label: "State", value: "running", tone: "accent" },
					],
				},
			};
		});
	if (newest)
		islands.push({
			key: `findings-${newest.task}`,
			title: `◎ Findings · Task ${newest.task}`,
			tone: "warning",
			view: {
				t: "box",
				dir: "col",
				children: [
					{
						t: "text",
						text: `IMPOSSIBLE ${newest.impossible} · NOT_FOUND ${newest.notFound}\nMISMATCH ${newest.mismatch} · WILL NOT RUN ${newest.willNotRun}`,
						tone: "warning",
					},
					{
						t: "text",
						text: newest.readback
							? newest.reviewed
								? `Decision: ${newest.decision}`
								: "Summary inspected · review pending"
							: "Summary readback failed",
						tone: "muted",
					},
					{ t: "list", action: "findings", items: [{ key: newest.task, label: "Review findings", mark: "◎" }] },
				],
			},
		});
	const columns: Array<{ title: string; tone: "muted" | "accent" | "warning" | "positive"; status: TaskStatus }> = [
		{ title: "☐ PENDING", tone: "muted", status: "pending" },
		{ title: "◉ RUNNING", tone: "accent", status: "running" },
		{ title: "◆ CHECKPOINT", tone: "warning", status: "checkpoint" },
		{ title: "☑ COMPLETE", tone: "positive", status: "complete" },
	];
	const visible = project.tasks.slice(0, 60);
	const taskCard = (task: Project["tasks"][number]): ViewBoardCard => {
		const finding = project.findings.find((item) => item.task === task.id);
		const badges: NonNullable<ViewBoardCard["badges"]> = [];
		if (task.gap) badges.push({ text: "LAB GAP", tone: "warning" });
		if (finding)
			badges.push({
				text: `I:${finding.impossible} N:${finding.notFound} M:${finding.mismatch} R:${finding.willNotRun}`,
				tone: finding.reviewed ? "muted" : "warning",
			});
		return {
			key: task.id,
			title: `${TYPE_GLYPHS[task.type] ?? "◇"} ${task.id} ${task.name.slice(0, 90)}`,
			detail: `deps ${task.dependencies.join(", ") || "none"}`,
			badges,
		};
	};
	const costSteps = Object.entries(usage.steps)
		.slice(0, 6)
		.map(([step, row]) => `${step}: ${row.unpriced ? `${row.input + row.output} tok` : `$${row.cost.toFixed(3)}`}`)
		.join(" · ");
	const total = totalUsage(usage);
	return {
		...(message ? { card: { t: "text" as const, text: message.slice(0, 2000), wrap: "wrap" as const } } : {}),
		text:
			message ??
			`Materio ► ${done}/${project.tasks.length} tasks ◆ ${project.phase} ► ${project.domain}\n${project.prompt}\n${project.tasks.map((task) => `${task.id}: ${task.name} [${task.status}] deps ${task.dependencies.join(",") || "none"}${task.gap ? " · LAB GAP" : ""}`).join("\n")}\nNext: ${next.command}\n${total.calls ? usageText(total) : "No usage recorded."}`,
		status: {
			text: `${done}/${project.tasks.length} tasks · ${project.phase} · ${Object.keys(runs).length} agents`,
			tone: "neutral",
		},
		band: {
			t: "box",
			dir: "col",
			children: [
				{ t: "text", text: next.label.slice(0, 180), tone: "accent" },
				{
					t: "actions",
					items: [
						{ id: "next", label: project.phase === "paper" ? "Prepare WTF-P handoff" : "Fill next action", primary: true },
					],
				},
			],
		},
		regions: {
			header: {
				t: "box",
				dir: "col",
				children: [
					{ t: "text", text: "◈ M A T E R I O   /   MATERIALS LAB BENCH", tone: "brand", bold: true },
					{ t: "text", text: project.prompt, wrap: "truncate" },
					{ t: "text", text: project.domain, tone: "muted", wrap: "truncate" },
					{
						t: "steps",
						items: PHASES.map((label, index) => ({
							label,
							state: index < activePhase ? "done" : index === activePhase ? "active" : "todo",
						})),
					},
				],
			},
			board: {
				t: "board",
				action: "task",
				columns: columns.map((column) => ({
					title: `${column.title} (${project.tasks.filter((task) => task.status === column.status).length})`,
					tone: column.tone,
					cards: visible.filter((task) => task.status === column.status).map(taskCard),
				})),
			},
			rail: { t: "text", text: `MATERIO ◆ ${project.phase.toUpperCase()}`, tone: "brand", bold: true },
			footer: {
				t: "text",
				text: `Σ ${total.calls ? (total.unpriced ? `${total.input + total.output} tokens · cost unavailable` : `$${total.cost.toFixed(4)}`) : "no usage"} · ${project.indexed} files indexed · checkpoint ${project.checkpoint.slice(0, 68)} · ${costSteps || "Step usage: no calls recorded"}${project.tasks.length > 60 ? ` · ${project.tasks.length - 60} tasks beyond board limit` : ""}`,
				wrap: "truncate",
			},
		},
		islands,
	};
}

async function localBench(ctx: ExtensionContextV2): Promise<ExtensionOutputV2> {
	const output = await bench(ctx);
	return { ...output, card: { t: "text", text: output.text.slice(0, 2000), wrap: "wrap" } };
}

const AGENT_STEPS: Record<string, string> = {
	"materio-research-explorer": "identify-research",
	"materio-literature-reviewer": "literature-review",
	"materio-lab-definer": "define-virtual-lab",
	"materio-workflow-planner": "define-research-tasks",
	"materio-task-executor": "execute-task",
	"materio-task-verifier": "execute-task",
};
const HELP = `Materio lab bench\nEnter: /ext:materio:lab · leave: host leader b or /workspace off\nLocal, no model: /materio:status [task], /materio:progress, /materio:help, /materio:checkpoint save [label]|list|restore <archive>, /ext:materio:cost\nReview: select a task card, leader v, or /materio:status <task>. Recheck existing task outputs: /materio:status check <task>.\nLeader suffixes: f fill next action · c checkpoint · v verify findings · d dollars/tokens · h help\nResearch prompts: identify-research → literature-review → define-virtual-lab → define-research-tasks → execute-task [N|all] → wtfp.\nTasks: add-task, remove-task [N], archive-task [N]; data: upload-data; control: pause-research, resume-research, settings.\nCheckers are advisory, citations stay offline/unverified, and prepared artifacts are not executed scientific results.`;
interface PendingDispatch {
	agentId: string;
	task: string | null;
}
async function cost(ctx: ExtensionContextV2): Promise<ExtensionOutputV2> {
	const usage = await ledger(ctx);
	const text =
		Object.entries(usage.steps)
			.map(([step, row]) => `${step}: ${usageText(row)}`)
			.join("\n") || "No usage recorded; local Materio commands do not start a model turn.";
	return {
		...(await bench(
			ctx,
			`Materio usage\n${text}\nTotal: ${totalUsage(usage).calls ? usageText(totalUsage(usage)) : "no calls"}`,
		)),
		card: { t: "text", text: text.slice(0, 2000), tone: "muted", wrap: "wrap" },
	};
}
async function review(ctx: ExtensionContextV2, requested?: string): Promise<ExtensionOutputV2> {
	const project = loadProject(ctx.snapshot.workspace);
	const finding = requested
		? project.findings.find((item) => item.task === taskId(requested))
		: (project.findings.filter((item) => !item.reviewed || item.decision === "fix").at(-1) ?? project.findings.at(-1));
	if (!finding)
		return bench(ctx, "No recorded findings for this task. Use /materio:status check <task> to inspect its artifacts.");
	await ctx.state.set(`review:${finding.task}`, { runId: finding.runId, at: finding.at });
	return {
		...(await bench(ctx, `Review advisory findings for Task ${finding.task}.`)),
		card: findingsView(finding),
		interview: {
			id: "findings",
			title: `Materio · Task ${finding.task} findings`,
			total: 1,
			step: {
				key: `task-${finding.task}`,
				intro: findingsView(finding),
				questions: [
					{
						id: "decision",
						label: "How should these findings be handled?",
						kind: "single",
						options: [
							{ value: "fix", label: "Fix and recheck", detail: "Keep the task at checkpoint; fill the executor command." },
							{
								value: "accept",
								label: "Note and continue",
								detail: "Record my decision; retain limitations and unverified citations.",
							},
						],
					},
					{ id: "note", label: "Researcher note for the task record", kind: "text" },
				],
			},
		},
	};
}
async function checkpointCommand(args: string, ctx: ExtensionContextV2): Promise<ExtensionOutputV2> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const operation = parts[0] ?? "save";
	if (parts.length > 2) return bench(ctx, "Usage: checkpoint save [label] | list | restore <exact archive>.");
	if (operation === "list")
		return bench(ctx, `Research checkpoints\n${(await checkpointNames(ctx)).join("\n") || "No checkpoints saved."}`);
	if (operation === "save") return bench(ctx, `Checkpoint saved: ${await checkpoint(ctx, parts[1] ?? "manual")}`);
	if (operation !== "restore" || !parts[1])
		return bench(ctx, "Usage: checkpoint save [label] | list | restore <exact archive>.");
	const name = parts[1];
	if (!(await checkpointNames(ctx)).includes(name))
		return bench(ctx, "Choose an exact archive returned by checkpoint list.");
	checkArchiveName(ctx, name);
	await ctx.state.set("restore", name);
	return {
		...(await bench(ctx, `Restore requested: ${name}; waiting for researcher confirmation.`)),
		interview: {
			id: "restore",
			title: "Materio · restore research checkpoint",
			total: 1,
			step: {
				key: "confirm",
				questions: [
					{
						id: "confirm",
						label: "Replace research state and task artifacts, removing later artifacts?",
						help: "Data and checkpoint archives stay. A before-restore snapshot will be saved first.",
						kind: "single",
						options: [
							{ value: "cancel", label: "Keep current research" },
							{ value: "restore", label: "Restore this checkpoint" },
						],
					},
				],
			},
		},
	};
}
async function observe(event: ExtensionObservationV2, ctx: ExtensionContextV2): Promise<ExtensionOutputV2 | undefined> {
	if (event.event === "tool_end" && event.tool === "dispatch" && event.outcome !== "ok") {
		await ctx.state.set("pending-dispatch", []);
		return undefined;
	}
	if (event.event === "turn_start") {
		const match = /^\s*\/materio:([a-z-]+)(?:\s+(\d+))?\b/.exec(event.text ?? "");
		if (match) await ctx.state.set("step", match[1]);
		return undefined;
	}
	if (event.event === "turn_end") {
		await addUsage(
			ctx,
			(await ctx.state.get<string>("step")).value ?? "unattributed",
			`turn:${ctx.snapshot.sessionId ?? OBSERVATION_INSTANCE}:${event.turnId}`,
			event.usage,
		);
		return bench(ctx, "");
	}
	if (event.event === "dispatch_started" && SKIN.agents?.[event.agentId]) {
		const pending = (await ctx.state.get<PendingDispatch[]>("pending-dispatch")).value ?? [];
		const index = pending.findIndex((entry) => entry.agentId === event.agentId);
		const task = index < 0 ? null : (pending.splice(index, 1)[0]?.task ?? null);
		await ctx.state.set("pending-dispatch", pending);
		const runs = (await ctx.state.get<Runs>("runs")).value ?? {};
		runs[event.runId] = {
			agentId: event.agentId,
			task,
			step: AGENT_STEPS[event.agentId] ?? "unattributed",
			at: Date.now(),
		};
		await ctx.state.set("runs", runs);
		return bench(ctx, "");
	}
	if ((event.event === "dispatch_completed" || event.event === "dispatch_failed") && SKIN.agents?.[event.agentId]) {
		const runs = (await ctx.state.get<Runs>("runs")).value ?? {};
		const run = runs[event.runId];
		delete runs[event.runId];
		await ctx.state.set("runs", runs);
		if (event.event === "dispatch_failed")
			return { ...(await bench(ctx, "")), toast: { text: `${event.agentId}: dispatch failed`, tone: "warning" } };
		await addUsage(ctx, AGENT_STEPS[event.agentId] ?? "unattributed", `dispatch:${event.runId}`, event.usage);
		if (event.agentId !== "materio-task-executor") return bench(ctx, "");
		const seen = (await ctx.state.get<string[]>("checked-runs")).value ?? [];
		if (seen.includes(event.runId)) return bench(ctx, "");
		if (!run?.task)
			return {
				...(await bench(ctx, "")),
				card: {
					t: "text",
					text: `Executor ${event.runId}: no exact task write root observed; guardrails were not assigned by guess. Recheck using /materio:status check <task>.`,
					tone: "warning",
				},
			};
		const findings = await checkTask(ctx, run.task, event.runId);
		await ctx.state.set("checked-runs", [...seen, event.runId].slice(-128));
		return {
			...(await bench(ctx, "")),
			card: findingsView(findings),
			toast: { text: `Task ${run.task} held at checkpoint; review findings.`, tone: "warning" },
		};
	}
	if (event.event === "fs_changed") {
		const project = loadProject(ctx.snapshot.workspace);
		for (const finding of project.findings)
			if (!finding.reviewed || !finding.readback || finding.decision === "fix")
				changeTaskStatus(ctx.snapshot.workspace, finding.task, "checkpoint");
	}
	return bench(ctx, "");
}
export default function extension(api: ExtensionApiV2): void {
	// Serialize this process's file/state transitions; store CAS still handles other sessions.
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(work: () => Promise<T>): Promise<T> => {
		const next = tail.then(work, work);
		tail = next.catch(() => undefined);
		return next;
	};
	api.handle("lab", (_args, ctx) =>
		serial(async () => ({ ...(await bench(ctx, "Entered the Materio lab bench.")), workspace: { enter: "lab" } })),
	);
	api.handle("status", (args, ctx) =>
		serial(async () => {
			const check = /^check\s+(\d+)\s*$/.exec(args.trim());
			if (check) {
				const finding = await checkTask(ctx, taskId(check[1] ?? ""), `manual:${ctx.requestId}`);
				return { ...(await bench(ctx)), card: findingsView(finding) };
			}
			return /^\d+$/.test(args.trim()) ? review(ctx, args.trim()) : localBench(ctx);
		}),
	);
	api.handle("progress", (_args, ctx) => serial(() => localBench(ctx)));
	api.handle("help", (_args, ctx) => serial(() => bench(ctx, HELP)));
	api.handle("cost", (_args, ctx) => serial(() => cost(ctx)));
	api.handle("checkpoint", (args, ctx) => serial(() => checkpointCommand(args, ctx)));
	for (const event of [
		"session_open",
		"turn_start",
		"turn_end",
		"tool_end",
		"dispatch_started",
		"dispatch_completed",
		"dispatch_failed",
		"fs_changed",
		"workspace_enter",
	] as const)
		api.on(event, (observation, ctx) => serial(() => observe(observation, ctx)));
	api.hook("before_tool", (event, ctx) =>
		serial(async () => {
			if (event.point !== "before_tool" || event.tool !== "dispatch" || !event.args || typeof event.args !== "object")
				return {};
			const args = event.args as { agent?: unknown; intent?: { write_roots?: unknown } };
			if (typeof args.agent !== "string" || !SKIN.agents?.[args.agent]) return {};
			const roots = args.intent?.write_roots;
			const tasks = new Set<string>();
			if (Array.isArray(roots))
				for (const root of roots)
					if (typeof root === "string") {
						const match = /^\.research\/tasks\/task-(\d+)(?:\/.*)?$/.exec(root);
						if (match) tasks.add(taskId(match[1] ?? ""));
					}
			const pending = (await ctx.state.get<PendingDispatch[]>("pending-dispatch")).value ?? [];
			pending.push({ agentId: args.agent, task: tasks.size === 1 ? ([...tasks][0] ?? null) : null });
			await ctx.state.set("pending-dispatch", pending.slice(-32));
			return {};
		}),
	);
	api.action("next", (_event, ctx) =>
		serial(async () => ({
			...(await bench(ctx, "Next research action filled; review it before submitting.")),
			prompt: { fill: nextAction(loadProject(ctx.snapshot.workspace)).command },
		})),
	);
	api.action("task", (event, ctx) =>
		serial(() => (event.key ? review(ctx, event.key) : bench(ctx, "Select a task card."))),
	);
	api.action("findings", (event, ctx) => serial(() => review(ctx, event.key)));
	api.action("checkpoint", (_event, ctx) => serial(() => checkpointCommand("save bench", ctx)));
	api.action("cost", (_event, ctx) => serial(() => cost(ctx)));
	api.action("help", (_event, ctx) => serial(() => bench(ctx, HELP)));
	api.interview(
		"findings",
		(answer, ctx): Promise<InterviewNext> =>
			serial(async () => {
				if (answer.nav === "cancel")
					return { done: true, ...(await bench(ctx, "Review cancelled; Task remains at checkpoint.")) };
				const id = taskId(answer.step.replace(/^task-/, ""));
				const finding = loadProject(ctx.snapshot.workspace).findings.find((item) => item.task === id);
				const opened = (await ctx.state.get<{ runId: string; at: string }>(`review:${id}`)).value;
				if (!finding || opened?.runId !== finding.runId || opened.at !== finding.at)
					return {
						done: true,
						...(await bench(ctx, "Findings changed since this interview opened; review the new findings.")),
					};
				if (!finding.fingerprint || finding.fingerprint !== taskFingerprint(ctx, id))
					return {
						done: true,
						...(await bench(
							ctx,
							`Task ${id} artifacts changed since checks; run /materio:status check ${id} and review again.`,
						)),
					};
				const decision = answer.answers.decision;
				const note = answer.answers.note;
				if ((decision !== "fix" && decision !== "accept") || typeof note !== "string")
					return { done: true, ...(await bench(ctx, "Invalid review answer; Task remains at checkpoint.")) };
				finding.reviewed = true;
				finding.decision = decision;
				finding.note = note.slice(0, 8000);
				saveFindings(ctx, finding);
				writeResearch(
					ctx.snapshot.workspace,
					`tasks/task-${id}/MATERIO-REVIEW.md`,
					`# Researcher review · Task ${id}\n\nDecision: ${decision}\nRecorded: ${new Date().toISOString()}\nRun: ${finding.runId}\n\n${finding.note}\n\nAdvisory checks only; citations remain unverified offline. Prepared outputs do not establish scientific validation.\n`,
				);
				await ctx.state.set(`findings:${id}`, finding);
				let text =
					decision === "fix"
						? `Task ${id} stays at checkpoint; executor command filled for your review.`
						: await completeReviewedTask(ctx, finding);
				if (decision === "accept" && !finding.readback)
					text = `Task ${id} stays at checkpoint: summary readback failed. ${text}`;
				return {
					done: true,
					...(await bench(ctx, text)),
					...(decision === "fix"
						? {
								prompt: {
									fill: `/materio:execute-task ${id} Address the recorded findings in .research/tasks/task-${id}/MATERIO-REVIEW.md.`,
								},
							}
						: {}),
				};
			}),
	);
	api.interview(
		"restore",
		(answer, ctx): Promise<InterviewNext> =>
			serial(async () => {
				const name = (await ctx.state.get<string>("restore")).value;
				await ctx.state.delete("restore");
				if (answer.nav === "cancel" || answer.answers.confirm !== "restore" || !name)
					return { done: true, ...(await bench(ctx, "Restore cancelled; research files unchanged.")) };
				checkArchiveName(ctx, name);
				await checkpoint(ctx, "before-restore");
				const result = await python(
					ctx,
					"research_state.py",
					["--project", ctx.snapshot.workspace, "checkpoint", "restore", name, "--confirmed"],
					1200,
				);
				if (result.code !== 0 || result.receipt.restored !== name) throw new Error(`Restore failed: ${result.stderr}`);
				return { done: true, ...(await bench(ctx, `Restored ${name}. ${readbackInventory(ctx)}`)) };
			}),
	);
}
