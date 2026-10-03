/**
 * Per-message affordances: copy the prompt, copy the response, try a failed
 * turn again, and the outcome footer that closes a settled turn.
 *
 * What is offered and why is decided in `composer-model.ts`. Nothing here reads the
 * timeline; each component takes the strings it renders, so the integrator can
 * mount these from whatever turn model Track A lands without this file learning
 * about it.
 *
 * Branch is deliberately absent. There is no wire affordance for it: `routes.turn`
 * posts into one linear timeline and `SessionSnapshot` carries no branch identity,
 * so a Branch button would be a control with nothing behind it.
 */

import { formatTime } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import { CopyButton } from "../render/Markdown.js";
import { fillComposer } from "./Composer.js";
import {
	type MessageActionContext,
	messageActionOffers,
	outcomeDetailGroups,
	type TurnOutcomeView,
} from "./composer-model.js";
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

/**
 * The outcome footer, one quiet line of facts from the `Turn` row: how it ended, how long it
 * took, the calls it made, what it spent and when. The token total opens the complete reported
 * accounting; the clock's title carries the full date.
 */
export function TurnOutcome({
	outcome,
	formatClock,
}: {
	outcome: TurnOutcomeView;
	formatClock: (at: string) => string;
}) {
	return (
		<details className="turn-outcome" data-tone={outcome.tone}>
			<summary className="turn-outcome__line">
				<StatusMark tone={outcome.tone} label={outcome.label} />
				{outcome.facts.slice(0, 1).map((fact) => (
					<span className="turn-outcome__fact" key={fact}>
						{fact}
					</span>
				))}
				{outcome.usageLabel ? <span className="turn-outcome__fact">{outcome.usageLabel}</span> : null}
				{outcome.facts.slice(1).map((fact) => (
					<span className="turn-outcome__fact" key={fact}>
						{fact}
					</span>
				))}
				{outcome.finishedAt ? (
					<time dateTime={outcome.finishedAt} title={formatTime(outcome.finishedAt)}>
						{formatClock(outcome.finishedAt)}
					</time>
				) : null}
			</summary>
			{outcome.detail ? <p className="turn-outcome__detail">{outcome.detail}</p> : null}
			{outcome.stopReason ? <code className="turn-outcome__code">{outcome.stopReason}</code> : null}
			{outcome.breakdown.length > 0 ? (
				<div className="turn-details">
					{outcomeDetailGroups(outcome).map((group) => (
						<section key={group.label} className="turn-details__group">
							<h3>{group.label}</h3>
							<dl>
								{group.fields.map((field) => (
									<div key={field.label}>
										<dt>{field.label}</dt>
										<dd>{field.value}</dd>
									</div>
								))}
							</dl>
						</section>
					))}
				</div>
			) : null}
		</details>
	);
}
