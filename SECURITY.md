# Security Policy

Clio Coder is pre-release. Security reports should still be handled privately.

## Report

Email Anthony Kougkas at `a.kougkas@gmail.com` or contact `@akougkas` on
GitHub with a minimal reproduction and affected commit or version.

Do not open public issues for secrets, credential handling, command injection,
unsafe filesystem writes, or branch-protection bypasses.

## Scope

In scope:

- Credential storage and leakage.
- Shell execution safety.
- Filesystem write restrictions.
- Git and release workflow protection.
- Runtime/provider auth behavior.

Out of scope:

- Unsupported local model behavior outside Clio Coder.
- Third-party provider outages.
- Social engineering or spam.

## Expectations

- Remove secrets from logs and screenshots.
- Include commands, environment, and changed files when possible.
- Give the maintainer time to triage before public disclosure.
