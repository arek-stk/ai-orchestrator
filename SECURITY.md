# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/arek-stk/ai-orchestrator/security/advisories/new) instead.
Include the affected component, a description of the impact and, if possible, steps to reproduce.
You will receive an acknowledgement within a few days.

## Supported versions

The project is pre-1.0; only the latest `main` branch receives security fixes.

## Security model

An orchestrator that lets AI agents change code is a high-value target. The design assumes that **model output and
repository content are untrusted** and enforces the following boundaries:

| Boundary | Enforcement |
|---|---|
| Agent side effects | All actions pass the tool router: role permissions, autonomy level, zod input validation, security guards, approval gates, budget check, audit entry. Agents never get a shell. |
| Repository writes | Paths are normalised; traversal, absolute paths, `.git`, NTFS alternate data streams and sensitive files (`.env`, keys, credentials) are rejected or gated. Content with secret-looking values is refused. |
| Git | Commits are created through the Git Data API on feature branches only. The default branch and configured protected branches are never write targets; branch names that could inject git options are rejected; updates are never forced. |
| Code execution | Verification commands come only from the project's allow-list and run in throwaway Docker containers (`--network none` unless installing, read-only root, all capabilities dropped, no-new-privileges, pids/memory/CPU limits, non-root user). No host shell. |
| Model context | Secrets are redacted from prompts, logs and events; sensitive files are excluded from context. Opinions from other agents are passed as delimited data, not instructions. |
| Human control | Approval gates for production deploys, migrations, destructive data changes, large architecture changes, secrets/permissions, critical infrastructure and high cost. |
| Spend | Budgets per global/project/task/run are checked before every model call; billed tokens of failed attempts are accounted for. |
| Webhooks | GitHub signatures are verified with HMAC-SHA256 in constant time; unknown payloads are ignored. |
| Credentials | Provider keys and tokens are stored encrypted (AES-256-GCM) and never placed into model context. |

## Deployment assumptions

* **One trusted organisation per instance.** Roles (`viewer < operator < admin < owner`) are global; there is no
  per-project membership yet. Do not share one instance between mutually untrusted teams or customers.
* **HTTPS only.** Session cookies are `Secure` in production and whenever `APP_ORIGIN` is an `https://` origin.
  Never expose a development instance (dev login, non-secure cookies) on a network.
* **Privileged project configuration.** Autonomy level, repository, budget, approval gates, stop conditions, model
  overrides and the project profile (sandbox commands, deploy workflow, critical paths) can only be changed by admins.
* **Sandbox egress.** Verification commands run without network access. Dependency installation needs network
  access and is refused unless `SANDBOX_EGRESS_NETWORK` names a Docker network whose egress is restricted to a
  package-registry proxy (no link-local, private-range or cloud metadata endpoints).
* **Encryption key.** `ORCH_ENCRYPTION_KEY` is mandatory in production; rotating it requires re-entering stored
  provider keys.

Known limitations are tracked as issues and in [`docs/STATE.md`](docs/STATE.md).
