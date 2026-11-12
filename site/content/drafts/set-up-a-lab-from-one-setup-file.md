A lab or site that runs its own model gateway can connect every member's CLIO Coder with one small YAML file. You publish it once; each member imports it, sees where their prompts will go, and confirms. The file can name models and where to find a key, but it can never carry a key or change what CLIO Coder is allowed to do.

::: note Version scope
This tutorial describes v0.8.0. The output below is from `clio-coder configure --import` run against a fresh CLIO Coder home.
:::

::: needs
- An OpenAI-compatible model gateway your members can reach, here `https://llm.lab.example.org/v1`.
- A way to give each member a key, which they keep in an environment variable.
- An `https` address or a shared path where you can publish the file.
:::

## Write the setup file

```yaml title=lab-clio.yaml
notes: "Lab gateway. Ask #research-computing for a key; export it as LAB_API_KEY."
targets:
  - id: lab
    runtime: openai-compat
    url: https://llm.lab.example.org/v1
    defaultModel: qwen3-coder-480b
    capabilities: { contextWindow: 131072 }
    auth: { apiKeyEnvVar: LAB_API_KEY }
chat: { target: lab }
fleet: { target: lab, model: qwen3-coder-480b }
```

`targets` lists the model endpoints. `chat` and `fleet` choose which target the main session and its workers use. `notes` is shown to the member before they confirm, so use it to say how to get a key.

## Know what the file may carry

A setup file may hold only `targets`, `chat`, `fleet` and `notes`. A target may hold only `id`, `runtime`, `url`, `defaultModel`, `wireModels`, `capabilities`, `pricing` and `auth`, and `auth` only names an environment variable (`apiKeyEnvVar`) or an OAuth profile. Anything else refuses the whole file. A literal key is the usual mistake:

```yaml title=bad.yaml
targets:
  - id: lab2
    runtime: openai-compat
    url: https://x/v1
    auth: { apiKey: sk-123 }
```

::: result What you should see
`error: setup file refused; nothing changed:` followed by `targets[0].auth.apiKey is not allowed in a setup file`, and exit code 1.
:::

The same rule refuses request headers and safety settings, so a member never has to read a setup file for hidden permissions.

## Try it on your own account first

```sh
clio-coder configure --import lab-clio.yaml
```

::: result What you should see
```text
Setup file lab-clio.yaml will:
Lab gateway. Ask #research-computing for a key; export it as LAB_API_KEY.

  add target lab (openai-compat)
    prompts go to https://llm.lab.example.org/v1
    model qwen3-coder-480b; key from $LAB_API_KEY
  chat uses lab / qwen3-coder-480b
  fleet uses lab / qwen3-coder-480b
Apply these changes? [y/N]
```
:::

Answer `n` and nothing changes. Answer `y` and it prints `Imported 1 target.` and one line per target: `lab: ready`, or what is still missing, such as `lab reads its key from LAB_API_KEY, which is not set in this shell.` 

A plain `http` address to anything other than this machine or a private network address adds a warning that prompts and keys cross the network unencrypted.

Importing saves the settings without sending a request to the model. Check the route yourself:

```sh
export LAB_API_KEY=...
clio-coder doctor
clio-coder targets --probe --target lab
```

The `chat` row of `doctor` should end in `endpoint reachable`, and the probe's `health` column should not read `down`.

## Publish it

Put the file at an `https` address or a path members can read. A fetched file must be `https` all the way, a redirect to anything else is refused, and the file may be at most 64 KiB.

## What a member sees

A member who has never run CLIO Coder runs `clio-coder`. At **What do you have?** they choose **A setup file from my lab or team**, type the address at **Where is the setup file?**, and see the same preview under **This setup file will:** with **Apply** and **Back**. A member who already uses CLIO Coder runs:

```sh
clio-coder configure --import https://hpc.example.edu/clio-coder/setup.yaml
```

Only the `lab` target and the chat and fleet routes change. Their other targets, project settings and stored keys stay as they were.

Importing the same file again prints `Setup file already imported; nothing changed` with the status line, so it is safe to put in a login script with `--yes`. Without a terminal and without `--yes`, the command prints the preview and exits 2 without saving.

## Change the file later

If you change the settings of a target a member already has, their import is refused with `lab already saved with different settings; nothing changed.` and the command to rerun with `--replace`. Tell members when you change it. A new target id imports without `--replace`.

::: limits
- Importing does not test the model. Members should run `clio-coder doctor` after setting their key.
- The file cannot hand out keys. Each member still gets a key and exports it in their shell.
- A member can change their route afterwards with `/model` or `clio-coder configure`; the file is not enforced.
:::

::: next
- [Connect CLIO Coder on an HPC login node](/docs/guide/hpc-clusters.html)
- [Setup files and model targets](/docs/guide/configuration-and-targets.html)
- [Run on a local model](/tutorials/run-on-a-local-model.html)
:::
