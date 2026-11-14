import assert from "node:assert/strict";
import { test } from "node:test";
import { aliasEntries, resolveAlias, type SlashFacts, slashEntries } from "../client/chat/slash-model.js";

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
