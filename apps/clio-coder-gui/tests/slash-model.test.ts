import assert from "node:assert/strict";
import { test } from "node:test";
import {
	aliasEntries,
	exactEntry,
	parseSlashLine,
	resolveAlias,
	SLASH_ALIASES,
	type SlashFacts,
	slashEntries,
} from "../client/chat/slash-model.js";

const command = (name: string, extra: Record<string, unknown> = {}) =>
	({ name, summary: `${name} summary`, usage: `/${name}`, group: "Work", args: {}, ...extra }) as never;

const catalog = {
	version: 1 as const,
	commands: [
		command("context", {
			requiresSubcommand: true,
			args: {
				subcommands: {
					compact: { positionals: [{ name: "instructions", required: false, rest: true }] },
					init: {},
				},
			},
		}),
		command("doctor"),
		command("status"),
	],
	prompts: ["review-pr"],
};

const facts = (over: Partial<SlashFacts> = {}): SlashFacts => ({
	capabilities: { commands: true, telemetry: true, branches: { fork: true } } as never,
	catalog,
	paneAvailable: true,
	...over,
});

test("a terminal name resolves to the app's control for it, and the catalog's own names stay the catalog's", () => {
	const compact = resolveAlias("/compact keep the API notes", facts());
	assert.deepEqual(compact?.alias.target, {
		kind: "command",
		command: "context",
		subcommand: "compact",
		passRest: true,
	});
	assert.equal(compact?.rest, "keep the API notes");
	assert.deepEqual(resolveAlias("/model", facts())?.alias.target, { kind: "control", control: "model" });
	assert.deepEqual(resolveAlias("/rename  Release notes ", facts()), {
		alias: {
			name: "rename",
			summary: "Rename this task",
			target: { kind: "control", control: "rename" },
			needsText: true,
		},
		rest: "Release notes",
	});
	assert.equal(resolveAlias("/nope", facts()), null);
	assert.equal(resolveAlias("/status", facts()), null, "a name the catalog has is the catalog's");
	assert.equal(resolveAlias("/review-pr 42", facts()), null, "a prompt template is the agent's");
	assert.equal(resolveAlias("plain /model", facts()), null);
	const dev = resolveAlias("/extensions dev", facts());
	assert.equal(dev?.alias.name, "extensions dev");
	assert.equal(dev?.alias.target.kind, "notice");
});

test("a name this task cannot serve says so instead of reaching the agent", () => {
	const notice = (text: string, over: Partial<SlashFacts>) => {
		const target = resolveAlias(text, facts(over))?.alias.target;
		return target?.kind === "notice" ? target.message : null;
	};
	const noContext = { version: 1 as const, commands: [command("doctor")], prompts: [] };
	assert.equal(notice("/compact", { catalog: noContext }), "/compact is not available in this task.");
	assert.equal(notice("/init", { catalog: undefined }), "/init is not available in this task.");
	assert.equal(notice("/tree", { capabilities: { commands: true } as never }), "/tree is not available in this task.");
	assert.equal(notice("/usage", { paneAvailable: false }), "/usage is not available in this task.");
	assert.equal(
		notice("/quit", {}),
		"Close this task from the task menu, or close the window. CLIO Coder keeps running.",
	);
	assert.equal(notice("/music", {}), "/music is a terminal command and has no equivalent in this app.");
});

test("the slash list offers what this task can serve under Also works, after everything it lists itself", () => {
	const listed = slashEntries(facts());
	const also = aliasEntries(facts(), listed);
	const names = also.map((entry) => entry.name);
	assert.ok(also.every((entry) => entry.group === "Also works"));
	for (const name of ["compact", "init", "model", "new", "help", "rename", "cost"])
		assert.ok(names.includes(name), name);
	assert.ok(!names.includes("status"), "the catalog's status is listed as the catalog's");
	assert.ok(!names.includes("quit") && !names.includes("music"), "a notice is not something to pick");
	assert.ok(!names.some((name) => listed.some((entry) => entry.name === name)), "no name is listed twice");
	const bare = aliasEntries(facts({ capabilities: { commands: true } as never, paneAvailable: false }), []).map(
		(entry) => entry.name,
	);
	assert.ok(!bare.includes("tree") && !bare.includes("usage"), "a capability the task lacks hides its names");
	assert.deepEqual(aliasEntries(facts({ capabilities: undefined }), []), []);
});

test("every terminal command a browser can serve lands on a control, and the rest say why", () => {
	const full = facts({
		capabilities: {
			commands: true,
			telemetry: true,
			branches: { fork: true },
			aside: { ask: true, draft: true },
			extensions: true,
			fleet: true,
			board: true,
			context: true,
		} as never,
		catalog: {
			...catalog,
			commands: [
				...catalog.commands,
				command("fleet", { requiresSubcommand: true, args: { subcommands: { share: {} } } }),
				command("memory", { requiresSubcommand: true, args: { subcommands: { seed: {} } } }),
			],
		},
	});
	const target = (text: string) => resolveAlias(text, full)?.alias.target;
	// The terminal's own names (src/session-control/slash-commands.ts) that are not catalog commands here.
	assert.deepEqual(target("/btw what does the retry loop do"), { kind: "action", action: "btw" });
	assert.equal(resolveAlias("/btw what does the retry loop do", full)?.rest, "what does the retry loop do");
	assert.deepEqual(target("/draft split the parser"), { kind: "action", action: "draft" });
	assert.deepEqual(target("/reload"), { kind: "action", action: "extensions" });
	assert.deepEqual(target("/view"), { kind: "pane", view: "artifacts" });
	assert.deepEqual(target("/files"), { kind: "control", control: "mention" });
	assert.deepEqual(target("/trust"), { kind: "pane", view: "session" });
	// A bare hub the catalog refuses opens what the terminal opens; its verbs stay the catalog's.
	const entries = slashEntries(full);
	const pane = (text: string) => {
		const entry = exactEntry(entries, text);
		return entry?.kind === "pane" ? entry.view : null;
	};
	assert.equal(pane("/fleet"), "agents");
	assert.deepEqual(pane("/memory"), { view: "board", section: "memory" });
	assert.equal(exactEntry(entries, "/memory seed note"), null);
	// Without the capability, the name says so rather than reaching the agent as a prompt.
	const bare = facts({ capabilities: { commands: true } as never, paneAvailable: false });
	for (const name of ["btw", "draft", "reload", "view", "trust"])
		assert.equal(resolveAlias(`/${name}`, bare)?.alias.target.kind, "notice", name);
	// Every terminal-only name is a notice, never a prompt.
	for (const name of ["restart", "upgrade", "panes", "music"])
		assert.equal(resolveAlias(`/${name}`, full)?.alias.target.kind, "notice", name);
	assert.ok(!SLASH_ALIASES.some((spec) => spec.names.includes("files") && spec.target.kind === "notice"));
});

test("commands the app serves elsewhere are not listed, and still run when typed", () => {
	const withHostWriters = {
		...catalog,
		commands: [
			...catalog.commands,
			command("export"),
			command("archive"),
			command("eggs"),
			command("report", { requiresSubcommand: true, args: { subcommands: { bug: {}, status: {} } } }),
		],
	};
	const listed = slashEntries(facts({ catalog: withHostWriters })).map((entry) => entry.name);
	for (const name of ["export", "eggs", "report bug", "report status"])
		assert.ok(!listed.includes(name), `${name} is listed`);
	assert.ok(listed.includes("doctor"));
	assert.ok(listed.includes("archive"), "no other control exports or imports a session");
	assert.ok(listed.includes("report"), "the Report a problem dialog keeps the name");
	assert.equal(parseSlashLine("/export", withHostWriters)?.kind, "command");
	assert.equal(parseSlashLine("/report status", withHostWriters)?.kind, "command");
});

test("the Task actions menu opens forms only for commands the harness admits over ACP", async () => {
	const { readFile } = await import("node:fs/promises");
	const { MENU_FORMS, UNLISTED_COMMANDS } = await import("../client/chat/slash-actions.js");
	const source = await readFile(new URL("../../../src/session-control/slash-commands.ts", import.meta.url), "utf8");
	for (const form of MENU_FORMS) {
		const at = source.indexOf(`\t\tname: "${form.name}",`);
		assert.ok(at >= 0, `${form.name} is not a harness command`);
		const admission = /\n\t\tacp: ([^\n]+)/u.exec(source.slice(at))?.[1];
		assert.ok(admission !== undefined && !admission.startsWith("false"), `${form.name} is refused over ACP`);
		assert.ok(!UNLISTED_COMMANDS.has(form.name));
	}
});
