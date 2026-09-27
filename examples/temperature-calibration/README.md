# Temperature Calibration

A small scientific example demonstrating temperature unit conversions with
input validation and test coverage using Node.js built-in test tools.

## Files

- `temperature.mjs` — conversion functions (`celsiusToKelvin`,
  `kelvinToCelsius`, `celsiusToFahrenheit`, `fahrenheitToCelsius`) with
  `TypeError` for non-numeric/non-finite inputs and `RangeError` for
  temperatures below absolute zero. Uses 273.15 as the Celsius/Kelvin offset.
- `calibration.test.mjs` — test suite using `node:test` and
  `node:assert/strict`, covering freezing point, boiling point, absolute zero,
  round-trip conversions (within 1e-10), invalid inputs, and below-absolute-zero
  temperatures.

## Running the tests

```sh
node --test examples/temperature-calibration/calibration.test.mjs
```

No dependencies are required beyond Node.js itself.
