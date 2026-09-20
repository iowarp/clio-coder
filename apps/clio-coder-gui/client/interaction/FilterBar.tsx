// The chip and search-field bar. Fully controlled and data-free: the caller owns the filter state,
// which is what lets the summary sentence be computed from the very array that is rendered.

import { useId } from "react";
import {
	EMPTY_FILTER,
	type FacetDefinition,
	type FacetValue,
	type FilterState,
	isFilterActive,
} from "./facet-filter.js";
import "./interaction.css";

function FacetGroup({
	label,
	values,
	selected,
	onSelect,
	noun,
}: {
	label: string;
	values: readonly FacetValue[];
	selected: string | null;
	onSelect: (value: string | null) => void;
	noun: { one: string; many: string };
}) {
	const labelId = useId();
	// A facet with one value cannot narrow anything, and a chip that changes nothing is noise, so the
	// group is absent. A pressed chip stays visible even when a refresh shrinks its facet to one
	// value, so the narrowing the operator applied is never hidden while it is still in force.
	if (values.length < 2 && selected === null) return null;
	return (
		// biome-ignore lint/a11y/useSemanticElements: a row of toggle chips is a labelled group, not a form fieldset.
		<div className="filter__group" role="group" aria-labelledby={labelId}>
			<span className="filter__group-label" id={labelId}>
				{label}
			</span>
			<div className="filter__chips">
				{values.map((facet) => {
					const pressed = selected === facet.value;
					return (
						<button
							type="button"
							className="filter__chip"
							key={facet.value}
							aria-pressed={pressed}
							onClick={() => onSelect(pressed ? null : facet.value)}
						>
							<span>{facet.label}</span>
							{/* The bare numeral reads as "Failed seven"; the sr-only phrase makes it "Failed, 7 runs". */}
							<small aria-hidden="true">{facet.count}</small>
							<span className="sr-only">{`${facet.count} ${facet.count === 1 ? noun.one : noun.many}`}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function FilterBar<Row>({
	filter,
	facets,
	definitions,
	summary,
	noun,
	onChange,
}: {
	filter: FilterState;
	facets: Readonly<Record<string, FacetValue[]>>;
	definitions: readonly FacetDefinition<Row>[];
	summary: string;
	noun: { one: string; many: string };
	onChange: (filter: FilterState) => void;
}) {
	const inputId = useId();
	const summaryId = useId();
	const active = isFilterActive(filter);
	return (
		<section className="filter" aria-label="Narrow this window">
			<div className="filter__query">
				<label htmlFor={inputId}>Narrow this window</label>
				<div className="filter__field">
					<span aria-hidden="true">⌕</span>
					<input
						id={inputId}
						type="search"
						value={filter.query}
						// No debounce: the rows are already in memory and a delay would add latency to an
						// operation that has none.
						onChange={(event) => onChange({ ...filter, query: event.target.value })}
						placeholder={`An id, a name, or a word in a ${noun.one}`}
						autoComplete="off"
						aria-describedby={summaryId}
					/>
					{filter.query.length > 0 ? (
						<button type="button" onClick={() => onChange({ ...filter, query: "" })} aria-label="Clear the search text">
							×
						</button>
					) : null}
				</div>
			</div>
			{definitions.map((definition) => (
				<FacetGroup
					key={definition.key}
					label={definition.label}
					values={facets[definition.key] ?? []}
					selected={filter.facets[definition.key] ?? null}
					noun={noun}
					onSelect={(value) => onChange({ ...filter, facets: { ...filter.facets, [definition.key]: value } })}
				/>
			))}
			<div className="filter__summary">
				<p role="status" id={summaryId}>
					{summary}
				</p>
				{active ? (
					<button type="button" className="filter__clear" onClick={() => onChange(EMPTY_FILTER)}>
						Clear the filter
					</button>
				) : null}
			</div>
		</section>
	);
}
