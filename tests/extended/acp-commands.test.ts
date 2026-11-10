import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PendingSkillRequest } from "../../src/core/skill-activation.js";
import {
	createReportTextHost,
	readReportDraft,
	saveReportDraft,
	updateOutbox,
} from "../../src/domains/report/index.js";
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

test("the catalog projects all seventeen allowlisted commands", async () => {
	const catalog = acpCommandCatalog();
	assert.equal(catalog.version, 1);
	assert.equal(ACP_COMMAND_RULES.length, 17);
	assert.equal(catalog.commands.length, 17);
	assert.equal(ACP_COMMANDS_CAPABILITY.count, 17);
	assert.deepEqual(
		catalog.commands.map((command) => command.name),
		[
			"eggs",
			"skill",
			"mcp",
			"doctor",
			"share",
			"archive",
			"run",
			"delegate",
			"oracle",
			"council",
			"loop",
			"context",
			"fleet",
			"tasks",
			"memory",
			"report",
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
		"recover",
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
		["skill", "share", "oracle", "loop", "fleet", "tasks"],
	);
	assert.equal(descriptor("export").streams, undefined);
	assert.equal(descriptor("export").injectsUserTurn, undefined);
});

test("a command outside the allowlist is refused before anything is parsed", async () => {
	for (const name of ["quit", "help", "settings", "library", "btw", "not-a-command", ""]) {
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
	const runs = (admission: () => Promise<unknown>) =>
		host({
			dispatch: {
				ownsProgressBus: () => true,
				dispatch: () => {
					requested += 1;
					return admission();
				},
			} as unknown as AcpCommandHost["dispatch"],
			// The run watches its own queue events to say when it waits for a slot (ac0e5b530).
			bus: { subscribe: () => () => {} } as unknown as AcpCommandHost["bus"],
		});
	// Admitted, and the run never settles inside this call; that is the point of the flag.
	const pending = runs(async () => ({
		runId: "run-1",
		events: (async function* () {
			await new Promise(() => {});
		})(),
		finalPromise: new Promise(() => {}),
	}));
	const result = await invokeAcpCommand({ command: "delegate", argv: ["codex", "summarize the diff"] }, pending);
	assert.equal(requested, 1);
	assert.equal(result.level, "info");
	assert.deepEqual(result.lines, ["delegate started; progress arrives as _clio-coder/event dispatch kinds"]);
	// A run refused at admission never started, so the reply is the refusal and never "started".
	const refused = await invokeAcpCommand(
		{ command: "run", argv: ["ghost", "summarize the diff"] },
		runs(() => Promise.reject(new Error("dispatch: unknown agent ghost"))),
	);
	assert.equal(refused.level, "error");
	assert.deepEqual(refused.lines, ["run refused: unknown agent ghost"]);
});

test("a command that is wired reports its own outcome instead of a started line", async () => {
	const shared = await invokeAcpCommand(
		{ command: "share", argv: [] },
		host({ listWorkerRuns: () => [], submitOperatorNote: () => assert.fail("nothing to share") }),
	);
	assert.equal(shared.level, "error");
	assert.match(shared.lines.join("\n"), /no finished \/run or \/delegate result for \/fleet share yet/u);

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
			count: 17,
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

test("/report previews as text with no transport call, and a read-only ceiling refuses send but not status", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "acp-report-"));
	const gh = "/fake/bin/gh";
	const commands: string[] = [];
	const reportHost = createReportTextHost({
		stateDir,
		cwd: () => stateDir,
		env: {},
		findGh: () => gh,
		run: async (command, args) => {
			commands.push([command, ...args].join(" "));
			return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
		},
	});
	const control = acpCommandControl(host({ reportHost }));
	assert.ok(control.catalog().commands.some((command) => command.name === "report"));
	assert.ok(
		!acpCommandControl(host())
			.catalog()
			.commands.some((command) => command.name === "report"),
	);

	const preview = await control.invoke({ command: "report", argv: ["bug", "the diff view is empty"] });
	const draftId = preview._meta?.["clio-coder/report"].draftId ?? "";
	assert.match(draftId, /^rpt_/);
	assert.ok(preview.lines.includes("Title: fix: the diff view is empty"));
	assert.ok(preview.lines.includes(`id: ${draftId}`), "the full body, report block included, is in the preview");
	assert.ok(preview.lines.some((line) => line.includes(`To send: \`/report send ${draftId}\``)));
	assert.deepEqual(
		commands.filter((command) => command.startsWith(gh)),
		[],
	);

	const readOnly = { readOnly: true } as Parameters<NonNullable<typeof control.ceilingRefusal>>[2];
	assert.match(control.ceilingRefusal?.("report", ["send", draftId], readOnly) ?? "", /ceiling is read-only/);
	assert.equal(control.ceilingRefusal?.("report", ["status"], readOnly), null);
	const status = await control.invoke({ command: "report", argv: ["status"] });
	assert.ok(status.lines.some((line) => line.startsWith(`${draftId} | draft | bug`)));

	const draft = readReportDraft(stateDir, draftId);
	assert.ok(draft);
	assert.ok(draft.identity?.paths.includes(stateDir), "the draft records the identity its preview masked with");
	saveReportDraft(stateDir, { ...draft, origin: "agent" });
	const refused = await control.invoke({ command: "report", argv: ["send", draftId] });
	assert.equal(refused.level, "warn");
	assert.match(refused.lines.join("\n"), /agent's draft is reviewed in a terminal/);

	updateOutbox(stateDir, draftId, {
		kind: "bug",
		title: "fix: the diff view is empty",
		state: "sent",
		url: "https://github.com/iowarp/clio-coder/issues/7",
		bundle: { sha256: "0".repeat(64), scopes: ["debug"], content: "none" },
	});
	const forgot = await control.invoke({ command: "report", argv: ["forget", draftId] });
	assert.match(forgot.lines.join("\n"), /deleted the diagnostic bundle of .*Clio cannot withdraw it/);
	assert.deepEqual(
		commands.filter((command) => command.startsWith(gh)),
		[],
	);
});
