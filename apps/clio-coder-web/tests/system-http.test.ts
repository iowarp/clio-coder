import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Meta } from "../contracts/meta.js";
import { Interop, SystemReport } from "../contracts/system.js";
import { harness, json } from "./harness/app.js";

test("system exposes canonical versions and four roots; doctor cannot repair and parser details cannot leak credentials", async () => {
	const h = await harness();
	try {
		await mkdir(join(h.home.path, "config"), { recursive: true });
		const path = join(h.home.path, "config/settings.yaml"),
			content = "targets: [secret-fixture-setting\n";
		await writeFile(path, content);
		const report = await json(await h.request("/api/system"), SystemReport);
		assert.deepEqual(
			report.paths,
			Object.fromEntries(["config", "data", "state", "cache"].map((role) => [role, join(h.home.path, role)])),
		);
		assert.ok(report.findings.length > 4);
		assert.equal(report.findings.find((row) => row.name === "settings.yaml")?.detailRedacted, true);
		assert.ok(!JSON.stringify(report).includes("secret-fixture-setting"));
		assert.equal(await readFile(path, "utf8"), content);
		assert.equal((await h.request("/api/system?fix=true")).status, 422);
		assert.equal((await h.post("/api/system", { fix: true })).status, 405);
		const meta = await json(await h.request("/api/meta"), Meta);
		assert.equal(meta.node, process.version);
		assert.equal(meta.platform, `${process.platform}-${process.arch}`);
		assert.ok(meta.piTui?.includes("0.85.1"));
	} finally {
		await h.close();
	}
});

test("interop lists all registered kinds, probes only version, keeps configuration values private and bounds a stalled probe", async () => {
	const bin = await mkdtemp(join(tmpdir(), "clio-web-interop-"));
	const executable = join(bin, "codex");
	await writeFile(
		executable,
		'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 1.2.3 private-probe-prose"; else exit 9; fi\n',
	);
	await chmod(executable, 0o700);
	const h = await harness({}, { env: { PATH: bin } });
	try {
		const dir = join(h.home.path, ".codex");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "config.toml"),
			'[mcp_servers.fixture]\ncommand="private-command"\n[mcp_servers.fixture.env]\nSECRET="private-key-value"\n',
		);
		const workspace = await h.workspaces.open(h.home.path),
			path = `/api/workspaces/${workspace.id}/interop`;
		const report = await json(await h.request(path), Interop);
		assert.deepEqual(report.agents.map((row) => row.kind).sort(), [
			"agents",
			"antigravity",
			"claude-code",
			"codex",
			"copilot",
			"cursor",
			"gemini",
			"opencode",
		]);
		const codex = report.agents.find((row) => row.kind === "codex");
		assert.equal(codex?.presence, "present");
		assert.equal(codex?.version, "1.2.3");
		assert.ok(codex?.inventory.items.some((item) => item.kind === "mcp" && item.name === "fixture"));
		assert.equal(report.agents.find((row) => row.kind === "claude-code")?.presence, "absent");
		assert.ok(!JSON.stringify(report).includes("private-"));
		await writeFile(executable, "#!/bin/sh\nexec /bin/sleep 30\n");
		const started = Date.now();
		const stalled = await json(await h.request(path), Interop);
		assert.equal(stalled.agents.find((row) => row.kind === "codex")?.version, null);
		assert.ok(Date.now() - started < 7000, "Version probe must not wait for the process's 30-second sleep");
		assert.equal((await h.post(path, { accept: "codex" })).status, 405);
	} finally {
		await h.close();
		await rm(bin, { recursive: true, force: true });
	}
});
