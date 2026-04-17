/**
 * End-to-end real-inference diag against the homelab Qwen endpoints.
 *
 * Gated behind CLIO_DIAG_LIVE=1 so default CI stays hermetic. When the gate
 * is unset, the script prints a single SKIP line and exits 0. When the gate
 * is set, the script:
 *
 *   1. Boots a throwaway CLIO_HOME with two local-engine endpoints seeded:
 *        providers.llamacpp.endpoints.mini  → http://192.168.86.141:8080
 *        providers.lmstudio.endpoints.dynamo → http://192.168.86.143:1234
 *   2. Loads the config + providers domains and runs probeAllLive()
 *      followed by probeEndpoints() to harvest the discovered model list.
 *   3. For each endpoint's default_model, resolves a pi-ai Model through
 *      src/engine/ai.js, builds a Context with a deterministic user prompt,
 *      calls stream(), drains every event, and asserts:
 *        (a) at least one text_delta OR thinking_delta fired
 *        (b) final AssistantMessage.usage.totalTokens > 0
 *        (c) stopReason is "stop" or "length" (not "error" / "aborted")
 *
 * Exits 0 on full pass, 1 on any assertion failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TargetSpec = {
	readonly providerId: "llamacpp" | "lmstudio";
	readonly endpointName: string;
	readonly url: string;
	readonly defaultModel: string;
	readonly apiKeyEnv?: string;
};

const TARGETS: ReadonlyArray<TargetSpec> = [
	{
		providerId: "llamacpp",
		endpointName: "mini",
		url: "http://192.168.86.141:8080",
		defaultModel: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
	},
	{
		providerId: "lmstudio",
		endpointName: "dynamo",
		url: "http://192.168.86.143:1234",
		defaultModel: "qwen3.6-35b-a3b",
		apiKeyEnv: "LMSTUDIO_API_KEY",
	},
];

const PROMPT = "Reply with the single word PONG, nothing else.";
const PER_REQUEST_TIMEOUT_MS = 60_000;

const failures: string[] = [];

function emit(status: "OK" | "FAIL" | "SKIP" | "INFO", label: string, detail?: string): void {
	const suffix = detail ? ` ${detail}` : "";
	const line = `[diag-real-inference] ${status.padEnd(4)} ${label}${suffix}\n`;
	if (status === "FAIL") process.stderr.write(line);
	else process.stdout.write(line);
}

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		emit("OK", label);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	emit("FAIL", label, detail ? `(${detail})` : undefined);
}

function info(label: string, detail: string): void {
	emit("INFO", label, detail);
}

function buildSettingsYaml(): string {
	const lines: string[] = ["runtimes:", "  enabled:", "    - llamacpp", "    - lmstudio", "providers:"];
	for (const t of TARGETS) {
		lines.push(`  ${t.providerId}:`);
		lines.push("    endpoints:");
		lines.push(`      ${t.endpointName}:`);
		lines.push(`        url: ${t.url}`);
		lines.push(`        default_model: ${t.defaultModel}`);
	}
	lines.push("");
	return lines.join("\n");
}

async function drainStreamWithTimeout(
	iterable: AsyncIterable<unknown>,
	timeoutMs: number,
): Promise<{
	events: unknown[];
	timedOut: boolean;
}> {
	const events: unknown[] = [];
	const iterator = iterable[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			try {
				await iterator.return?.();
			} catch {
				// best effort
			}
			return { events, timedOut: true };
		}
		const nextPromise = iterator.next();
		const timeoutPromise = new Promise<{ done: true; value: undefined; __timeout: true }>((resolve) => {
			setTimeout(() => resolve({ done: true, value: undefined, __timeout: true }), remaining).unref();
		});
		const result = (await Promise.race([nextPromise, timeoutPromise])) as
			| IteratorResult<unknown>
			| { done: true; value: undefined; __timeout: true };
		if ("__timeout" in result) {
			try {
				await iterator.return?.();
			} catch {
				// best effort
			}
			return { events, timedOut: true };
		}
		if (result.done) return { events, timedOut: false };
		events.push(result.value);
	}
}

async function run(): Promise<void> {
	if (process.env.CLIO_DIAG_LIVE !== "1") {
		emit("SKIP", "CLIO_DIAG_LIVE!=1");
		return;
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-real-inference-"));
	const envSnapshot = new Map<string, string | undefined>();
	const envKeys = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	for (const k of envKeys) envSnapshot.set(k, process.env[k]);
	for (const k of envKeys) if (k !== "CLIO_HOME") delete process.env[k];
	process.env.CLIO_HOME = home;

	try {
		writeFileSync(join(home, "settings.yaml"), buildSettingsYaml());

		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();

		const { resetSharedBus } = await import("../src/core/shared-bus.js");
		resetSharedBus();

		const { resetPackageRootCache } = await import("../src/core/package-root.js");
		resetPackageRootCache();

		const { loadDomains } = await import("../src/core/domain-loader.js");
		const { ConfigDomainModule } = await import("../src/domains/config/index.js");
		const { ProvidersDomainModule } = await import("../src/domains/providers/index.js");
		const engineAi = await import("../src/engine/ai.js");

		const domains = await loadDomains([ConfigDomainModule, ProvidersDomainModule]);
		check("domain:loaded", domains.loaded.includes("providers"), `loaded=${domains.loaded.join(",")}`);

		type ProvidersContractType = import("../src/domains/providers/contract.js").ProvidersContract;
		const providers = domains.getContract<ProvidersContractType>("providers");
		if (!providers) {
			check("domain:contract-exposed", false, "providers contract missing");
			await domains.stop();
			return;
		}

		const liveStart = Date.now();
		await providers.probeAllLive();
		await providers.probeEndpoints();
		info("probe:elapsed-ms", String(Date.now() - liveStart));

		const listing = providers.list();

		for (const target of TARGETS) {
			const label = `${target.providerId}/${target.endpointName}`;
			const entry = listing.find((e) => e.id === target.providerId);
			check(`${label}:provider-listed`, entry !== undefined);
			if (!entry) continue;
			check(
				`${label}:provider-healthy`,
				entry.health.status === "healthy" || entry.health.status === "degraded",
				`status=${entry.health.status} error=${entry.health.lastError ?? "null"}`,
			);

			const endpointEntry = entry.endpoints?.find((ep) => ep.name === target.endpointName);
			check(`${label}:endpoint-listed`, endpointEntry !== undefined);
			if (!endpointEntry) continue;
			const probe = endpointEntry.probe;
			check(`${label}:endpoint-probe-ok`, probe?.ok === true, `probe=${JSON.stringify(probe ?? null)}`);
			const discoveredModels = probe?.models ?? [];
			check(
				`${label}:endpoint-discovered-models-nonempty`,
				discoveredModels.length > 0,
				`count=${discoveredModels.length}`,
			);
			info(`${label}:discovered-count`, String(discoveredModels.length));
			if (probe?.latencyMs !== undefined) info(`${label}:probe-latency-ms`, String(probe.latencyMs));

			const modelKey = `${target.defaultModel}@${target.endpointName}`;
			let registered: import("@mariozechner/pi-ai").Model<never>;
			try {
				registered = engineAi.getModel(target.providerId, modelKey);
			} catch (err) {
				check(`${label}:getModel`, false, `err=${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			// The local registry uses `${modelId}@${endpointName}` as the unique
			// key so multiple endpoints under the same provider don't collide.
			// The server-visible model name is the bare modelId; override id
			// before dispatching the chat-completions request.
			const model = { ...registered, id: target.defaultModel } as typeof registered;
			check(
				`${label}:getModel`,
				true,
				`key=${registered.id} serverId=${model.id} api=${model.api} reasoning=${model.reasoning}`,
			);

			const context = {
				messages: [
					{
						role: "user" as const,
						content: PROMPT,
						timestamp: Date.now(),
					},
				],
			};

			// Local llama-server / LM Studio endpoints ignore the bearer token but
			// pi-ai's openai-completions provider refuses to construct a client with
			// an empty key. A placeholder string satisfies the SDK while keeping
			// the request unauthenticated from the server's perspective.
			const envKey = target.apiKeyEnv ? process.env[target.apiKeyEnv] : undefined;
			const apiKey = envKey && envKey.length > 0 ? envKey : "clio-local-endpoint";
			const options: Record<string, unknown> = {
				maxTokens: 512,
				reasoning: "minimal" as const,
				apiKey,
			};

			const streamStart = Date.now();
			let eventsSnapshot: unknown[];
			let timedOut = false;
			try {
				const events = engineAi.stream(model, context, options);
				const drained = await drainStreamWithTimeout(events, PER_REQUEST_TIMEOUT_MS);
				eventsSnapshot = drained.events;
				timedOut = drained.timedOut;
			} catch (err) {
				check(`${label}:stream-threw`, false, `err=${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			const streamElapsed = Date.now() - streamStart;
			info(`${label}:stream-elapsed-ms`, String(streamElapsed));
			check(`${label}:stream-not-timed-out`, timedOut === false, `timeoutMs=${PER_REQUEST_TIMEOUT_MS}`);

			const counts = { text: 0, thinking: 0, toolCall: 0 };
			let terminalEvent: { type: string; reason?: string; message?: unknown; error?: unknown } | null = null;
			for (const raw of eventsSnapshot) {
				const evt = raw as { type: string } & Record<string, unknown>;
				switch (evt.type) {
					case "text_delta":
						counts.text += 1;
						break;
					case "thinking_delta":
						counts.thinking += 1;
						break;
					case "toolcall_delta":
						counts.toolCall += 1;
						break;
					case "done":
					case "error":
						terminalEvent = evt as typeof terminalEvent;
						break;
				}
			}
			info(`${label}:event-counts`, `text=${counts.text} thinking=${counts.thinking} toolCall=${counts.toolCall}`);

			check(
				`${label}:terminal-event`,
				terminalEvent !== null,
				`events=${eventsSnapshot.length} last=${String((eventsSnapshot.at(-1) as { type?: string } | undefined)?.type)}`,
			);
			if (!terminalEvent) continue;

			const finalMessage = (terminalEvent.type === "done" ? terminalEvent.message : terminalEvent.error) as
				| import("@mariozechner/pi-ai").AssistantMessage
				| undefined;
			check(`${label}:final-message-present`, finalMessage !== undefined, `terminal=${terminalEvent.type}`);
			if (!finalMessage) continue;

			check(
				`${label}:stop-reason-not-error`,
				finalMessage.stopReason === "stop" || finalMessage.stopReason === "length",
				`stopReason=${finalMessage.stopReason} errorMessage=${finalMessage.errorMessage ?? ""}`,
			);

			check(
				`${label}:has-thinking-or-text`,
				counts.thinking > 0 || counts.text > 0,
				`thinking=${counts.thinking} text=${counts.text}`,
			);

			check(
				`${label}:usage-totalTokens-nonzero`,
				typeof finalMessage.usage?.totalTokens === "number" && finalMessage.usage.totalTokens > 0,
				`usage=${JSON.stringify(finalMessage.usage)}`,
			);

			const textBlocks = finalMessage.content.filter(
				(c): c is import("@mariozechner/pi-ai").TextContent => c.type === "text",
			);
			const preview = textBlocks
				.map((c) => c.text)
				.join("")
				.slice(0, 200)
				.replace(/\s+/g, " ")
				.trim();
			info(`${label}:content-preview`, preview.length > 0 ? preview : "(empty)");
			info(
				`${label}:usage`,
				`input=${finalMessage.usage.input} output=${finalMessage.usage.output} total=${finalMessage.usage.totalTokens}`,
			);
			info(`${label}:stop-reason`, finalMessage.stopReason);
		}

		await domains.stop();
	} finally {
		for (const [k, v] of envSnapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-real-inference] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-real-inference] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-real-inference] ERROR ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
