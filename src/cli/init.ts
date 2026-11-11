import { formatContextOperationResult } from "../core/context-operation.js";
import {
	acceptHandbookProposal,
	proposeHandbookVerification,
	runBootstrap,
	verifyHandbook,
} from "../domains/context/index.js";
import {
	bootstrapInputFromInitOptions,
	CONTEXT_INIT_FLAG_TABLE,
	type ContextInitOptions,
	validateInitOptions,
} from "../domains/context/init-options.js";
import { bootstrapOperationFacts } from "../domains/context/operation-result.js";
import { type ThinkingLevel, VALID_THINKING_LEVELS } from "../domains/providers/index.js";
import { modelBootstrapGenerate } from "./bootstrap-generate.js";
import { createContextCliOperation, createContextCliProgress } from "./context-progress.js";

const HELP = `Usage:
  clio-coder context init [--preview] [--heuristic] [--json] [--adopt] [--global] [--propose|--apply|--rewrite]
                    [--depth quick|standard|deep] [--target <id> [--model <id>] [--thinking <level>]]
  clio-coder context init --verify [--apply] [--json]
  clio-coder context init --accept [<proposal path or id>] [--json]

Explore the repository and bootstrap the project context in one pass: CLIO-CODER.md,
the codewiki index, and the .clio-coder state. The configured Clio
target drafts CLIO-CODER.md grounded in the existing handbook, codewiki structure, and
sibling agent context. Existing CLIO-CODER.md files are preserved by default; use
--propose for an ignored draft, --apply to update the handbook using it as source,
or --rewrite to replace it with a fresh draft that ignores the current CLIO-CODER.md,
except Hard invariants whose cited paths and symbols still exist.

Options:
  --preview        show the plan without writing any files
  --heuristic      skip model exploration; use the deterministic generator (offline)
  --adopt          refresh only the managed Imported agent context section
  --global         include global sibling agent context from user home directory
  --propose        write an ignored .clio-coder/proposals/CLIO-CODER-*.md draft when CLIO-CODER.md exists
  --apply          replace an existing CLIO-CODER.md with a draft grounded in the existing handbook
  --rewrite        replace an existing CLIO-CODER.md with a fresh draft that ignores it as source,
                   keeping Hard invariants whose cited paths and symbols still exist
  --json           emit one machine-readable result object on stdout
  --depth <level>  bounded exploration: quick (8 calls, 2m), standard (16 calls, 4m), deep (32 calls, 8m)
  --target <id>    override the configured bootstrap target for this noninteractive run
  --model <id>     override the bootstrap wire model (requires --target)
  --thinking <n>   override bootstrap thinking: ${VALID_THINKING_LEVELS.join("|")} (requires --target)
  --verify         re-check every rule of the effective handbook against the current tree without a model;
                   lists rules as verified, stale, contradicted or unverifiable with file:line, records the
                   verdicts in the handbook ledger, and exits 1 when any rule is stale or contradicted.
                   With --apply, writes a proposal without the flagged rules (correcting renumbered rule ids)
                   and prints its diff; the handbook changes only when --accept writes it
  --accept [<id>]  write a reviewed .clio-coder/proposals draft (newest when no path or id is given) to the
                   handbook it was drafted for, byte for byte; refuses when that handbook changed since
`;

/** Where the command writes; tests pass their own instead of replacing process.stdout. */
export interface InitCommandIo {
	stdout(text: string): void;
	stderr(text: string): void;
}

const PROCESS_IO: InitCommandIo = {
	stdout: (text) => {
		process.stdout.write(text);
	},
	stderr: (text) => {
		process.stderr.write(text);
	},
};

const VERDICT_ORDER = ["verified", "stale", "contradicted", "unverifiable"] as const;

async function runVerifyCommand(args: ReadonlyArray<string>, io: InitCommandIo): Promise<number> {
	const extra = args.filter((arg) => arg !== "--verify" && arg !== "--json" && arg !== "--apply");
	if (extra.length > 0) {
		io.stderr(`clio-coder context init: --verify takes only --apply and --json, not ${extra.join(" ")}\n`);
		return 2;
	}
	const json = args.includes("--json");
	const cwd = process.cwd();
	const verification = await verifyHandbook(cwd);
	const flagged = verification.entries.filter((entry) => entry.verdict === "stale" || entry.verdict === "contradicted");
	const proposals = args.includes("--apply") && flagged.length > 0 ? proposeHandbookVerification(verification) : [];
	if (json) {
		io.stdout(
			`${JSON.stringify({
				version: 1,
				files: verification.files,
				commit: verification.commit,
				flagged: flagged.length,
				rules: verification.entries.map((entry) => ({
					verdict: entry.verdict,
					file: entry.source.file,
					line: entry.source.line,
					text: entry.text,
					reason: entry.reason,
					...(entry.ruleIds ? { ruleIds: entry.ruleIds } : {}),
				})),
				proposals: proposals.map(({ file, id, proposalPath, diff }) => ({ file, id, proposalPath, diff })),
			})}\n`,
		);
	} else if (verification.files.length === 0) {
		io.stdout("No project handbook to verify.\n");
	} else {
		const lines = [`Verified ${verification.files.join(", ")} at ${verification.commit?.slice(0, 12) ?? "uncommitted"}`];
		for (const verdict of VERDICT_ORDER) {
			const rows = verification.entries.filter((entry) => entry.verdict === verdict);
			if (rows.length === 0) continue;
			lines.push("", `${verdict} (${rows.length}):`);
			for (const entry of rows) {
				const text = entry.text.length > 100 ? `${entry.text.slice(0, 97)}...` : entry.text;
				const reason = verdict === "verified" ? "" : ` [${entry.reason}]`;
				lines.push(`  ${entry.source.file}:${entry.source.line}  ${text}${reason}`);
			}
		}
		for (const proposal of proposals) lines.push("", proposal.diff);
		const from = verification.root === cwd ? "" : ` from ${verification.root}`;
		for (const proposal of proposals)
			lines.push(
				"",
				`Proposed ${proposal.file} without the flagged rules; review the diff, then run \`clio-coder context init --accept ${proposal.id}\`${from}.`,
			);
		if (flagged.length > 0 && proposals.length === 0)
			lines.push(
				"",
				`${flagged.length} rule${flagged.length === 1 ? "" : "s"} need attention; rerun with --apply to propose removing or correcting them.`,
			);
		io.stdout(`${lines.join("\n")}\n`);
	}
	return flagged.length > 0 ? 1 : 0;
}

function runAcceptCommand(args: ReadonlyArray<string>, io: InitCommandIo): number {
	const json = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--accept" && arg !== "--json");
	if (rest.length > 1 || rest.some((arg) => arg.startsWith("-"))) {
		io.stderr(`clio-coder context init: --accept takes one proposal path or id and --json, not ${rest.join(" ")}\n`);
		return 2;
	}
	const result = acceptHandbookProposal(process.cwd(), rest[0]);
	if (json) io.stdout(`${JSON.stringify({ version: 1, ...result })}\n`);
	else if (result.ok) io.stdout(`Wrote ${result.handbookPath} from ${result.proposalPath}\n`);
	else
		io.stderr(
			`clio-coder context init --accept refused${result.proposalPath ? ` ${result.proposalPath}` : ""}: ${result.reason}\n`,
		);
	return result.ok ? 0 : 1;
}

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
}

function parseContextInitArgs(args: ReadonlyArray<string>): {
	options: ContextInitOptions;
	json: boolean;
	target?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	error: string | null;
} {
	const options: ContextInitOptions = {};
	let json = false;
	let target: string | undefined;
	let model: string | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	const thinkingLevels = new Set<ThinkingLevel>(VALID_THINKING_LEVELS);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] as string;
		if (arg === "--help" || arg === "-h") continue;
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--target" || arg === "--model" || arg === "--thinking" || arg === "--depth") {
			const value = args[index + 1];
			if (!value || value.startsWith("-")) return { options, json, error: `${arg} requires a value` };
			index += 1;
			if (arg === "--target") target = value;
			else if (arg === "--model") model = value;
			else if (arg === "--depth") {
				if (value !== "quick" && value !== "standard" && value !== "deep")
					return { options, json, error: "--depth must be quick, standard, or deep" };
				options.depth = value;
			} else {
				if (!thinkingLevels.has(value as ThinkingLevel)) {
					return { options, json, error: `--thinking must be one of: ${[...thinkingLevels].join("|")}` };
				}
				thinkingLevel = value as ThinkingLevel;
			}
			continue;
		}
		const row = CONTEXT_INIT_FLAG_TABLE.find((candidate) => candidate.flag === arg || candidate.aliases?.includes(arg));
		if (!row) {
			return { options, json, error: arg.startsWith("-") ? `unknown flag: ${arg}` : `unexpected argument: ${arg}` };
		}
		options[row.field] = true;
	}
	if (!target && (model || thinkingLevel)) {
		return { options, json, error: "--model and --thinking require --target" };
	}
	return {
		options,
		json,
		...(target ? { target } : {}),
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		error: null,
	};
}

interface InitPhaseTiming {
	startedAt: number;
	completedMs?: number;
}

export async function runInitCommand(args: string[], io: InitCommandIo = PROCESS_IO): Promise<number> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		io.stdout(HELP);
		return 0;
	}
	if (hasFlag(args, "--verify")) return runVerifyCommand(args, io);
	if (hasFlag(args, "--accept")) return runAcceptCommand(args, io);
	const parsed = parseContextInitArgs(args);
	if (parsed.error) {
		io.stderr(`clio-coder context init: ${parsed.error}\n`);
		io.stderr(HELP);
		return 2;
	}
	const validationError = validateInitOptions(parsed.options);
	if (validationError) {
		io.stderr(`${validationError}\n`);
		io.stderr(HELP);
		return 2;
	}
	const bootstrapOptions = bootstrapInputFromInitOptions(parsed.options);
	// Model-driven exploration is the default. --heuristic
	// forces the deterministic generator; preview never spawns a model.
	const useModel = parsed.options.heuristic !== true && parsed.options.preview !== true;
	const startedAt = performance.now();
	const phaseTimings = new Map<string, InitPhaseTiming>();
	const progress = createContextCliProgress("init");
	const operation = createContextCliOperation("context-init", progress.update);
	const warnings: string[] = [];
	try {
		const result = await runBootstrap({
			cwd: process.cwd(),
			io: {
				stdout: (s) => {
					if (!parsed.json) io.stdout(s);
				},
				stderr: (s) => {
					warnings.push(s);
					io.stderr(s);
				},
			},
			onProgress: (event) => {
				if (event.phase !== "done") operation.progress(event);
				const now = performance.now();
				const timing = phaseTimings.get(event.phase);
				if (event.status === "started") phaseTimings.set(event.phase, { startedAt: now });
				else if (event.status === "completed" && timing) timing.completedMs = Math.max(0, now - timing.startedAt);
			},
			...bootstrapOptions,
			...(useModel
				? {
						generate: modelBootstrapGenerate({
							...(parsed.target
								? {
										route: {
											target: parsed.target,
											...(parsed.model ? { model: parsed.model } : {}),
											...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
										},
									}
								: {}),
							onFallback: (err, mode) =>
								io.stderr(
									`clio-coder context init: model exploration unavailable, using ${mode === "existing" ? "existing CLIO-CODER.md" : "heuristic"} (${err.message})\n`,
								),
						}),
						modelId: "configured-clio-target",
					}
				: {}),
		});
		const conclusion = operation.finish(
			result.summary.action === "previewed" ? "previewed" : "completed",
			"Context init finished",
			{ facts: bootstrapOperationFacts(result), warnings: warnings.slice(0, 8) },
		);
		if (!parsed.json) io.stdout(`${formatContextOperationResult(conclusion)}\n`);
		if (parsed.json) {
			io.stdout(
				`${JSON.stringify({
					version: 1,
					operation: conclusion,
					action: result.summary.action,
					projectType: result.projectType,
					codewikiEntries: result.summary.codewikiEntries,
					clioMdPath: result.clioMdPath,
					statePath: result.statePath,
					preload: result.preload,
					adoption: result.summary.adoption,
					...(result.summary.absorb ? { absorb: result.summary.absorb } : {}),
					generation: result.telemetry.generation,
					timings: {
						wallMs: Math.max(0, performance.now() - startedAt),
						...(phaseTimings.get("codewiki")?.completedMs !== undefined
							? { codewikiMs: phaseTimings.get("codewiki")?.completedMs }
							: {}),
						...(phaseTimings.get("generate")?.completedMs !== undefined
							? { generationMs: phaseTimings.get("generate")?.completedMs }
							: {}),
					},
				})}\n`,
			);
		}
		// `--rewrite` asks for a draft that ignores the current CLIO-CODER.md. When the
		// model pass fails, preserve the original bytes and make a scripted caller
		// aware that the requested rewrite did not happen. The plain heuristic
		// fallback still exits 0: it is a legitimate degraded mode, and the
		// warning line above already names it.
		// A model failure late in a long run used to scroll its one fallback line
		// away under progress output, and a heuristic handbook then read as the
		// model's. Close with the verdict, naming the file and the reason.
		const generation = result.telemetry.generation;
		const written = result.summary.action === "wrote" || result.summary.action === "refreshed";
		if (useModel && generation.mode === "heuristic" && (written || result.summary.action === "proposed")) {
			const reason = (generation.fallbackReason ?? "the model draft was unusable").split("\n")[0]?.slice(0, 300) ?? "";
			const file = written ? result.clioMdPath : "the CLIO-CODER.md proposal";
			io.stderr(
				`clio-coder context init: warning: ${file} is a heuristic draft, not a model draft (${reason}).\n` +
					"  review it before committing, or rerun `clio-coder context init --rewrite` once the bootstrap target answers.\n",
			);
		}
		if (parsed.options.rewriteClioMd === true && result.telemetry.generation.mode === "existing") {
			io.stderr(
				"clio-coder context init: --rewrite did not rewrite CLIO-CODER.md; the model draft failed and the existing file was preserved.\n" +
					"  rerun `clio-coder context init --rewrite` once the bootstrap target answers, or `clio-coder context init --rewrite --heuristic` to replace it with the deterministic draft.\n",
			);
			return 1;
		}
		return 0;
	} catch (err) {
		operation.finish(
			err instanceof Error && err.name === "AbortError" ? "cancelled" : "failed",
			err instanceof Error ? err.message : String(err),
		);
		io.stderr(`clio-coder context init failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	} finally {
		progress.stop();
	}
}
