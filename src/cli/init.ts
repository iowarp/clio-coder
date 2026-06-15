import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { runBootstrap } from "../domains/context/index.js";
import { modelBootstrapGenerate } from "./bootstrap-generate.js";

const HELP = `Usage:
  clio context-init [--preview] [--heuristic] [--yes] [--adopt] [--propose|--apply|--rewrite]

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
	const rewriteClioMd = hasFlag(args, "--rewrite");
	const applyClioMd = hasFlag(args, "--apply") || rewriteClioMd;
	const proposeClioMd = hasFlag(args, "--propose");
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
			adopt: hasFlag(args, "--adopt"),
			applyClioMd,
			rewriteClioMd,
			proposeClioMd,
			includeGlobalImports: hasFlag(args, "--global") || hasFlag(args, "--include-global"),
			...(useModel
				? {
						generate: modelBootstrapGenerate({
							onFallback: (err, mode) =>
								process.stderr.write(
									`clio context-init: model exploration unavailable, using ${mode === "existing" ? "existing CLIO.md" : "heuristic"} (${err.message})\n`,
								),
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
