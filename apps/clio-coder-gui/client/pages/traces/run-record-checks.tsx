import { memo } from "react";
import type { RunEvidenceV1 } from "../../../contracts/wire.js";
import { StatusMark } from "../../design/status.js";
import { runRecordChecks, runRecordIntegrity } from "./run-record-checks-model.js";
import "./run-record-checks.css";

/**
 * The record's checks as separate facts, under the seal that vouches for them. Each row keeps its own authority, so
 * a verified run with an unmeasured quality label reads as exactly that, and a check that never ran never borrows a
 * pass. A seal that does not verify shows no check at all, only why.
 */
export const RunRecordChecks = memo(function RunRecordChecks({ evidence }: { evidence: RunEvidenceV1 }) {
	const integrity = runRecordIntegrity(evidence);
	const rows = runRecordChecks(evidence);
	return (
		<section className="run-record-checks" aria-labelledby="run-record-checks-heading">
			<h3 id="run-record-checks-heading">Checks and quality</h3>
			<p className="run-record-checks__integrity">
				<StatusMark tone={integrity.tone} label={integrity.word} /> {integrity.meaning}
			</p>
			{rows.length > 0 ? (
				<p className="run-record-checks__intro">
					Each line is a separate fact the verified seal vouches for. A check that did not run reads as not run, never as
					passed.
				</p>
			) : null}
			{rows.length > 0 ? (
				<ul className="run-record-checks__rows">
					{rows.map((row) => (
						<li key={row.key} className="run-record-check" data-key={row.key}>
							<span className="run-record-check__label">{row.label}</span>
							<span className="run-record-check__state">
								<StatusMark tone={row.tone} label={row.word} />
							</span>
							<div className="run-record-check__body">
								<p className="run-record-check__meaning">{row.meaning}</p>
								{row.exact && <p className="run-record-check__exact">{row.exact}</p>}
								{row.items.length > 0 && (
									<ul className="run-record-check__items">
										{row.items.map((item) => (
											<li key={item.id}>
												<StatusMark tone={item.tone} label={item.word} />
												<span className="run-record-check__item-name">{item.name}</span>
												{item.facts.length > 0 && <span className="run-record-check__facts">{item.facts.join(" · ")}</span>}
												{item.output && (
													<details>
														<summary>Last output</summary>
														{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Output longer than its well scrolls, and a scrolling region must take focus so the keyboard can move it. */}
														<pre className="run-record-check__output" tabIndex={0}>
															{item.output}
														</pre>
													</details>
												)}
											</li>
										))}
									</ul>
								)}
								<p className="run-record-check__source">{row.source}</p>
							</div>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
});
