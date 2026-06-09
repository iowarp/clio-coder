import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { runBootstrap } from "../domains/context/index.js";
import { modelBootstrapGenerate } from "./bootstrap-generate.js";

const HELP = `Usage:
  clio context-init [--preview] [--heuristic] [--yes]

Explore the repository and bootstrap the project context in one pass: CLIO.md,
the codewiki index, a starter handoff, and the .clio state. The configured Clio
target drafts CLIO.md grounded in the codewiki structure and folds in sibling
agent context (AGENTS.md, CLAUDE.md, .codex, ...); it falls back to a
deterministic heuristic when no target is reachable.

Options:
  --preview        show the plan without writing any files
  --heuristic      skip model exploration; use the deterministic generator (offline)
  --yes, -y        update .gitignore without prompting
`;

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
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
	const preview = hasFlag(args, "--preview");
	// Model-driven exploration is the default. --heuristic (or legacy --no-generate)
	// forces the deterministic generator; preview never spawns a model.
	const heuristic = hasFlag(args, "--heuristic") || hasFlag(args, "--no-generate");
	const useModel = !heuristic && !preview;
	try {
		await runBootstrap({
			cwd: process.cwd(),
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
			confirmGitignore: () => confirmGitignore(assumeYes),
			preview,
			// Always fold in project agent context; context-init is the one-pass
			// bootstrap. --global stays opt-in (and undocumented) for privacy.
			adopt: true,
			includeGlobalImports: hasFlag(args, "--global") || hasFlag(args, "--include-global"),
			...(useModel
				? {
						generate: modelBootstrapGenerate({
							onFallback: (err) =>
								process.stderr.write(`clio context-init: model exploration unavailable, using heuristic (${err.message})\n`),
						}),
						modelId: "configured-clio-target",
					}
				: {}),
		});
		return 0;
	} catch (err) {
		process.stderr.write(`clio context-init failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
