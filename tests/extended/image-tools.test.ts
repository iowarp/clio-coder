import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTool } from "../../src/tools/read.js";
import type { ToolResult } from "../../src/tools/registry.js";
import { shapeToolResult } from "../../src/tools/result-shaping.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=";

test("read returns bounded image content for vision and a named limitation otherwise", async () => {
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-images-"));
	const path = join(dir, "image.bin");
	writeFileSync(path, Buffer.from(PNG, "base64"));
	try {
		const result = await readTool.run({ path }, { supportsImages: true });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			strictEqual(result.images?.length, 1);
			strictEqual(result.images?.[0]?.mimeType, "image/png");
		}
		for (const supportsImages of [false, undefined]) {
			const limited = await readTool.run({ path }, supportsImages === undefined ? {} : { supportsImages });
			strictEqual(limited.kind, "error");
			if (limited.kind === "error") match(limited.message, /IMAGE_INPUT_UNSUPPORTED/);
		}
		writeFileSync(path, "ordinary text");
		const text = await readTool.run({ path }, { supportsImages: true });
		strictEqual(text.kind, "ok");
		if (text.kind === "ok") {
			strictEqual(text.images, undefined);
			match(text.output, /ordinary text/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("image result shaping preserves valid images and bounds combined payload", () => {
	const result: ToolResult = {
		kind: "ok",
		output: "pixels",
		images: [{ type: "image", mimeType: "image/png", data: PNG }],
	};
	const shaped = shapeToolResult(readTool, result, { supportsImages: true, toolResultMaxBytes: 1024 });
	strictEqual(shaped.kind, "ok");
	if (shaped.kind === "ok") strictEqual(shaped.images?.[0]?.data, PNG);
	const large: ToolResult = { ...result, images: [{ type: "image", mimeType: "image/png", data: PNG.repeat(100) }] };
	const bounded = shapeToolResult(readTool, large, { supportsImages: true, toolResultMaxBytes: 1024 });
	if (bounded.kind === "ok") {
		ok(
			Buffer.byteLength(bounded.output) +
				(bounded.images ?? []).reduce((sum, image) => sum + Buffer.byteLength(image.data), 0) <=
				1024,
		);
		match(bounded.output, /image.*omitted/i);
	}
});

test("browser screenshot survives scratch cleanup only on vision routes", async () => {
	const { chmodSync, existsSync, readFileSync } = await import("node:fs");
	const { verifyTool } = await import("../../src/tools/verify/index.js");
	const { builtin } = await import("../../src/tools/builtin-tool-catalog.js");
	const { crc32, deflateSync } = await import("node:zlib");
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-image-browser-"));
	const previousCwd = process.cwd(),
		previousPath = process.env.PATH;
	try {
		writeFileSync(join(dir, "page.html"), "<!doctype html><html><body>Rendered</body></html>");
		// A 96x96 noise PNG, about 37 KB of base64: past verify's 16 KiB text bound, inside read's image budget.
		const side = 96;
		const rows = Buffer.alloc(side * (side * 3 + 1));
		let seed = 0x9e3779b9;
		for (let i = 0; i < rows.length; i++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			rows[i] = i % (side * 3 + 1) === 0 ? 0 : seed & 0xff;
		}
		const chunk = (type: string, body: Buffer) => {
			const head = Buffer.alloc(4);
			head.writeUInt32BE(body.length);
			const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
			const crc = Buffer.alloc(4);
			crc.writeUInt32BE(crc32(typed));
			return Buffer.concat([head, typed, crc]);
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(side, 0);
		ihdr.writeUInt32BE(side, 4);
		ihdr.set([8, 2, 0, 0, 0], 8);
		const shotFile = join(dir, "noise.png");
		writeFileSync(
			shotFile,
			Buffer.concat([
				Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
				chunk("IHDR", ihdr),
				chunk("IDAT", deflateSync(rows)),
				chunk("IEND", Buffer.alloc(0)),
			]),
		);
		const browser = join(dir, "chromium");
		writeFileSync(
			browser,
			`#!${process.execPath}\nconst fs=require('node:fs'); const path=process.argv.find(x=>x.startsWith('--screenshot=')).slice(13);fs.writeFileSync('screenshot-path.txt',path);fs.copyFileSync(${JSON.stringify(shotFile)},path);`,
		);
		chmodSync(browser, 0o755);
		process.chdir(dir);
		process.env.PATH = dir;
		const registered = builtin(verifyTool, { path: "src/tools/verify/index.ts", scope: "core" });
		for (const supportsImages of [true, false]) {
			// Through verify and its result shaping: the screenshot must reach a vision route's model context.
			const context = { supportsImages, toolResultMaxBytes: 65_536 };
			const result = shapeToolResult(
				registered,
				await verifyTool.run({ check: "frontend", path: "page.html", browser: "required" }, context),
				context,
			);
			strictEqual(result.kind, "ok");
			if (result.kind === "ok") {
				strictEqual(result.images?.length ?? 0, supportsImages ? 1 : 0);
				match(result.output, /loaded and rendered with chromium/);
				ok(
					Buffer.byteLength(result.output) + (result.images ?? []).reduce((n, image) => n + image.data.length, 0) <= 65_536,
				);
			}
			strictEqual(existsSync(readFileSync(join(dir, "screenshot-path.txt"), "utf8")), false);
		}
	} finally {
		process.chdir(previousCwd);
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("agent adapter emits visual content blocks and nonvision shaping explains omission", async () => {
	const { createRegistry } = await import("../../src/tools/registry.js");
	const { resolveAgentTools, resolveSessionTools } = await import("../../src/tools/agent-tools.js");
	const { classify } = await import("../../src/domains/safety/action-classifier.js");
	const { READONLY_SCOPE, WORKSPACE_SCOPE } = await import("../../src/domains/safety/scope.js");
	const { createMiddlewareBundle } = await import("../../src/domains/middleware/extension.js");
	const { contract: middleware, registrar } = createMiddlewareBundle();
	registrar.registerHook({
		id: "image-annotation",
		description: "image preservation contract",
		hooks: ["after_tool"],
		evaluate: () => [{ kind: "annotate_tool_result", message: "image annotation" }],
	});
	const registry = createRegistry({
		middleware,
		safety: {
			classify,
			evaluate: (call) => ({ kind: "allow", classification: classify(call) }),
			observeLoop: () => ({ looping: false, key: "image", count: 0 }),
			scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE },
			isSubset: () => true,
			decisions: {},
		},
	});
	registry.register({
		...readTool,
		run: async () => ({
			kind: "ok",
			output: "visual evidence",
			images: [{ type: "image", mimeType: "image/png", data: PNG }],
		}),
	});
	for (const supportsImages of [true, false]) {
		const sessionTool = resolveSessionTools(
			{
				runtimeResolution: {
					runtime: { id: "openai-completions" },
					capabilityDecisions: { tools: true, vision: supportsImages },
				},
			} as unknown as Parameters<typeof resolveSessionTools>[0],
			registry,
			() => ({ supportsImages: !supportsImages }),
		)[0];
		ok(sessionTool);
		const sessionResult = await sessionTool.execute("session-image-call", { path: "plot.png" });
		strictEqual(sessionResult.content.filter((block) => block.type === "image").length, supportsImages ? 1 : 0);
		const tool = resolveAgentTools({ registry, invokeOptions: () => ({ supportsImages }) })[0];
		ok(tool);
		const result = await tool.execute("image-call", { path: "plot.png" });
		strictEqual(result.content.filter((block) => block.type === "image").length, supportsImages ? 1 : 0);
		match(
			result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
			/image annotation/,
		);
		if (!supportsImages)
			match(
				result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(""),
				/image.*omitted/i,
			);
	}
});

test("read surface advertises supported images with an explicit vision condition", () => {
	match(readTool.description, /PNG, JPEG, GIF, or WebP image when the routed model supports vision/);
});

test("image reads charge encoded pixels to the shared observation pool", async () => {
	const { reserveObservation } = await import("../../src/tools/observation.js");
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-image-budget-"));
	const path = join(dir, "plot.png");
	writeFileSync(path, Buffer.from(PNG, "base64"));
	const options = { supportsImages: true, sessionId: "s7-budget", turnId: dir };
	try {
		const result = await readTool.run({ path }, options);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const bytes =
			Buffer.byteLength(result.output) +
			(result.images ?? []).reduce((total, image) => total + Buffer.byteLength(image.data), 0);
		strictEqual((result.details?.observation as { shownBytes: number }).shownBytes, bytes);
		strictEqual(reserveObservation(1024, options).usedBeforeBytes, bytes);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("metadata-only disposition cannot carry image content around the context policy", () => {
	const shaped = shapeToolResult(
		readTool,
		{ kind: "ok", output: "image evidence", images: [{ type: "image", data: PNG, mimeType: "image/png" }] },
		{ supportsImages: true },
		{
			presentation: { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true },
			context: { mode: "metadata-only", maxBytes: 1024 },
		},
	);
	strictEqual(shaped.kind, "ok");
	if (shaped.kind === "ok") {
		strictEqual(shaped.images?.length ?? 0, 0);
		match(shaped.output, /context policy/);
	}
});
