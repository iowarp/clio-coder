const HELP = `Usage:
  clio context
  clio context init [--yes] [--preview|--heuristic] [--adopt] [--propose|--apply|--rewrite]
  clio context refresh [--wiki]
  clio context wiki [--update] [--status]
  clio context reset [--all]
  clio context index [--json]

Project context commands:
  clio context              show project context status (CLIO.md, preload, codewiki)
  clio context init         explore the repo and bootstrap CLIO.md and codewiki
  clio context refresh      re-index the codewiki and optionally update the Markdown wiki
  clio context wiki         generate or inspect the agent-authored Markdown wiki
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
		: state && !context.isStale(state.fingerprint, context.computeFingerprint(cwd, codewiki))
			? "fresh"
			: "stale (run clio context refresh)";
	const codewikiLines = [`codewiki: ${codewikiState} (${codewikiCount} entr${codewikiCount === 1 ? "y" : "ies"})`];
	if (codewiki) codewikiLines.push(context.renderCodewikiDigest(codewiki));

	const adoptionSources = state?.contextSources ?? [];
	const adoptionChanged = adoptionSources.length > 0 && context.adoptionSourcesChanged(adoptionSources);
	const adoptionState = adoptionChanged ? "changed (run clio context init --adopt)" : "up to date";

	process.stdout.write(
		[
			`CLIO.md: ${clioMdState}`,
			`preload: ${preloadClass.label}`,
			...codewikiLines,
			`adoption: ${adoptionSources.length} source${adoptionSources.length === 1 ? "" : "s"}, ${adoptionState}`,
			"",
		].join("\n"),
	);
	return 0;
}

async function runRefreshCommand(args: string[]): Promise<number> {
	let updateWiki = false;
	for (const arg of args) {
		if (arg === "--wiki") {
			updateWiki = true;
			continue;
		}
		process.stderr.write(`clio context refresh: unknown flag ${arg}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	try {
		const { runContextRefresh } = await import("../domains/context/index.js");
		const wikiEntry = updateWiki ? await import("./wiki-generate.js") : null;
		const result = await runContextRefresh({
			cwd: process.cwd(),
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
			wiki: updateWiki,
			...(wikiEntry
				? { wikiGenerate: wikiEntry.modelWikiGenerate(), wikiModel: await wikiEntry.resolveDocumenterModelId() }
				: {}),
		});
		if (result.hint) process.stdout.write(`${result.hint}\n`);
		if (result.wiki) {
			if (result.wiki.status === "failed") {
				process.stderr.write(
					`clio context refresh: wiki update failed: ${(result.wiki.problems ?? ["unknown failure"]).join("; ")}\n`,
				);
				return 1;
			}
			process.stdout.write(
				result.wiki.status === "noop"
					? `clio context refresh: wiki unchanged (${result.wiki.pages} page${result.wiki.pages === 1 ? "" : "s"})\n`
					: `clio context refresh: wiki updated (${result.wiki.pages} page${result.wiki.pages === 1 ? "" : "s"})\n`,
			);
		}
		return 0;
	} catch (err) {
		process.stderr.write(`clio context refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

async function runWikiStatusCommand(): Promise<number> {
	const context = await import("../domains/context/index.js");
	const cwd = process.cwd();
	const meta = context.readWikiMeta(cwd);
	if (!meta) {
		const pageCount = context.listWikiPages(cwd).length;
		process.stdout.write(`wiki: absent (${pageCount} page${pageCount === 1 ? "" : "s"})\n`);
		return 0;
	}
	const currentHead = context.currentWikiGitHead(cwd);
	const lines = [
		`wiki: present (${meta.pages.length} page${meta.pages.length === 1 ? "" : "s"})`,
		`updatedAt: ${meta.updatedAt}`,
		`gitHead: ${meta.gitHead ?? "none"}`,
	];
	if (currentHead !== meta.gitHead) {
		lines.push(`staleness: gitHead differs from current HEAD (${currentHead ?? "none"})`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

async function runWikiCommand(args: string[]): Promise<number> {
	let forceUpdate = false;
	let status = false;
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(HELP);
			return 0;
		}
		if (arg === "--update") {
			forceUpdate = true;
			continue;
		}
		if (arg === "--status") {
			status = true;
			continue;
		}
		process.stderr.write(`clio context wiki: unknown flag ${arg}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	if (status) return runWikiStatusCommand();
	try {
		const context = await import("../domains/context/index.js");
		const { modelWikiGenerate, resolveDocumenterModelId } = await import("./wiki-generate.js");
		const result = await context.runWikiGenerate({
			cwd: process.cwd(),
			...(forceUpdate ? { mode: "update" as const } : {}),
			model: await resolveDocumenterModelId(),
			generate: modelWikiGenerate(),
		});
		if (result.status === "failed") {
			process.stderr.write(`clio context wiki failed: ${(result.problems ?? ["unknown failure"]).join("; ")}\n`);
			return 1;
		}
		process.stdout.write(
			result.status === "noop"
				? `clio context wiki: unchanged (${result.pages} page${result.pages === 1 ? "" : "s"})\n`
				: `clio context wiki: generated ${result.pages} page${result.pages === 1 ? "" : "s"}\n`,
		);
		return 0;
	} catch (err) {
		process.stderr.write(`clio context wiki failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
		case "wiki":
			return runWikiCommand(rest);
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
