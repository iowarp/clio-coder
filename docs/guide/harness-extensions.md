# Harness extensions

> **Visual blueprint:** See the [visual reference](../html/harness_extensions_blueprint.html) in the source checkout.

Harness extensions add executable capabilities to Clio. They are the only Clio package kind that runs code. A domain workflow that combines prompts, agents, skills, fleets, and reference files is a plugin instead, installed with `clio-coder library install <path>`.

An extension declares command tools in `clio-coder-extension.yaml`, `.yml`, or `.json`. Clio discovers and validates declarations without importing or executing package code. Tools become available in a new session after installation. Native workers can use a tool when their admitted recipe includes its qualified name; narrower profiles such as `minimal-local` exclude extension commands.

## Create a command tool

Create a directory containing this `clio-coder-extension.yaml`:

```yaml
id: local-analysis
name: Local Analysis
version: 1.0.0
description: Local analysis capabilities for Clio.
compatibility:
  clio: ">=0.4.7"
capabilities:
  tools:
    - name: summarize
      description: Return the count and sum of supplied measurements.
      runtime: node
      entrypoint: tools/summarize.cjs
      timeoutMs: 10000
      maxOutputBytes: 16384
      inputSchema:
        type: object
        properties:
          values:
            type: array
            items:
              type: number
            maxItems: 1000
        required: [values]
        additionalProperties: false
```

Add `tools/summarize.cjs`:

```javascript
const { values } = JSON.parse(process.argv[2]);
console.log(JSON.stringify({
  count: values.length,
  sum: values.reduce((sum, value) => sum + value, 0),
}));
```

Install the directory and start a new Clio session:

```bash
clio-coder extensions install /path/to/local-analysis --user
clio-coder extensions list --all --json
clio-coder
```

The model can call `extension_local-analysis__summarize` with `{"values":[1,2,3]}`. A recipe requests that same qualified name in `tools.required` or `tools.optional`. Python tools use `runtime: python3` and read `json.loads(sys.argv[1])`; Clio launches Python with `-I` to isolate interpreter configuration.

## Command contract

Each tool declares `name`, `description`, `runtime`, `entrypoint`, and `inputSchema`. Supported runtimes are `node` and `python3`. Clio uses its current Node executable and resolves `python3` from the normal tool environment. Entrypoints are ordinary files inside the installed package; symlinks, hard links, absolute paths, and parent traversal are refused. Helper files remain covered by the full package digest.

Clio passes the validated JSON object as one argument and runs a fixed argument vector with no shell. The child runs in the workspace directory. Standard output must contain exactly one JSON value. Use standard error for diagnostics. Nonzero exits, invalid JSON, cancellation, timeout, and exceeded output limits return tool errors with execution metadata and package provenance.

Input is limited to 64 KiB. `timeoutMs` defaults to 120000 and is bounded at 300000. `maxOutputBytes` defaults to 600000 and is bounded at 1048576. Output limits include standard output and standard error together.

Schemas support `type`, `description`, `properties`, `required`, `additionalProperties`, `items`, scalar `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, and `maxItems`. The root must be an object. Each object declares its properties and `additionalProperties: false`; array schemas declare `items`. References and executable schema keywords are refused. Clio validates each invocation against the schema before starting the child.

Qualified names use `extension_<id>__<name>` and must fit 64 characters. Package IDs use provider-safe lowercase letters, numbers, single underscores, and hyphens; local tool names start with a letter and use lowercase letters, numbers, and single underscores. Duplicate and colliding tool registrations are refused.

The manifest keys are `id`, `name`, `version`, `description`, `capabilities`, and `compatibility`. A manifest naming `resources`, `prompts`, `skills`, `agents`, `fleets`, or `themes` is invalid, and the diagnostic points at `clio-coder library install <path>`. `capabilities` is optional: a package whose only contribution is a root `hooks.yaml` is a valid harness extension with no command tools.

## Admission and lifecycle

Every extension command is an execution action and runs sequentially. Packages cannot declare themselves read-only. The registry evaluates both the qualified capability call and its fixed executable command through Clio's existing safety policy, autonomy, approval, and middleware rules. Read-only autonomy blocks commands; workers with explicit write confinement cannot execute an unconfined extension command. Installation does not bypass command approval. The child receives Clio's normal allowlisted tool environment, which excludes provider credentials and interpreter injection variables.

Command tools are installed programs with the filesystem and network access of the invoking process. Entry containment and environment filtering do not create an operating-system sandbox. Install code you trust, as you would a local executable script.

The existing extension lifecycle applies:

```bash
clio-coder extensions disable local-analysis --user
clio-coder extensions enable local-analysis --user
clio-coder extensions install /path/to/new-local-analysis --user --force
clio-coder extensions remove local-analysis --user
```

Installation records and verifies the entire package tree. Each invocation rechecks the effective installed package, enabled state, canonical root, and digest. Disabling, removing, replacing, or modifying a package revokes existing tool calls. A disabled project installation also suppresses the user installation with the same ID.

Tool schemas are frozen when a session or worker registry is created. Restart the session after installing, enabling, or updating capabilities; `/library extensions reload` refreshes resource and hook generations and does not change a live model's tool schemas. A new native worker constructs its own verified registry, and the ordinary allowed-tool surface and worker attestation apply. External command-line worker runtimes do not gain Clio command tools.
