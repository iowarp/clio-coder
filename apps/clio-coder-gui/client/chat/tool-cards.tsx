/**
 * Tool rows. Every decision lives in `tool-presentation.ts` and `diff.ts`;
 * this file is the markup and nothing else.
 *
 * A call is one line by default: status glyph, a plain verb, what it touched,
 * and the one fact worth reading. Opening the row shows the evidence. Four
 * properties are load-bearing and easy to lose in a refactor:
 *
 * 1. The row is the default and the JSON is the escape hatch, not the other
 *    way round. Every row keeps a closed `raw input and result` disclosure,
 *    because an operator debugging a tool needs the bytes.
 * 2. The live output pane is ONE element whose identity never changes across
 *    the running/settled boundary. `partialOutput` and the final result render
 *    into the same `<pre>` so the row does not flash or reflow when the
 *    terminal frame lands. A row that opened for live output stays open when
 *    the call settles; the operator was reading it.
 * 3. A failure is never hidden behind a closed line: the folded row carries the
 *    last line the call printed, as the terminal does, and the group around it
 *    opens.
 * 4. Status meaning never rides on colour. The glyph's shape differs per state
 *    and every state other than done is also written out; done is written for
 *    assistive technology.
 */

import { memo, useState } from "react";
import type { TimelineItem } from "../../contracts/sessions.js";
import { StatusMark } from "../design/status.js";
import { CopyButton } from "../render/Markdown.js";
import { statusGlyph } from "./activity.js";
import { ELAPSED_TITLE } from "./chat-turn.js";
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
	toolOpensAtMount,
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

function Locations({ locations, headline }: { locations: readonly ToolLocation[]; headline: string }) {
	if (locations.length === 0) return null;
	// One location that only restates the headline path is noise.
	if (locations.length === 1 && locations[0] !== undefined && formatLocation(locations[0]) === headline) return null;
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
 * The output pane. It renders unconditionally for a terminal-shaped row so the
 * DOM node exists from the first frame, which is what keeps the
 * partialOutput-to-result handover from reflowing the row.
 */
function OutputBlock({ pane }: { pane: OutputPane }) {
	return (
		<div className="tool-card__output" data-source={pane.source} data-running={pane.running ? "yes" : "no"}>
			<div className="tool-card__output-head">
				<span className="tool-card__output-label" role="status">
					{pane.source === "partial" ? "Output so far" : pane.running ? "Waiting for output" : "Output"}
				</span>
				{pane.truncated ? <span className="tool-card__output-cap">Output may be shortened</span> : null}
				{pane.text ? <CopyButton text={pane.text} label="Copy output" /> : null}
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: A long output scrolls inside its own bounded well, so the keyboard must be able to focus it to scroll. */}
			<pre className="tool-card__pre" tabIndex={0}>
				{pane.source === "none" ? (pane.placeholder ?? "") : pane.text}
			</pre>
		</div>
	);
}

function ResultDisclosure({ pane, label }: { pane: OutputPane; label: string }) {
	const [open, setOpen] = useState(false);
	return (
		<details className="tool-card__result" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>{label}</summary>
			{open ? <OutputBlock pane={pane} /> : null}
		</details>
	);
}

function resultLabel(card: ToolPresentation): string {
	if (card.name === "read") return "View file contents";
	if (card.name === "ls") return "View directory listing";
	if (card.body === "fetch") return "View fetched content";
	if (card.body === "dispatch") return "View worker result";
	return "View result";
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
	const [open, setOpen] = useState(false);
	return (
		<details className="tool-card__raw" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>Raw input and result</summary>
			{open ? (
				<pre className="tool-card__pre">{JSON.stringify({ input: item.rawInput, output: item.rawOutput }, null, 2)}</pre>
			) : null}
		</details>
	);
}

/**
 * A `terminal` row keeps ONE output node for the life of the call, which is
 * what stops the partialOutput-to-result handover from flashing. The other
 * bodies swap a live pane for a structured body when they settle. A failure
 * always keeps its output visible, so an error is never mistaken for an empty
 * successful result.
 */
function Body({ card }: { card: ToolPresentation }) {
	switch (card.body) {
		case "diff":
			return card.failed ? <OutputBlock pane={card.output} /> : card.diff === null ? null : <DiffView panel={card.diff} />;
		case "terminal":
			return <OutputBlock pane={card.output} />;
		case "matches":
			return card.output.running || card.failed ? (
				<OutputBlock pane={card.output} />
			) : (
				<Matches groups={card.matches} dropped={card.matchesDropped} />
			);
		case "file":
		case "fetch":
		case "dispatch":
			if (card.output.running || card.failed) return <OutputBlock pane={card.output} />;
			if (card.output.source !== "final") return null;
			return <ResultDisclosure pane={card.output} label={resultLabel(card)} />;
		case "ask":
			return card.failed ? <OutputBlock pane={card.output} /> : null;
		default:
			return <OutputBlock pane={card.output} />;
	}
}

export interface ToolCardProps {
	readonly item: TimelineItem;
	readonly options?: PresentOptions;
	/** Delegated worker named by Clio Coder's provenance, or null for the orchestrator. */
	readonly agent?: string | null;
	/** Browser-measured running time, already formatted, or null when not worth showing. */
	readonly elapsed?: string | null;
}

export const ToolCard = memo(function ToolCard({ item, options, agent = null, elapsed = null }: ToolCardProps) {
	const card = presentTool(item, options ?? {});
	const [open, setOpen] = useState(() => toolOpensAtMount(card));
	return (
		<details
			className={`tool-card is-${card.body}`}
			data-tone={card.tone}
			data-settled={card.settled ? "yes" : "no"}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-card__head">
				<span className="tool-card__glyph" aria-hidden="true">
					{card.failed ? "✕" : statusGlyph(item.status)}
				</span>
				<span className="tool-card__verb" title={`Clio Coder tool: ${card.name}`}>
					{card.verb}
				</span>
				<span className="tool-card__headline" title={card.headline}>
					{card.headline}
				</span>
				<span className="tool-card__trail">
					{agent === null ? null : <span className="tool-card__agent">agent {agent}</span>}
					{card.digest === null ? null : (
						<span className="tool-card__digest" data-tone={card.digestTone ?? undefined}>
							{card.digest}
						</span>
					)}
					{elapsed === null ? null : (
						<span className="tool-card__elapsed" title={ELAPSED_TITLE}>
							{elapsed}
						</span>
					)}
					<span className={card.tone === "success" ? "sr-only" : "tool-card__state"}>{card.statusLabel}</span>
				</span>
			</summary>
			{open ? (
				<div className="tool-card__body">
					<FactStrip facts={card.facts} />
					{card.note === null ? null : <p className="tool-card__note">{card.note}</p>}
					<Locations locations={card.locations} headline={card.headline} />
					<Body card={card} />
					<RawDisclosure item={item} />
				</div>
			) : null}
		</details>
	);
});
