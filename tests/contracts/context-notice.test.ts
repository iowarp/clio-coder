import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

async function captureStderr(fn: () => Promise<void> | void): Promise<string> {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		await fn();
		return stderr;
	} finally {
		process.stderr.write = original;
	}
}

function context(): DomainContext {
	return {
		bus: createSafeEventBus(),
		getContract: () => undefined,
	};
}

describe("contracts/context startup notice", () => {
	it("suppresses the missing CLIO-CODER.md notice when context files are disabled", async () => {
		const scratchHome = newScratchClioHome("clio-context-notice-");
		const cwd = mkdtempSync(join(tmpdir(), "clio-context-project-"));
		const previousCwd = process.cwd();
		try {
			writeFileSync(join(cwd, "package.json"), "{}\n");
			process.chdir(cwd);
			const noContext = context();
			const suppressed = await captureStderr(async () => {
				const bundle = createContextBundle(noContext, { noContextFiles: true });
				await bundle.extension.start?.();
				noContext.bus.emit(BusChannels.SessionStart, { at: Date.now() });
				await bundle.extension.stop?.();
			});
			strictEqual(suppressed.includes("No CLIO-CODER.md detected"), false);

			const withContext = context();
			const visible = await captureStderr(async () => {
				const bundle = createContextBundle(withContext);
				await bundle.extension.start?.();
				withContext.bus.emit(BusChannels.SessionStart, { at: Date.now() });
				await bundle.extension.stop?.();
			});
			strictEqual(visible.includes("No CLIO-CODER.md detected"), true);
			strictEqual(visible.includes("Run /context init to explore the repo and bootstrap context."), true);
			strictEqual(visible.includes("/context-init"), false);
		} finally {
			process.chdir(previousCwd);
			rmSync(cwd, { recursive: true, force: true });
			clearScratchClioHome(scratchHome);
		}
	});
});
