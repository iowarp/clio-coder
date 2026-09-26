import assert from "node:assert/strict";
import { test } from "node:test";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";

// The ACP context verbs were allowlisted but no host supplied them, so a wire client never saw them.
// A host that supplies one now gets it in the catalog, and the reply waits for the operation's report.

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

const contextVerbs = (control: ReturnType<typeof acpCommandControl>) =>
	Object.keys(control.catalog().commands.find((command) => command.name === "context")?.args.subcommands ?? {}).sort();

test("the catalog offers exactly the context verbs the host wired", () => {
	assert.deepEqual(contextVerbs(acpCommandControl(host())), []);
	const wired = acpCommandControl(host({ runCompact: async () => undefined, runContextRecall: async () => undefined }));
	assert.deepEqual(contextVerbs(wired), ["compact", "recall"]);
	assert.throws(() => wired.invoke({ command: "context", argv: ["reset"] }), /not available/);
});

test("a context reply waits for the host operation and carries its report", async () => {
	const order: string[] = [];
	let received: string | undefined;
	const control = acpCommandControl(
		host({
			runCompact: async (instructions) => {
				received = instructions;
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push("compacted");
				return { level: "success", text: "Context compacted." };
			},
		}),
	);
	const result = await control.invoke({ command: "context", argv: ["compact", "keep the decisions"] });
	order.push("replied");
	assert.deepEqual(order, ["compacted", "replied"]);
	assert.equal(received, "keep the decisions");
	assert.deepEqual(result, { level: "success", lines: ["Context compacted."] });
});

test("a recalled body arrives line by line, and a failure is an error-level result", async () => {
	const recalled = acpCommandControl(
		host({
			runContextRecall: async (ref) => ({ level: "success", text: `[/context recall] ${ref}\nline one\nline two` }),
		}),
	);
	assert.deepEqual(await recalled.invoke({ command: "context", argv: ["recall", "turn-7"] }), {
		level: "success",
		lines: ["[/context recall] turn-7", "line one", "line two"],
	});
	const failing = acpCommandControl(
		host({
			runContextRefresh: async () => {
				throw new Error("codewiki locked");
			},
		}),
	);
	assert.deepEqual(await failing.invoke({ command: "context", argv: ["refresh"] }), {
		level: "error",
		lines: ["context refresh failed: codewiki locked"],
	});
});

test("init flags reach the host and a report of an unknown shape adds nothing", async () => {
	let options: unknown;
	const control = acpCommandControl(
		host({
			runInit: async (value) => {
				options = value;
				return 42;
			},
		}),
	);
	assert.deepEqual(await control.invoke({ command: "context", argv: ["init", "--heuristic"] }), {
		level: "info",
		lines: [],
	});
	assert.deepEqual(options, { heuristic: true });
});

test("a reset runs only with the operator's --yes, and --all widens it only when confirmed", async () => {
	const received: unknown[] = [];
	const control = acpCommandControl(
		host({
			runContextClear: async (options) => {
				received.push(options);
				return { level: "success", text: "Project context reset." };
			},
		}),
	);
	const reset = control.catalog().commands.find((command) => command.name === "context")?.args.subcommands?.reset;
	assert.deepEqual(
		reset?.flags?.map((flag) => flag.name),
		["--yes", "--all"],
	);
	const bare = await control.invoke({ command: "context", argv: ["reset"] });
	assert.equal(bare.level, "warn");
	assert.match(bare.lines.join("\n"), /Confirm with \/context reset --yes.*Nothing was changed/);
	const unconfirmedAll = await control.invoke({ command: "context", argv: ["reset", "--all"] });
	assert.equal(unconfirmedAll.level, "warn");
	assert.deepEqual(received, [], "no unconfirmed reset reaches the host");
	assert.deepEqual(await control.invoke({ command: "context", argv: ["reset", "--yes"] }), {
		level: "success",
		lines: ["Project context reset."],
	});
	await control.invoke({ command: "context", argv: ["reset", "--all", "--yes"] });
	assert.deepEqual(received, [{ confirmed: true }, { all: true, confirmed: true, confirmedAll: true }]);
});

test("handoff recovery is a prompt-turn subcommand whose reply waits for the continued turn", async () => {
	const order: string[] = [];
	const control = acpCommandControl(
		host({
			runHandoffRecovery: async (handoffId, action) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push(`${action}:${handoffId}`);
				return { level: "success", text: "Handoff delivered." };
			},
		}),
	);
	const context = control.catalog().commands.find((command) => command.name === "context");
	assert.deepEqual(context?.promptTurnSubcommands, ["recover"]);
	assert.deepEqual(context?.args.subcommands?.recover?.positionals?.[1]?.values, ["reduce", "deliver"]);
	assert.equal(control.promptTurn?.("context", ["recover", "h1", "deliver"]), true);
	assert.equal(control.promptTurn?.("context", ["compact"]), false);
	const result = await control.invoke({ command: "context", argv: ["recover", "h1", "deliver"] });
	order.push("replied");
	assert.deepEqual(order, ["deliver:h1", "replied"]);
	assert.deepEqual(result, { level: "success", lines: ["Handoff delivered."] });
	const refused = await control.invoke({ command: "context", argv: ["recover", "h1", "discard"] });
	assert.equal(refused.level, "error");
});
