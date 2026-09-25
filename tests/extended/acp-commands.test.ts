import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingSkillRequest } from "../../src/core/skill-activation.js";
import {
	ACP_COMMAND_RULES,
	ACP_COMMANDS_CAPABILITY,
	type AcpCommandArgsSpec,
	type AcpCommandDescriptor,
	type AcpCommandHost,
	acpCommandCatalog,
	acpCommandControl,
	invokeAcpCommand,
} from "../../src/engine/acp/commands.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";

/**
 * The three required host members belong to commands this file never invokes
 * (`/run` and friends dispatch; `providers` is reached by no allowlisted
 * command at all). Reaching one of them through a stub is a test failure, not a
 * crash to interpret, so they throw.
 */
function host(overrides: Partial<AcpCommandHost> = {}): AcpCommandHost {
	const refuse = (member: string) =>
		new Proxy(
			{},
			{
				get() {
					throw new Error(`test host: ${member} was reached`);
				},
			},
		);
	return {
		dispatch: refuse("dispatch") as AcpCommandHost["dispatch"],
		bus: refuse("bus") as AcpCommandHost["bus"],
		providers: refuse("providers") as AcpCommandHost["providers"],
		...overrides,
	};
}

function descriptor(name: string): AcpCommandDescriptor {
	const found = acpCommandCatalog().commands.find((command) => command.name === name);
	assert.ok(found, `catalog is missing ${name}`);
	return found;
}

function refusalReason(call: () => unknown): string {
	try {
		call();
	} catch (error) {
		assert.ok(error instanceof AcpRequestError, `expected AcpRequestError, got ${String(error)}`);
		assert.equal(error.rpcCode, -32602);
		return error.detail.reason ?? "";
	}
	throw new Error("expected a refusal");
}

test("the catalog projects all thirteen allowlisted commands", async () => {
	const catalog = acpCommandCatalog();
	assert.equal(catalog.version, 1);
	assert.equal(ACP_COMMAND_RULES.length, 13);
	assert.equal(catalog.commands.length, 13);
	assert.equal(ACP_COMMANDS_CAPABILITY.count, 13);
	assert.deepEqual(
		catalog.commands.map((command) => command.name),
		[
			"mcp",
			"doctor",
			"share",
			"archive",
			"run",
			"delegate",
			"oracle",
			"council",
			"skill",
			"context",
			"tasks",
			"memory",
			"export",
		],
	);
	for (const command of catalog.commands) {
		assert.ok(command.summary.length > 0, `${command.name} has no summary`);
		assert.ok(command.usage.startsWith(`/${command.name}`), `${command.name} usage is ${command.usage}`);
	}
});

test("the projection carries the real flag and positional grammar", async () => {
	const run = descriptor("run");
	const flags = new Map((run.args.flags ?? []).map((flag) => [flag.name, flag]));
	assert.deepEqual(flags.get("--agent-profile"), { name: "--agent-profile", takesValue: true, valueName: "profile" });
	assert.equal(flags.get("--require")?.repeatable, true);
	assert.equal(flags.get("--share")?.takesValue, undefined);
	assert.ok((flags.get("--thinking")?.values ?? []).includes("high"), "--thinking must carry its closed value set");
	assert.ok((flags.get("--tool-profile")?.values ?? []).length > 0, "--tool-profile must carry its closed value set");
	assert.deepEqual(run.args.positionals, [
		{ name: "agent", required: true },
		{ name: "task", required: true, rest: true },
	]);

	const council = descriptor("council");
	const synthesis = (council.args.flags ?? []).find((flag) => flag.name === "--synthesis");
	assert.ok((synthesis?.values ?? []).length > 0, "--synthesis must carry its closed value set");

	const archive: AcpCommandArgsSpec = descriptor("archive").args;
	assert.deepEqual(Object.keys(archive.subcommands ?? {}).sort(), ["export", "import"]);
	assert.deepEqual(archive.subcommands?.export?.positionals, [{ name: "path", required: true }]);
	assert.deepEqual(
		(archive.subcommands?.import?.flags ?? []).map((flag) => flag.name),
		["--dry-run", "--force"],
	);

	const tasks = descriptor("tasks");
	const add = tasks.args.subcommands?.add;
	assert.equal(add?.flags?.find((flag) => flag.name === "--expect")?.repeatable, true);
	assert.deepEqual(add?.positionals, [{ name: "text", required: true, rest: true }]);
});

test("a hub command is projected as subcommands only, narrowed to the wire-shaped verbs", async () => {
	const context = descriptor("context");
	assert.equal(context.requiresSubcommand, true);
	assert.deepEqual(Object.keys(context.args.subcommands ?? {}).sort(), [
		"compact",
		"init",
		"recall",
		"refresh",
		"reset",
	]);
	assert.deepEqual(Object.keys(descriptor("memory").args.subcommands ?? {}), ["seed"]);
	assert.deepEqual(Object.keys(descriptor("tasks").args.subcommands ?? {}).sort(), ["add", "done", "drop", "hand"]);
	// The bare form opens an overlay, so it is not reachable even though the name is.
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "context", argv: [] }, host())),
		"subcommand_not_exposed",
	);
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "tasks", argv: [] }, host())),
		"subcommand_not_exposed",
	);
});

test("streams and injectsUserTurn mark exactly the commands that earn them", async () => {
	const catalog = acpCommandCatalog();
	assert.deepEqual(
		catalog.commands.filter((command) => command.streams === "dispatch").map((command) => command.name),
		["run", "delegate", "oracle", "council"],
	);
	assert.deepEqual(
		catalog.commands.filter((command) => command.injectsUserTurn === true).map((command) => command.name),
		["share", "oracle", "skill", "tasks"],
	);
	assert.equal(descriptor("export").streams, undefined);
	assert.equal(descriptor("export").injectsUserTurn, undefined);
});

test("a command outside the allowlist is refused before anything is parsed", async () => {
	for (const name of ["quit", "help", "settings", "library", "fleet", "btw", "not-a-command", ""]) {
		assert.equal(
			refusalReason(() => invokeAcpCommand({ command: name, argv: [] }, host())),
			"command_not_exposed",
		);
	}
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: 42, argv: [] }, host())),
		"invalid_params",
	);
});

test("a TUI-bound command is refused by name rather than crashing on a missing keyboardActions", async () => {
	// `background`, `editor` and `interrupt` all dereference ctx.keyboardActions,
	// which a headless context does not have.
	for (const name of ["background", "editor", "interrupt"]) {
		assert.equal(
			refusalReason(() => invokeAcpCommand({ command: name, argv: ["x"] }, host())),
			"command_not_exposed",
		);
	}
});

test("argv is refused rather than escaped where the tokenizer would disagree with the client", async () => {
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "mcp", argv: ['"list"'] }, host())),
		"argv_invalid",
	);
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "mcp", argv: ["li\u0000st"] }, host())),
		"argv_invalid",
	);
	// Only the trailing element may hold whitespace: it is the one that can be rest text.
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "mcp", argv: ["trust me", "x"] }, host())),
		"argv_invalid",
	);
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "mcp", argv: new Array(40).fill("list") }, host())),
		"argv_too_long",
	);
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "mcp", argv: "list" }, host())),
		"argv_invalid",
	);
});

test("a headless invoke of a simple command returns its lines", async () => {
	const result = await invokeAcpCommand({ command: "mcp", argv: ["list"] }, host());
	assert.equal(result.level, "info");
	assert.deepEqual(result.lines, ["mcp: none"]);

	const bare = await invokeAcpCommand({ command: "mcp", argv: [] }, host());
	assert.deepEqual(bare.lines, ["mcp: none"]);
});

test("export reaches the host, and says so when the host has no transcript", async () => {
	const seen: Array<string | undefined> = [];
	const wired = await invokeAcpCommand(
		{ command: "export", argv: ["out.md"] },
		host({
			exportTranscript: (path) => {
				seen.push(path);
			},
		}),
	);
	assert.deepEqual(seen, ["out.md"]);
	assert.deepEqual(wired.lines, []);

	const unwired = await invokeAcpCommand({ command: "export", argv: [] }, host());
	assert.equal(unwired.level, "error");
	assert.match(unwired.lines.join("\n"), /export is not wired/u);
});

test("a usage error comes back as an error level with the registry's own usage line", async () => {
	const result = await invokeAcpCommand({ command: "doctor", argv: ["shallow"] }, host());
	assert.equal(result.level, "error");
	assert.match(result.lines.join("\n"), /doctor accepts only deep/u);
	assert.match(result.lines.join("\n"), /usage: \/doctor/u);
});

test("a dispatch command reports that it started, because its result is an event stream", async () => {
	let requested = 0;
	const pending = host({
		// The run never settles inside this call; that is the point of the flag.
		dispatch: {
			ownsProgressBus: () => true,
			dispatch: () => {
				requested += 1;
				return new Promise(() => {});
			},
		} as unknown as AcpCommandHost["dispatch"],
	});
	const result = await invokeAcpCommand({ command: "delegate", argv: ["codex", "summarize the diff"] }, pending);
	assert.equal(requested, 1);
	assert.equal(result.level, "info");
	assert.deepEqual(result.lines, ["delegate started; progress arrives as _clio-coder/event dispatch kinds"]);
});

test("a command that is wired reports its own outcome instead of a started line", async () => {
	const shared = await invokeAcpCommand(
		{ command: "share", argv: [] },
		host({ listWorkerRuns: () => [], submitOperatorNote: () => assert.fail("nothing to share") }),
	);
	assert.equal(shared.level, "error");
	assert.match(shared.lines.join("\n"), /no finished \/run or \/delegate result to share yet/u);

	const seeded = await invokeAcpCommand(
		{ command: "memory", argv: ["seed"] },
		host({ seedTaskMemory: () => ({ status: "disabled" }) }),
	);
	assert.equal(seeded.level, "warn");
	assert.match(seeded.lines.join("\n"), /task memory is disabled/u);
});

test("/skill expands before submitting, and refuses when the expander is absent", async () => {
	assert.equal(
		refusalReason(() => invokeAcpCommand({ command: "skill", argv: ["review"] }, host())),
		"not_wired",
	);

	const submitted: Array<{ text: string; skills: ReadonlyArray<PendingSkillRequest> }> = [];
	const result = await invokeAcpCommand(
		{ command: "skill", argv: ["review", "check the diff"] },
		host({
			parsePendingSkillRequests: (text) => {
				assert.equal(text, "/skill review check the diff");
				return {
					text: "check the diff",
					pendingSkillRequests: [
						{ name: "review", args: "check the diff", source: "slash-command", installed: true },
					] as PendingSkillRequest[],
				};
			},
			submitTurn: (text, options) => submitted.push({ text, skills: options.pendingSkillRequests ?? [] }),
		}),
	);
	assert.equal(result.level, "info");
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0]?.text, "check the diff");
	assert.equal(submitted[0]?.skills[0]?.name, "review");

	// `/skill off` clears the armed surface and submits nothing, so it needs no expander.
	const cleared = await invokeAcpCommand(
		{ command: "skill", argv: ["off"] },
		host({ clearSkillSurface: () => ["review"] }),
	);
	assert.match(cleared.lines.join("\n"), /Skill tool surface cleared: review/u);
});

test("the announced capability names the two methods a client calls", async () => {
	assert.deepEqual(
		{ ...ACP_COMMANDS_CAPABILITY },
		{
			version: 1,
			list: "_clio-coder/commands/list",
			invoke: "_clio-coder/commands/invoke",
			count: 13,
		},
	);
});

test("host catalog advertises only wired commands and context operations", async () => {
	const control = acpCommandControl(host({ runContextClear: () => {} }));
	const catalog = control.catalog();
	assert.deepEqual(
		catalog.commands.map((command) => command.name),
		["mcp", "run", "delegate", "context"],
	);
	assert.equal(control.capability.count, catalog.commands.length);
	assert.deepEqual(Object.keys(catalog.commands.find((command) => command.name === "context")?.args.subcommands ?? {}), [
		"reset",
	]);
	assert.equal(
		refusalReason(() => control.invoke({ command: "export", argv: [] })),
		"command_unavailable",
	);
	assert.equal(
		refusalReason(() => control.invoke({ command: "context", argv: ["compact"] })),
		"subcommand_not_exposed",
	);
});

test("doctor returns completed asynchronous findings and contains failures", async () => {
	const control = acpCommandControl(
		host({
			runDoctor: async ({ deep }) => {
				await Promise.resolve();
				assert.equal(deep, true);
				return { level: "warn", text: "target unavailable\ncheck configuration" };
			},
		}),
	);
	assert.deepEqual(await control.invoke({ command: "doctor", argv: ["deep"] }), {
		level: "warn",
		lines: ["target unavailable", "check configuration"],
	});
	const failed = acpCommandControl(
		host({
			runDoctor: async () => {
				throw new Error("probe failed");
			},
		}),
	);
	assert.deepEqual(await failed.invoke({ command: "doctor", argv: [] }), {
		level: "error",
		lines: ["doctor failed: probe failed"],
	});
});
