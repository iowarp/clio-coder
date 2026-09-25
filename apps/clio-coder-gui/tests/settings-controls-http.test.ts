import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Workspace } from "../contracts/sessions.js";
import { SettingsControls, SettingWritten } from "../contracts/settings-controls.js";
import { harness, json } from "./harness/app.js";
import { seedSettings } from "./harness/settings-fixture.js";

const HIDDEN = [
	"interface.smoothStreaming",
	"interface.mode",
	"interface.fullscreenScrollbar",
	"interface.terminalProgress",
	"interface.panes.workers.ratio",
	"interface.panes.files.ratio",
	"interface.keybindings",
];

test("settings controls derive from the engine registry, write only the user layer, and refuse what the policy withholds", async () => {
	const h = await harness();
	try {
		const seeded = await seedSettings(h.home.path, h.home.env);
		const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), Workspace);
		const base = `/api/workspaces/${workspace.id}/settings/controls`;
		const patch = (body: unknown) =>
			h.request(base, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
				body: JSON.stringify(body),
			});
		const report = await json(await h.request(base), SettingsControls);
		const byPath = new Map(report.controls.map((control) => [control.path, control]));

		// The surface is the registry minus the hidden set: no hand-listed paths, no retired v1 roots.
		assert.deepEqual(
			[...byPath.keys()].sort(),
			seeded.controlPaths.filter((path) => !HIDDEN.includes(path)),
		);
		assert.ok(report.controls.every((control) => control.access === "writable" || control.reason));
		assert.ok(report.controls.every((control) => report.sections.some((section) => section.id === control.section)));
		for (const control of report.controls.filter((candidate) => candidate.kind === "json")) {
			assert.equal(control.access, "read-only", control.path);
			assert.match(control.value, /^\d+ entr(y|ies)$/, "structured content never crosses");
		}
		assert.equal(byPath.get("integrations.library.confirmedRemote")?.access, "read-only");
		assert.equal(byPath.get("fleet.permissions.mode")?.section, "safety");
		assert.equal(byPath.get("fleet.concurrency")?.timing, "restartRequired");
		assert.equal(byPath.get("safety.review.enabled")?.timing, "hotReload");
		assert.match(byPath.get("safety.review.enabled")?.note ?? "", /ACP runs never fire/);
		assert.deepEqual(byPath.get("chat.target")?.suggestions, ["fixture-target"]);
		assert.ok(Object.keys(byPath.get("safety.autonomy")?.valueHelp ?? {}).includes("yolo"));

		// Autonomy comes from the operator layer, while project overrides still block user writes to their own controls.
		const autonomy = byPath.get("safety.autonomy");
		assert.equal(autonomy?.source, "built-in");
		assert.equal(autonomy?.access, "writable");
		assert.equal((await patch({ path: "safety.autonomy", value: "yolo" })).status, 200);
		assert.equal(byPath.get("fleet.concurrency")?.source, "project");
		assert.equal(byPath.get("fleet.concurrency")?.access, "read-only");
		assert.equal((await patch({ path: "fleet.concurrency", value: "3" })).status, 409);

		const thinking = byPath.get("chat.thinkingLevel");
		assert.equal(thinking?.value, "high");
		assert.equal(thinking?.access, "writable");
		assert.equal(thinking?.timing, "nextTurn");
		const written = await json(await patch({ path: "chat.thinkingLevel", value: "low" }), SettingWritten);
		assert.deepEqual(written.changed, [{ path: "chat.thinkingLevel", value: "low" }]);
		assert.equal(written.timing, "nextTurn");
		assert.match(await readFile(join(h.home.path, "config/settings.yaml"), "utf8"), /thinkingLevel: low/);
		const reread = await json(await h.request(base), SettingsControls);
		assert.equal(reread.controls.find((control) => control.path === "chat.thinkingLevel")?.value, "low");

		// Engine validation, not a copy of it.
		const badChoice = await patch({ path: "chat.thinkingLevel", value: "extreme" });
		assert.equal(badChoice.status, 422);
		const badTarget = await patch({ path: "chat.target", value: "no-such-connection" });
		assert.equal(badTarget.status, 422);
		assert.match(JSON.stringify(await badTarget.json()), /existing connection/);
		assert.equal((await patch({ path: "chat.retry.maxRetries", value: "many" })).status, 422);

		// A connection change clears the model override, and the response says so.
		const target = await json(await patch({ path: "fleet.default.target", value: "fixture-target" }), SettingWritten);
		assert.equal(target.changed[0]?.path, "fleet.default.target");
		const model = await json(await patch({ path: "fleet.default.model", value: "fixture-model" }), SettingWritten);
		assert.deepEqual(model.changed, [{ path: "fleet.default.model", value: "fixture-model" }]);
		const cleared = await json(await patch({ path: "fleet.default.target", value: "" }), SettingWritten);
		assert.deepEqual(cleared.changed.map((row) => row.path).sort(), ["fleet.default.model", "fleet.default.target"]);

		assert.equal((await patch({ path: "interface.mode", value: "fullscreen" })).status, 404);
		assert.equal((await patch({ path: "targets.0.url", value: "http://x" })).status, 422);
		assert.equal((await patch({ path: "fleet.profiles", value: "{}" })).status, 409);
		assert.equal((await patch({ path: "integrations.library.confirmedRemote", value: "x" })).status, 409);

		const unconfirmed = await patch({ path: "fleet.history.maxRuns", value: "10" });
		assert.equal(unconfirmed.status, 422);
		assert.match(JSON.stringify(await unconfirmed.json()), /event journal/);
		const confirmed = await json(
			await patch({ path: "fleet.history.maxRuns", value: "10", confirmed: true }),
			SettingWritten,
		);
		assert.deepEqual(confirmed.changed, [{ path: "fleet.history.maxRuns", value: "10" }]);
	} finally {
		await h.close();
	}
});
