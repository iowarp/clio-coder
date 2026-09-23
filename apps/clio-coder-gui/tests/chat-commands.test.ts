import assert from "node:assert/strict";
import { test } from "node:test";
import { commandOptions, planCommand } from "../client/chat/command-model.js";
import type { CommandDescriptor } from "../contracts/steering.js";

const command: CommandDescriptor = {
	name: "run",
	summary: "Run a fleet agent",
	usage: "/run [flags] <agent> <task>",
	group: "Work",
	args: {
		flags: [
			{ name: "--target", takesValue: true },
			{ name: "--share" },
			{ name: "--require", takesValue: true, repeatable: true },
		],
		positionals: [
			{ name: "agent", required: true },
			{ name: "task", required: true, rest: true },
		],
	},
};

test("catalog is the only source of offered commands", () => {
	assert.deepEqual(commandOptions(undefined), []);
	assert.deepEqual(commandOptions({ version: 1, commands: [command] }), [command]);
});

test("plans bounded argv from flags, repeated values and final task text", () => {
	assert.deepEqual(
		planCommand(command, {
			"flag:--target": "local",
			"flag:--share": true,
			"flag:--require": "code\njson",
			"pos:0": "reviewer",
			"pos:1": "Review this project",
		}),
		{
			plan: {
				request: {
					command: "run",
					argv: [
						"--target",
						"local",
						"--share",
						"--require",
						"code",
						"--require",
						"json",
						"reviewer",
						"Review this project",
					],
				},
				description: "/run --target local --share --require code --require json reviewer Review this project",
			},
		},
	);
});

test("only a catalogued subcommand can run; values are checked against the selected grammar", () => {
	const hub: CommandDescriptor = {
		name: "context",
		summary: "Manage context",
		usage: "/context",
		group: "Session",
		requiresSubcommand: true,
		args: {
			subcommands: {
				compact: { positionals: [{ name: "instructions", required: false, rest: true }] },
				reset: { flags: [{ name: "--yes" }] },
			},
		},
	};
	assert.match(planCommand(hub, {}).error ?? "", /Choose/);
	assert.match(planCommand(hub, { subcommand: "import" }).error ?? "", /Choose/);
	assert.deepEqual(planCommand(hub, { subcommand: "compact", "pos:0": "Summarize the code" }).plan?.request, {
		command: "context",
		argv: ["compact", "Summarize the code"],
	});
	assert.deepEqual(planCommand(hub, { subcommand: "reset", "flag:--yes": true }).plan?.request, {
		command: "context",
		argv: ["reset", "--yes"],
	});
});

test("rejects malformed tokens before a command can reach the ACP bridge", () => {
	for (const value of ["with spaces", "quoted'", "--unexpected", "line\nbreak", "🤖".repeat(1100)]) {
		assert.ok(planCommand(command, { "pos:0": value, "pos:1": "Do work" }).error, value.slice(0, 40));
	}
	assert.match(planCommand(command, { "pos:0": "worker" }).error ?? "", /required/);
	assert.ok(planCommand(command, { "flag:--target": "two words", "pos:0": "worker", "pos:1": "Do work" }).error);
	assert.ok(planCommand(command, { "pos:0": "worker", "pos:1": "Do\nwork" }).error);
	assert.ok(planCommand(command, { "pos:0": "worker", "pos:1": "--force" }).error);
});

test("enum values and optional positional ordering cannot be bypassed", () => {
	const enumCommand: CommandDescriptor = {
		name: "doctor",
		summary: "Check",
		usage: "/doctor",
		group: "Inspect",
		args: {
			positionals: [
				{ name: "depth", required: false, values: ["deep"] },
				{ name: "scope", required: false },
			],
		},
	};
	assert.ok(planCommand(enumCommand, { "pos:0": "unsafe" }).error);
	assert.ok(planCommand(enumCommand, { "pos:1": "later" }).error);
	assert.deepEqual(planCommand(enumCommand, { "pos:0": "deep" }).plan?.request, { command: "doctor", argv: ["deep"] });
});
