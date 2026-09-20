import type { Tool } from "../../contracts/toolchain.js";
import type { WorkerHost } from "../worker/host.js";
import type { RawTool } from "../worker/protocol.js";
import type { EventHub } from "./event-hub.js";
import { fingerprint, type OperationRegistry } from "./operations.js";
import { AppProblem } from "./problem.js";

/** The HTTP projection deliberately exposes installDir and binaryPath to the local operator. */
export function projectTool(raw: RawTool): Tool {
	return {
		id: raw.id,
		version: raw.version,
		summary: raw.summary,
		license: raw.license,
		platform: raw.platform,
		supported: raw.supported,
		installed: raw.installed,
		installDir: raw.installDir,
		resolution: {
			source: raw.resolution.source,
			binaryPath: raw.resolution.binaryPath,
			version: raw.resolution.version,
			description: raw.resolution.description,
			vendoredPath: raw.resolution.vendoredPath,
			pathCandidate: raw.resolution.pathCandidate
				? {
						path: raw.resolution.pathCandidate.path,
						version: raw.resolution.pathCandidate.version,
						satisfiesMinimum: raw.resolution.pathCandidate.satisfiesMinimum,
					}
				: null,
		},
	};
}
export class ToolchainService {
	constructor(
		private reads: WorkerHost,
		private ops: WorkerHost,
		private operations: OperationRegistry,
		private hub: EventHub,
	) {}
	async list() {
		const result = await this.reads.call("tools.list", {});
		return { tools: result.rows.map(projectTool), threadId: result.threadId };
	}
	async mutate(action: "install" | "remove", id: string, body: { force?: boolean }, key: string) {
		if (!(await this.list()).tools.some((tool) => tool.id === id))
			throw new AppProblem("not_found", "Unknown pinned tool.");
		return this.operations.create({
			kind: `toolchain.${action}`,
			scope: "installation",
			key,
			fingerprint: fingerprint({ path: `/api/toolchain/tools/${id}/${action}`, params: { toolId: id }, body }),
			run: async (progress) => {
				try {
					return action === "install"
						? await this.ops.call("tools.install", { id, force: body.force ?? false }, { progress })
						: await this.ops.call("tools.remove", { id });
				} finally {
					this.hub.publish({ type: "toolchain.changed", payload: { id } });
				}
			},
		});
	}
}
