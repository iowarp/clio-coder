import type { ToolName } from "../core/tool-names.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type { EndpointDescriptor, RuntimeDescriptor, ThinkingLevel } from "../domains/providers/index.js";
import type { AgentEvent, AgentMessage } from "./types.js";

export interface SessionRuntimeStartInput {
	threadId?: string;
	resumeSessionId?: string;
	systemPrompt: string;
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	mode?: ModeName;
	thinkingLevel?: ThinkingLevel;
	allowedTools?: ReadonlyArray<ToolName>;
	signal?: AbortSignal;
}

export interface SessionRuntimeSendTurnInput {
	threadId: string;
	task: string;
	wireModelId?: string;
	mode?: ModeName;
}

export interface SessionRuntimeTurnHandle {
	threadId: string;
	turnId: string;
	done: Promise<SessionRuntimeTurnResult>;
}

export interface SessionRuntimeTurnResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface SessionRuntimeSession {
	threadId: string;
	runtimeId: string;
	model: string;
	permissionMode?: string;
	resumeSessionId?: string;
	startedAt: number;
}

export interface SessionfulRuntime {
	startSession(input: SessionRuntimeStartInput, emit: (event: AgentEvent) => void): Promise<SessionRuntimeSession>;
	sendTurn(input: SessionRuntimeSendTurnInput): Promise<SessionRuntimeTurnHandle>;
	interruptTurn(threadId: string, turnId?: string): Promise<void>;
	stopSession(threadId: string): Promise<void>;
	listSessions(): ReadonlyArray<SessionRuntimeSession>;
	readThread?(threadId: string): ReadonlyArray<AgentMessage>;
	rollbackThread?(threadId: string, turns: number): ReadonlyArray<AgentMessage>;
}
