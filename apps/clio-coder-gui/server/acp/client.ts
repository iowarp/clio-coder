import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { ArtifactsCapability } from "../../contracts/artifacts.js";
import { AsideCapability } from "../../contracts/aside.js";
import type { TurnFile, TurnImage } from "../../contracts/attachments.js";
import { BoardCapability } from "../../contracts/board.js";
import { BranchesCapability } from "../../contracts/branches.js";
import {
	type AgentCapabilities,
	CommandsCapability,
	DecisionCapability,
	EMPTY_CAPABILITIES,
	EventsCapability,
	QueueCapability,
	ShellCapability,
	SteeringCapability,
	ToolProgressCapability,
} from "../../contracts/capabilities.js";
import { Id } from "../../contracts/common.js";
import { ContextCapability } from "../../contracts/context-ledger.js";
import { ExtensionsCapability, LibraryCapability } from "../../contracts/extensions.js";
import { FleetCapability } from "../../contracts/fleet-run.js";
import { HandoffCapability } from "../../contracts/handoff.js";
import { INTERVIEW_CANCEL_METHOD, INTERVIEW_REQUEST_METHOD, InterviewCapability } from "../../contracts/interviews.js";
import { PERMISSION_WITHDRAW_METHOD } from "../../contracts/permissions.js";
import type { SessionConfig } from "../../contracts/session-config.js";
import type { SessionTelemetry } from "../../contracts/session-telemetry.js";
import { ACP_EVENT_KINDS, Usage } from "../../contracts/sessions.js";
import { UsageCapability } from "../../contracts/usage.js";
import { type AcpJsonRpcTransport, AcpProtocolError, AcpTimeoutError } from "../clio/http-shims.js";
import { AppProblem } from "../services/problem.js";
import { projectConfigOptions } from "./session-config.js";
import { sessionResultTelemetry } from "./telemetry.js";

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
function stableCapability(value: unknown): boolean {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readCapabilities(result: unknown): AgentCapabilities {
	const capabilities = record(record(result).agentCapabilities);
	const meta = record(capabilities._meta);
	const stableSession = record(capabilities.sessionCapabilities);
	const extensionSession = record(meta["clio-coder/session"]);
	return {
		loadSession: capabilities.loadSession === true,
		mediatedTools: meta["clio-coder/tools"] === "mediated",
		...(record(capabilities.promptCapabilities).image === true ? { images: true } : {}),
		...(record(capabilities.promptCapabilities).embeddedContext === true ? { embeddedContext: true } : {}),
		...(Object.keys(stableSession).length > 0 || Object.keys(extensionSession).length > 0
			? {
					session: {
						close: stableCapability(stableSession.close),
						list: stableCapability(stableSession.list),
						delete: stableCapability(stableSession.delete),
						label: extensionSession.label === true,
						autonomy: false,
					},
				}
			: {}),
		...maybe("settings", optional(Settings, meta["clio-coder/settings"])),
		...maybe("targets", optional(Targets, meta["clio-coder/targets"])),
		...maybe("steering", optional(SteeringCapability, meta["clio-coder/steering"])),
		...maybe("queue", optional(QueueCapability, meta["clio-coder/queue"])),
		...maybe("shell", optional(ShellCapability, meta["clio-coder/shell"])),
		...maybe("commands", optional(CommandsCapability, meta["clio-coder/commands"])),
		...maybe("toolProgress", optional(ToolProgressCapability, meta["clio-coder/toolProgress"])),
		...maybe("decision", optional(DecisionCapability, meta["clio-coder/decision"])),
		...maybe("events", optional(EventsCapability, meta["clio-coder/events"])),
		...maybe("board", optional(BoardCapability, meta["clio-coder/board"])),
		...maybe("branches", optional(BranchesCapability, meta["clio-coder/branches"])),
		...maybe("handoff", optional(HandoffCapability, meta["clio-coder/handoff"])),
		...maybe("fleet", optional(FleetCapability, meta["clio-coder/fleet"])),
		...maybe("context", optional(ContextCapability, meta["clio-coder/context"])),
		...maybe("artifacts", optional(ArtifactsCapability, meta["clio-coder/artifacts"])),
		...maybe("extensions", optional(ExtensionsCapability, meta["clio-coder/extensions"])),
		...maybe("aside", optional(AsideCapability, meta["clio-coder/aside"])),
		...maybe("interviews", optional(InterviewCapability, meta["clio-coder/interviews"])),
		...maybe("usage", optional(UsageCapability, meta["clio-coder/accounting"])),
		...maybe("library", optional(LibraryCapability, meta["clio-coder/library"])),
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
		if (code === "prompt_active" || code === "shell_active")
			return new AppProblem(
				"conflict",
				code === "shell_active"
					? "A shell line is running in this task. Wait for it or stop it."
					: "A shell line runs between turns. Wait for this turn or stop it.",
			);
		if (code === "shell_failed")
			return new AppProblem("upstream_acp", "Clio could not run or record that shell line. (shell_failed)");
		if (code === "unknown_command")
			return new AppProblem(
				"upstream_acp",
				"That /name is not a command or a loaded prompt template in this session, so nothing was sent to the model. Start the line with \\/ to send it as text.",
			);
		if (code === "command_unavailable")
			return new AppProblem(
				"upstream_acp",
				"That command does not run from a message in this app. Use the command list, or start the line with \\/ to send it as text.",
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
	config: SessionConfig | undefined;
	private readonly modes = new Map<string, { level: "default" | "yolo"; source: "settings" | "session" }>();
	constructor(readonly transport: AcpJsonRpcTransport) {}
	/** Requests awaiting the agent's answer. A child with one in flight is not idle. */
	pending = 0;
	async request<T>(method: string, params: unknown, timeoutMs = 15000): Promise<T> {
		this.pending++;
		try {
			return await this.transport.request<T>(method, params, timeoutMs);
		} catch (error) {
			throw acpProblem(error);
		} finally {
			this.pending--;
		}
	}
	/** The agent restores a session without replaying it, which a resume uses when the transcript is already held. */
	private resumable = false;
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
					// Opting in turns on `_clio-coder/session/queue_changed`, so the queue is pushed and not polled.
					"clio-coder/queue": { version: 1 },
					"clio-coder/interviews": { version: 1, request: INTERVIEW_REQUEST_METHOD, cancel: INTERVIEW_CANCEL_METHOD },
					// A dispatched worker's escalation reaches the approval card as a permission request,
					// and a withdrawn one retires the card, because the wire cannot cancel a single ask.
					"clio-coder/workerPermissions": { version: 1, withdraw: PERMISSION_WITHDRAW_METHOD },
				},
			},
		});
		if (!Value.Check(Initialize, result))
			throw new AppProblem("upstream_acp", "Clio ACP returned an invalid initialize response.");
		this.capabilities = readCapabilities(result);
		this.resumable = stableCapability(record(record(record(result).agentCapabilities).sessionCapabilities).resume);
	}
	telemetry: SessionTelemetry = {};
	async open(cwd: string, sessionId?: string, replay = true) {
		const load = replay || !this.resumable ? "session/load" : "session/resume";
		const result = await this.request<unknown>(sessionId ? load : "session/new", {
			cwd,
			mcpServers: [],
			...(sessionId ? { sessionId } : {}),
		});
		this.telemetry = sessionResultTelemetry(result);
		const mode = record(record(result).modes).currentModeId;
		const options = projectConfigOptions(record(result).configOptions);
		const target = record(record(record(result)._meta)["clio-coder/session"]).target;
		if (options !== undefined)
			this.config = {
				options,
				...(target === null || (typeof target === "string" && target.length <= 128) ? { target } : {}),
			};
		if (sessionId) {
			if (mode === "default" || mode === "yolo") this.rememberMode(sessionId, mode);
			return sessionId;
		}
		if (!Value.Check(NewSession, result))
			throw new AppProblem("upstream_acp", "Clio ACP returned an invalid session identity.");
		if (mode === "default" || mode === "yolo") this.rememberMode(result.sessionId, mode);
		return result.sessionId;
	}
	/**
	 * The process now hosts `nextId` in place of `previousId`, after a fork or a
	 * handoff. The new session reports its mode like a load does; a choice made
	 * for the old conversation carries over, as the agent keeps it too.
	 */
	adopt(previousId: string, nextId: string, result: unknown) {
		const previous = this.modes.get(previousId);
		this.modes.delete(previousId);
		this.telemetry = sessionResultTelemetry(result);
		const mode = record(record(result).modes).currentModeId;
		if (mode === "default" || mode === "yolo")
			this.modes.set(nextId, { level: mode, source: previous?.source ?? "settings" });
		else if (previous) this.modes.set(nextId, previous);
	}
	private rememberMode(sessionId: string, level: "default" | "yolo") {
		this.modes.set(sessionId, { level, source: "settings" });
		this.capabilities.session = {
			close: false,
			list: false,
			delete: false,
			label: false,
			...this.capabilities.session,
			autonomy: true,
		};
	}
	async autonomy(sessionId: string, level?: "default" | "yolo") {
		if (level !== undefined) {
			await this.request("session/set_mode", { sessionId, modeId: level });
			this.modes.set(sessionId, { level, source: "session" });
		}
		const current = this.modes.get(sessionId);
		if (!current) throw new AppProblem("upstream_acp", "Clio did not provide a session mode.");
		return current;
	}
	async prompt(
		sessionId: string,
		text: string,
		images: ReadonlyArray<TurnImage> = [],
		files: ReadonlyArray<TurnFile> = [],
	) {
		const result = await this.request<unknown>(
			"session/prompt",
			{
				sessionId,
				prompt: [
					{ type: "text", text },
					...images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data })),
					// A picked file has a name and no path; the URI says so rather than inventing one.
					...files.map((file) => ({
						type: "resource",
						resource: { uri: `attachment:${encodeURIComponent(file.name)}`, mimeType: "text/plain", text: file.text },
					})),
				],
			},
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
