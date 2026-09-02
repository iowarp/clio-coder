/**
 * Render docs/knobs.md from the registry plus what the source tree says about
 * each entry: read sites, whether another doc mentions it, whether a test does.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchRegistry } from "./check.js";
import { projectFileSites } from "./sources.js";
import {
	entryKey,
	KNOB_KINDS,
	type KnobKind,
	type Registry,
	type RegistryEntry,
	type SourceInventory,
	type SourceSite,
} from "./types.js";

export const KNOBS_DOC_PATH = "docs/knobs.md";

const KIND_TITLES: Record<KnobKind, string> = {
	env: "Environment variables",
	setting: "Settings keys (settings.yaml)",
	flag: "CLI flags",
	"project-file": "Project files under .clio-coder/",
	"tool-arg": "Tool arguments that carry policy",
	"recipe-key": "Agent recipe frontmatter",
	"fragment-key": "Prompt fragment frontmatter",
	"model-tag": "Model knowledge-base keys",
	constant: "Hardcoded constants",
};

const KIND_INTROS: Record<KnobKind, string> = {
	env: "Read from `process.env` under `src/`. Durable policy lives in settings; these override one process, mark Clio's own children, or exist for tests. `docs/environment-variables.md` carries the prose.",
	setting:
		"Every dotted key the settings-v2 schema accepts. `<key>` stands for an operator-chosen name and `[]` for a list element. Layering: built-in default, then the user `settings.yaml`, then `.clio-coder/settings.yaml`, then `.clio-coder/settings.local.yaml`, then CLI flags for one process.",
	flag:
		"Every `--flag` a command parser under `src/cli` matches. `global` flags come before the subcommand. A flag overrides the setting it names for one process and never writes it.",
	"project-file": "Keys of the YAML files and resource directories a repository can commit under `.clio-coder/`.",
	"tool-arg":
		"Argument schema paths of the tools whose arguments shape policy rather than carry the task: `dispatch`, `bash`, `context`, and `verify`. Class `policy` is a knob a model turns; class `task` is the payload.",
	"recipe-key":
		"Frontmatter keys of an agent recipe (`src/domains/agents/builtins/*.md` and project `.clio-coder/agents/`).",
	"fragment-key": "Frontmatter keys of the prompt fragments under `src/domains/prompts/fragments/`.",
	"model-tag":
		"Key paths in the model knowledge base (`src/domains/providers/models/**/*.yaml`). `<gpuTiers>`-style segments are data. Only `capabilities`, `quirks.kvCache`, `quirks.sampling`, and `quirks.thinking` reach a request; the rest is provenance or server-start advice.",
	constant:
		"Numeric constants in the files listed under `constantScopes` in the registry. They are not operator-tunable; they are here because they bound prompts, budgets, and repairs, and a change to one is a behavior change.",
};

function walkFiles(dir: string, accept: (file: string) => boolean): string[] {
	const found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const entry of entries.sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) found.push(...walkFiles(full, accept));
		else if (accept(full)) found.push(full);
	}
	return found;
}

interface Corpus {
	docs: Array<{ path: string; text: string }>;
	tests: Array<{ path: string; text: string }>;
}

function readCorpus(root: string): Corpus {
	const docs = [
		...walkFiles(join(root, "docs"), (f) => f.endsWith(".md") && !f.endsWith(KNOBS_DOC_PATH.slice("docs".length))),
		join(root, "README.md"),
		...walkFiles(join(root, "skills"), (f) => f.endsWith("README.md")),
	].map((file) => ({ path: file.slice(root.length + 1), text: readFileSync(file, "utf8") }));
	const tests = walkFiles(join(root, "tests"), (f) => f.endsWith(".ts")).map((file) => ({
		path: file.slice(root.length + 1),
		text: readFileSync(file, "utf8"),
	}));
	return { docs, tests };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The token a doc or test would spell for this knob. */
function mentionPattern(entry: RegistryEntry): RegExp {
	const name = entry.name;
	if (
		entry.kind === "setting" ||
		entry.kind === "model-tag" ||
		entry.kind === "tool-arg" ||
		entry.kind === "recipe-key"
	) {
		// The dotted path anywhere, or the last segment as a word inside a code
		// span: docs spell keys in backticks, and a bare English word is not a mention.
		const leaf = name.replace(/\[\]$/, "").split(".").at(-1) ?? name;
		if (leaf.startsWith("<")) return new RegExp(escapeRegExp(name.split(".").slice(0, -1).join(".")));
		return new RegExp(
			`${escapeRegExp(name)}|\`[^\`\\n]*?(?:^|[^A-Za-z0-9_])${escapeRegExp(leaf)}(?![A-Za-z0-9_])[^\`\\n]*?\``,
			"m",
		);
	}
	if (entry.kind === "flag") return new RegExp(`${escapeRegExp(name)}(?![a-zA-Z0-9-])`);
	if (entry.kind === "project-file") {
		const leaf = name.replace(/\[\]$/, "").split(".").at(-1) ?? name;
		if (leaf.startsWith("(")) return new RegExp(escapeRegExp(entry.file ?? name));
		return new RegExp(`\`[^\`\\n]*?(?:^|[^A-Za-z0-9_])${escapeRegExp(leaf)}(?![A-Za-z0-9_])[^\`\\n]*?\``, "m");
	}
	return new RegExp(`(?:^|[^a-zA-Z0-9_])${escapeRegExp(name)}(?![a-zA-Z0-9_])`, "m");
}

function mentions(corpus: Array<{ path: string; text: string }>, entry: RegistryEntry): string[] {
	const pattern = mentionPattern(entry);
	return corpus.filter((doc) => pattern.test(doc.text)).map((doc) => doc.path);
}

function cell(text: string | undefined): string {
	return (text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function sitesCell(sites: SourceSite[]): string {
	if (sites.length === 0) return "";
	const shown = sites.slice(0, 3).map((s) => `\`${s.path}:${s.line}\``);
	return sites.length > 3 ? `${shown.join(", ")} (+${sites.length - 3})` : shown.join(", ");
}

export interface RenderedCounts {
	byKind: Record<KnobKind, number>;
	undocumented: number;
	untested: number;
	byVerdict: Record<string, number>;
}

/** Whether each entry is mentioned by a doc page other than knobs.md, keyed like the registry check. */
export function computeCountsPerEntry(root: string, registry: Registry): Map<string, boolean> {
	const corpus = readCorpus(root);
	const out = new Map<string, boolean>();
	for (const entry of registry.entries) out.set(entryKey(entry), mentions(corpus.docs, entry).length > 0);
	return out;
}

export function computeCounts(root: string, registry: Registry): RenderedCounts {
	const corpus = readCorpus(root);
	const byKind = {} as Record<KnobKind, number>;
	const byVerdict: Record<string, number> = {};
	let undocumented = 0;
	let untested = 0;
	for (const entry of registry.entries) {
		byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
		byVerdict[entry.verdict] = (byVerdict[entry.verdict] ?? 0) + 1;
		if (mentions(corpus.docs, entry).length === 0) undocumented += 1;
		if (mentions(corpus.tests, entry).length === 0) untested += 1;
	}
	return { byKind, undocumented, untested, byVerdict };
}

export function renderKnobsDoc(root: string, registry: Registry, inventory: SourceInventory): string {
	const corpus = readCorpus(root);
	const matches = matchRegistry(registry, inventory);
	const lines: string[] = [];
	lines.push("# Knob Registry");
	lines.push("");
	lines.push(
		"Every flag, key, argument, and constant that changes what Clio Coder does, rendered from `docs/knobs.yaml` by `npm run knobs`. The `knob-registry` check in `scripts/check-hygiene.ts` (run by `npm run lint`) fails when the source tree reads a knob the registry does not list, when the registry lists one the tree no longer reads, when a settings or constant default disagrees with the code, or when this page is stale. Declare a new knob in the registry first; the check tells you which surface it found it on.",
	);
	lines.push("");
	lines.push(
		"Columns: **Default** is what applies when nothing sets the knob. **Read at** cites the source line the check verified. **Doc** lists other pages that mention the knob (none means the registry row is its only documentation). **Test** lists test files that mention it. **Verdict** is the maintainers' call: `keep`, `merge` into another knob, `deprecate` behind a warning, `document` (kept, and this row is now its documentation), or `remove`.",
	);
	lines.push("");

	lines.push("## Counts");
	lines.push("");
	lines.push(
		"| Kind | Entries | Undocumented elsewhere | No test mention | keep | merge | deprecate | document | remove |",
	);
	lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
	let total = 0;
	const totals = { undocumented: 0, untested: 0, keep: 0, merge: 0, deprecate: 0, document: 0, remove: 0 };
	for (const kind of KNOB_KINDS) {
		const entries = registry.entries.filter((e) => e.kind === kind);
		if (entries.length === 0) continue;
		const undocumented = entries.filter((e) => mentions(corpus.docs, e).length === 0).length;
		const untested = entries.filter((e) => mentions(corpus.tests, e).length === 0).length;
		const verdicts = { keep: 0, merge: 0, deprecate: 0, document: 0, remove: 0 };
		for (const e of entries) verdicts[e.verdict] += 1;
		total += entries.length;
		totals.undocumented += undocumented;
		totals.untested += untested;
		for (const v of Object.keys(verdicts) as Array<keyof typeof verdicts>) totals[v] += verdicts[v];
		lines.push(
			`| ${KIND_TITLES[kind]} | ${entries.length} | ${undocumented} | ${untested} | ${verdicts.keep} | ${verdicts.merge} | ${verdicts.deprecate} | ${verdicts.document} | ${verdicts.remove} |`,
		);
	}
	lines.push(
		`| **Total** | **${total}** | **${totals.undocumented}** | **${totals.untested}** | **${totals.keep}** | **${totals.merge}** | **${totals.deprecate}** | **${totals.document}** | **${totals.remove}** |`,
	);
	lines.push("");

	for (const kind of KNOB_KINDS) {
		const entries = registry.entries.filter((e) => e.kind === kind);
		if (entries.length === 0) continue;
		lines.push(`## ${KIND_TITLES[kind]}`);
		lines.push("");
		lines.push(KIND_INTROS[kind]);
		lines.push("");
		const groups = new Map<string, RegistryEntry[]>();
		for (const entry of entries) {
			const group = entry.command ?? entry.file ?? entry.source ?? "";
			const list = groups.get(group) ?? [];
			list.push(entry);
			groups.set(group, list);
		}
		const groupNames = [...groups.keys()].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b)));
		for (const group of groupNames) {
			const list = (groups.get(group) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
			if (group.length > 0) {
				lines.push(
					`### ${kind === "flag" ? `\`clio-coder ${group === "global" ? "" : group}\`` : `\`${group}\``}`.replace(
						/ `$/,
						"`",
					),
				);
				lines.push("");
			}
			const hasClass = kind === "tool-arg";
			lines.push(
				`| Name | Owner |${hasClass ? " Class |" : ""} Default | Controls | Precedence | Read at | Doc | Test | Verdict |`,
			);
			lines.push(`| --- | --- |${hasClass ? " --- |" : ""} --- | --- | --- | --- | --- | --- | --- |`);
			for (const entry of list) {
				const match = matches.get(entryKey(entry));
				const sites =
					entry.kind === "project-file" && entry.file
						? projectFileSites(root, entry.file, entry.name)
						: (match?.sources.flatMap((s) => s.sites) ?? []);
				const docs = mentions(corpus.docs, entry);
				const tests = mentions(corpus.tests, entry);
				const verdict =
					entry.verdict === "merge" || entry.verdict === "deprecate"
						? `${entry.verdict} → \`${entry.mergeWith ?? ""}\``
						: entry.verdict;
				const note = entry.note ? ` ${cell(entry.note)}` : "";
				lines.push(
					`| \`${cell(entry.name)}\` | ${cell(entry.owner)} |${hasClass ? ` ${cell(entry.class)} |` : ""} ${entry.default === undefined ? "" : `\`${cell(entry.default)}\``} | ${cell(entry.controls)}${note} | ${cell(entry.precedence)} | ${sitesCell(sites)} | ${docs.map((d) => `\`${d}\``).join(", ")} | ${tests.map((t) => `\`${t.replace(/^tests\//, "")}\``).join(", ")} | ${verdict} |`,
				);
			}
			lines.push("");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Line numbers move with every edit; the staleness check compares everything but them. */
export function normalizeRenderedDoc(text: string): string {
	return text.replace(/((?:src|scripts|docs|tests|skills)\/[\w./-]+):\d+/g, "$1");
}
