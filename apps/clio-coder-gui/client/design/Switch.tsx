import "./switch.css";

export interface SwitchProps {
	readonly checked: boolean;
	readonly onChange: (next: boolean) => void;
	readonly id?: string | undefined;
	readonly disabled?: boolean | undefined;
	readonly "aria-labelledby"?: string | undefined;
	readonly "aria-describedby"?: string | undefined;
}

/**
 * A two-state setting. The caller owns the state: this renders `checked` and reports the next value.
 * The word beside the track says On or Off, so the state never rests on colour alone. The word is hidden
 * from assistive technology because `aria-checked` already announces it.
 */
export function Switch({
	checked,
	onChange,
	id,
	disabled,
	"aria-labelledby": labelledBy,
	"aria-describedby": describedBy,
}: SwitchProps) {
	return (
		<span className="switch-field">
			<button
				type="button"
				role="switch"
				id={id}
				className="switch"
				aria-checked={checked}
				aria-labelledby={labelledBy}
				aria-describedby={describedBy}
				disabled={disabled}
				onClick={() => onChange(!checked)}
			>
				<span className="switch__thumb" />
			</button>
			<span className="switch__state" aria-hidden="true">
				{checked ? "On" : "Off"}
			</span>
		</span>
	);
}
