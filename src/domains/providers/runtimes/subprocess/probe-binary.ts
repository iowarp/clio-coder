import type { spawn as SpawnFn } from "node:child_process";

import type { ProbeContext } from "../../types/runtime-descriptor.js";

export interface BinaryProbeOutcome {
	ok: boolean;
	version?: string;
	error?: string;
}

const SUBPROCESS_PROBE_TIMEOUT_MS = 3000;

export async function probeBinaryVersion(
	spawnFn: typeof SpawnFn,
	binary: string,
	ctx: ProbeContext,
): Promise<BinaryProbeOutcome> {
	const timeoutMs = Math.max(1, Math.min(ctx.httpTimeoutMs, SUBPROCESS_PROBE_TIMEOUT_MS));
	return new Promise<BinaryProbeOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: BinaryProbeOutcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};
		let child: ReturnType<typeof SpawnFn>;
		try {
			child = spawnFn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			finish({ ok: false, error: describe(err) });
			return;
		}
		const killTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
		}, timeoutMs);
		const onExternalAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish({ ok: false, error: "aborted by caller" });
		};
		if (ctx.signal) {
			if (ctx.signal.aborted) {
				clearTimeout(killTimer);
				try {
					child.kill("SIGKILL");
				} catch {}
				finish({ ok: false, error: "aborted by caller" });
				return;
			}
			ctx.signal.addEventListener("abort", onExternalAbort, { once: true });
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (err: Error) => {
			clearTimeout(killTimer);
			if (ctx.signal) ctx.signal.removeEventListener("abort", onExternalAbort);
			finish({ ok: false, error: describe(err) });
		});
		child.once("close", (code: number | null) => {
			clearTimeout(killTimer);
			if (ctx.signal) ctx.signal.removeEventListener("abort", onExternalAbort);
			if (code === 0) {
				const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
				const outcome: BinaryProbeOutcome = { ok: true };
				if (firstLine.length > 0) outcome.version = firstLine;
				finish(outcome);
				return;
			}
			const message = stderr.trim() || `exit ${code ?? "unknown"}`;
			finish({ ok: false, error: message });
		});
	});
}

function describe(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
