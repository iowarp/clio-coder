/** Hard request admission; pressure thresholds remain a separate preference. */
export function requestFits(input: number | null, output: number | null, window: number | null): boolean {
	return (
		input !== null &&
		output !== null &&
		window !== null &&
		Number.isFinite(input) &&
		input >= 0 &&
		Number.isFinite(output) &&
		output >= 0 &&
		Number.isFinite(window) &&
		window > 0 &&
		input + output <= window
	);
}
