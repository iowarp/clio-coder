/**
 * The structured account of a refused tool call: which layer refused it,
 * the action class Clio enforces for it, and the configuration outside the
 * model's reach that would allow it. No refusal is retryable as the identical
 * call. The orchestrator registry refuses an identical repeat later in the
 * same turn without running or asking again, except after an attended
 * operator's refusal, a worker's or a call outside a turn, so the account
 * says that only when the registry remembered the refusal.
 *
 * A live trace showed why each field exists. A model denied by an MCP
 * server's own policy repeated the identical call until the loop guard
 * stopped it, called an excluded read a write, and read one-call approvals in
 * Clio as if they could override the server.
 */

/**
 * Who refused. `clio_policy` is Clio's own enforcement (safety net, task
 * scope, read-only ceiling); `operator_approval` is an ask nobody approved,
 * either an operator's refusal or a headless run that has no operator;
 * `mcp_server_policy` is the MCP server refusing on its own authority, which
 * no Clio trust record or approval reaches.
 */
export type DenialLayer = "clio_policy" | "operator_approval" | "mcp_server_policy";

export interface ToolDenial {
	layer: DenialLayer;
	/** Clio's action class for the call, the one its own policy enforces. */
	actionClass: string;
	/** Refusals are never retryable as the identical call. */
	retryable: false;
	/** The configuration, outside the model's reach, that would allow the call. */
	allowedBy: string;
	/** The refusing layer's own code: a reason code, a rule id, or the server's error code. */
	code?: string;
	/** The MCP server that refused, for `mcp_server_policy`. */
	server?: string;
	/** The MCP server's own read-only or destructive annotation, when it gave one. */
	serverHint?: "read-only" | "destructive";
	/** Set when the registry refuses an identical call later in this turn without running it. */
	repeatRefused?: true;
}

const LAYER_LABEL: Readonly<Record<DenialLayer, string>> = {
	clio_policy: "Clio policy",
	operator_approval: "operator approval",
	mcp_server_policy: "MCP server policy",
};

/**
 * The model-facing account, kept first after the reason so the rejection's
 * line budget never elides it. The remedy is its own line: the per-line cap
 * would otherwise cut what would allow the call off a long refusal.
 */
export function denialLines(denial: ToolDenial): [refusal: string, remedy: string] {
	const source =
		denial.layer === "mcp_server_policy" && denial.server !== undefined
			? `server ${denial.server}${denial.code !== undefined ? `, ${denial.code}` : ""}`
			: denial.code;
	const hint = denial.serverHint !== undefined ? `, which the server marks ${denial.serverHint}` : "";
	const repeat =
		denial.repeatRefused === true
			? "an identical call later in this turn is refused without running"
			: denial.layer === "operator_approval"
				? "an identical call asks the operator again"
				: "an identical call meets the same refusal";
	return [
		`Refused by ${LAYER_LABEL[denial.layer]}${source !== undefined ? ` (${source})` : ""}; Clio classifies this call as ${denial.actionClass}${hint}. Not retryable: ${repeat}.`,
		`To allow it: ${denial.allowedBy}`,
	];
}

/** The line an identical repeat of a refused call reads, ahead of the original account. */
export function repeatedDenialReason(tool: string, denial: ToolDenial): string {
	return `${tool} refused again: an identical call was already refused by ${LAYER_LABEL[denial.layer]} in this turn, and nothing that decides it has changed.`;
}

const SERVER_POLICY_CODE = /DENIED|FORBIDDEN|NOT_ALLOWED|NOT_PERMITTED|PERMISSION|POLICY|UNAUTHORI[SZ]ED/i;

/**
 * Bounds on the server's own text. Its message leads the model-facing
 * account, so an unbounded one pushed the "To allow it" remedy past the
 * rejection's line budget; its code and profile land inside one line each.
 */
const SERVER_MESSAGE_MAX_LINES = 4;
const SERVER_MESSAGE_MAX_CHARS = 600;
const SERVER_LABEL_MAX_CHARS = 80;

function boundServerText(text: string, maxLines: number, maxChars: number): string {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	let bounded = lines.slice(0, maxLines).join("\n");
	if (bounded.length > maxChars) bounded = bounded.slice(0, maxChars);
	return bounded.length < lines.join("\n").length ? `${bounded}…` : bounded;
}

/**
 * A server's own policy refusal, recognized from the structured error the
 * tool returned rather than from its prose: `retryable: false` together with
 * an error code that names a denial (`POLICY_DENIED`, `FORBIDDEN`). Any other
 * tool error, a non-retryable argument error included, stays an ordinary error.
 */
export function mcpServerPolicyRefusal(
	structured: unknown,
): { code: string; message: string; profile?: string } | null {
	if (typeof structured !== "object" || structured === null || Array.isArray(structured)) return null;
	const record = structured as Record<string, unknown>;
	if (record.retryable !== false) return null;
	const code = [record.error_code, record.errorCode, record.code].find(
		(value): value is string => typeof value === "string" && SERVER_POLICY_CODE.test(value),
	);
	if (code === undefined) return null;
	const message = [record.error, record.message].find((value): value is string => typeof value === "string") ?? code;
	return {
		code: boundServerText(code, 1, SERVER_LABEL_MAX_CHARS),
		message: boundServerText(message, SERVER_MESSAGE_MAX_LINES, SERVER_MESSAGE_MAX_CHARS) || code,
		...(typeof record.profile === "string"
			? { profile: boundServerText(record.profile, 1, SERVER_LABEL_MAX_CHARS) }
			: {}),
	};
}
