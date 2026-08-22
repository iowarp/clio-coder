/**
 * Procedural long-horizon traces for the context engine.
 *
 * Real Clio ledgers on a developer machine are short, and the one long corpus
 * the replay tables used to rest on was private Claude Code transcripts that
 * nobody else could regenerate. This module replaces that corpus with traces
 * any checkout can rebuild byte for byte from a seed: science-coding sessions
 * of hundreds of turns that exercise every structural rung and every metric
 * the replay measures.
 *
 * The grammar is deliberately small. A trace is a run of episodes, each opened
 * by an operator message. An episode picks a focus set of files under a
 * Zipf-shaped popularity so a few files are hot and most are cold, then plays
 * one of four scripts: explore (listings and greps whose surfaced paths are
 * then read), implement (read, edit, read back, so the first read goes stale
 * and the read-back supersedes a range), validate (a test run that fails, an
 * edit, the same command passing, so a failure is resolved), and analyze (a
 * simulation run whose stdout is far over the result cap and is offloaded,
 * then a read of the results file). Episodes return to files from earlier
 * episodes with a tunable probability, which is what produces the long-range
 * future references retention is measured on. Every assistant turn carries a
 * thinking block so thinking eviction has something to remove.
 *
 * Pure over the spec and the seed: same inputs, same entries, same bytes. No
 * clock, no filesystem, no `Math.random`.
 */

import type { SessionEntry } from "../../../session/entries.js";
import type { ReplayLoadCascade } from "./load-clio.js";
import { countReplayTurns, type Trace } from "./trace.js";

export interface SyntheticCorpusSpec {
	/** Stable id, also the trace id prefix and the JSON `corpus` field. */
	id: string;
	seed: number;
	traces: number;
	/** Operator turns per trace. */
	turns: number;
	/** Files in the synthetic repository. */
	files: number;
	/** Probability that an episode returns to a focus set from an earlier episode. */
	returnProbability: number;
	/** Relative weight of each episode script. */
	scripts: { explore: number; implement: number; validate: number; analyze: number };
	/** Lines per file, uniform in this range. */
	fileLines: [number, number];
	/** Lines a simulation prints; anything over `offloadAfterLines` is offloaded. */
	simulationLines: [number, number];
	offloadAfterLines: number;
}

export const SYNTHETIC_CORPORA: ReadonlyArray<SyntheticCorpusSpec> = [
	{
		id: "science-long",
		seed: 7,
		traces: 8,
		turns: 300,
		files: 48,
		returnProbability: 0.3,
		scripts: { explore: 1, implement: 3, validate: 2, analyze: 2 },
		fileLines: [12, 96],
		simulationLines: [100, 2400],
		offloadAfterLines: 200,
	},
	{
		id: "refactor",
		seed: 11,
		traces: 8,
		turns: 200,
		files: 64,
		returnProbability: 0.4,
		scripts: { explore: 1, implement: 5, validate: 2, analyze: 0 },
		fileLines: [16, 110],
		simulationLines: [100, 400],
		offloadAfterLines: 200,
	},
	{
		id: "exploration",
		seed: 13,
		traces: 8,
		turns: 200,
		files: 120,
		returnProbability: 0.15,
		scripts: { explore: 4, implement: 1, validate: 1, analyze: 1 },
		fileLines: [10, 64],
		simulationLines: [100, 800],
		offloadAfterLines: 200,
	},
];

export function syntheticCorpus(id: string): SyntheticCorpusSpec | undefined {
	return SYNTHETIC_CORPORA.find((spec) => spec.id === id);
}

function mulberry32(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value = (value + 0x6d2b79f5) >>> 0;
		let next = value;
		next = Math.imul(next ^ (next >>> 15), next | 1);
		next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
		return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const DIRECTORIES = ["src/sim", "src/io", "src/analysis", "src/mesh", "tests", "scripts", "configs"];
const STEMS = ["solver", "reader", "writer", "grid", "field", "boundary", "stepper", "metrics", "plot", "checkpoint"];
const EXTENSIONS = ["py", "py", "py", "c", "h", "yaml", "toml"];

interface RepoFile {
	path: string;
	lines: number;
	version: number;
}

class Ledger {
	readonly entries: SessionEntry[] = [];
	private parent: string | null = null;
	private sequence = 0;
	private calls = 0;

	constructor(private readonly cwd: string) {}

	private next(kind: string): { turnId: string; parentTurnId: string | null; timestamp: string } {
		this.sequence += 1;
		const turnId = `${kind}-${String(this.sequence).padStart(5, "0")}`;
		const stamp = {
			turnId,
			parentTurnId: this.parent,
			timestamp: new Date(1_787_000_000_000 + this.sequence * 1000).toISOString(),
		};
		this.parent = turnId;
		return stamp;
	}

	user(text: string): void {
		this.entries.push({ kind: "message", ...this.next("user"), role: "user", payload: { text } });
	}

	assistant(thinking: string, text: string): void {
		this.entries.push({
			kind: "message",
			...this.next("assistant"),
			role: "assistant",
			payload: {
				content: [
					{ type: "thinking", thinking },
					{ type: "text", text },
				],
			},
		});
	}

	call(
		name: string,
		args: Record<string, unknown>,
		text: string,
		options: { isError?: boolean; offload?: boolean } = {},
	): void {
		this.calls += 1;
		const toolCallId = `call-${String(this.calls).padStart(5, "0")}`;
		this.entries.push({ kind: "message", ...this.next("call"), role: "tool_call", payload: { toolCallId, name, args } });
		const details =
			options.offload === true
				? { resultDisposition: { offloadPath: `${this.cwd}/.clio-state/scratch/${toolCallId}.txt` } }
				: undefined;
		this.entries.push({
			kind: "message",
			...this.next("result"),
			role: "tool_result",
			payload: {
				toolCallId,
				toolName: name,
				result: { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) },
				isError: options.isError === true,
			},
		});
	}
}

function fileBody(file: RepoFile, offset = 0, limit: number | null = null): string {
	const end = limit === null ? file.lines : Math.min(file.lines, offset + limit);
	const lines: string[] = [];
	for (let line = offset + 1; line <= end; line += 1) {
		lines.push(`${String(line).padStart(4, " ")}  ${file.path}@v${file.version}: x[${line}] = f(x[${line - 1}]) + eps`);
	}
	return lines.join("\n");
}

function simulationOutput(lines: number, seed: number): string {
	const rnd = mulberry32(seed);
	const out: string[] = [];
	for (let step = 0; step < lines; step += 1) {
		out.push(
			`step ${String(step).padStart(5, "0")} t=${(step * 0.01).toFixed(2)} e=${(1 - rnd() * 1e-3).toFixed(6)} r=${(rnd() * 1e-6).toExponential(2)}`,
		);
	}
	return out.join("\n");
}

function testOutput(files: ReadonlyArray<RepoFile>, failing: RepoFile | null): string {
	const out = [
		"============================= test session starts =============================",
		`collected ${files.length * 4} items`,
		"",
	];
	for (const file of files) {
		for (let case_ = 1; case_ <= 4; case_ += 1) {
			out.push(
				`${file.path}::test_${file.path.replace(/\W/g, "_")}_${case_} ${file === failing && case_ === 3 ? "FAILED" : "PASSED"} [${String(Math.round((100 * case_) / 4)).padStart(3, " ")}%]`,
			);
		}
	}
	if (failing !== null) {
		const line = Math.max(1, Math.floor(failing.lines / 2));
		out.push(
			"",
			"=================================== FAILURES ===================================",
			`____________________ test_${failing.path.replace(/\W/g, "_")}_3 ____________________`,
			"",
		);
		for (let frame = 0; frame < 12; frame += 1) {
			out.push(
				`  File "${failing.path}", line ${line + frame}, in step_${frame}`,
				`    residual = advance(state, dt)  # frame ${frame}`,
			);
		}
		out.push(
			"",
			"AssertionError: residual 3.2e-4 exceeds tolerance 1e-6",
			`FAILED ${failing.path}::test_${failing.path.replace(/\W/g, "_")}_3`,
		);
	}
	out.push(
		"",
		`${failing === null ? files.length * 4 : files.length * 4 - 1} passed, ${failing === null ? 0 : 1} failed`,
	);
	return out.join("\n");
}

/** Generate one trace of the corpus. `index` selects the trace; the spec's seed and index fix every byte. */
export function generateSyntheticTrace(spec: SyntheticCorpusSpec, index: number): Trace {
	const rnd = mulberry32(spec.seed * 1000 + index);
	const between = (low: number, high: number): number => low + Math.floor(rnd() * (high - low + 1));
	const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(rnd() * items.length)] as T;
	const cwd = `/synthetic/${spec.id}-${index}`;
	const ledger = new Ledger(cwd);

	const repo: RepoFile[] = [];
	for (let file = 0; file < spec.files; file += 1) {
		const dir = DIRECTORIES[file % DIRECTORIES.length] as string;
		const stem = STEMS[Math.floor(file / DIRECTORIES.length) % STEMS.length] as string;
		const ext = EXTENSIONS[file % EXTENSIONS.length] as string;
		repo.push({
			path: `${dir}/${stem}${Math.floor(file / (DIRECTORIES.length * STEMS.length)) || ""}.${ext}`,
			lines: between(spec.fileLines[0], spec.fileLines[1]),
			version: 1,
		});
	}
	/** Zipf over file rank: rank 0 is hot, the tail is cold. */
	const zipf = (): RepoFile => repo[Math.min(repo.length - 1, Math.floor(repo.length ** rnd()) - 1)] as RepoFile;
	const scriptNames = (Object.keys(spec.scripts) as Array<keyof typeof spec.scripts>).flatMap((name) =>
		Array.from({ length: spec.scripts[name] }, () => name),
	);
	const history: RepoFile[][] = [];

	const readWhole = (file: RepoFile): void => ledger.call("read", { path: file.path }, fileBody(file));
	const readRange = (file: RepoFile): void => {
		const limit = between(20, 80);
		const offset = between(1, Math.max(1, file.lines - limit));
		ledger.call("read", { path: file.path, offset, limit }, fileBody(file, offset - 1, limit));
	};
	const edit = (file: RepoFile): void => {
		file.version += 1;
		ledger.call(
			"edit",
			{ path: file.path, edits: [{ oldText: `v${file.version - 1}`, newText: `v${file.version}` }] },
			`Applied 1 edit to ${file.path}`,
		);
	};
	const runTests = (focus: RepoFile[], failing: RepoFile | null): void =>
		ledger.call(
			"bash",
			{ command: `pytest ${focus.map((file) => file.path).join(" ")} -q` },
			testOutput(focus, failing),
			{ isError: failing !== null },
		);

	for (let turn = 0; turn < spec.turns; turn += 1) {
		const script = pick(scriptNames);
		const returning = history.length > 0 && rnd() < spec.returnProbability;
		const focus = returning ? (pick(history) as RepoFile[]) : Array.from({ length: between(1, 3) }, zipf);
		if (!returning) history.push(focus);
		const names = focus.map((file) => file.path).join(", ");
		ledger.user(`Episode ${turn + 1}: ${script} ${names}`);
		ledger.assistant(`Plan for ${script}: start from ${names} and keep the residual bounded.`, `Working on ${names}.`);
		switch (script) {
			case "explore": {
				// A listing walks a subtree; relative names resolve against the listed
				// root, exactly as the path index reads a real find/ls result.
				const dir = pick(DIRECTORIES);
				const tree = rnd() < 0.6;
				const listed = tree
					? repo.slice(0, between(24, repo.length))
					: repo.filter((file) => file.path.startsWith(`${dir}/`));
				const root = tree ? "." : dir;
				ledger.call(
					rnd() < 0.5 ? "find" : "ls",
					{ path: root },
					listed.map((file) => (tree ? file.path : file.path.slice(dir.length + 1))).join("\n"),
				);
				const term = pick(["residual", "checkpoint", "boundary", "tolerance"]);
				const matches = repo.filter(() => rnd() < 0.15).slice(0, 20);
				ledger.call(
					"grep",
					{ pattern: term, path: "src" },
					matches
						.map(
							(file) =>
								`${file.path}:${between(1, file.lines)}: ${term} = compute_${term}(state, dt, tol=1e-6)  # ${file.path}`,
						)
						.join("\n"),
				);
				// A few listings are walked in full, which is what rung 4 and the
				// discovery edges measure; the rest leave unread paths behind.
				const walk = rnd() < 0.15 ? listed : listed.slice(0, between(2, 4));
				for (const file of [...walk, ...matches.slice(0, between(0, 2))]) readWhole(file);
				break;
			}
			case "implement": {
				for (const file of focus) {
					readWhole(file);
					edit(file);
					if (rnd() < 0.7) readRange(file);
				}
				break;
			}
			case "validate": {
				const culprit = pick(focus);
				readWhole(culprit);
				runTests(focus, culprit);
				edit(culprit);
				runTests(focus, null);
				break;
			}
			case "analyze": {
				const lines = between(spec.simulationLines[0], spec.simulationLines[1]);
				const text = simulationOutput(lines, spec.seed + turn);
				const offload = lines > spec.offloadAfterLines;
				ledger.call(
					"bash",
					{ command: `python scripts/run_sim.py --config configs/run.yaml --steps ${lines}` },
					offload ? `${text.split("\n").slice(0, spec.offloadAfterLines).join("\n")}\n[tool result truncated]` : text,
					{ offload },
				);
				const results = pick(focus);
				readRange(results);
				if (rnd() < 0.5)
					ledger.call(
						"grep",
						{ pattern: "energy", path: results.path },
						`${results.path}:${between(1, results.lines)}: energy = 0.999`,
					);
				break;
			}
		}
		ledger.assistant(`Checked ${names}; residual acceptable for this episode.`, `Done with episode ${turn + 1}.`);
	}

	const entries = ledger.entries;
	return {
		id: `${spec.id}-${String(index).padStart(2, "0")}`,
		source: `synthetic:${spec.id}#${index}`,
		cwd,
		entries,
		turnCount: countReplayTurns(entries),
	};
}

/** Every trace of the named corpora, with a cascade shaped like the ledger loader's. */
export function generateSyntheticCorpora(ids: ReadonlyArray<string>): { traces: Trace[]; cascade: ReplayLoadCascade } {
	const traces: Trace[] = [];
	for (const id of ids) {
		const spec = syntheticCorpus(id);
		if (spec === undefined) throw new Error(`unknown synthetic corpus: ${id}`);
		for (let index = 0; index < spec.traces; index += 1) traces.push(generateSyntheticTrace(spec, index));
	}
	return { traces, cascade: { found: traces.length, unreadable: 0, filtered: {}, kept: traces.length } };
}
