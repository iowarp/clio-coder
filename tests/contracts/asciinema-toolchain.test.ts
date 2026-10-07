import { equal, match, ok, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { updateSettings } from "../../src/core/config.js";
import {
	describeFleetToolInstall,
	executeFleetToolInstall,
	prepareFleetToolInstall,
} from "../../src/domains/dispatch/fleet-tool-install.js";
import { installPinnedTool } from "../../src/domains/toolchain/install.js";
import { findPinnedTool } from "../../src/domains/toolchain/registry.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

let env: Awaited<ReturnType<typeof isolateClioEnv>>;
beforeEach(async () => {
	env = await isolateClioEnv("clio-coder-asciinema-");
});
afterEach(() => env.restore());

it("pins asciinema, GPL notice and corresponding upstream release source", async () => {
	const entry = findPinnedTool("asciinema");
	ok(entry);
	equal(entry.version, "3.2.1");
	equal(entry.license, "GPL-3.0-or-later");
	ok(entry.documents.some((doc) => doc.name.endsWith("source.tar.gz")));
	match(entry.notice ?? "", /separate program/);
	const root = join(env.dir, "tools");
	const bad = await installPinnedTool(entry, { root, platform: "linux-x64", fetch: async () => Buffer.from("corrupt") });
	equal(bad.ok, false);
	match(bad.message, /checksum mismatch/);
	equal(existsSync(join(root, entry.id, entry.version)), false);
});

it("writes the separate-program notice during an atomic checksum-verified installation", async () => {
	const bytes = Buffer.from("fixture program");
	const digest = createHash("sha256").update(bytes).digest("hex");
	const entry = findPinnedTool("asciinema");
	ok(entry);
	const result = await installPinnedTool(
		{
			...entry,
			documents: [],
			downloads: {
				"linux-x64": {
					url: "https://fixture.invalid/asciinema",
					sha256: digest,
					archive: "raw",
					binaryMembers: { asciinema: "" },
					documentMembers: [],
				},
			},
		},
		{ root: join(env.dir, "tools"), platform: "linux-x64", fetch: async () => bytes },
	);
	equal(result.ok, true);
	equal(readFileSync(join(result.dir, "NOTICE"), "utf8"), `${entry.notice}\n`);
	ok(result.documents.includes(join(result.dir, "NOTICE")));
});

it("previews explicit user-level SSH provisioning and rejects changed connections before remote execution", async () => {
	updateSettings((settings) => {
		settings.fleet.nodes.push({
			id: "seven",
			host: "fixture.invalid",
			maxWorkers: 1,
			clioCoderEntry: '"$HOME/.local/share/clio-coder/workers/pin/node_modules/.bin/clio-coder" worker',
		});
	});
	const plan = prepareFleetToolInstall("seven", "asciinema");
	match(plan.command, /tools install asciinema --json/);
	match(plan.command, /TMPDIR=/);
	equal(plan.command.includes("sudo"), false);
	match(describeFleetToolInstall(plan), /GPL-3.0-or-later/);
	updateSettings((settings) => {
		const node = settings.fleet.nodes.find((node) => node.id === "seven");
		if (node) node.host = "changed.invalid";
	});
	await rejects(executeFleetToolInstall(plan), /configuration changed/);
});
