# Connect a model

Set up local models, institutional endpoints, and cloud connections.

## Connect the way you already work

Run `clio-coder configure`, or choose **Guided setup** in the desktop alpha. Pick the source you recognize: an app on this computer, a model server, an AI subscription, or a provider account/API.

1. Choose the app or provider. Enter a key or complete browser sign-in when required.
2. Confirm the endpoint if the provider uses one. Clio checks reachability and the model catalog where supported.
3. Select a model from the available list. For a local server with no models, load one and choose **Check again**.
4. Review the connection evidence, then save. The first connection supplies the chat and worker defaults.

Setup checks do not send a generation request or establish model quality. Live, cached, and provider-catalog model lists are labeled separately. Choose a model that supports tool calling for repository work.

Already know the URL? Use `clio-coder configure --quick` for endpoint-first setup.

## Settings Center

Run `clio-coder configure --settings` or choose **Settings** on the desktop. Both use these sections:

| Section | What to change |
| --- | --- |
| Connections | Providers, credentials, endpoints, and model lists |
| Chat | The connection and model answering you |
| Fleet | Worker models, profiles, and capacity |
| Context & Memory | Context limits, compaction, and memory |
| Permissions & Limits | Approvals, autonomy, and spending limits |
| Appearance | Output style and interface preferences |
| Integrations | Agents, libraries, plugins, and Git |
| Advanced | Diagnostics and the full settings editor |

Terminal `/settings` arranges the same controls into finer areas, adding Recent & Pinned, Models & Inference, Agents & Delegation, and Workspace & Files.

**Use connection default** lets a route inherit its connection's model. In the terminal, save to the session, project, or global scope where offered. Configure edits global defaults; desktop saved settings apply to new conversations. Active conversation controls have their own scope.

## Check the connection

```sh
clio-coder doctor
clio-coder targets --probe
```

If setup fails, check credentials, the endpoint address, and whether the local model is loaded. See [troubleshooting](/docs/guide/troubleshooting.html) for the next step.
