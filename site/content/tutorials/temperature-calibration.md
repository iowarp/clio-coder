A small numerical task makes it easy to follow a change from code to a recorded check. This example converts temperatures between Celsius, Kelvin, and Fahrenheit, validates inputs, and tests physical boundaries without adding dependencies.

## Open the example

Download the [runnable temperature-calibration example](/assets/temperature-calibration.zip). It includes the actual implementation, seven tests, and a private package manifest. It uses only the built-in Node.js test runner, so it needs `node` and `npm` on your `PATH` and nothing else. The installer's private Node.js is not added to `PATH`.

Extract the archive into your project's `examples/` folder, so the files live in `examples/temperature-calibration/`. Open the project in the terminal:

```sh
clio-coder
```

Select a model that supports tool calling. You can also use the desktop alpha with `clio-coder gui --open`. To reproduce the authoring task in your own project, ask:

> Create four temperature conversion functions for Celsius, Kelvin, and Fahrenheit. Reject non-numeric and non-finite inputs with TypeError, and temperatures below absolute zero with RangeError. Use 273.15 for the Celsius/Kelvin offset. Add Node.js tests for freezing, boiling, absolute zero, round trips within 1e-10, and invalid inputs. Use no dependencies. Run the tests and report the actual result.

Choose a new example directory when creating files. In the supplied example, the implementation and tests are already present; start by asking Clio to read them.

## Check the numerical boundaries

These reference temperatures cover ordinary values and the physical lower boundary:

| Reference | Celsius | Kelvin | Fahrenheit |
| --- | --- | --- | --- |
| Freezing point | 0 °C | 273.15 K | 32 °F |
| Boiling point | 100 °C | 373.15 K | 212 °F |
| Absolute zero | −273.15 °C | 0 K | −459.67 °F |

When Clio first wrote this example, the first run exposed an exact-equality assertion for the Fahrenheit value at absolute zero. JavaScript produced `−459.66999999999996`; the test expected `−459.67`. Clio changed that assertion to an absolute tolerance of `1e-10` and reran the tests. Review a tolerance against your domain’s numerical requirements before applying it elsewhere.

## Run a declared check

The example’s private `package.json` declares its test command. With the archive extracted into the folder above, ask Clio:

> Use verify with check test and cwd examples/temperature-calibration, then show the reference temperatures from examples/temperature-calibration/calibration.test.mjs as a table. Do not edit files.

Review any permission request before allowing the command. In the recorded run, the check exited 0 with seven passing tests, and Clio read the test file for the table. Naming the file keeps a fast model from searching the project for it.

![Clio Coder in the terminal running the declared test check through verify with exit 0, then showing the reference temperatures from the test file as a table](/assets/tui-verify.webp)

To run the same tests yourself from the repository root:

```sh
node --test examples/temperature-calibration/calibration.test.mjs
```

## Inspect the recorded result

In the terminal, open `/view` and select the `checked test` row. The preview shows the check, its working directory, the exit status, and the output, so you can compare the answer with what ran. On the desktop alpha, **Artifacts** in the Session column lists the same record.

::: capture tui-view-result
:::

Passing tests establish the behavior covered by those tests. This small example does not establish the scientific validity of a larger application. For project-specific requirements, see [quality policies](/docs/guide/quality-policy.html) and [tool usage](/docs/guide/tool-usage.html).
