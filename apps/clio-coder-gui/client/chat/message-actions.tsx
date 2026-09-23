/**
 * Per-message affordances: copy the prompt, copy the response, try a failed
 * turn again, and the outcome footer that closes a settled turn.
 *
 * What is offered and why is decided in `composer.ts`. Nothing here reads the
 * timeline; each component takes the strings it renders, so the integrator can
 * mount these from whatever turn model Track A lands without this file learning
 * about it.
 *
 * Branch is deliberately absent. There is no wire affordance for it: `routes.turn`
 * posts into one linear timeline and `SessionSnapshot` carries no branch identity,
 * so a Branch button would be a control with nothing behind it.
 */

import type { Usage } from "../../contracts/sessions.js";
import { StatusMark } from "../design/status.js";
import { CopyButton } from "../render/Markdown.js";
import { fillComposer } from "./Composer.js";
import { type MessageActionContext, messageActionOffers, type TurnOutcomeView } from "./composer.js";
import "./composer.css";

export interface MessageActionsProps extends MessageActionContext {
	readonly sessionId: string;
	/** Which affordances this row carries. The request row and the response row differ. */
	readonly row: "request" | "response";
}

/**
 * The action row. It is quiet until the turn is hovered or something in it takes
 * focus, which `composer.css` handles; it is never hidden from the keyboard.
 */
export function MessageActions({ sessionId, row, requestText, responseText, status }: MessageActionsProps) {
	const offers = messageActionOffers({ requestText, responseText, status });
	const offered = (id: string) => offers.find((offer) => offer.id === id);
	const copyRequest = offered("copy-request");
	const copyResponse = offered("copy-response");
	const retry = offered("retry");
	return (
		<span className="message-actions">
			{row === "request" && copyRequest?.available ? (
				<CopyButton text={requestText ?? ""} label={copyRequest.label} />
			) : null}
			{row === "response" && copyResponse?.available ? (
				<CopyButton text={responseText} label={copyResponse.label} />
			) : null}
			{row === "response" && retry?.available ? (
				<button
					className="message-actions__button"
					type="button"
					onClick={() => fillComposer(sessionId, requestText ?? "")}
					title="Put this prompt back in the composer. It is not sent until you send it."
				>
					{retry.label}
				</button>
			) : null}
		</span>
	);
}

type UsageCounter = "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning";

const USAGE_ROWS: readonly { key: UsageCounter; label: string }[] = [
	{ key: "input", label: "Input" },
	{ key: "output", label: "Output" },
	{ key: "cacheRead", label: "Cache read" },
	{ key: "cacheWrite", label: "Cache write" },
	{ key: "reasoning", label: "Reasoning" },
];

function UsageBreakdown({ summary, title, usage }: { summary: string; title: string | null; usage: Usage }) {
	return (
		<details className="turn-usage">
			<summary className="turn-outcome__fact" title={title ?? undefined}>
				{summary}
			</summary>
			<dl className="turn-usage__details">
				{USAGE_ROWS.map((row) => (
					<div key={row.key}>
						<dt>{row.label}</dt>
						<dd>{usage[row.key].toLocaleString("en-US")}</dd>
					</div>
				))}
			</dl>
		</details>
	);
}

/**
 * The outcome footer. Every value is a reported fact from the `Turn` row: the
 * tool count this turn made and what it spent. Two usage numbers stay visible;
 * the complete reported accounting is available from their native disclosure.
 */
export function TurnOutcome({
	outcome,
	formatClock,
}: {
	outcome: TurnOutcomeView;
	formatClock: (at: string) => string;
}) {
	return (
		<footer className="turn-outcome" data-tone={outcome.tone}>
			<StatusMark tone={outcome.tone} label={outcome.label} />
			{outcome.detail ? <span className="turn-outcome__detail">{outcome.detail}</span> : null}
			{outcome.stopReason ? <code className="turn-outcome__code">{outcome.stopReason}</code> : null}
			{outcome.facts.map((fact) =>
				fact.startsWith("tokens") && outcome.usage !== null ? (
					<UsageBreakdown key={fact} summary={fact} title={outcome.usageTitle} usage={outcome.usage} />
				) : (
					<span className="turn-outcome__fact" key={fact}>
						{fact}
					</span>
				),
			)}
			{outcome.finishedAt ? <time dateTime={outcome.finishedAt}>{formatClock(outcome.finishedAt)}</time> : null}
		</footer>
	);
}
