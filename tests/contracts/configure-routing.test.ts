import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { assignTarget } from "../../src/cli/configure-routing.js";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const role of ["chat", "fleet", "memory"] as const) {
	test(`${role} selects the chosen connection's live models and preserves default inheritance`, async (t) => {
		const home = await isolateClioEnv(`clio-configure-${role}-`);
		t.after(() => home.restore());
		registerBuiltinRuntimes(getRuntimeRegistry());
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(`${request.method} ${request.url}`);
			response.setHeader("content-type", "application/json");
			if (request.url === "/chosen/v1/models")
				response.end(JSON.stringify({ data: [{ id: "chosen-default" }, { id: "chosen-other" }] }));
			else {
				response.statusCode = 404;
				response.end("{}");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const file = join(home.dir, "config/settings.yaml");
		mkdirSync(join(home.dir, "config"), { recursive: true });
		writeFileSync(
			file,
			stringify({
				version: 2,
				targets: [
					{ id: "previous", runtime: "openai-compat", url: `${url}/previous`, defaultModel: "previous-model" },
					{ id: "chosen", runtime: "openai-compat", url: `${url}/chosen`, defaultModel: "chosen-default" },
				],
				chat: { target: "previous", model: "previous-model" },
			}),
		);
		let inherit = false;
		const prompts: string[] = [];
		const io = {
			rl: {
				async choose(label: string, choices: readonly string[]) {
					prompts.push(label);
					if (label.endsWith("connection")) {
						const choice = choices.find((value) => value.startsWith("chosen ·"));
						assert.ok(choice);
						return choice;
					}
					assert.equal(label, `${role === "memory" ? "Proactive memory" : role === "chat" ? "Chat" : "Fleet"} model`);
					assert.deepEqual(choices, ["Use connection default · chosen-default", "chosen-default", "chosen-other"]);
					return inherit ? "Use connection default · chosen-default" : "chosen-other";
				},
			},
			out: new PassThrough(),
			ok() {},
			warn(message: string) {
				assert.fail(message);
			},
		};
		const route = () => {
			const saved = parse(readFileSync(file, "utf8"));
			return role === "chat" ? saved.chat : role === "fleet" ? saved.fleet.default : saved.context.memory;
		};
		await assignTarget(io, role);
		assert.equal(route().target, "chosen");
		assert.equal(route().model, "chosen-other");
		inherit = true;
		await assignTarget(io, role);
		assert.equal(route().model, null, "inheritance must remain null in the saved document");
		updateSettings((settings) => {
			const target = settings.targets.find((target) => target.id === "chosen");
			assert.ok(target);
			target.defaultModel = "chosen-other";
		});
		const settings = readSettings();
		const effective =
			role === "chat" ? settings.chat : role === "fleet" ? settings.fleet.default : settings.context.memory;
		assert.equal(effective.model, "chosen-other", "inherited route follows later connection-default changes");
		assert.ok(requests.includes("GET /chosen/v1/models"));
		assert.ok(
			requests.every((request) => request.startsWith("GET /chosen/")),
			requests.join("\n"),
		);
		assert.equal(prompts.length, 4, "connection and listed model are the only prompts");
	});
}

test("memory offers the chat route even when no eligible connections exist", async (t) => {
	const home = await isolateClioEnv("clio-configure-rules-");
	t.after(() => home.restore());
	registerBuiltinRuntimes(getRuntimeRegistry());
	await assignTarget(
		{
			rl: {
				async choose(label, choices) {
					assert.equal(label, "Proactive memory connection");
					assert.deepEqual(choices, ["Chat route · no memory model set"]);
					const first = choices[0];
					assert.ok(first);
					return first;
				},
			},
			out: new PassThrough(),
			ok() {},
			warn(message) {
				assert.fail(message);
			},
		},
		"memory",
	);
	assert.equal(readSettings().context.memory.target, null);
	assert.equal(readSettings().context.memory.model, null);
});

test("an unavailable inventory without a configured default cannot invent a route model", async (t) => {
	const home = await isolateClioEnv("clio-configure-no-models-");
	t.after(() => home.restore());
	registerBuiltinRuntimes(getRuntimeRegistry());
	const file = join(home.dir, "config/settings.yaml");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		file,
		stringify({ version: 2, targets: [{ id: "empty", runtime: "openai-compat", url: "http://127.0.0.1:1" }] }),
	);
	const before = readFileSync(file, "utf8");
	let prompts = 0;
	let warning = "";
	await assignTarget(
		{
			rl: {
				async choose(label, choices) {
					assert.equal(label, "Chat connection");
					prompts++;
					const first = choices[0];
					assert.ok(first);
					return first;
				},
			},
			out: new PassThrough(),
			ok() {
				assert.fail("a missing model must not save");
			},
			warn(message) {
				warning = message;
			},
		},
		"chat",
	);
	assert.equal(prompts, 1);
	assert.match(warning, /No selectable models/u);
	assert.equal(readFileSync(file, "utf8"), before);
});
