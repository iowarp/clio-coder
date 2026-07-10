import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { runBootstrap } from "../domains/context/index.js";
import {
	bootstrapInputFromInitOptions,
	CONTEXT_INIT_FLAG_TABLE,
	type ContextInitOptions,
	validateInitOptions,
} from "../domains/context/init-options.js";
import { modelBootstrapGenerate } from "./bootstrap-generate.js";

const HELP = `Usage:
  clio context init [--preview] [--heuristic] [--yes] [--json] [--adopt] [--propose|--apply|--rewrite]

Explore the repository and bootstrap the project context in one pass: CLIO.md,
the codewiki index, and the .clio state. The configured Clio
target drafts CLIO.md grounded in the existing handbook, codewiki structure, and
sibling agent context. Existing CLIO.md files are preserved by default; use
--propose for an ignored draft, --apply to update the handbook using it as source,
or --rewrite to replace it with a fresh draft that ignores the current CLIO.md.

Options:
  --preview        show the plan without writing any files
  --heuristic      skip model exploration; use the deterministic generator (offline)
  --adopt          refresh only the managed Imported agent context section
  --propose        write an ignored .clio/proposals/CLIO-*.md draft when CLIO.md exists
  --apply          replace an existing CLIO.md with a draft grounded in the existing handbook
  --rewrite        replace an existing CLIO.md with a fresh draft that ignores it as source
  --json           emit one machine-readable result object on stdout
  --yes, -y        update .gitignore without prompting
`;

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
}

function parseContextInitArgs(args: ReadonlyArray<string>): {
	options: ContextInitOptions;
	json: boolean;
	error: string | null;
} {
	const options: ContextInitOptions = {};
	let json = false;
	for (const arg of args) {
		if (arg === "--help" || arg === "-h" || arg === "--yes" || arg === "-y") continue;
		if (arg === "--json") {
			json = true;
			continue;
		}
		const row = CONTEXT_INIT_FLAG_TABLE.find((candidate) => candidate.flag === arg || candidate.aliases?.includes(arg));
		if (!row) {
			return { options, json, error: arg.startsWith("-") ? `unknown flag ${arg}` : `unexpected argument ${arg}` };
		}
		options[row.field] = true;
	}
	return { options, json, error: null };
}

interface InitPhaseTiming {
	startedAt: number;
	completedMs?: number;
}

async function confirmGitignore(assumeYes: boolean): Promise<boolean> {
	if (assumeYes) return true;
	if (!input.isTTY) return false;
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question("Update .gitignore for Clio context artifacts? [y/N] ");
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

export async function runInitCommand(args: string[]): Promise<number> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const assumeYes = hasFlag(args, "--yes") || hasFlag(args, "-y");
	const parsed = parseContextInitArgs(args);
	if (parsed.error) {
		process.stderr.write(`clio context init: ${parsed.error}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	const validationError = validateInitOptions(parsed.options);
	if (validationError) {
		process.stderr.write(`${validationError}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	const bootstrapOptions = bootstrapInputFromInitOptions(parsed.options);
	// Model-driven exploration is the default. --heuristic (or legacy --no-generate)
	// forces the deterministic generator; preview never spawns a model.
	const useModel = parsed.options.heuristic !== true && parsed.options.preview !== true;
	const startedAt = performance.now();
	const phaseTimings = new Map<string, InitPhaseTiming>();
	try {
		const result = await runBootstrap({
			cwd: process.cwd(),
			io: {
				stdout: (s) => {
					if (!parsed.json) process.stdout.write(s);
				},
				stderr: (s) => process.stderr.write(s),
			},
			onProgress: (event) => {
				const now = performance.now();
				const timing = phaseTimings.get(event.phase);
				if (event.status === "started") phaseTimings.set(event.phase, { startedAt: now });
				else if (event.status === "completed" && timing) timing.completedMs = Math.max(0, now - timing.startedAt);
			},
			confirmGitignore: () => confirmGitignore(assumeYes),
			...bootstrapOptions,
			...(useModel
				? {
						generate: modelBootstrapGenerate({
							onFallback: (err, mode) =>
								process.stderr.write(
									`clio context init: model exploration unavailable, using ${mode === "existing" ? "existing CLIO.md" : "heuristic"} (${err.message})\n`,
								),
						}),
						modelId: "configured-clio-target",
					}
				: {}),
		});
		if (parsed.json) {
			process.stdout.write(
				`${JSON.stringify({
					version: 1,
					action: result.summary.action,
					projectType: result.projectType,
					codewikiEntries: result.summary.codewikiEntries,
					clioMdPath: result.clioMdPath,
					statePath: result.statePath,
					preload: result.preload,
					adoption: result.summary.adoption,
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
		return 0;
	} catch (err) {
		process.stderr.write(`clio context init failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
