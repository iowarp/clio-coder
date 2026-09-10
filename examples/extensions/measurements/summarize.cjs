const { values, units } = JSON.parse(process.argv[2]);
if (!Array.isArray(values) || values.length < 1 || values.length > 1000 || !values.every(Number.isFinite))
	throw new Error("Expected 1-1000 finite measurements");
let mean = 0;
let m2 = 0;
for (const [index, value] of values.entries()) {
	const delta = value - mean;
	mean += delta / (index + 1);
	m2 += delta * (value - mean);
}
if (!Number.isFinite(mean) || !Number.isFinite(m2))
	throw new Error("Numerical overflow; rescale the supplied measurements");
console.log(
	JSON.stringify({
		count: values.length,
		mean,
		min: Math.min(...values),
		max: Math.max(...values),
		sampleStandardDeviation: values.length > 1 ? Math.sqrt(m2 / (values.length - 1)) : null,
		units: units ?? null,
		source: "caller-supplied measurements; provenance not independently verified",
	}),
);
