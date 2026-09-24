/**
 * The diff surface. Every decision lives in `diff-model.ts`; this file is the grid
 * and the disclosure.
 *
 * Two properties are load-bearing:
 *
 * 1. The block is a grid, not a table, and the marker glyph is a `::before`
 *    that is `user-select: none`, so selecting the block and copying yields the
 *    code and not the gutters.
 * 2. Truncation is stated, never implied. When a producer cut the payload the
 *    header says which one did and the block ends in an explicit row, because a
 *    diff that merely stops looks complete.
 */

import { memo, useState } from "react";
import { StatusMark } from "../design/status.js";
import { CopyButton } from "../render/Markdown.js";
import {
	type CollapsePlan,
	collapsePlan,
	type DiffPanel,
	diffCopyText,
	diffCounts,
	type ParsedDiff,
} from "./diff-model.js";

function DiffRows({ diff, plan }: { diff: ParsedDiff; plan: CollapsePlan }) {
	const rows = diff.rows.slice(plan.start, plan.end + 1);
	return (
		<div className="diff__grid" role="presentation">
			{rows.map((row) => (
				// `row.id` is assigned by the parser, which is where the identity
				// decision belongs. See DiffRow in diff-model.ts.
				<div key={row.id} className={`diff__row is-${row.kind}`}>
					<span className="diff__num" aria-hidden="true">
						{row.oldLine ?? ""}
					</span>
					<span className="diff__num" aria-hidden="true">
						{row.newLine ?? ""}
					</span>
					<code className="diff__text">{row.text}</code>
				</div>
			))}
		</div>
	);
}

export const DiffView = memo(function DiffView({ panel }: { panel: DiffPanel }) {
	const diff = panel.diff;
	const [expanded, setExpanded] = useState(false);
	if (diff === null)
		return (
			<div className="diff is-empty">
				<StatusMark tone="warn" label={panel.label} />
				{panel.note === null ? null : <p className="diff__note">{panel.note}</p>}
			</div>
		);

	const plan = collapsePlan(diff, panel.firstChangedLine);
	const showAll = expanded || !plan.collapsed;
	const rendered: CollapsePlan = showAll
		? { start: 0, end: Math.max(0, diff.rows.length - 1), collapsed: false, hiddenRows: 0 }
		: plan;

	return (
		<div className={`diff is-${panel.provenance}`}>
			<div className="diff__head">
				{panel.path === null ? (
					<StatusMark
						tone={panel.provenance === "applied" ? "success" : panel.provenance === "rejected" ? "fail" : "warn"}
						label={panel.label}
					/>
				) : (
					<StatusMark
						tone={panel.provenance === "applied" ? "success" : panel.provenance === "rejected" ? "fail" : "warn"}
						label={panel.label}
						detail={panel.path}
					/>
				)}
				<span className="diff__counts">{diffCounts(diff)}</span>
				<CopyButton text={diffCopyText(diff)} label="Copy diff" />
			</div>
			{panel.note === null ? null : <p className="diff__note">{panel.note}</p>}
			{diff.format === "unparsed" ? (
				<p className="diff__note">
					This payload is not a diff this view can read. It is shown verbatim, and the raw bytes are in the disclosure below.
				</p>
			) : null}
			{diff.noNewlineAtEof ? <p className="diff__note">The file does not end with a newline.</p> : null}
			<DiffRows diff={diff} plan={rendered} />
			{plan.collapsed && !showAll ? (
				<button type="button" className="diff__more" onClick={() => setExpanded(true)}>
					Show all {diff.rows.length} lines
				</button>
			) : null}
			{diff.truncated ? (
				<p className="diff__truncation">{panel.diff?.truncationNote ?? "This diff was cut short by a cap."}</p>
			) : null}
			{diff.rowsDropped > 0 ? (
				<p className="diff__truncation">
					{diff.rowsDropped} further rows are not drawn. This view stops before the browser does.
				</p>
			) : null}
		</div>
	);
});
