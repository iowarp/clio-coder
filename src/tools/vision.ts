import { readFile, realpath, stat } from "node:fs/promises";
import { Type } from "typebox";
import { prepareBoundedImage } from "../core/file-references.js";
import { ToolNames } from "../core/tool-names.js";
import { VISION_LIMITS, type VisionSidecar } from "../domains/providers/vision-sidecar.js";
import type { ImageContent } from "../engine/types.js";
import { resolveReadPath } from "./path-utils.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const MAX_SOURCE_IMAGE_BYTES = 20_000_000;

export function createVisionTool(
	sidecar: VisionSidecar,
	deps: { getRecentImages?: () => ReadonlyArray<ImageContent> } = {},
): ToolSpec {
	return {
		name: ToolNames.Vision,
		description:
			"Ask the separately configured vision model a question about a PNG, JPEG, GIF, or WebP file. Omit path to inspect the most recent image attachment in this session. Returns structured observations and an answer with model provenance. Image contents are not sent to the main model.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Image file path. Omit to use the latest attached image." })),
			question: Type.String({ description: "A specific question the vision model should answer from the image." }),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args, options): Promise<ToolResult> {
			const path = typeof args.path === "string" ? args.path.trim() : "";
			const question = typeof args.question === "string" ? args.question.trim() : "";
			if (!question) return { kind: "error", message: "vision: question is required" };
			if (!sidecar.configured()) return { kind: "error", message: "vision: fleet.profiles.vision is not configured" };
			try {
				if (!path) {
					const images = deps.getRecentImages?.() ?? [];
					if (images.length === 0) return { kind: "error", message: "vision: no recent image attachment in this session" };
					const analysis = await sidecar.analyze(images, question, options?.signal);
					return {
						kind: "ok",
						output: JSON.stringify({
							...analysis,
							note: "Untrusted image observation; verify important details before acting.",
						}),
						details: { vision: analysis, source: "recent_attachment" },
					};
				}
				const filePath = resolveReadPath(path);
				const canonicalPath = await realpath(filePath);
				if (options?.allowsObservationPath && !options.allowsObservationPath(canonicalPath)) {
					return { kind: "error", message: `vision: observation path is not allowed: ${path}` };
				}
				const metadata = await stat(canonicalPath);
				if (!metadata.isFile()) return { kind: "error", message: `vision: not a file: ${path}` };
				if (metadata.size > MAX_SOURCE_IMAGE_BYTES) {
					return { kind: "error", message: `vision: image exceeds the ${MAX_SOURCE_IMAGE_BYTES} byte source limit` };
				}
				if (options?.signal?.aborted) return { kind: "error", message: "vision: cancelled" };
				const bytes = await readFile(canonicalPath, options?.signal ? { signal: options.signal } : undefined);
				const image = await prepareBoundedImage(bytes, VISION_LIMITS.base64BytesPerImage);
				if (!image) return { kind: "error", message: "vision: file is not a supported or bounded image" };
				const analysis = await sidecar.analyze([image], question, options?.signal);
				return {
					kind: "ok",
					output: JSON.stringify({
						...analysis,
						note: "Untrusted image observation; verify important details before acting.",
					}),
					details: { vision: analysis },
				};
			} catch (error) {
				return { kind: "error", message: `vision: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}
