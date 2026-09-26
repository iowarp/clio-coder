import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { SelectOptions, SelectResult, TextPromptOptions, TextResult } from "../../src/cli/select.js";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { initializeClioHome } from "../../src/core/init.js";
import { getRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { dockTop } from "../../src/interactive/dock.js";
import { buildSettingItems, openSettingsOverlay } from "../../src/interactive/overlays/settings.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { TargetWizardSurface } from "../../src/interactive/target-wizard.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("/config opens the same settings areas as /settings (#385)", () => {
	for (const area of ["", "targets", "chat", "interface"]) {
		deepStrictEqual(parseSlashCommand(`/config ${area}`.trim()), parseSlashCommand(`/settings ${area}`.trim()));
	}
});

test("Add target is an actionable in-TUI wizard (#385)", () => {
	const items = buildSettingItems(structuredClone(DEFAULT_SETTINGS));
	const add = items.find((item) => item.id === "targets.add-cta");
	ok(add);
	strictEqual(add.readOnly, false);
	ok(!add.currentValue.includes("clio-coder"));
});

function fixtures(): void {
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	const base = registry.get("llamacpp");
	ok(base);
	for (const id of ["wizard-one", "wizard-two"]) {
		if (registry.get(id)) continue;
		const runtime: RuntimeDescriptor = {
			...base,
			id,
			aliases: [],
			displayName: id,
			auth: "none",
			knownModels: ["model-a", "model-b"],
			defaultCapabilities: { ...base.defaultCapabilities, reasoning: false },
			probe: async () => ({ ok: true, models: ["model-a", "model-b"] }),
		};
		registry.register(runtime);
	}
}

class ScriptedWizard extends TargetWizardSurface {
	seen: string[] = [];
	constructor(
		private readonly runtime: string,
		private readonly url: string,
		private readonly model: string,
		private readonly save = true,
	) {
		super(
			() => {},
			() => {},
		);
	}
	private check(): void {
		for (const width of [40, 60, 80, 120, 200]) {
			const rows = this.render(width);
			strictEqual(rows.length, 16);
			for (const row of rows) ok(visibleWidth(row) <= width);
		}
	}
	override async select<T>(options: SelectOptions<T>): Promise<SelectResult<T>> {
		const pending = super.select(options);
		this.check();
		const heading = stripTerminalSequences(
			typeof options.heading === "string" ? options.heading : (options.heading ?? []).join(" "),
		);
		this.seen.push(heading);
		let value: unknown;
		if (heading.includes("How will")) value = "local-http";
		else if (heading.includes("Which runtime")) value = this.runtime;
		else if (heading.includes("Which model")) value = this.model;
		else if (heading.includes("Review target")) {
			value = this.save ? "save" : "cancel";
			ok(
				!readSettings().targets.some((target) => target.id === "dock-target") || this.runtime === "wizard-two",
				"Add remains a draft until Save",
			);
		} else value = options.choices[0]?.value;
		const index = options.choices.findIndex((choice) => choice.value === value);
		ok(index >= 0, `${heading}: missing ${String(value)}`);
		const start = options.initialIndex ?? 0;
		for (let step = 0; step < (index - start + options.choices.length) % options.choices.length; step++)
			this.handleInput("\x1b[B");
		this.handleInput("\r");
		return pending;
	}
	override async text(options: TextPromptOptions): Promise<TextResult> {
		const pending = super.text(options);
		this.check();
		const heading = stripTerminalSequences(
			typeof options.heading === "string" ? options.heading : (options.heading ?? []).join(" "),
		);
		this.seen.push(heading);
		const value = heading.includes("Target id")
			? "dock-target"
			: heading.includes("server") || heading.includes("URL")
				? this.url
				: (options.initial ?? "");
		this.handleInput("\x15");
		if (value) this.handleInput(value);
		this.handleInput("\r");
		return pending;
	}
}

test("the dock hosts shared target add and URL/runtime/model editing through Save (#385)", async () => {
	const env = await isolateClioEnv("clio-coder-target-dock-");
	try {
		fixtures();
		initializeClioHome();
		const add = new ScriptedWizard("wizard-one", "localhost:9911", "model-a");
		strictEqual(await add.start({ mode: "add" }), 0, add.render(200).map(stripTerminalSequences).join("\n"));
		const target = readSettings().targets.find((entry) => entry.id === "dock-target");
		ok(
			target,
			JSON.stringify({
				targets: readSettings().targets,
				seen: add.seen,
				rows: add.render(200).map(stripTerminalSequences),
			}),
		);
		strictEqual(target.runtime, "wizard-one");
		strictEqual(target.url, "http://localhost:9911");
		strictEqual(target.defaultModel, "model-a");
		updateSettings((settings) => {
			settings.chat.target = target.id;
			settings.chat.model = "model-a";
		});
		const edit = new ScriptedWizard("wizard-two", "localhost:9922", "model-b");
		strictEqual(await edit.start({ mode: "edit", target }), 0, edit.render(200).map(stripTerminalSequences).join("\n"));
		const settings = readSettings();
		const updated = settings.targets.find((entry) => entry.id === target.id);
		ok(updated);
		strictEqual(updated.runtime, "wizard-two");
		strictEqual(updated.url, "http://localhost:9922");
		strictEqual(updated.defaultModel, "model-b");
		strictEqual(settings.chat.target, target.id);
		strictEqual(settings.chat.model, "model-a", "editing the target does not rewrite chat's explicit model");
		match(edit.seen.join("\n"), /Which runtime/);
	} finally {
		env.restore();
	}
});

test("cancelling target setup leaves settings unchanged (#385)", async () => {
	const env = await isolateClioEnv("clio-coder-target-cancel-");
	try {
		fixtures();
		initializeClioHome();
		const before = readSettings();
		const wizard = new ScriptedWizard("wizard-one", "localhost:9911", "model-a", false);
		strictEqual(await wizard.start({ mode: "add" }), 0);
		deepStrictEqual(readSettings(), before);
	} finally {
		env.restore();
	}
});

test("prefilled text, validation and back navigation stay inside the hosted prompt (#385)", async () => {
	const body = new TargetWizardSurface(
		() => {},
		() => {},
	);
	let answer = body.text({ initial: "old", heading: "URL", validate: (value) => (value ? null : "A URL is required") });
	body.handleInput("\x15");
	body.handleInput("\r");
	match(body.render(40).map(stripTerminalSequences).join("\n"), /A URL is required/);
	body.handleInput("localhost:9000");
	body.handleInput("\r");
	deepStrictEqual(await answer, { kind: "value", value: "localhost:9000" });
	answer = body.text({ heading: "Model", initial: "draft" });
	body.handleInput("\x1b");
	deepStrictEqual(await answer, { kind: "back" });
	const secret = body.text({ heading: "Key", mask: true });
	body.handleInput("test-secret");
	ok(!body.render(40).join("\n").includes("test-secret"));
	body.cancel();
	deepStrictEqual(await secret, { kind: "quit" });
});

test("Settings mounts Add and Edit as docked prompts and tears them down with its parent (#385)", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "local", runtime: "wizard-one", url: "http://localhost:9911", defaultModel: "model-a" }];
	const proxies: Component[] = [];
	const tui = {
		terminal: { rows: 24 },
		requestRender() {},
		showOverlay(component: Component) {
			proxies.push(component);
			return { hide() {} };
		},
	} as unknown as TUI;
	for (const rowId of ["targets.add-cta", "targets.local"] as const) {
		const parent = openSettingsOverlay(tui, {
			getSettings: () => settings,
			writeSettings() {
				throw new Error("No Save was requested");
			},
			onClose() {},
			section: "targets",
			rowId,
		});
		const frame = dockTop(tui)?.frame as unknown as Component;
		frame.handleInput?.("\r");
		if (rowId === "targets.local") {
			frame.handleInput?.("\x1b[B");
			frame.handleInput?.("\r");
		}
		const wizard = dockTop(tui)?.frame;
		ok(wizard);
		match(wizard.dockTitle(), rowId === "targets.local" ? /Edit target: local/ : /Add target/);
		for (const width of [40, 60, 80, 120, 200]) {
			for (const proxy of proxies) deepStrictEqual(proxy.render(width), []);
			for (const line of wizard.renderDockBody(width - 4, 16)) ok(visibleWidth(line) <= width - 4);
		}
		parent.hide();
		strictEqual(dockTop(tui), null);
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
});

test("closing setup during a probe cannot save a late target (#385)", async () => {
	const env = await isolateClioEnv("clio-coder-target-late-");
	try {
		fixtures();
		initializeClioHome();
		const runtime = getRuntimeRegistry().get("wizard-one");
		ok(runtime);
		const original = runtime.probe;
		let began!: () => void;
		const probing = new Promise<void>((resolve) => {
			began = resolve;
		});
		let release!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		runtime.probe = async () => {
			began();
			await wait;
			return { ok: true, models: ["model-a"] };
		};
		try {
			const wizard = new ScriptedWizard("wizard-one", "localhost:9911", "model-a");
			const pending = wizard.start({ mode: "add" });
			await probing;
			wizard.cancel();
			release();
			strictEqual(await pending, 130);
			ok(!readSettings().targets.some((target) => target.id === "dock-target"));
		} finally {
			if (original) runtime.probe = original;
			else delete runtime.probe;
		}
	} finally {
		env.restore();
	}
});
