import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { DynamicToolName } from "../../src/core/tool-names.js";
import { loadManifestFromRoot, parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import { promptRefs } from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { OperatorExtensionRuntime, resolveExtensionCommands } from "../../src/domains/extensions/operator-runtime.js";
import { ExtensionRuntimeProcess } from "../../src/domains/extensions/runtime-process.js";
import {
	extensionPlainText,
	parseExtensionOutput,
	parseExtensionRuntime,
} from "../../src/domains/extensions/runtime-schema.js";
import {
	disableExtension,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "../../src/domains/extensions/state.js";
import { isLoadableExtension } from "../../src/domains/extensions/types.js";
import { disablePlugin, enablePlugin, installPlugin, removePlugin } from "../../src/domains/plugins/state.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { ExtensionPanelView } from "../../src/interactive/overlays/extension-panel.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/session-control/slash-commands.js";
import { registerHarnessExtensionTools } from "../../src/tools/harness-extensions.js";
import { createRegistry } from "../../src/tools/registry.js";
import { trustProjectPackages } from "../harness/project-trust.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const declaration = {
	api: 1,
	entrypoint: "extension.mjs",
	commands: [{ name: "inspect", description: "Inspect synthetic measurements", timeoutMs: 1000 }],
	events: [],
	ui: ["status", "panel"],
};
const normal =
	'export default api => { let n=0; api.handle("inspect", (args,ctx) => ({text:JSON.stringify({args,n:++n,snapshot:ctx.snapshot,secret:process.env.CLIO_CODER_TEST_SECRET??null}),status:{text:"SYNTHETIC fixture ready"}})); };';
/** Install into the project and approve it as `config trust extensions` would, returning the entry as it now lists. */
function installProject(source: string, cwd: string, options: { force?: boolean } = {}) {
	const result = installExtension(source, { cwd, scope: "project", ...options });
	trustProjectPackages(cwd, "extensions");
	const id = result.extension?.id;
	const extension = id
		? listInstalledExtensions(cwd, { scope: "project", all: true }).find((entry) => entry.id === id)
		: undefined;
	return { ...result, extension };
}
async function fixture(t: TestContext, script = normal, overrides: Record<string, unknown> = {}) {
	const env = await isolateClioEnv("clio-coder-operator-test-");
	const source = path.join(env.dir, "source");
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(source);
	mkdirSync(cwd);
	const manifest = {
		id: "lab_status.v1",
		name: "Lab status",
		version: "1.0.0",
		description: "Synthetic local fixture",
		runtime: { ...declaration, ...overrides },
	};
	writeFileSync(path.join(source, "clio-coder-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(source, "extension.mjs"), script);
	const result = installProject(source, cwd);
	ok(result.extension && isLoadableExtension(result.extension), JSON.stringify(result.diagnostics));
	const extension = result.extension;
	let sessionId = "clio-coder-session-one";
	let idle = true;
	const runtime = new OperatorExtensionRuntime({
		context: () => ({ workspace: cwd, sessionId, mode: "interactive" }),
		isIdle: () => idle,
	});
	t.after(async () => {
		await runtime.dispose();
		env.restore();
	});
	return {
		env,
		source,
		cwd,
		extension,
		runtime,
		manifest,
		setSession: (next: string) => {
			sessionId = next;
		},
		setIdle: (next: boolean) => {
			idle = next;
		},
	};
}

test("runtime manifest validates declarations and contained entrypoints without running startup code", async (t) => {
	const f = await fixture(t, 'throw new Error("discovery executed code")');
	ok(loadManifestFromRoot(f.source).valid);
	for (const bad of [
		{ api: 3 },
		{ surprise: true },
		{ entrypoint: "extension.ts" },
		{ commands: [{ name: "inspect", description: "x", timeoutMs: 0 }] },
		{ events: ["before_tool"] },
		{ ui: ["editor"] },
	]) {
		const parsed = parseExtensionManifest(
			{ ...f.manifest, runtime: { ...declaration, ...bad } },
			"clio-coder-extension.json",
		);
		equal(parsed.manifest, undefined, JSON.stringify(bad));
	}
	writeFileSync(
		path.join(f.source, "clio-coder-extension.json"),
		JSON.stringify({ ...f.manifest, runtime: { ...declaration, entrypoint: "../outside.mjs" } }),
	);
	equal(loadManifestFromRoot(f.source).valid, false);
});

test("real runtime stages before activation, filters env, keeps instance state and disposes private copy", async (t) => {
	const f = await fixture(t);
	process.env.CLIO_CODER_TEST_SECRET = "synthetic-private-value";
	const child = new ExtensionRuntimeProcess(f.extension, {
		workspace: f.cwd,
		sessionId: null,
		generation: 3,
		mode: "headless",
	});
	t.after(() => child.dispose());
	await child.staged;
	equal(child.state, "starting");
	await rejects(child.request({ kind: "command", name: "inspect", args: "before" }, 1000), /not ready/);
	await child.activate();
	const first = JSON.parse((await child.request({ kind: "command", name: "inspect", args: "hello" }, 1000)).text);
	equal(first.secret, null);
	equal(first.n, 1);
	equal(first.snapshot.generation, 3);
	ok(child.rss > 0);
	ok(existsSync(child.copyRoot));
	const pid = child.pid;
	await child.dispose();
	equal(existsSync(child.copyRoot), false);
	if (pid) throws(() => process.kill(pid, 0));
});

test("commands and UI carry runtime generation; relative helpers change only after reviewed reinstall and reload", async (t) => {
	const script =
		'import {label} from "./helper.mjs"; export default api=>api.handle("inspect",()=>({text:label,status:{text:label}}));';
	const f = await fixture(t, script);
	writeFileSync(path.join(f.source, "helper.mjs"), 'export const label="synthetic-first";');
	ok(installProject(f.source, f.cwd, { force: true }).extension?.loadable);
	equal((await f.runtime.reload("startup")).status, "committed");
	const command = "ext:lab_status.v1:inspect";
	equal((await f.runtime.invoke(command, "")).text, "synthetic-first");
	writeFileSync(path.join(f.source, "helper.mjs"), 'export const label="synthetic-second";');
	ok(installProject(f.source, f.cwd, { force: true }).extension?.loadable);
	await rejects(f.runtime.invoke(command, ""), /reload|revoked/);
	equal(f.runtime.entries()[0]?.status, undefined);
	await f.runtime.reload();
	equal((await f.runtime.invoke(command, "")).text, "synthetic-second");
	equal(f.runtime.activeGeneration, 2);
	const installed = installProject(f.source, f.cwd, { force: true }).extension;
	ok(installed?.provenance);
	deepStrictEqual(f.runtime.entries()[0]?.provenance, installed.provenance);
	ok(f.runtime.entries()[0]?.provenance?.contentDigest !== f.extension.provenance.contentDigest);
});

test("disabled project suppresses user runtime and removal reveals user copy", async (t) => {
	const f = await fixture(t);
	ok(installExtension(f.source, { cwd: f.cwd, scope: "user" }).extension?.valid);
	await f.runtime.reload();
	equal(f.runtime.commands()[0]?.scope, "project");
	disableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	f.runtime.reconcile();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /not enabled|revoked|disabled/);
	await f.runtime.reload();
	equal(
		f.runtime.commands().some((row) => row.available),
		false,
	);
	enableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	await f.runtime.reload();
	ok(f.runtime.commands()[0]?.available);
	removeExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	await f.runtime.reload();
	equal(f.runtime.commands()[0]?.scope, "user");
	ok(f.runtime.commands()[0]?.available);
});

test("idle reload is deferred and revalidated instead of interrupting active work", async (t) => {
	const f = await fixture(t);
	f.setIdle(false);
	equal((await f.runtime.reload()).status, "deferred");
	equal(f.runtime.activeGeneration, 0);
	f.setIdle(true);
	f.runtime.reconcile();
	for (let i = 0; i < 100 && !f.runtime.commands()[0]?.available; i++) await delay(20);
	ok(f.runtime.commands()[0]?.available);
});

test("real import failure and missing/undeclared handlers report degraded readiness", async (t) => {
	const f = await fixture(t, 'throw new Error("synthetic import failure")');
	const result = await f.runtime.reload();
	equal(result.status, "committed");
	match(result.message, /1 failed to start/);
	equal(f.runtime.entries()[0]?.state, "failed");
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /synthetic import failure/);
	for (const script of ["export default ()=>{}", 'export default api=>api.handle("undeclared",()=>({text:"bad"}))']) {
		writeFileSync(path.join(f.source, "extension.mjs"), script);
		installProject(f.source, f.cwd, { force: true });
		await f.runtime.reload();
		equal(f.runtime.commands()[0]?.available, false);
	}
});

test("CPU-bound command timeout kills real process and clears its UI", async (t) => {
	const f = await fixture(t, 'export default api=>api.handle("inspect",()=>{while(true){}});', {
		commands: [{ name: "inspect", description: "hang", timeoutMs: 100 }],
	});
	await f.runtime.reload();
	const start = performance.now();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /timed out/);
	ok(performance.now() - start < 3000);
	equal(f.runtime.entries()[0]?.state, "failed");
	equal(f.runtime.entries()[0]?.status, undefined);
});

test("cancellation fences ignored abort responses and invokes best-effort disposal", async (t) => {
	const f = await fixture(
		t,
		'import {writeFileSync} from "node:fs"; export default api=>{api.onDispose(()=>writeFileSync("clio-coder-disposed.txt","disposed")); api.handle("inspect",async()=>{await new Promise(r=>setTimeout(r,80));return {text:"late",status:{text:"stale"}}});};',
	);
	await f.runtime.reload();
	const controller = new AbortController();
	const call = f.runtime.invoke("ext:lab_status.v1:inspect", "", [], controller.signal);
	controller.abort();
	await rejects(call, /cancelled|disposed/);
	await delay(150);
	equal(f.runtime.entries()[0]?.status, undefined);
	equal(readFileSync(path.join(f.cwd, "clio-coder-disposed.txt"), "utf8"), "disposed");
});

test("session switch during request fences old output and rebuilds context", async (t) => {
	const f = await fixture(
		t,
		'export default api=>api.handle("inspect",async(args,ctx)=>{await new Promise(r=>setTimeout(r,60));return {text:ctx.snapshot.sessionId,status:{text:"session status"}}});',
	);
	await f.runtime.reload();
	const call = f.runtime.invoke("ext:lab_status.v1:inspect", "");
	f.setSession("clio-coder-session-two");
	f.runtime.invalidateContext();
	await rejects(call, /disposed|revoked/);
	await f.runtime.reload("session-change");
	equal((await f.runtime.invoke("ext:lab_status.v1:inspect", "")).text, "clio-coder-session-two");
});

test("install change while staging rejects candidate and starts no substituted bytes", async (t) => {
	const f = await fixture(
		t,
		'export default async api=>{await new Promise(r=>setTimeout(r,100));api.handle("inspect",()=>({text:"snapshot"}));};',
	);
	const reload = f.runtime.reload();
	await delay(30);
	disableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	equal((await reload).status, "rejected");
	equal(
		f.runtime.commands().some((row) => row.available),
		false,
	);
});

test("event observations have no bodies, cannot open panels, and status resets on reload", async (t) => {
	const f = await fixture(
		t,
		'export default api=>{api.handle("inspect",()=>({text:"ok"}));for(const event of ["session_open","turn_end"])api.on(event,(event,ctx)=>({text:JSON.stringify(event),status:{text:event.reason+":"+ctx.snapshot.sessionId}}));};',
		{ events: ["session_open", "turn_end"] },
	);
	await f.runtime.reload("startup");
	equal(f.runtime.entries()[0]?.status?.text, "startup:clio-coder-session-one");
	f.runtime.observe({ event: "turn_end", reason: "completed" });
	for (let i = 0; i < 50 && !f.runtime.entries()[0]?.status?.text.startsWith("completed"); i++) await delay(10);
	equal(f.runtime.entries()[0]?.status?.text, "completed:clio-coder-session-one");
});

test("host rejects forged protocol identity, oversized documents and undeclared UI", async (t) => {
	const f = await fixture(
		t,
		'export default api=>api.handle("inspect",()=>{process.send({protocol:1,instance:"forged",kind:"result",id:"fake",output:{text:"bad"}});return {text:"normal"};});',
	);
	await f.runtime.reload();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /instance mismatch/);
	const schema = parseExtensionRuntime(declaration);
	throws(() => parseExtensionOutput({ text: "x".repeat(70000) }, schema), /64 KiB/);
	throws(() => parseExtensionOutput({ text: "", status: { text: "x" } }, { ...schema, ui: [] }), /did not declare/);
	throws(() =>
		parseExtensionOutput(
			{ text: "", panel: { title: "x", sections: [{ kind: "table", columns: ["x"], rows: [["a", "b"]] }] } },
			schema,
		),
	);
	throws(() => parseExtensionOutput({ text: "", session: {} }, schema), /unknown/);
});

test("canonical IDs coexist with prompt ownership and preserve escaped/path prose", async (t) => {
	const f = await fixture(t);
	await f.runtime.reload();
	const invocation = "ext:lab_status.v1:inspect";
	equal(parseSlashCommand(`/${invocation}`).kind, "unknown-command");
	equal(parseSlashCommand(`\\/${invocation}`).kind, "unknown");
	equal(parseSlashCommand("/home/user/file").kind, "unknown");
	const rows = resolveExtensionCommands(f.runtime.commands(), [invocation.toUpperCase()]);
	equal(rows[0]?.available, false);
	match(rows[0]?.reason ?? "", /prompt/);
	await rejects(f.runtime.invoke(invocation, "", [invocation]), /prompt/);
});

test("host panels sanitize controls, wrap narrowly, scroll and expire without extension callbacks", () => {
	const output = parseExtensionOutput(
		{
			text: "fallback",
			status: { text: "\u001b[31mready\u001b[0m\nnext\u0007" },
			panel: {
				title: "Synthetic jobs",
				sections: [{ kind: "text", text: `\u001b]52;c;injected\u0007${"measurement data ".repeat(100)}` }],
			},
		},
		parseExtensionRuntime(declaration),
	);
	equal(output.status?.text, "ready next");
	ok(output.panel);
	let valid = true;
	const view = new ExtensionPanelView(
		output.panel,
		() => valid,
		() => {},
	);
	const lines = view.render(20);
	ok(lines.length <= 12);
	ok(lines.every((line) => line.length <= 20));
	view.handleInput("\u001b[B");
	ok(view.render(20).join("\n") !== lines.join("\n"));
	valid = false;
	match(view.render(100).join(""), /expired/);
	equal(extensionPlainText("\u001b[2Jhello\u0000"), "hello");
});

test("scientific examples are valid packages and the real dashboard labels synthetic evidence", async (t) => {
	const f = await fixture(t);
	for (const name of ["lab-status", "measurements"]) {
		const source = path.resolve("examples/extensions", name);
		ok(loadManifestFromRoot(source).valid, name);
		ok(installProject(source, f.cwd).extension?.loadable);
	}
	await f.runtime.reload();
	const output = await f.runtime.invoke("ext:lab-status:dashboard", "");
	match(output.text, /SYNTHETIC FIXTURE/);
	ok(output.panel);
	match(output.status?.text ?? "", /2\/3 completed/);
	deepStrictEqual(output.panel.sections.find((section) => section.kind === "table")?.columns, [
		"Job",
		"MPI ranks",
		"State",
		"Elapsed s",
	]);
});

test("post-activation child death is failed and cannot leave a stale status", async (t) => {
	const f = await fixture(t, 'export default api=>api.handle("inspect",()=>{process.exit(23)});');
	await f.runtime.reload();
	await rejects(f.runtime.invoke("ext:lab_status.v1:inspect", ""), /exited/);
	equal(f.runtime.entries()[0]?.state, "failed");
});

test("startup CPU loop has a real deadline and disposal kills hanging hooks and descendants", {
	timeout: 12000,
}, async (t) => {
	const f = await fixture(t, "while(true){}");
	const start = performance.now();
	equal((await f.runtime.reload()).status, "committed");
	match(f.runtime.entries()[0]?.reason ?? "", /startup timed out/);
	ok(performance.now() - start < 9000);
	if (process.platform === "win32") return;
	writeFileSync(
		path.join(f.source, "extension.mjs"),
		'import {spawn} from "node:child_process";export default api=>{let child;api.handle("inspect",()=>{child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});return {text:String(child.pid)}});api.onDispose(()=>new Promise(()=>{}));};',
	);
	installProject(f.source, f.cwd, { force: true });
	await f.runtime.reload();
	const pid = Number((await f.runtime.invoke("ext:lab_status.v1:inspect", "")).text);
	await f.runtime.dispose();
	// Linux may briefly retain the killed orphan as a zombie awaiting init.
	let alive = true;
	for (let i = 0; i < 100; i++) {
		try {
			process.kill(pid, 0);
			if (process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z") {
				alive = false;
				break;
			}
		} catch {
			alive = false;
			break;
		}
		await delay(10);
	}
	equal(alive, false, "ordinary descendant must not keep executing after disposal");
});

test("unsolicited stdout flood fails without forwarding terminal bytes", async (t) => {
	const f = await fixture(
		t,
		'export default api=>api.handle("inspect",()=>{process.stdout.write("x".repeat(100000));return {text:"done"}});',
	);
	await f.runtime.reload();
	// The response and pipe chunks can arrive in either order. Both lead to failure.
	await f.runtime.invoke("ext:lab_status.v1:inspect", "").catch(() => {});
	for (let i = 0; i < 100 && f.runtime.entries()[0]?.state !== "failed"; i++) await delay(10);
	match(f.runtime.entries()[0]?.reason ?? "", /diagnostic output/);
});

test("four-runtime cap is explicit and command-only packages consume no process", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 5; i++) {
		writeFileSync(
			path.join(f.source, "clio-coder-extension.json"),
			JSON.stringify({ ...f.manifest, id: `clio-coder-fixture-${i}` }),
		);
		ok(installProject(f.source, f.cwd).extension?.loadable);
	}
	await f.runtime.reload();
	equal(f.runtime.entries().filter((entry) => entry.state === "ready").length, 4);
	equal(f.runtime.entries().filter((entry) => entry.reason?.includes("limit is 4")).length, 2);
});

test("a result with the wrong request ID has no effect before the real response", async (t) => {
	const script =
		'let identity;process.on("message",m=>{identity=m.instance});export default api=>api.handle("inspect",()=>{process.send({protocol:1,instance:identity,kind:"result",id:"clio-coder-late-request",output:{text:"wrong",status:{text:"stale"}}});return {text:"right",status:{text:"current"}}});';
	const f = await fixture(t, script);
	await f.runtime.reload();
	equal((await f.runtime.invoke("ext:lab_status.v1:inspect", "")).text, "right");
	equal(f.runtime.entries()[0]?.status?.text, "current");
});

test("UI-only changes in a mixed package revoke frozen tools; workers never start its runtime", async (t) => {
	const f = await fixture(
		t,
		'import {writeFileSync} from "node:fs";writeFileSync("clio-coder-runtime-started.txt","started");export default api=>api.handle("inspect",()=>({text:"ok"}));',
	);
	const manifest = {
		...f.manifest,
		id: "mixed-fixture",
		capabilities: {
			tools: [
				{
					name: "measure",
					description: "Synthetic tool",
					runtime: "node",
					entrypoint: "measure.cjs",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		},
	};
	writeFileSync(path.join(f.source, "clio-coder-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(f.source, "measure.cjs"), "console.log(JSON.stringify({value:42,synthetic:true}));");
	ok(installExtension(f.source, { cwd: f.cwd, scope: "user" }).extension?.loadable);
	const name = "extension_mixed-fixture__measure" as DynamicToolName;
	const worker = createWorkerToolRegistry();
	ok(worker.get(name));
	equal(existsSync(path.join(f.cwd, "clio-coder-runtime-started.txt")), false);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: f.cwd }) });
	registerHarnessExtensionTools(registry, f.cwd);
	const tool = registry.get(name);
	ok(tool);
	equal((await tool.run({})).kind, "ok");
	await f.runtime.reload();
	writeFileSync(path.join(f.source, "extension.mjs"), normal);
	ok(installExtension(f.source, { cwd: f.cwd, scope: "user", force: true }).extension?.loadable);
	await f.runtime.reload();
	equal((await tool.run({})).kind, "error");
	ok(f.runtime.entries().find((entry) => entry.id === "mixed-fixture")?.newSessionReasons.length);
	// No model tool schema was dynamically rebound by the successful runtime reload.
	equal(registry.get(name), tool);
});

test("completion and dispatch preserve display-only prompt ownership at the same canonical spelling", async (t) => {
	const f = await fixture(t);
	await f.runtime.reload();
	const invocation = "ext:lab_status.v1:inspect";
	let promptNames: Array<{ name: string; description: string; displayOnly: boolean; sourceInfo: { source: string } }> =
		[];
	const provider = createSlashCommandAutocompleteProvider({
		fdPath: null,
		extensionCommands: () => f.runtime.commands(),
		promptTemplates: () => promptNames,
	});
	const line = "/ext:lab";
	const suggestions = () => provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	equal((await suggestions())?.items[0]?.value, invocation);
	promptNames = [
		{ name: invocation, description: "Legacy reference", displayOnly: true, sourceInfo: { source: "project" } },
	];
	const collided = await suggestions();
	equal(collided?.items.length, 1);
	match(String(collided?.items[0]?.description), /reference/);
	let references = 0;
	let turns = 0;
	const ctx = {
		operatorExtensions: f.runtime,
		listPrompts: () => ({ items: promptNames, diagnostics: [] }),
		expandPromptTemplate: () => ({
			expanded: false,
			display: { template: { name: invocation, sourceInfo: { source: "project" } }, text: "Legacy reference" },
		}),
		submitChat: () => {
			turns++;
		},
		showReference: () => {
			references++;
		},
		render: () => {},
		notice: () => {},
	} as unknown as SlashCommandContext;
	equal(dispatchSlashCommand(parseSlashCommand(`/${invocation}`), ctx), "accepted");
	equal(references, 1);
	equal(turns, 0);
	equal(f.runtime.entries()[0]?.status, undefined);
});

test("operator dispatch joins local admission and preserves unavailable drafts", async (t) => {
	const f = await fixture(t);
	await f.runtime.reload();
	const invocation = "ext:lab_status.v1:inspect";
	const operations: Array<() => Promise<void>> = [];
	const outputs: string[] = [];
	const notices: string[] = [];
	const ctx = {
		operatorExtensions: f.runtime,
		listPrompts: () => ({ items: [], diagnostics: [] }),
		runLocalOperation: (operation: () => Promise<void>) => operations.push(operation),
		showExtensionOutput: (_command: string, output: { text: string }) => outputs.push(output.text),
		render: () => {},
		notice: (_level: string, message: string) => notices.push(message),
	} as unknown as SlashCommandContext;
	equal(dispatchSlashCommand(parseSlashCommand(`/${invocation} queued args`), ctx), "accepted");
	equal(operations.length, 1);
	equal(outputs.length, 0);
	equal(f.runtime.entries()[0]?.status, undefined, "dispatch must wait for the host's local-operation queue");
	await operations[0]?.();
	equal(JSON.parse(outputs[0] ?? "null").args, "queued args");
	disableExtension(f.extension.id, { cwd: f.cwd, scope: "project" });
	trustProjectPackages(f.cwd, "extensions");
	f.runtime.reconcile();
	equal(dispatchSlashCommand(parseSlashCommand(`/${invocation}`), ctx), "rejected");
	equal(dispatchSlashCommand(parseSlashCommand("/ext:unknown:missing"), ctx), "rejected");
	equal(operations.length, 1);
	equal(notices.length, 2);
});

test("no-runtime and queued busy maintenance do no repeated disk verification", async (t) => {
	const f = await fixture(t);
	let lists = 0;
	let idle = true;
	const runtime = new OperatorExtensionRuntime({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		list: () => {
			lists++;
			return [];
		},
		isIdle: () => idle,
	});
	t.after(() => runtime.dispose());
	await runtime.reload();
	const baseline = lists;
	equal(runtime.maintenanceDelayMs, null);
	for (let i = 0; i < 100; i++) {
		runtime.maintenance();
		runtime.reconcile();
		runtime.invalidateContext();
		runtime.observe({ event: "turn_end", reason: "completed" });
	}
	equal(lists, baseline);
	idle = false;
	equal((await runtime.reload()).status, "deferred");
	for (let i = 0; i < 100; i++) runtime.maintenance();
	equal(lists, baseline);
	equal(runtime.maintenanceDelayMs, 250);
});

for (const failure of ["context", "inventory"] as const) {
	test(`reload retains cleanup ownership when ${failure} lookup fails before staging`, async (t) => {
		const f = await fixture(t, 'export default api=>{api.handle("inspect",()=>({text:String(process.pid)}));};');
		let broken = false;
		const runtime = new OperatorExtensionRuntime({
			context: () => {
				if (broken && failure === "context") throw new Error("context unavailable");
				return { workspace: f.cwd, sessionId: null, mode: "interactive" };
			},
			list: () => {
				if (broken && failure === "inventory") throw new Error("inventory unavailable");
				return [f.extension];
			},
			isIdle: () => true,
		});
		let pid: number | undefined;
		try {
			equal((await runtime.reload()).status, "committed");
			const childPid = Number((await runtime.invoke("ext:lab_status.v1:inspect", "")).text);
			pid = childPid;
			ok(Number.isSafeInteger(pid) && pid > 0);
			broken = true;
			equal((await runtime.reload()).status, "rejected");
			await runtime.dispose();
			throws(() => process.kill(childPid, 0), { code: "ESRCH" });
		} finally {
			await runtime.dispose();
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already reaped by disposal. */
				}
			}
		}
	});
}

test("missing workspace and throwing context adapters quarantine real observations without unhandled rejection", async (t) => {
	const f = await fixture(
		t,
		'export default api=>{api.handle("inspect",()=>({text:"ok"}));api.on("turn_end",()=>({text:"",status:{text:"observation"}}));};',
		{ events: ["turn_end"] },
	);
	let broken = false;
	const diagnostics: string[] = [];
	const runtime = new OperatorExtensionRuntime({
		context: () => {
			if (broken) throw new Error("synthetic context adapter failed");
			return { workspace: f.cwd, sessionId: null, mode: "interactive" };
		},
		isIdle: () => false,
		onDiagnostic: (message) => diagnostics.push(message),
	});
	// A second host with a mutable adapter drives the failure after real activation.
	let idle = true;
	const active = new OperatorExtensionRuntime({
		context: () => {
			if (broken) throw new Error("synthetic context adapter failed");
			return { workspace: f.cwd, sessionId: null, mode: "interactive" };
		},
		isIdle: () => idle,
		onDiagnostic: (message) => diagnostics.push(message),
	});
	t.after(async () => {
		await runtime.dispose();
		await active.dispose();
	});
	await active.reload();
	broken = true;
	idle = false;
	active.observe({ event: "turn_end", reason: "completed" });
	await delay(50);
	match(diagnostics.join("\n"), /context adapter failed/);
	equal(
		active.commands().some((row) => row.available),
		false,
	);
	broken = false;
	idle = true;
	await active.reload();
	rmSync(f.cwd, { recursive: true });
	active.observe({ event: "turn_end", reason: "completed" });
	await delay(50);
	ok(diagnostics.length >= 2);
	equal(
		active.commands().some((row) => row.available),
		false,
	);
});

test("frozen registry provenance detects a package changed between tool bootstrap and runtime startup", async (t) => {
	const f = await fixture(t);
	const manifest = {
		...f.manifest,
		id: "bootstrap-gap",
		capabilities: {
			tools: [
				{
					name: "measure",
					description: "Synthetic tool",
					runtime: "node",
					entrypoint: "measure.cjs",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		},
	};
	writeFileSync(path.join(f.source, "clio-coder-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(f.source, "measure.cjs"), 'console.log("42")');
	installProject(f.source, f.cwd);
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: f.cwd }) });
	registerHarnessExtensionTools(registry, f.cwd);
	const frozenTools = registry
		.listAll()
		.flatMap((tool) => (tool.sourceInfo?.extension ? [tool.sourceInfo.extension] : []));
	writeFileSync(path.join(f.source, "extension.mjs"), `${normal}\n// UI-only changed after schema bootstrap`);
	installProject(f.source, f.cwd, { force: true });
	const runtime = new OperatorExtensionRuntime({
		context: () => ({ workspace: f.cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		frozenTools,
	});
	t.after(() => runtime.dispose());
	await runtime.reload();
	const entry = runtime.entries().find((entry) => entry.id === "bootstrap-gap");
	equal(entry?.toolEvidence, "frozen-registry");
	match(entry?.newSessionReasons.join(" ") ?? "", /differs from the frozen tool registry/);
});

test("runtime activation rejects metadata that differs from the digest-bound manifest", async (t) => {
	const f = await fixture(t);
	const forged = structuredClone(f.extension);
	ok(forged.runtime);
	forged.runtime.ui = [];
	throws(
		() => new ExtensionRuntimeProcess(forged, { workspace: f.cwd, sessionId: null, generation: 1, mode: "headless" }),
		/declarations differ/,
	);
});

test("empty startup reload reports structured readiness and its origin to the UI", async () => {
	const observations: string[] = [];
	const runtime = new OperatorExtensionRuntime({
		context: () => ({ workspace: process.cwd(), sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: () => [],
		onReload: (result, reason) => observations.push(`${reason}:${result.degraded}`),
	});
	try {
		const result = await runtime.reload("startup");
		equal(result.status, "committed");
		equal(result.degraded, 0);
		deepStrictEqual(observations, ["startup:0"]);
		ok(!result.message.includes("generation"));
		await runtime.reload();
		deepStrictEqual(observations, ["startup:0", "reload:0"]);
	} finally {
		await runtime.dispose();
	}
});

test("a running extension snapshot follows its served plugin's installation, enable and disable", async (t) => {
	const env = await isolateClioEnv("clio-coder-served-plugin-test-");
	const cwd = path.join(env.dir, "workspace");
	const source = path.join(env.dir, "source");
	mkdirSync(cwd);
	mkdirSync(source);
	writeFileSync(
		path.join(source, "clio-coder-extension.json"),
		JSON.stringify({
			id: "lab_status.v1",
			name: "Lab status",
			version: "1.0.0",
			description: "Synthetic served plugin fixture",
			plugin: "materio",
			runtime: { ...declaration, api: 2 },
		}),
	);
	writeFileSync(path.join(source, "extension.mjs"), normal);
	ok(installExtension(source, { cwd, scope: "user" }).extension);
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		stateDir: () => path.join(env.dir, "state"),
	});
	t.after(async () => {
		await runtime.dispose();
		env.restore();
	});
	equal((await runtime.reload("startup")).status, "committed");
	const inspect = async () => JSON.parse((await runtime.invoke("ext:lab_status.v1:inspect", "")).text);
	deepStrictEqual((await inspect()).snapshot.plugin, null);
	ok(installPlugin(path.resolve(import.meta.dirname, "../../library/plugins/materio"), { cwd, scope: "user" }).plugin);
	const enabled = await inspect();
	equal(enabled.n, 2, "plugin changes update the existing child");
	deepStrictEqual(enabled.snapshot.plugin, {
		id: "materio",
		prompts: listInstalledExtensions(cwd).find((entry) => entry.id === "lab_status.v1")?.pluginPrompts,
	});
	ok(enabled.snapshot.plugin.prompts.includes("materio:identify-research"));
	disablePlugin("materio", { cwd, scope: "user" });
	const disabled = await inspect();
	equal(disabled.n, 3);
	equal(disabled.snapshot.plugin, null);
	enablePlugin("materio", { cwd, scope: "user" });
	deepStrictEqual((await inspect()).snapshot.plugin, enabled.snapshot.plugin);
	equal((await runtime.reload()).status, "committed");
	deepStrictEqual((await inspect()).snapshot.plugin, enabled.snapshot.plugin);
	removePlugin("materio", { cwd, scope: "user" });
	equal((await inspect()).snapshot.plugin, null);
});

test("a served plugin's prompt is a plain prompt until its extension is installed and in effect", async (t) => {
	const env = await isolateClioEnv("clio-coder-takeover-test-");
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	const library = path.resolve(import.meta.dirname, "../../library");
	ok(installPlugin(path.join(library, "plugins/materio"), { cwd, scope: "user" }).plugin);
	const prompts = () => loadPromptTemplates({ cwd });
	let turns = 0;
	const shown: string[] = [];
	const ctx = {
		get operatorExtensions() {
			return runtime;
		},
		listPrompts: () => ({ items: prompts().items, diagnostics: [] }),
		expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, prompts()),
		submitChat: () => {
			turns++;
		},
		runLocalOperation: (operation: () => Promise<void>) => void operation(),
		showExtensionOutput: (command: string) => shown.push(command),
		render: () => {},
		notice: () => {},
	} as unknown as SlashCommandContext;
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		list: (root) => listInstalledExtensions(root, { all: true }),
		stateDir: () => path.join(env.dir, "state"),
	});
	t.after(async () => {
		await runtime.dispose();
		env.restore();
	});
	const names = () => promptRefs(prompts().items);
	ok(
		names().some((prompt) => prompt.name === "materio:status"),
		"the plugin alone provides the prompt",
	);

	// Plugin alone: no runtime exists, and the name expands as an ordinary prompt template.
	equal((await runtime.reload("startup")).status, "committed");
	deepStrictEqual(runtime.entries(), []);
	deepStrictEqual(runtime.commands(names()), []);
	equal(dispatchSlashCommand(parseSlashCommand("/materio:status"), ctx), "accepted");
	equal(turns, 1);
	deepStrictEqual(shown, []);

	// With its extension installed and running, the same name routes to the runtime command.
	ok(installExtension(path.join(library, "extensions/materio"), { cwd, scope: "user" }).extension);
	equal((await runtime.reload()).status, "committed");
	equal(runtime.entries().find((entry) => entry.id === "materio")?.state, "ready");
	const takeover = runtime.commands(names()).find((row) => row.invocation === "materio:status");
	ok(takeover?.available && takeover.replaces === "prompt", JSON.stringify(takeover));
	equal(dispatchSlashCommand(parseSlashCommand("/materio:status"), ctx), "accepted");
	for (let waited = 0; shown.length === 0 && waited < 10_000; waited += 50) await delay(50);
	equal(turns, 1, "the takeover must not also send the prompt to the model");
	deepStrictEqual(shown, ["materio:status"]);
});
