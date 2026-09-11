import { Type } from "typebox";
import { Value } from "typebox/value";
import { Id } from "../../contracts/common.js";
import { ACP_EVENT_KINDS, Usage } from "../../contracts/sessions.js";
import { type AcpJsonRpcTransport, AcpProtocolError, AcpTimeoutError } from "../clio/http-shims.js";
import { AppProblem } from "../services/problem.js";

const Initialize = Type.Object({ protocolVersion: Type.Literal(1) });
const NewSession = Type.Object({ sessionId: Id });
const PromptResult = Type.Object({
	stopReason: Type.Union([
		Type.Literal("end_turn"),
		Type.Literal("cancelled"),
		Type.Literal("max_tokens"),
		Type.Literal("max_turn_requests"),
		Type.Literal("refusal"),
	]),
	_meta: Type.Object({ "clio-coder/usage": Usage }),
});
export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function acpProblem(error: unknown) {
	if (error instanceof AppProblem) return error;
	if (error instanceof AcpProtocolError) {
		const detail = record(record(record(error.data).data)._meta)["clio-coder/error"];
		const code = record(detail).code;
		return new AppProblem(
			"upstream_acp",
			`Clio ACP refused the request (${typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : "protocol_error"}).`,
		);
	}
	if (error instanceof AcpTimeoutError)
		return new AppProblem("unavailable", "Clio ACP did not respond before its deadline.");
	return new AppProblem("upstream_acp", "Clio ACP process is unavailable.");
}
export class AcpClient {
	constructor(readonly transport: AcpJsonRpcTransport) {}
	async request<T>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
		try {
			return await this.transport.request<T>(method, params, timeoutMs);
		} catch (error) {
			throw acpProblem(error);
		}
	}
	async initialize() {
		const result = await this.request<unknown>("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "clio-coder-web", version: "0.0.0" },
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
				_meta: { "clio-coder/events": { version: 1, kinds: [...ACP_EVENT_KINDS] } },
			},
		});
		if (!Value.Check(Initialize, result))
			throw new AppProblem("upstream_acp", "Clio ACP returned an invalid initialize response.");
	}
	async open(cwd: string, sessionId?: string) {
		const result = await this.request<unknown>(sessionId ? "session/load" : "session/new", {
			cwd,
			mcpServers: [],
			...(sessionId ? { sessionId } : {}),
		});
		if (sessionId) return sessionId;
		if (!Value.Check(NewSession, result))
			throw new AppProblem("upstream_acp", "Clio ACP returned an invalid session identity.");
		return result.sessionId;
	}
	async prompt(sessionId: string, text: string) {
		const result = await this.request<unknown>(
			"session/prompt",
			{ sessionId, prompt: [{ type: "text", text }] },
			24 * 60 * 60 * 1000,
		);
		const projected = Value.Clean(PromptResult, result);
		if (!Value.Check(PromptResult, projected))
			throw new AppProblem("upstream_acp", "Clio ACP returned invalid turn usage or stop reason.");
		return { stopReason: projected.stopReason, usage: projected._meta["clio-coder/usage"] };
	}
	async close(sessionId: string) {
		try {
			if (!this.transport.closed) await this.request("session/close", { sessionId }, 2000);
		} finally {
			this.transport.close();
			if (!(await this.transport.waitForExit(500))) await this.transport.forceTerminate();
		}
	}
}
