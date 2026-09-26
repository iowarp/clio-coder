import { memo } from "react";
import { StatusMark } from "../../design/status.js";
import { receiptChecks } from "./receipt-checks-model.js";
import "./receipt-checks.css";

/**
 * The receipt's checks as separate facts. Each row keeps its own authority, so a verified run with an
 * unmeasured quality label reads as exactly that, and a check that never ran never borrows a pass.
 */
export const ReceiptChecks = memo(function ReceiptChecks({ receipt }: { receipt: Record<string, unknown> }) {
	const rows = receiptChecks(receipt);
	return (
		<section className="receipt-checks" aria-labelledby="receipt-checks-heading">
			<h3 id="receipt-checks-heading">Checks and quality</h3>
			<p className="receipt-checks__intro">
				Each line is a separate fact from the saved receipt. A check that did not run reads as not run, never as passed.
			</p>
			<ul className="receipt-checks__rows">
				{rows.map((row) => (
					<li key={row.key} className="receipt-check" data-key={row.key}>
						<span className="receipt-check__label">{row.label}</span>
						<span className="receipt-check__state">
							<StatusMark tone={row.tone} label={row.word} />
						</span>
						<div className="receipt-check__body">
							<p className="receipt-check__meaning">{row.meaning}</p>
							{row.exact && <p className="receipt-check__exact">{row.exact}</p>}
							{row.items.length > 0 && (
								<ul className="receipt-check__items">
									{row.items.map((item) => (
										<li key={item.id}>
											<StatusMark tone={item.tone} label={item.word} />
											<span className="receipt-check__item-name">{item.name}</span>
											{item.facts.length > 0 && <span className="receipt-check__facts">{item.facts.join(" · ")}</span>}
											{item.output && (
												<details>
													<summary>Last output</summary>
													{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Output longer than its well scrolls, and a scrolling region must take focus so the keyboard can move it. */}
													<pre className="receipt-check__output" tabIndex={0}>
														{item.output}
													</pre>
												</details>
											)}
										</li>
									))}
								</ul>
							)}
							<p className="receipt-check__source">{row.source}</p>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
});
