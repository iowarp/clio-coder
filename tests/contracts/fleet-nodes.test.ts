import { match, ok, strictEqual, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { readClioVersion } from "../../src/core/package-root.js";
import { shellQuote } from "../../src/core/shell-quote.js";
import {
	addFleetNode,
	inspectFleetNodes,
	rejectSameMachineNodes,
	removeFleetNode,
	testFleetNode,
} from "../../src/domains/dispatch/fleet-nodes.js";
import { sameFleetBuild } from "../../src/domains/dispatch/fleet-preflight.js";
import { verifyFleetProject } from "../../src/domains/dispatch/fleet-project-verification.js";
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

	it("remote Git verification never executes configured fsmonitor", {
		skip: process.platform === "win32",
	}, async () => {
		const project = join(scratch, "project");
		mkdirSync(project);
		spawnSync("git", ["init", "-q", project]);
		spawnSync("git", [
			"-C",
			project,
			"-c",
			"user.name=Review",
			"-c",
			"user.email=review@example.invalid",
			"commit",
			"--allow-empty",
			"-qm",
			"base",
		]);
		const marker = join(scratch, "fsmonitor-ran");
		const monitor = join(scratch, "monitor");
		writeFileSync(monitor, `#!/bin/sh\nprintf ran > ${shellQuote(marker)}\n`);
		chmodSync(monitor, 0o755);
		const ssh = join(scratch, "ssh");
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = `${scratch}:${originalPath}`;
			for (const key of ["core.fsmonitor", "filter.review.clean", "filter.review.process"]) {
				rmSync(marker, { force: true });
				writeFileSync(
					ssh,
					`#!/bin/sh\nfor command do :; done\nexport GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${shellQuote(key)} GIT_CONFIG_VALUE_0=${shellQuote(monitor)}\nexec /bin/sh -c "$command"\n`,
				);
				chmodSync(ssh, 0o755);
				const result = await verifyFleetProject({ id: "fake", host: "fake.invalid" }, project);
				strictEqual(existsSync(marker), false, key);
				strictEqual(result.kind, key === "core.fsmonitor" ? "independent" : "unverified", result.reason ?? key);
			}
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("read-only project verification never creates a shared-storage challenge", {
		skip: process.platform === "win32",
	}, async () => {
		const project = join(scratch, "project");
		mkdirSync(project);
		const observed = join(scratch, "observed");
		const ssh = join(scratch, "ssh");
		writeFileSync(
			ssh,
			`#!/bin/sh\nfind ${shellQuote(project)} -name '.clio-coder-fleet-probe-*' > ${shellQuote(observed)}\nprintf 'shared=no\\n'\n`,
		);
		chmodSync(ssh, 0o755);
		const originalPath = process.env.PATH;
		try {
			process.env.PATH = `${scratch}:${originalPath}`;
			await verifyFleetProject({ id: "fake", host: "fake.invalid" }, project, true, true);
			strictEqual(readFileSync(observed, "utf8"), "");
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("refuses removing nodes referenced by profile pins", () => {
		addFleetNode({ id: "builder", host: "builder.invalid", maxWorkers: 1 });
		updateSettings((settings) => {
			settings.targets.push({ id: "test-target", runtime: "openai-compat", url: "http://localhost:8080" });
			settings.fleet.profiles.pinned = { node: "builder", target: "test-target", model: null, thinkingLevel: "off" };
		});
		throws(() => removeFleetNode("builder"), /pinned by profiles/);
		strictEqual(readSettings().fleet.nodes.length, 1);
	});

	it("observes without admitting and records failures that revoke eligibility", async () => {
		addFleetNode({ id: "builder", host: "builder.invalid", maxWorkers: 1 });
		const ssh = join(scratch, "ssh");
		writeFileSync(
			ssh,
			`#!/bin/sh\nprintf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=${readClioVersion()}' 'workerSpecs=8 9' 'state=ok'\n`,
		);
		chmodSync(ssh, 0o755);
		await testFleetNode("builder", process.cwd(), { sshBinary: ssh, targets: [], verifyProject: false });
		strictEqual(inspectFleetNodes()[0]?.readiness, "not checked");
		await testFleetNode("builder", process.cwd(), { sshBinary: ssh, targets: [], verifyProject: false, record: true });
		strictEqual(inspectFleetNodes()[0]?.readiness, "ready for this project");
		writeFileSync(ssh, "#!/bin/sh\nexit 255\n");
		await testFleetNode("builder", process.cwd(), { sshBinary: ssh, targets: [], verifyProject: false, record: true });
		strictEqual(inspectFleetNodes()[0]?.readiness, "needs attention");
	});

	it("refuses a second node entry for a machine another node already holds", async () => {
		addFleetNode({ id: "builder", host: "builder.invalid", maxWorkers: 1 });
		addFleetNode({ id: "builder-lan", host: "192.0.2.10", maxWorkers: 1 });
		const ssh = join(scratch, "ssh");
		writeFileSync(
			ssh,
			`#!/bin/sh\nprintf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=${readClioVersion()}' 'workerSpecs=8 9' 'state=ok' 'machine=0123456789abcdef0123456789abcdef'\n`,
		);
		chmodSync(ssh, 0o755);
		const options = { sshBinary: ssh, targets: [], verifyProject: false } as const;
		// Checked together, as a doctor sweep does, before either holds a record: the first listed keeps the machine.
		const batch = [
			await testFleetNode("builder", process.cwd(), options),
			await testFleetNode("builder-lan", process.cwd(), options),
		];
		rejectSameMachineNodes(batch);
		strictEqual(batch[0]?.ok, true);
		strictEqual(batch[1]?.ok, false);
		strictEqual((await testFleetNode("builder", process.cwd(), { ...options, record: true })).ok, true);
		const twin = await testFleetNode("builder-lan", process.cwd(), { ...options, record: true });
		strictEqual(twin.ok, false);
		match(twin.detail ?? "", /same machine as node 'builder'/);
		strictEqual((await testFleetNode("builder", process.cwd(), { ...options, record: true })).ok, true);
	});

	it("tells builds of one -dev version apart by clean commit or build id", () => {
		const build = (id: string | null, commit: string | null, dirty = false) => ({ id, commit, dirty });
		strictEqual(sameFleetBuild(build("a", "abc1234", true), build("a", "abc1234", true)), true);
		strictEqual(sameFleetBuild(build("a", "abc1234"), build("b", "abc1234")), true);
		strictEqual(sameFleetBuild(build("a", "abc1234", true), build("b", "abc1234", true)), false);
		strictEqual(sameFleetBuild(build(null, "abc1234"), build(null, "def5678")), false);
		ok(sameFleetBuild(build(null, "abc1234", true), build(null, "abc1234", true)) === null);
	});

	it("passes a node too old to report its worker spec versions as hook-free only", async () => {
		addFleetNode({ id: "builder", host: "builder.invalid", maxWorkers: 1 });
		const ssh = join(scratch, "ssh");
		// A build older than the spec report prints its version line for the probe.
		writeFileSync(
			ssh,
			`#!/bin/sh\nprintf '%s\\n' 'clio-coder-preflight/1' 'cwd=ok' 'clioCoder=${readClioVersion()}' 'workerSpecs=Clio Coder 0.6.2' 'state=ok'\n`,
		);
		chmodSync(ssh, 0o755);
		const record = await testFleetNode("builder", process.cwd(), {
			sshBinary: ssh,
			targets: [],
			verifyProject: false,
			record: true,
		});
		strictEqual(record.ok, true, record.detail ?? "");
		strictEqual(record.remoteWorkerSpecs, null);
		match(record.note ?? "", /version 8 only.*extension hooks \(version 9\) will not run on this node/);
		strictEqual(inspectFleetNodes()[0]?.readiness, "ready for this project");
	});
});
