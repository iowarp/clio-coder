/**
 * Tool cards. Every decision lives in `tool-presentation.ts` and `diff.ts`;
 * this file is the markup and nothing else.
 *
 * Three properties are load-bearing and easy to lose in a refactor:
 *
 * 1. The card is the default and the JSON is the escape hatch, not the other
 *    way round. Every card keeps a closed `raw input and result` disclosure,
 *    because an operator debugging a tool needs the bytes.
 * 2. The live output pane is ONE element whose identity never changes across
 *    the running/settled boundary. `partialOutput` and the final result render
 *    into the same `<pre>` so the card does not flash or reflow when the
 *    terminal frame lands.
 * 3. Status meaning never rides on colour. Every state is a StatusMark, which
 *    carries a glyph and a word.
 */

import { memo } from "react";
import type { TimelineItem } from "../../contracts/sessions.js";
import { StatusMark } from "../design/status.js";
import { DiffView } from "./Diff.js";
import {
	formatLocation,
	type MatchGroup,
	type OutputPane,
	type PresentOptions,
	presentTool,
	type ToolFact,
	type ToolLocation,
	type ToolPresentation,
} from "./tool-presentation.js";
import "./tool-cards.css";

function FactStrip({ facts }: { facts: readonly ToolFact[] }) {
	if (facts.length === 0) return null;
	return (
		<ul className="tool-card__facts">
			{facts.map((fact) => (
				<li className="tool-card__fact" key={`${fact.label}:${fact.value}`}>
					{fact.tone === undefined ? (
						<>
							<span className="tool-card__fact-label">{fact.label}</span>
							<span className="tool-card__fact-value">{fact.value}</span>
						</>
					) : (
						<StatusMark tone={fact.tone} label={fact.label} detail={fact.value} />
					)}
				</li>
			))}
		</ul>
	);
}

function Locations({ locations }: { locations: readonly ToolLocation[] }) {
	if (locations.length === 0) return null;
	const shown = locations.slice(0, 3);
	const rest = locations.length - shown.length;
	return (
		<p className="tool-card__locations">
			{shown.map((location) => (
				<code className="tool-card__location" key={formatLocation(location)}>
					{formatLocation(location)}
				</code>
			))}
			{rest > 0 ? <span className="tool-card__more">+{rest} more</span> : null}
		</p>
	);
}

/**
 * The output pane. It renders unconditionally for a terminal-shaped card so the
 * DOM node exists from the first frame, which is what keeps the
 * partialOutput-to-result handover from reflowing the card.
 */
function OutputBlock({ pane }: { pane: OutputPane }) {
	return (
		<div className="tool-card__output" data-source={pane.source} data-running={pane.running ? "yes" : "no"}>
			<div className="tool-card__output-head">
				<StatusMark
					tone={pane.running ? "running" : "neutral"}
					label={pane.source === "partial" ? "Output so far" : "Output"}
				/>
				{pane.truncated ? <span className="tool-card__output-cap">cut at the byte cap</span> : null}
			</div>
			<pre className="tool-card__pre" aria-live={pane.running ? "polite" : "off"}>
				{pane.source === "none" ? (pane.placeholder ?? "") : pane.text}
			</pre>
		</div>
	);
}

function Matches({ groups, dropped }: { groups: readonly MatchGroup[]; dropped: number }) {
	if (groups.length === 0) return <p className="tool-card__empty">No matches.</p>;
	return (
		<div className="tool-card__matches">
			{groups.map((group) => (
				<details className="tool-card__match-file" key={group.path} open={groups.length === 1}>
					<summary>
						<code>{group.path}</code>
						<span className="tool-card__more">
							{group.total} {group.total === 1 ? "row" : "rows"}
						</span>
					</summary>
					{group.rows.map((row) => (
						<div className="tool-card__match" key={row.id}>
							<span className="tool-card__match-line" aria-hidden="true">
								{row.line ?? ""}
							</span>
							<code className="tool-card__match-text">{row.text}</code>
						</div>
					))}
				</details>
			))}
			{dropped > 0 ? <p className="tool-card__empty">{dropped} further rows are not drawn.</p> : null}
		</div>
	);
}

function RawDisclosure({ item }: { item: TimelineItem }) {
	return (
		<details className="tool-card__raw">
			<summary>Raw input and result</summary>
			<pre className="tool-card__pre">{JSON.stringify({ input: item.rawInput, output: item.rawOutput }, null, 2)}</pre>
		</details>
	);
}

/**
 * A `terminal` card keeps ONE output node for the life of the call, which is
 * what stops the partialOutput-to-result handover from flashing. The other
 * bodies swap a live pane for a structured body when they settle, which is a
 * deliberate trade: a grep or a read settles in well under a frame, and a
 * structured result is worth more there than node identity.
 */
function Body({ card }: { card: ToolPresentation }) {
	switch (card.body) {
		case "diff":
			return card.diff === null ? null : <DiffView panel={card.diff} />;
		case "terminal":
			return <OutputBlock pane={card.output} />;
		case "matches":
			return card.output.running ? (
				<OutputBlock pane={card.output} />
			) : (
				<Matches groups={card.matches} dropped={card.matchesDropped} />
			);
		case "file":
		case "fetch":
		case "dispatch":
			// The fact strip is the body. A read's content is what the assistant then
			// talks about, and duplicating it doubles the transcript.
			return card.output.running ? <OutputBlock pane={card.output} /> : null;
		case "ask":
			return null;
		default:
			return <OutputBlock pane={card.output} />;
	}
}

export interface ToolCardProps {
	readonly item: TimelineItem;
	readonly options?: PresentOptions;
}

export const ToolCard = memo(function ToolCard({ item, options }: ToolCardProps) {
	const card = presentTool(item, options ?? {});
	return (
		<article className={`tool-card is-${card.body}`} data-tone={card.tone} data-settled={card.settled ? "yes" : "no"}>
			<header className="tool-card__head">
				<span className="tool-card__chip">{card.chip}</span>
				<span className="tool-card__headline" title={card.headline}>
					{card.headline}
				</span>
				<StatusMark tone={card.tone} label={card.statusLabel} />
			</header>
			<FactStrip facts={card.facts} />
			{card.note === null ? null : <p className="tool-card__note">{card.note}</p>}
			<Locations locations={card.locations} />
			<Body card={card} />
			<RawDisclosure item={item} />
		</article>
	);
});
