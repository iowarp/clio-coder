A small numerical task makes it easy to follow a change from code to a recorded check. This example converts temperatures between Celsius, Kelvin, and Fahrenheit, validates inputs, and tests physical boundaries without adding dependencies.

## Open the example

Download the [runnable temperature-calibration example](/assets/temperature-calibration.zip). It includes the actual implementation, seven tests, and a private package manifest from the recorded session. It needs Node.js 22.19 or newer and has no dependencies to install.

Extract the archive into your project's `examples/` folder, so the files live in `examples/temperature-calibration/`. Open the project in the desktop alpha:

```sh
clio-coder gui --open
```

You can also use the terminal. Select a model that supports tool calling. To reproduce the authoring task in your own project, ask:

> Create four temperature conversion functions for Celsius, Kelvin, and Fahrenheit. Reject non-numeric and non-finite inputs with TypeError, and temperatures below absolute zero with RangeError. Use 273.15 for the Celsius/Kelvin offset. Add Node.js tests for freezing, boiling, absolute zero, round trips within 1e-10, and invalid inputs. Use no dependencies. Run the tests and report the actual result.

Choose a new example directory when creating files. In the supplied example, the implementation and tests are already present; start by asking Clio to read them.

## Check the numerical boundaries

These reference temperatures cover ordinary values and the physical lower boundary:

| Reference | Celsius | Kelvin | Fahrenheit |
| --- | --- | --- | --- |
| Freezing point | 0 °C | 273.15 K | 32 °F |
| Boiling point | 100 °C | 373.15 K | 212 °F |
| Absolute zero | −273.15 °C | 0 K | −459.67 °F |

The first run exposed an exact-equality assertion for the Fahrenheit value at absolute zero. JavaScript produced `−459.66999999999996`; the test expected `−459.67`. Clio changed that assertion to an absolute tolerance of `1e-10` and reran the tests. Review a tolerance against your domain’s numerical requirements before applying it elsewhere.

## Run a declared check

The example’s private `package.json` declares its test command. With the archive extracted into the folder above, ask Clio:

> Use verify with check test and cwd examples/temperature-calibration. Report the result and show the reference-temperature table. Do not edit files.

Review any permission request before allowing the command. The recorded run passed seven tests with zero failures. The conversation keeps the check and its result beside Clio’s response.

![Clio Coder conversation reporting seven passing calibration tests and a reference-temperature table](/assets/gui-conversation.webp)

To run the same tests yourself from the repository root:

```sh
node --test examples/temperature-calibration/calibration.test.mjs
```

## Inspect the recorded result

Open **Artifacts** beside the conversation, then choose **Results**. Review the command, output, and recorded outcome. **Files** shows the paths reported by tools and their recorded changes. These views help you compare the answer with what ran.

![Clio Coder Artifacts panel displaying a successful verify call beside the temperature-calibration conversation](/assets/gui-artifacts.webp)

The same conversation is available in the light theme:

![Clio Coder light desktop conversation with calibration test results and reference temperatures](/assets/gui-conversation-light.webp)

Passing tests establish the behavior covered by those tests. This small example does not establish the scientific validity of a larger application. For project-specific requirements, see [quality policies](/docs/guide/quality-policy.html) and [tool usage](/docs/guide/tool-usage.html).
