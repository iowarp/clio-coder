import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { slurmMcpFindings } from "../../src/cli/doctor-slurm.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createMcpStdioClient } from "../../src/domains/gateway/mcp/index.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/index.js";
import { createRegistry, type ToolRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Slurm reaches Clio through the clio-kit Slurm MCP server and the existing
 * stdio gateway. A fixture server speaks its five tool names; no scheduler
 * runs. The declaration is user scope, as the guide recommends, so its action
 * class is `unknown` and every call asks, submissions and cancellations
 * included, at every level that asks at all.
 */

const FIXTURE = resolve("tests/fixtures/mcp-slurm-server.mjs");
const TOOLS = ["slurm_cancel", "slurm_cluster", "slurm_describe", "slurm_list", "slurm_submit"];

describe("Slurm through the clio-kit MCP server", () => {
	let env: IsolatedClioEnv;
	let root: string;
	let project: string;
	let configDir: string;
	let journal: string;
	let originalPath: string | undefined;
	const open: McpCapabilitySource[] = [];

	beforeEach(async () => {
		env = await isolateClioEnv("slurm-mcp-");
		root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-slurm-mcp-")));
		project = join(root, "project");
		configDir = join(root, "config");
		journal = join(root, "journal.txt");
		mkdirSync(project, { recursive: true });
		mkdirSync(configDir, { recursive: true });
		originalPath = process.env.PATH;
	});

	afterEach(async () => {
		for (const source of open.splice(0)) await source.close();
		process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	function declare(command: string, args: string[]): void {
		writeFileSync(
			join(configDir, "mcp.yaml"),
			[
				"version: 1",
				"servers:",
				"  - id: slurm",
				`    command: ${JSON.stringify(command)}`,
				`    args: ${JSON.stringify(args)}`,
				"",
			].join("\n"),
		);
	}

	function wire(level: AutonomyLevel, approve: boolean): { registry: ToolRegistry; parks: string[] } {
		const parks: string[] = [];
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: project }), autonomy: () => level });
		const source = createMcpCapabilitySource({
			cwd: project,
			configDir,
			registry,
			requestTimeoutMs: 5_000,
			clientFactory: (spec, options) =>
				createMcpStdioClient(spec, { ...options, initializeTimeoutMs: 5_000, killGraceMs: 200 }),
		});
		open.push(source);
		registerCoreTools(registry, { mcpCapabilities: source });
		registry.onPermissionRequired((call, decision, meta) => {
			parks.push(call.tool);
			if (approve) {
				void registry.resumeParkedCalls({
					actionClass: decision.classification.actionClass,
					requestId: meta.requestId,
					requestedBy: "contract-operator",
				});
			} else registry.cancelParkedCall(meta.requestId, "denied by the test");
		});
		return { registry, parks };
	}

	function call(registry: ToolRegistry, tool: string, args: Record<string, unknown>) {
		return registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability: `mcp_slurm__${tool}`, args } });
	}

	it("lists the five Slurm tools as gateway capabilities with the unknown action class", async () => {
		declare(process.execPath, [FIXTURE, journal]);
		const { registry } = wire("auto-edit", false);
		// Nothing has recorded this server's tools yet, and an ordinary find no
		// longer launches a server to fill that gap. The scoped refresh is the
		// call that does.
		const found = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "find", server: "slurm", refresh: true },
		});
		if (found.kind !== "ok" || found.result.kind !== "ok") throw new Error(JSON.stringify(found));
		const listing = JSON.parse(found.result.output) as { capabilities: Array<{ name: string; actionClass: string }> };
		const slurm = listing.capabilities.filter((entry) => entry.name.startsWith("mcp_slurm__"));
		deepStrictEqual(
			slurm.map((entry) => entry.name).sort(),
			TOOLS.map((tool) => `mcp_slurm__${tool}`),
		);
		deepStrictEqual([...new Set(slurm.map((entry) => entry.actionClass))], ["unknown"]);
	});

	it("asks before a submission and a cancellation at the default autonomy, and a denied one never reaches the server", async () => {
		declare(process.execPath, [FIXTURE, journal]);
		const { registry, parks } = wire("auto-edit", false);
		strictEqual((await call(registry, "slurm_submit", { script_path: "run.sh" })).kind, "blocked");
		strictEqual((await call(registry, "slurm_cancel", { job_id: "4821", confirm_job_id: "4821" })).kind, "blocked");
		deepStrictEqual(parks, ["mcp_slurm__slurm_submit", "mcp_slurm__slurm_cancel"]);
		strictEqual(existsSync(journal), false, "neither call reached the server");
	});

	it("runs the submit, describe, cancel loop once the operator approves each call, at full-auto too", async () => {
		declare(process.execPath, [FIXTURE, journal]);
		const { registry, parks } = wire("full-auto", true);
		const submitted = await call(registry, "slurm_submit", { script_path: "run.sh", partition: "debug" });
		if (submitted.kind !== "ok" || submitted.result.kind !== "ok") throw new Error(JSON.stringify(submitted));
		strictEqual((JSON.parse(submitted.result.output) as { job_id: string }).job_id, "4821");
		const described = await call(registry, "slurm_describe", { job_id: "4821" });
		if (described.kind !== "ok" || described.result.kind !== "ok") throw new Error(JSON.stringify(described));
		strictEqual((JSON.parse(described.result.output) as { terminal: boolean }).terminal, true);
		strictEqual((await call(registry, "slurm_cancel", { job_id: "4821", confirm_job_id: "4821" })).kind, "ok");
		// One server, one class: the read-only describe asks like the other two.
		deepStrictEqual(parks, ["mcp_slurm__slurm_submit", "mcp_slurm__slurm_describe", "mcp_slurm__slurm_cancel"]);
		strictEqual(readFileSync(journal, "utf8"), "submit run.sh\ncancel 4821\n");
	});

	function fakeBin(names: Record<string, string>): string {
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		for (const [name, body] of Object.entries(names)) {
			writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		}
		return bin;
	}

	it("doctor reports one informational row when nothing Slurm is set up", async () => {
		process.env.PATH = fakeBin({});
		const findings = await slurmMcpFindings({ workspaceRoot: project, configDir });
		strictEqual(findings.length, 1);
		deepStrictEqual([findings[0]?.name, findings[0]?.level, findings[0]?.ok], ["slurm mcp", "info", true]);
		match(findings[0]?.detail ?? "", /not set up/u);
	});

	it("doctor reports clio-kit, the declaration, and the scheduler clients from a fake PATH", async () => {
		const bin = fakeBin({
			"clio-kit":
				"if (process.argv[2] === 'mcp-servers') console.log('Available MCP servers:\\n  - hdf5\\n  - slurm'); else { console.error(\"Error: No such option '--version'.\"); process.exit(2); }",
			sbatch: "console.log('slurm 24.05.1')",
		});
		process.env.PATH = bin;
		declare(join(bin, "clio-kit"), ["mcp-server", "slurm"]);
		{
			const findings = await slurmMcpFindings({ workspaceRoot: project, configDir });
			deepStrictEqual(
				findings.map((finding) => [finding.name, finding.level, finding.ok]),
				[
					["slurm clio-kit", "ok", true],
					["slurm mcp server", "ok", true],
					["slurm scheduler", "ok", true],
				],
			);
			match(findings[0]?.detail ?? "", /version not reported \(no --version\); ships the slurm server/u);
			match(findings[1]?.detail ?? "", /slurm declared in .*mcp\.yaml \(user, trusted, action class unknown\)/u);
			match(findings[2]?.detail ?? "", /sbatch .*\/bin\/sbatch; squeue not on PATH/u);
			ok(findings.every((finding) => finding.ok));
		}
	});
});
