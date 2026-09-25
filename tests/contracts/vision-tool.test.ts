import { match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { VisionSidecar } from "../../src/domains/providers/vision-sidecar.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { createRegistry } from "../../src/tools/registry.js";
import { createVisionTool } from "../../src/tools/vision.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("lets the main agent ask an explicit image question through the configured sidecar", async () => {
	const env = await isolateClioEnv("vision-tool-");
	try {
		const path = join(env.dir, "pixel.png");
		writeFileSync(
			path,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		let seen = 0;
		const sidecar: VisionSidecar = {
			configured: () => true,
			label: () => "MiniCPM-V-4.6",
			analyze: async (images, question) => {
				seen += 1;
				strictEqual(question, "What is shown?");
				strictEqual(images.length, 1);
				strictEqual(images[0]?.mimeType, "image/png");
				return {
					target: "mini-vision",
					model: "MiniCPM-V-4.6",
					images: [{ index: 1, description: "One pixel" }],
					answer: "A pixel",
				};
			},
		};
		const tool = createVisionTool(sidecar);
		const result = await tool.run({ path, question: "What is shown?" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			match(result.output, /MiniCPM-V-4\.6/u);
			match(result.output, /A pixel/u);
		}
		strictEqual(seen, 1);
		const latest = createVisionTool(sidecar, {
			getRecentImages: () => [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		});
		const fromHistory = await latest.run({ question: "What is shown?" });
		strictEqual(fromHistory.kind, "ok");
		strictEqual(seen, 2);
		const denied = await tool.run({ path, question: "What is shown?" }, { allowsObservationPath: () => false });
		strictEqual(denied.kind, "error");
		ok(denied.kind === "error" && /not allowed/u.test(denied.message));
		strictEqual(seen, 2);
	} finally {
		env.restore();
	}
});

it("advertises the explicit image question behind gateway only when a sidecar is bound", async () => {
	const env = await isolateClioEnv("vision-gateway-");
	try {
		const makeRegistry = () => createRegistry({ safety: createWorkerSafety({ cwd: env.dir }), autonomy: () => "yolo" });
		const unbound = makeRegistry();
		registerCoreTools(unbound);
		strictEqual(unbound.get(ToolNames.Vision), undefined);
		const bound = makeRegistry();
		const sidecar: VisionSidecar = {
			configured: () => true,
			label: () => "MiniCPM-V-4.6",
			analyze: async () => ({
				target: "mini-vision",
				model: "MiniCPM-V-4.6",
				images: [{ index: 1, description: "pixel" }],
				answer: "pixel",
			}),
		};
		registerCoreTools(bound, { visionSidecar: sidecar });
		ok(bound.get(ToolNames.Vision));
		match(String(bound.get(ToolNames.Gateway)?.metadata?.promptHint), /vision \(ask the configured image model/u);
		const found = await bound.invoke({ tool: ToolNames.Gateway, args: { op: "find", query: "vision" } });
		strictEqual(found.kind, "ok");
		if (found.kind === "ok" && found.result.kind === "ok") match(found.result.output, /"name":"vision"/u);
	} finally {
		env.restore();
	}
});
