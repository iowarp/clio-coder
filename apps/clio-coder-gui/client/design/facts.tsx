import type { ReactNode } from "react";
import { type Fact, factsOf, omittedSentence } from "./facts-model.js";
import "./facts.css";

function FactRow({ fact }: { fact: Fact }) {
	if (fact.kind === "value")
		return (
			<div className="fact">
				<dt>{fact.label}</dt>
				<dd data-tone={fact.tone} className={fact.mono ? "fact__mono" : undefined}>
					{fact.text}
				</dd>
			</div>
		);
	if (fact.kind === "list")
		return (
			<div className="fact">
				<dt>
					{fact.label} · {fact.items.length + fact.omitted}
				</dt>
				<dd>
					<ul className="fact__chips">
						{fact.items.map((item, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a wire list may repeat a value, and it is never reordered.
							<li key={`${index}:${item}`}>{item}</li>
						))}
					</ul>
					{fact.omitted > 0 && <small>{omittedSentence(fact.omitted, "value")}</small>}
				</dd>
			</div>
		);
	if (fact.kind === "group")
		return (
			<div className="fact fact--nested">
				<dt>{fact.label}</dt>
				<dd>
					<FactList facts={fact.facts} omitted={fact.omitted} />
				</dd>
			</div>
		);
	return (
		<div className="fact fact--nested">
			<dt>
				{fact.label} · {fact.rows.length + fact.omitted}
			</dt>
			<dd>
				<ol className="fact__rows">
					{fact.rows.map((row, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: wire rows carry no stable identity and are never reordered.
						<li key={index}>
							<FactList facts={row} omitted={0} />
						</li>
					))}
				</ol>
				{fact.omitted > 0 && <small>{omittedSentence(fact.omitted, "record")}</small>}
			</dd>
		</div>
	);
}

function FactList({ facts, omitted }: { facts: Fact[]; omitted: number }) {
	return (
		<>
			<dl className="facts">
				{facts.map((fact) => (
					<FactRow key={fact.label} fact={fact} />
				))}
			</dl>
			{omitted > 0 && <small>{omittedSentence(omitted, "field")}</small>}
		</>
	);
}

/**
 * A wire record as labelled facts. This replaces a raw JSON dump: keys read as words, units follow the
 * key, absent reads "Not recorded" and zero reads zero, and every bound that drops something says so.
 */
export function Facts({
	value,
	order,
	hide,
	empty = "Nothing was recorded here.",
}: {
	value: unknown;
	order?: readonly string[];
	hide?: readonly string[];
	empty?: ReactNode;
}) {
	if (value === null || value === undefined || (typeof value === "object" && !Object.keys(value).length))
		return <p className="facts__empty">{empty}</p>;
	const { facts, omitted } = factsOf(value, { ...(order ? { order } : {}), ...(hide ? { hide } : {}) });
	return <FactList facts={facts} omitted={omitted} />;
}
