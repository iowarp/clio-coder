import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { resetXdgCache } from "../../src/core/xdg.js";
import { runDoctorModelChecks } from "../../src/domains/lifecycle/doctor.js";
import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";

const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 2_000 };

const SPLIT_ARGS = ["llama-server", "--parallel", "4", "--ctx-size", "786432", "--jinja"];
const UNIFIED_ARGS = ["llama-server", "--parallel", "4", "--ctx-size", "131072", "--kv-unified", "--jinja"];

describe("llama.cpp router probe", () => {
	let server: Server;
	let url = "";
	let state = "unloaded";
	let args: string[] = SPLIT_ARGS;
	let workerPropsHits = 0;

	before(async () => {
		server = createServer((request, response) => {
			const path = request.url ?? "/";
			const json = (body: unknown, status = 200) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			};
			if (path === "/health") return json({ status: "ok" });
			if (path === "/v1/models") {
				return json({
					object: "list",
					data: [{ id: "ornith", object: "model", status: { value: state, args } }],
				});
			}
			if (path === "/props") return json({ build_info: "router-b1", max_instances: 1 });
			if (path.startsWith("/props?model=")) {
				workerPropsHits += 1;
				return json({ total_slots: 4, default_generation_settings: { n_ctx: 196_608 }, build_info: "worker-b1" });
			}
			return json({ error: "not found" }, 404);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	after(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it("reads an unloaded model's slots from the router list instead of loading it for /props", async () => {
		// Asking /props?model=<id> makes the router load the model; with
		// --models-max 1 that evicts the resident chat model and the next turn
		// prefills from zero. The list already carries --parallel.
		state = "unloaded";
		args = SPLIT_ARGS;
		workerPropsHits = 0;
		const target = { id: "mini", runtime: "llamacpp", url, defaultModel: "ornith" };
		const result = await llamacppRuntime.probe?.(target, ctx);
		strictEqual(result?.ok, true);
		strictEqual(result?.ok === true ? result.discoveredCapabilities?.parallelSlots : undefined, 4);
		strictEqual(workerPropsHits, 0, "an unloaded model must not be loaded to answer a probe");

		state = "loaded";
		const loaded = await llamacppRuntime.probe?.(target, ctx);
		strictEqual(loaded?.ok, true);
		strictEqual(loaded?.ok === true ? loaded.discoveredCapabilities?.parallelSlots : undefined, 4);
		strictEqual(workerPropsHits, 1, "a resident model's worker props are still read");
	});

	it("flags idle-slot eviction only on a unified multi-slot server that keeps it on", async () => {
		// The preset renders `cache-idle-slots = false` as --no-cache-idle-slots
		// and `cache-ram = 0` as --cache-ram 0; a repeated boolean resolves to the
		// last spelling given, as llama.cpp itself does.
		state = "unloaded";
		const target = { id: "mini", runtime: "llamacpp", url, defaultModel: "ornith" };
		const cases: Array<{ argv: string[]; flagged: boolean }> = [
			{ argv: UNIFIED_ARGS, flagged: true },
			{ argv: [...UNIFIED_ARGS, "--no-cache-idle-slots"], flagged: false },
			{ argv: [...UNIFIED_ARGS, "--cache-ram", "0"], flagged: false },
			{ argv: [...UNIFIED_ARGS, "--cache-ram", "-1"], flagged: true },
			{ argv: [...UNIFIED_ARGS, "--no-cache-idle-slots", "--cache-idle-slots"], flagged: true },
			{ argv: ["llama-server", "--parallel", "1", "--kv-unified"], flagged: false },
			{ argv: ["llama-server", "--parallel", "4", "--no-kv-unified"], flagged: false },
			{ argv: ["llama-server", "--kv-unified"], flagged: false },
		];
		for (const { argv, flagged } of cases) {
			args = argv;
			const result = await llamacppRuntime.probe?.(target, ctx);
			strictEqual(result?.ok, true, argv.join(" "));
			const advisories = result?.ok === true ? result.cacheAdvisories : undefined;
			if (!flagged) {
				strictEqual(advisories, undefined, argv.join(" "));
				continue;
			}
			strictEqual(advisories?.length, 1, argv.join(" "));
			const advisory = advisories?.[0] ?? "";
			match(advisory, /^ornith clears idle slots from its unified KV cache/);
			match(advisory, /--parallel 4/);
			match(advisory, /--no-cache-idle-slots \(preset: cache-idle-slots = false\)$/);
			ok(result?.notes?.includes(advisory), "targets --probe renders the advisory with the other notes");
		}
	});

	it("reports the advisory as a doctor warning next to the model check", async () => {
		state = "loaded";
		const home = mkdtempSync(join(tmpdir(), "clio-coder-llamacpp-doctor-"));
		const previousHome = process.env.CLIO_CODER_HOME;
		try {
			for (const role of ["config", "data", "state", "cache"]) mkdirSync(join(home, role), { mode: 0o700 });
			writeFileSync(
				join(home, "config", "settings.yaml"),
				[
					"version: 2",
					"targets:",
					"  - id: mini",
					"    runtime: llamacpp",
					`    url: ${url}`,
					"    defaultModel: ornith",
					"chat:",
					"  target: mini",
					"  model: ornith",
					"  prewarm: false",
					"",
				].join("\n"),
				{ mode: 0o600 },
			);
			process.env.CLIO_CODER_HOME = home;
			resetXdgCache();

			args = UNIFIED_ARGS;
			const flagged = await runDoctorModelChecks();
			deepStrictEqual(
				flagged.map((finding) => [finding.name, finding.ok, finding.level ?? "ok"]),
				[
					["model mini", true, "ok"],
					["cache mini", true, "warn"],
				],
			);
			match(flagged[1]?.detail ?? "", /start it with --no-cache-idle-slots/);

			args = [...UNIFIED_ARGS, "--no-cache-idle-slots"];
			const fixed = await runDoctorModelChecks();
			deepStrictEqual(
				fixed.map((finding) => finding.name),
				["model mini"],
			);
		} finally {
			if (previousHome === undefined) delete process.env.CLIO_CODER_HOME;
			else process.env.CLIO_CODER_HOME = previousHome;
			resetXdgCache();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
