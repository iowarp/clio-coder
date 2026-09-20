import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type AgentCapabilities,
	CommandsCapability,
	DecisionCapability,
	EMPTY_CAPABILITIES,
	EventsCapability,
	SessionCapability,
	SteeringCapability,
	ToolProgressCapability,
} from "../../contracts/capabilities.js";
import { Id } from "../../contracts/common.js";
import { ACP_EVENT_KINDS, Usage } from "../../contracts/sessions.js";
import { type AcpJsonRpcTransport, AcpProtocolError, AcpTimeoutError } from "../clio/http-shims.js";
import { AppProblem } from "../services/problem.js";

const Initialize = Type.Object({ protocolVersion: Type.Literal(1) });
/**
 * Capabilities are read leniently on purpose. The protocol version is the one
 * hard gate; everything under `agentCapabilities._meta` is an extension this
 * app may or may not find, and a key it cannot parse means that feature is off,
 * never that the session is unusable. `Value.Clean` drops what the schema does
 * not name, so a newer engine's extra fields cost nothing here.
 */
function optional<S extends TSchema>(schema: S, value: unknown): Static<S> | undefined {
	if (value === undefined) return undefined;
	const projected = Value.Clean(schema, structuredClone(value));
	return Value.Check(schema, projected) ? (projected as Static<S>) : undefined;
}
function readCapabilities(result: unknown): AgentCapabilities {
	const capabilities = record(record(result).agentCapabilities);
	const meta = record(capabilities._meta);
	return {
		loadSession: capabilities.loadSession === true,
		mediatedTools: meta["clio-coder/tools"] === "mediated",
		...maybe("session", optional(SessionCapability, meta["clio-coder/session"])),
		...maybe("settings", optional(Settings, meta["clio-coder/settings"])),
		...maybe("targets", optional(Targets, meta["clio-coder/targets"])),
		...maybe("steering", optional(SteeringCapability, meta["clio-coder/steering"])),
		...maybe("commands", optional(CommandsCapability, meta["clio-coder/commands"])),
		...maybe("toolProgress", optional(ToolProgressCapability, meta["clio-coder/toolProgress"])),
		...maybe("decision", optional(DecisionCapability, meta["clio-coder/decision"])),
		...maybe("events", optional(EventsCapability, meta["clio-coder/events"])),
	};
}
const closed = { additionalProperties: false };
const Settings = Type.Object({ get_safe: Type.Boolean(), patch_safe: Type.Boolean() }, closed);
const Targets = Type.Object({ list: Type.Boolean(), probe: Type.Boolean() }, closed);
function maybe<K extends string, V>(key: K, value: V | undefined) {
	return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
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
		if (code === "prompt_not_admitted" && record(detail).reason === "authentication-required")
			return new AppProblem(
				"upstream_acp",
				"Clio cannot access credentials for the selected target. Connect it with clio-coder auth login <target> in a terminal, then close and reopen this session. Background apps use Clio's saved credentials; terminal-only API keys are unavailable after login or restart.",
			);
		if (code === "turn_failed")
			return new AppProblem(
				"upstream_acp",
				"Clio could not complete this turn. Probe the selected target and check this session's trace for the cause, then retry. (turn_failed)",
			);
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
	/** What the agent announced at initialize. Empty until {@link initialize} returns. */
	capabilities: AgentCapabilities = EMPTY_CAPABILITIES;
	async initialize() {
		const result = await this.request<unknown>("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "clio-coder-gui", version: "0.0.0" },
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
				_meta: {
					"clio-coder/events": { version: 1, kinds: [...ACP_EVENT_KINDS] },
					// Opting in turns on non-terminal `tool_call_update` frames whose
					// content is the tool's CUMULATIVE output. The projection replaces
					// the running row's partial text rather than appending, which is
					// the whole reason the stream is an opt-in.
					"clio-coder/toolProgress": { version: 1 },
				},
			},
		});
		if (!Value.Check(Initialize, result))
			throw new AppProblem("upstream_acp", "Clio ACP returned an invalid initialize response.");
		this.capabilities = readCapabilities(result);
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
