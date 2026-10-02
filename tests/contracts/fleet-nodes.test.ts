import { strictEqual, throws } from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { readClioVersion } from "../../src/core/package-root.js";
import {
	addFleetNode,
	inspectFleetNodes,
	removeFleetNode,
	testFleetNode,
} from "../../src/domains/dispatch/fleet-nodes.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

describe("fleet node management", () => {
	let scratch: string;
	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-coder-fleet-nodes-");
	});
	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	it("persists add/list/remove without claiming readiness", () => {
		addFleetNode({ id: "builder", host: "builder.invalid", maxWorkers: 1 });
		strictEqual(inspectFleetNodes()[0]?.readiness, "not checked");
		strictEqual(readSettings().fleet.nodes[0]?.host, "builder.invalid");
		throws(() => addFleetNode({ id: "builder", host: "other.invalid", maxWorkers: 1 }), /already exists/);
		removeFleetNode("builder");
		strictEqual(inspectFleetNodes().length, 0);
	});

	it("refuses removing nodes referenced by profile pins", () => {
		addFleetNode({ id: "builder", host: "builder.invalid", maxWorkers: 1 });
		updateSettings((settings) => {
			settings.targets.push({ id: "test-target", runtime: "openai-compat", url: "http://localhost:8080" });
			settings.fleet.profiles.pinned = { node: "builder", target: "test-target" };
		});
		throws(() => removeFleetNode("builder"), /pinned by profiles/);
		strictEqual(readSettings().fleet.nodes.length, 1);
	});

	it("observes without admitting and records failures that revoke eligibility", async () => {
		addFleetNode({ id: "builder", host: "builder.invalid", maxWorkers: 1 });
		const ssh = join(scratch, "ssh");
		writeFileSync(
			ssh,
			`#!/bin/sh\nprintf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=${readClioVersion()}' 'state=ok'\n`,
		);
		chmodSync(ssh, 0o755);
		await testFleetNode("builder", process.cwd(), { sshBinary: ssh, targets: [] });
		strictEqual(inspectFleetNodes()[0]?.readiness, "not checked");
		await testFleetNode("builder", process.cwd(), { sshBinary: ssh, targets: [], record: true });
		strictEqual(inspectFleetNodes()[0]?.readiness, "ready for this project");
		writeFileSync(ssh, "#!/bin/sh\nexit 255\n");
		await testFleetNode("builder", process.cwd(), { sshBinary: ssh, targets: [], record: true });
		strictEqual(inspectFleetNodes()[0]?.readiness, "needs attention");
	});
});
