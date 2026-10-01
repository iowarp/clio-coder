import type { DispatchScopeNoticePayload } from "./bus-events.js";

/**
 * The scope notice every operator surface projects. The terminal, the headless
 * stderr and JSON stream, the ACP event stream and the GUI each read the bus
 * payload through here, so a code one of them draws is a code all of them draw.
 */
// A Record keyed by the payload union, so a new notice code fails typecheck here
// instead of being dropped by every surface at runtime.
const SCOPE_NOTICE_CODES: Record<DispatchScopeNoticePayload["code"], true> = {
	typed_scope_replaced_inferred_paths: true,
	legacy_scope_inferred: true,
	legacy_scope_empty: true,
	write_root_dot_unconfined: true,
	write_roots_checks_withheld: true,
};

export const DISPATCH_SCOPE_NOTICE_CODES = Object.keys(SCOPE_NOTICE_CODES) as ReadonlyArray<
	DispatchScopeNoticePayload["code"]
>;

export interface DispatchScopeNoticeView {
	code: DispatchScopeNoticePayload["code"];
	level: "warning";
	/** Two sentences: what the entry did, then what it does not change. */
	message: string;
}

/** The notice's display fields, or null for anything that is not a well-formed scope notice. */
export function readDispatchScopeNotice(value: unknown): DispatchScopeNoticeView | null {
	if (value === null || typeof value !== "object") return null;
	const event = value as { code?: unknown; message?: unknown };
	if (
		typeof event.message !== "string" ||
		event.message.length === 0 ||
		!(DISPATCH_SCOPE_NOTICE_CODES as ReadonlyArray<unknown>).includes(event.code)
	) {
		return null;
	}
	return { code: event.code as DispatchScopeNoticeView["code"], level: "warning", message: event.message };
}
