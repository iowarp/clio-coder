import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// `CLIO_CODER_BUS_TRACE=1` is the only subscriber of `domain.loaded`,
// `domain.failed` and the drained, terminated and persisted shutdown channels,
// so it is what keeps them. Nothing else proves the tracer writes its lines or
// that shutdown publishes its phases in order. The child runs the real domain
// loader and the real termination coordinator, which ends in `process.exit`.

const moduleUrl = (file: string): string => JSON.stringify(pathToFileURL(resolve(file)).href);

async function runTracedChild(trace: boolean): Promise<{ code: number | null; lines: string[]; stderr: string }> {
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-bus-trace-"));
	try {
		const script = join(dir, "traced.mjs");
		writeFileSync(
			script,
			`
			import { installBusTracer } from ${moduleUrl("src/core/bus-trace.ts")};
			import { loadDomains } from ${moduleUrl("src/core/domain-loader.ts")};
			import { getTerminationCoordinator } from ${moduleUrl("src/core/termination.ts")};
			installBusTracer();
			const quiet = { diagnostic() {} };
			const domain = (name, start) => ({
				manifest: { name, dependsOn: [] },
				createExtension: () => ({ contract: {}, extension: { start } }),
			});
			await loadDomains([domain("traced", () => {})], quiet);
			await loadDomains([domain("broken", () => { throw new Error("refused"); })], quiet).catch(() => {});
			await getTerminationCoordinator().shutdown(0);
			`,
		);
		const env = { ...process.env };
		if (trace) env.CLIO_CODER_BUS_TRACE = "1";
		else delete env.CLIO_CODER_BUS_TRACE;
		const child = spawn(process.execPath, ["--import", "tsx", script], {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		try {
			const [code] = (await once(child, "close")) as [number | null];
			const lines = stderr.split("\n").filter((line) => line.startsWith("[clio-coder:bus]"));
			return { code, lines, stderr };
		} finally {
			clearTimeout(timer);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the bus tracer writes domain and shutdown lines in publication order", async () => {
	const { code, lines, stderr } = await runTracedChild(true);
	strictEqual(code, 0, stderr);
	deepStrictEqual(lines, [
		"[clio-coder:bus] domain.loaded traced",
		"[clio-coder:bus] domain.failed broken",
		"[clio-coder:bus] shutdown.requested",
		"[clio-coder:bus] shutdown.drained",
		"[clio-coder:bus] shutdown.terminated",
		"[clio-coder:bus] shutdown.persisted",
		"[clio-coder:bus] session.end",
	]);
});

test("the bus tracer stays silent unless CLIO_CODER_BUS_TRACE is 1", async () => {
	const { code, lines, stderr } = await runTracedChild(false);
	strictEqual(code, 0, stderr);
	deepStrictEqual(lines, []);
});
