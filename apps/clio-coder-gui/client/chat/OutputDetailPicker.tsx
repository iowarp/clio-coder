import { useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { useDetailsDismiss } from "../interaction/use-details-dismiss.js";
import { OUTPUT_DETAILS, type OutputDetail, outputDetailLabel } from "./output-detail-model.js";

/**
 * The transcript's detail tier, as a small menu beside Find. It reuses the shell menu's surface, but
 * its items are radios: one tier is always chosen, and choosing one leaves the menu open so the
 * transcript behind it can be compared tier by tier.
 */
export function OutputDetailPicker({
	value,
	onChange,
}: {
	value: OutputDetail;
	onChange: (next: OutputDetail) => void;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	useDetailsDismiss(ref, open);
	return (
		<details className="wb-menu output-detail" ref={ref} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary
				className="wb-chip output-detail__button"
				aria-label={`Transcript detail: ${outputDetailLabel(value)}`}
				title="How much of each turn the transcript shows"
			>
				<Icon name="sliders" />
				<span className="output-detail__value">{outputDetailLabel(value)}</span>
			</summary>
			<fieldset className="wb-menu__panel output-detail__panel">
				<legend className="output-detail__legend">Transcript detail</legend>
				{OUTPUT_DETAILS.map((tier) => (
					<label key={tier.value} className="output-detail__option">
						<input
							type="radio"
							name="output-detail"
							value={tier.value}
							checked={value === tier.value}
							onChange={() => onChange(tier.value)}
						/>
						<span>
							<strong>{tier.label}</strong>
							<small>{tier.summary}</small>
						</span>
					</label>
				))}
				<p className="output-detail__note">Approvals and failures show in every view.</p>
			</fieldset>
		</details>
	);
}
