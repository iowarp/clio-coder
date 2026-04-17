/**
 * End-to-end vision-inference diag against the Qwen3-VL endpoint on mini.
 *
 * Gated behind CLIO_DIAG_LIVE=1 so default CI stays hermetic. When the gate
 * is unset, the script prints a single SKIP line and exits 0. When the gate
 * is set, the script:
 *
 *   1. Boots a throwaway CLIO_HOME with a single llamacpp/mini endpoint
 *      pinned to the Qwen3-VL-30B-A3B-Thinking default_model.
 *   2. Generates a 64x64 RGB PNG in-process (solid red square on white
 *      background) using the zlib stdlib. No binary dep, no external file.
 *   3. Runs hermetic fixture checks for the generated PNG and multimodal
 *      prompt shape, then resolves the vision model through src/engine/ai.js,
 *      builds a Context whose single user message carries a text prompt
 *      followed by one ImageContent block, and calls stream() with
 *      maxTokens=256 and reasoning=minimal.
 *   4. Drains every event and asserts:
 *        (a) at least one text_delta OR thinking_delta fired
 *        (b) the terminal event is `done` with stopReason in {stop, length}
 *        (c) the assembled text (content + thinking) contains "red"
 *            case-insensitively
 *
 * Exits 0 on pass, 1 on any assertion failure. Lands as proof that the
 * pi-ai stream() path carries image content all the way to mini before we
 * wire vision into the interactive TUI.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const TARGET = {
	providerId: "llamacpp" as const,
	endpointName: "mini",
	url: "http://192.168.86.141:8080",
	defaultModel: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
};

const PROMPT = "What color is the square in this image? Reply with one word.";
const PNG_MIME_TYPE = "image/png";
const PNG_SIZE = 64;
const RED_SQUARE_MARGIN = 16;
const STREAM_TIMEOUT_MS = 90_000;

const failures: string[] = [];

function emit(status: "OK" | "FAIL" | "SKIP" | "INFO", label: string, detail?: string): void {
	const suffix = detail ? ` ${detail}` : "";
	const line = `[diag-vision] ${status.padEnd(4)} ${label}${suffix}\n`;
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

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function buildSettingsYaml(): string {
	const lines: string[] = [
		"runtimes:",
		"  enabled:",
		"    - llamacpp",
		"providers:",
		`  ${TARGET.providerId}:`,
		"    endpoints:",
		`      ${TARGET.endpointName}:`,
		`        url: ${yamlString(TARGET.url)}`,
		`        default_model: ${yamlString(TARGET.defaultModel)}`,
		"",
	];
	return lines.join("\n");
}

// CRC32 table (IEEE 802.3 polynomial 0xedb88320). Used for PNG chunk CRCs.
const CRC_TABLE: Uint32Array = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
	return Buffer.concat([len, typeBytes, data, crc]);
}

/**
 * Build a 64x64 PNG with a centered solid-red 32x32 square on a white
 * background. Inline generation via zlib stdlib so no external image file
 * or third-party decoder is needed.
 */
function buildRedSquarePng(): Buffer {
	const size = PNG_SIZE;
	const inner = RED_SQUARE_MARGIN; // red square spans [16,48) in both axes -> 32x32.
	const innerEnd = size - inner;

	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr.writeUInt8(8, 8); // bit depth
	ihdr.writeUInt8(2, 9); // color type: truecolor RGB
	ihdr.writeUInt8(0, 10); // compression
	ihdr.writeUInt8(0, 11); // filter
	ihdr.writeUInt8(0, 12); // interlace

	const rowStride = 1 + size * 3;
	const raw = Buffer.alloc(rowStride * size);
	for (let y = 0; y < size; y++) {
		raw[y * rowStride] = 0; // filter type None
		for (let x = 0; x < size; x++) {
			const px = y * rowStride + 1 + x * 3;
			const isRed = y >= inner && y < innerEnd && x >= inner && x < innerEnd;
			raw[px] = 0xff; // R: both red and white are maxed
			raw[px + 1] = isRed ? 0x00 : 0xff;
			raw[px + 2] = isRed ? 0x00 : 0xff;
		}
	}

	const idat = deflateSync(raw);
	return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

type VisionUserMessage = Extract<import("@mariozechner/pi-ai").Context["messages"][number], { role: "user" }>;

function buildVisionUserMessage(base64Png: string): VisionUserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: PROMPT },
			{ type: "image", data: base64Png, mimeType: PNG_MIME_TYPE },
		],
		timestamp: Date.now(),
	};
}

function validateHermeticFixtures(): void {
	const png = buildRedSquarePng();
	const base64Png = png.toString("base64");
	const message = buildVisionUserMessage(base64Png);
	const content = Array.isArray(message.content) ? message.content : [];

	check("image:b64-whitespace-free", !/\s/.test(base64Png), `length=${base64Png.length}`);
	check("image:b64-roundtrip", Buffer.from(base64Png, "base64").equals(png), `length=${base64Png.length}`);
	check(
		"prompt:text-before-image",
		content.length === 2 && content[0]?.type === "text" && content[1]?.type === "image",
		`order=${content.map((item) => item.type).join(",")}`,
	);
	check(
		"prompt:image-mime-type",
		content[1]?.type === "image" && content[1].mimeType === PNG_MIME_TYPE,
		`mimeType=${content[1]?.type === "image" ? content[1].mimeType : "missing"}`,
	);
	check(
		"stream:timeout-budget",
		STREAM_TIMEOUT_MS >= 60_000 && STREAM_TIMEOUT_MS <= 90_000,
		`timeoutMs=${STREAM_TIMEOUT_MS}`,
	);

	check("png:signature", png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
	const chunks: Array<{ type: string; data: Buffer; crc: number }> = [];
	let offset = 8;
	while (offset < png.length) {
		if (offset + 12 > png.length) {
			check("png:chunk-layout", false, `offset=${offset} length=${png.length}`);
			return;
		}
		const length = png.readUInt32BE(offset);
		offset += 4;
		const type = png.toString("ascii", offset, offset + 4);
		offset += 4;
		const dataEnd = offset + length;
		if (dataEnd + 4 > png.length) {
			check("png:chunk-layout", false, `type=${type} length=${length} fileBytes=${png.length}`);
			return;
		}
		const data = png.subarray(offset, dataEnd);
		offset = dataEnd;
		const crc = png.readUInt32BE(offset);
		offset += 4;
		chunks.push({ type, data: Buffer.from(data), crc });
		if (type === "IEND") break;
	}
	check("png:chunk-layout", offset === png.length, `offset=${offset} length=${png.length}`);
	check(
		"png:chunk-order",
		chunks[0]?.type === "IHDR" && chunks.some((chunk) => chunk.type === "IDAT") && chunks.at(-1)?.type === "IEND",
		`chunks=${chunks.map((chunk) => chunk.type).join(",")}`,
	);

	const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
	check("png:ihdr-present", ihdr !== undefined);
	if (ihdr) {
		check("png:ihdr-length", ihdr.data.length === 13, `length=${ihdr.data.length}`);
		if (ihdr.data.length === 13) {
			check("png:width", ihdr.data.readUInt32BE(0) === PNG_SIZE, `width=${ihdr.data.readUInt32BE(0)}`);
			check("png:height", ihdr.data.readUInt32BE(4) === PNG_SIZE, `height=${ihdr.data.readUInt32BE(4)}`);
		}
	}

	for (const chunk of chunks) {
		const expectedCrc = crc32(Buffer.concat([Buffer.from(chunk.type, "ascii"), chunk.data]));
		check(`png:crc:${chunk.type}`, chunk.crc === expectedCrc, `crc=${chunk.crc} expected=${expectedCrc}`);
	}

	const idatData = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
	let raw: Buffer;
	try {
		raw = inflateSync(idatData);
		check("png:idat-zlib", true);
	} catch (err) {
		check("png:idat-zlib", false, err instanceof Error ? err.message : String(err));
		return;
	}
	const rowStride = 1 + PNG_SIZE * 3;
	check("png:raw-length", raw.length === rowStride * PNG_SIZE, `rawLength=${raw.length}`);
	const badFilterRow = Array.from({ length: PNG_SIZE }, (_, y) => y).find((y) => raw[y * rowStride] !== 0);
	check("png:filter-none", badFilterRow === undefined, `row=${badFilterRow ?? "none"}`);

	const pixelAt = (x: number, y: number): readonly [number, number, number] => {
		const px = y * rowStride + 1 + x * 3;
		return [raw[px], raw[px + 1], raw[px + 2]];
	};
	check("png:background-white", pixelAt(0, 0).join(",") === "255,255,255", `rgb=${pixelAt(0, 0).join(",")}`);
	check(
		"png:center-red",
		pixelAt(PNG_SIZE / 2, PNG_SIZE / 2).join(",") === "255,0,0",
		`rgb=${pixelAt(32, 32).join(",")}`,
	);
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
	validateHermeticFixtures();
	if (failures.length > 0) return;

	if (process.env.CLIO_DIAG_LIVE !== "1") {
		emit("SKIP", "CLIO_DIAG_LIVE!=1");
		return;
	}

	const home = mkdtempSync(join(tmpdir(), "clio-diag-vision-"));
	const envSnapshot = new Map<string, string | undefined>();
	const envKeys = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR"] as const;
	for (const k of envKeys) envSnapshot.set(k, process.env[k]);
	for (const k of envKeys) if (k !== "CLIO_HOME") delete process.env[k];
	process.env.CLIO_HOME = home;
	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		for (const [k, v] of envSnapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	};
	const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
	const installSignalCleanup = (signal: NodeJS.Signals, exitCode: number): void => {
		const handler = () => {
			emit("FAIL", "signal", signal);
			cleanup();
			process.exit(exitCode);
		};
		signalHandlers.push({ signal, handler });
		process.once(signal, handler);
	};
	process.once("exit", cleanup);
	installSignalCleanup("SIGINT", 130);
	installSignalCleanup("SIGTERM", 143);

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
		try {
			check("domain:loaded", domains.loaded.includes("providers"), `loaded=${domains.loaded.join(",")}`);

			type ProvidersContractType = import("../src/domains/providers/contract.js").ProvidersContract;
			const providers = domains.getContract<ProvidersContractType>("providers");
			if (!providers) {
				check("domain:contract-exposed", false, "providers contract missing");
				return;
			}

			const liveStart = Date.now();
			await providers.probeAllLive();
			await providers.probeEndpoints();
			info("probe:elapsed-ms", String(Date.now() - liveStart));

			const png = buildRedSquarePng();
			const base64Png = png.toString("base64");
			info("image:bytes", String(png.length));
			info("image:b64-length", String(base64Png.length));

			const modelKey = `${TARGET.defaultModel}@${TARGET.endpointName}`;
			let model: import("@mariozechner/pi-ai").Model<never>;
			try {
				model = engineAi.getModel(TARGET.providerId, modelKey);
			} catch (err) {
				check("getModel", false, `err=${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			check("getModel", true);
			check(
				"model-accepts-image",
				(model as unknown as { input: readonly string[] }).input.includes("image"),
				`input=${JSON.stringify((model as unknown as { input: readonly string[] }).input)}`,
			);

			const context: import("@mariozechner/pi-ai").Context = {
				messages: [buildVisionUserMessage(base64Png)],
			};

			const streamStart = Date.now();
			let eventsSnapshot: unknown[];
			let timedOut = false;
			try {
				const events = engineAi.stream(model, context, {
					maxTokens: 256,
					reasoning: "minimal",
					apiKey: "clio-local-endpoint",
				});
				const drained = await drainStreamWithTimeout(events, STREAM_TIMEOUT_MS);
				eventsSnapshot = drained.events;
				timedOut = drained.timedOut;
			} catch (err) {
				check("stream-threw", false, `err=${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			const streamElapsed = Date.now() - streamStart;
			info("stream-elapsed-ms", String(streamElapsed));
			check("stream-not-timed-out", timedOut === false, `timeoutMs=${STREAM_TIMEOUT_MS}`);

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
			info("event-counts", `text=${counts.text} thinking=${counts.thinking} toolCall=${counts.toolCall}`);

			check(
				"has-thinking-or-text",
				counts.thinking > 0 || counts.text > 0,
				`thinking=${counts.thinking} text=${counts.text}`,
			);

			check(
				"terminal-event",
				terminalEvent !== null,
				`events=${eventsSnapshot.length} last=${String((eventsSnapshot.at(-1) as { type?: string } | undefined)?.type)}`,
			);
			if (!terminalEvent) return;
			let terminalDetail = `terminal=${terminalEvent.type} reason=${terminalEvent.reason ?? "unknown"}`;
			if (terminalEvent.type === "error") {
				const errMsg = terminalEvent.error as { errorMessage?: string; stopReason?: string; content?: unknown } | undefined;
				terminalDetail = `${terminalDetail} errorMessage=${JSON.stringify(errMsg?.errorMessage ?? null)} stopReason=${String(errMsg?.stopReason ?? "unknown")}`;
				info("terminal-error-detail", terminalDetail);
			}
			check("terminal-done", terminalEvent.type === "done", terminalDetail);
			if (terminalEvent.type !== "done") return;

			const finalMessage = terminalEvent.message as import("@mariozechner/pi-ai").AssistantMessage | undefined;
			check("final-message-present", finalMessage !== undefined, `terminal=${terminalEvent.type}`);
			if (!finalMessage) return;

			check(
				"stop-reason-allowed",
				finalMessage.stopReason === "stop" || finalMessage.stopReason === "length",
				`stopReason=${finalMessage.stopReason} errorMessage=${finalMessage.errorMessage ?? ""}`,
			);

			const textBlocks = finalMessage.content.filter(
				(c): c is import("@mariozechner/pi-ai").TextContent => c.type === "text",
			);
			const thinkingBlocks = finalMessage.content.filter(
				(c): c is import("@mariozechner/pi-ai").ThinkingContent => c.type === "thinking",
			);
			const assembledText = textBlocks
				.map((c) => c.text)
				.join("")
				.trim();
			const assembledThinking = thinkingBlocks
				.map((c) => c.thinking)
				.join("")
				.trim();
			const preview = assembledText.slice(0, 200).replace(/\s+/g, " ");
			const thinkingPreview = assembledThinking.slice(0, 200).replace(/\s+/g, " ");
			info("content-preview", preview.length > 0 ? preview : "(empty)");
			info("thinking-preview", thinkingPreview.length > 0 ? thinkingPreview : "(empty)");
			info(
				"usage",
				`input=${finalMessage.usage.input} output=${finalMessage.usage.output} total=${finalMessage.usage.totalTokens}`,
			);

			// Accept "red" in either the visible reply or the reasoning trace,
			// since Qwen3-VL-Thinking may produce its color identification in
			// the thinking channel before the final text block is emitted.
			const haystack = `${assembledText}\n${assembledThinking}`.toLowerCase();
			check(
				"response-mentions-red",
				haystack.includes("red"),
				`text=${JSON.stringify(preview)} thinking=${JSON.stringify(thinkingPreview)}`,
			);
		} finally {
			await domains.stop();
		}
	} finally {
		cleanup();
		process.off("exit", cleanup);
		for (const { signal, handler } of signalHandlers) {
			process.off(signal, handler);
		}
	}
}

async function main(): Promise<void> {
	await run();
	if (failures.length > 0) {
		process.stderr.write(`[diag-vision] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-vision] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-vision] ERROR ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
