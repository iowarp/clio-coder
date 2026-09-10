/** Operator runtime API v1. Import these types only; Clio injects the API. */
export type ExtensionEvent = "session_open" | "turn_end";
export type ExtensionTone = "neutral" | "positive" | "warning" | "error";
export interface ExtensionStatus {
	text: string;
	tone?: ExtensionTone;
}
export type ExtensionPanelSection =
	| { kind: "text"; text: string }
	| { kind: "metrics"; items: Array<{ label: string; value: string }> }
	| { kind: "table"; columns: string[]; rows: string[][] };
export interface ExtensionPanel {
	title: string;
	sections: ExtensionPanelSection[];
}
/** Text is always the headless fallback; panel and status require declarations. */
export interface ExtensionOutput {
	text: string;
	status?: ExtensionStatus | null;
	panel?: ExtensionPanel;
}
export interface ExtensionRuntimeSnapshot {
	workspace: string;
	sessionId: string | null;
	generation: number;
	mode: "interactive" | "headless";
}
export interface ExtensionCommandContext {
	readonly snapshot: Readonly<ExtensionRuntimeSnapshot>;
	readonly requestId: string;
	readonly signal: AbortSignal;
}
export interface ExtensionObservation {
	event: ExtensionEvent;
	/** No conversation bodies, tool arguments, credentials, or mutable host objects. */
	reason: "startup" | "reload" | "session-change" | "completed";
}
export interface ExtensionApi {
	readonly apiVersion: 1;
	handle(
		name: string,
		handler: (args: string, context: ExtensionCommandContext) => ExtensionOutput | Promise<ExtensionOutput>,
	): void;
	on(
		event: ExtensionEvent,
		handler: (
			event: ExtensionObservation,
			context: ExtensionCommandContext,
		) => ExtensionOutput | undefined | Promise<ExtensionOutput | undefined>,
	): void;
	onDispose(handler: (reason: string) => void | Promise<void>): void;
}
export type ExtensionFactory = (api: ExtensionApi) => void | Promise<void>;
