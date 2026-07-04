const HELP = `Usage:
  clio context
  clio context init [--yes] [--preview|--heuristic] [--adopt] [--propose|--apply|--rewrite]
  clio context refresh
  clio context reset [--all]
  clio context index [--json]

Project context commands:
  clio context              show project context status (CLIO.md, preload, codewiki)
  clio context init         explore the repo and bootstrap CLIO.md and codewiki
  clio context refresh      re-index the codewiki and refresh .clio state
  clio context reset        clear accumulated project context artifacts
  clio context index        build the codewiki index without model calls
`;

async function printContextStatus(): Promise<number> {
	const context = await import("../domains/context/index.js");
	const preload = await import("../domains/prompts/preload.js");
	const cwd = process.cwd();

	const clio = context.tryReadClioMd(cwd);
	const state = context.readClioState(cwd);
	const clioMdState = !clio
		? "none"
		: !clio.ok
			? "malformed"
			: state?.contextSources && state.contextSources.length > 0 && context.adoptionSourcesChanged(state.contextSources)
				? "stale"
				: "ok";

	const prompt = context.renderPromptContext(cwd);
	const preloadClass = preload.classifyProjectPreload({
		hasClioMd: prompt.clioMd !== null,
		text: prompt.text,
	});

	const codewiki = context.readCodewiki(cwd);
	const codewikiCount = codewiki ? context.codewikiEntries(codewiki).length : 0;
	const codewikiState = !codewiki
		? "absent"
		: state && state.fingerprint.treeHash === context.computeFingerprint(cwd).treeHash
			? "fresh"
			: "stale (run clio context refresh)";

	const adoptionSources = state?.contextSources ?? [];
	const adoptionChanged = adoptionSources.length > 0 && context.adoptionSourcesChanged(adoptionSources);
	const adoptionState = adoptionChanged ? "changed (run clio context init --adopt)" : "up to date";

	process.stdout.write(
		[
			`CLIO.md: ${clioMdState}`,
			`preload: ${preloadClass.label}`,
			`codewiki: ${codewikiState} (${codewikiCount} entr${codewikiCount === 1 ? "y" : "ies"})`,
			`adoption: ${adoptionSources.length} source${adoptionSources.length === 1 ? "" : "s"}, ${adoptionState}`,
			"",
		].join("\n"),
	);
	return 0;
}

async function runRefreshCommand(args: string[]): Promise<number> {
	for (const arg of args) {
		process.stderr.write(`clio context refresh: unknown flag ${arg}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	try {
		const { runContextRefresh } = await import("../domains/context/index.js");
		await runContextRefresh({
			cwd: process.cwd(),
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
		});
		return 0;
	} catch (err) {
		process.stderr.write(`clio context refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

export async function runContextCommand(args: string[]): Promise<number> {
	const [verb, ...rest] = args;
	if (verb === undefined) {
		return printContextStatus();
	}
	if (verb === "--help" || verb === "-h") {
		process.stdout.write(HELP);
		return 0;
	}

	switch (verb) {
		case "init":
			return (await import("./init.js")).runInitCommand(rest);
		case "refresh":
			return runRefreshCommand(rest);
		case "reset":
			return (await import("./context-clear.js")).runContextClearCommand(rest);
		case "index":
			return (await import("./context-index.js")).runContextIndexCommand(rest);
		default:
			process.stderr.write(`clio context: unknown subcommand ${verb}\n`);
			process.stdout.write(HELP);
			return 2;
	}
}
