/** #427 AC4: an observed HTTP status outranks numbers or auth words in provider prose. */
export function isProviderAuthRejection(message: string | null | undefined, status?: unknown): boolean {
	if (status !== undefined && status !== null) return status === 401 || status === "401";
	return (
		message !== undefined &&
		message !== null &&
		/\b401\s+unauthori[sz]ed\b|\b(?:token|jwt)\b[^\r\n]{0,120}\bexpired\b|\bexpired\s+(?:(?:access|refresh)\s+)?token\b|\binvalid_token\b/i.test(
			message,
		)
	);
}
