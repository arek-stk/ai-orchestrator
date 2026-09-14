# Research: Mehrere AI-Accounts (Claude, ChatGPT & Co.) im Orchestrator

Stand: 2026-09-14. Recherche, keine Rechtsberatung. Quellen am Ende; Unsicherheiten sind markiert.

## Zusammenfassung (Deutsch)

- **Der Orchestrator selbst darf nur mit API-Zugängen arbeiten.** Anthropic erlaubt Drittanwendungen (auch mit dem
  Agent SDK) ausdrücklich **nicht**, Claude-Free/Pro/Max-Logins anzubieten oder Anfragen über Abo-Credentials zu
  leiten. Claude.ai-Credentials oder Session-Tokens dürfen weder gesammelt noch gespeichert noch weitergereicht
  werden [A1][A2]. Claude-Pro/Max-Abos scheiden als Modellquelle für den Orchestrator also aus.
- **Mehrere Anthropic-/OpenAI-API-Accounts sind erlaubt und vorgesehen:** Anthropic-Workspaces (bis 100 pro Org,
  eigene Keys, Spend- und Rate-Limits pro Workspace) [A4][A5]; OpenAI-Projects (Budgets, Rate-Limits und
  Service-Accounts pro Projekt) [O4][O5]. Dazu kommen Bedrock, Vertex, Microsoft Foundry und Claude Platform on AWS
  mit Cloud-Credentials [A6][A7].
- **Nicht erlaubt ist Key-Rotation, um Rate-Limits zu umgehen.** OpenAI verbietet ausdrücklich, Rate-Limits zu
  umgehen oder die Dienste so zu konfigurieren, dass Usage-Limits vermieden werden [O2]. Bei Anthropic gelten Limits
  pro Organisation [A5]. Mehrere Accounts für verbotene Zwecke oder zur Umgehung von Sperren untersagt die Usage
  Policy [A3]. Mehrere Keys **derselben** Org oder desselben Google-Projekts bringen ohnehin kein zusätzliches
  Kontingent [A5][G1].
- **Keys von Freunden oder Kollegen sind eine Grauzone.** Die Consumer Terms verbieten, Account-Credentials oder
  API-Keys „mit anderen zu teilen“ [A8]. Anthropic erlaubt aber, eigene API-Keys für die eigenen autorisierten
  Nutzer bereitzustellen, sofern auf den Key-Inhaber abgerechnet und nichts weiterverkauft wird [A1]. Daraus folgt
  der Designvorschlag: Der Key gehört genau einer Person, sie hinterlegt ihn selbst, er wird nie angezeigt, nur für
  ausdrücklich freigegebene Projekte genutzt und mit eigenem Budget ausgewiesen.
- **„Sign in with ChatGPT“ (Codex-OAuth) in eigener Software ist eine Grauzone.** OpenAI signalisiert Offenheit
  gegenüber Drittwerkzeugen [O6]. Die Codex-Doku empfiehlt für programmatische Workflows aber API-Keys [O1], und es
  gibt kein dokumentiertes OAuth-Programm für Dritte. Für einen autonomen Server-Orchestrator ist das nicht zu
  empfehlen.
- **Der saubere Weg für fremde AIs ist „Bring your own AI“ über MCP.** Kollegen verbinden ihr eigenes Claude Code,
  Codex, Cursor, ChatGPT (Developer Mode) oder Claude.ai (Custom Connector) mit dem geplanten MCP-Server aus
  ADR-030. Jeder zahlt und authentifiziert sich bei seinem eigenen Anbieter, der Orchestrator sieht keine fremden
  AI-Credentials. Für Claude Code ist die Anmeldung mit dem eigenen Abo ausdrücklich erlaubt [A1][M2][M3][M4][M5].
- **GitHub Copilot SDK ist eine Ausnahme mit offiziellem Weg:** Nutzer autorisieren eine OAuth-App, die Anfragen
  laufen über **ihr eigenes** Copilot-Abo [X3]. Das ist dokumentiert und damit legitim, aber eine Agent-Engine,
  kein reines Modell-API.
- **Code-Stand:** Mehrere `provider_configs` pro Anbieter sind technisch schon möglich. Es fehlen aber Besitzer,
  Budgets, Rate-Limits und Projektfreigaben pro Account, außerdem eine Account-Spalte im Usage-Ledger. Der Router
  wählt nur Modelle, keine Accounts.
- **Empfehlung:** Provider-Accounts als eigene Entität einführen (Besitzer, Auth-Typ, verschlüsseltes Secret mit
  Key-ID, Budget, Self-Limits, Projektfreigaben, Status). Der Router wählt zuerst das Modell, dann den Account.
  Budget-Scope „account“, Kostenzuordnung pro Account und Person. Kein Failover auf fremde Accounts bei 429.
  Außerdem BYO-AI per MCP mit OAuth 2.1 als ADR-030-Stufe 3. Umsetzung in 5 Stufen (siehe unten).

---

## 1. Current state of the model layer (repository)

| Aspect | Today | Evidence |
|---|---|---|
| Env credentials | Exactly one key per provider kind (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, one OpenAI-compatible base URL/key) | `apps/server/src/config.ts:30-34`, `:62-68`; turned into credentials `env:<kind>` in `apps/server/src/container.ts:119-135` |
| Stored credentials | `provider_configs` rows: `id, kind, name, baseUrl, apiKeyEncrypted, enabled`. **No owner, budget, rate limit, project scope or status** | `packages/db/src/schema.ts:399-409` |
| Multiple accounts of one kind | Possible: a model row can pin `providerConfigId`; otherwise the resolver takes the **first enabled** credential of that kind | `packages/core/src/models/types.ts:32-33`, `packages/db/src/schema.ts:414`, `packages/integrations/src/providers/resolver.ts:42-44` |
| Adapter cache | Per credential fingerprint (id + key + baseUrl) | `resolver.ts:48-56` |
| Router | Model-centric: pin, then role override, then the cheapest model meeting the quality floor. Account availability is a boolean `isProviderAvailable(model)`. Fallbacks prefer a **different provider**. | `packages/core/src/models/router.ts:105-121`, `:137-146`, `:163-185` |
| Runtime fallback | Tries primary + fallbacks (default max 3) when the provider error is fallback-eligible | `packages/core/src/agents/runtime.ts:175`, `:210` |
| Budgets | Scopes `global, project, task, agent`; global daily budget, project budget, task max cost | `packages/core/src/budget/budget-guard.ts:1-52`; wiring in `apps/server/src/container.ts:209-218`, `:242-243` |
| Cost ledger | `usage_ledger`: project, task, run, provider, model, tokens, cost. **No provider account id, no billed user** | `packages/db/src/schema.ts:361-378`; written in `packages/core/src/agents/runtime.ts:278-297`, `packages/db/src/repositories.ts:509-520` |
| Who manages keys | `PUT/DELETE /api/providers/:id` is admin-only and audited; `GET` returns only `hasApiKey` | `apps/server/src/routes.ts:550-589` |
| Secret encryption | AES-256-GCM, format `v1:iv:tag:ct`, one global `ORCH_ENCRYPTION_KEY`, **no key id**, so rotating the master key needs re-encryption | `apps/server/src/crypto.ts:31-45`; ADR-009 (`docs/DECISIONS.md:96-100`) |
| Planned external AI identities | `ai_identities` (owner, token hash, scopes, projects) + MCP server at `/mcp` with bearer token | `docs/plans/project-room.md:22`, `:53-56`; ADR-030 (`docs/DECISIONS.md:198-220`) |

Net: the layer is multi-provider (ADR-005) but effectively **single-tenant per provider**. Several keys can be
stored, but nothing represents *whose* key it is, *which projects* may use it, *how much* it may spend, or *which
account* paid for a ledger entry.

---

## 2. Findings per vendor

### 2.1 Anthropic

**Legitimate ways to have several accounts or keys**

- **Workspaces** in one Console organization separate "projects, environments, or teams while maintaining
  centralized billing". Default maximum is 100 workspaces per org. Keys can be scoped to one workspace. Each
  workspace can get **spend limits** ("cap monthly spending") and **rate limits** (RPM/ITPM/OTPM), set lower than
  the org's limits. "Organization-wide limits always apply, even if workspace limits add up to more." [A4]
- **Rate and spend limits are enforced at the organization level** ("The API enforces service-configured limits
  at the organization level"). Tiers (Start/Build/Scale) carry monthly spend caps. The `anthropic-workspace-id`
  response header shows which workspace a request counted against. [A5]
- **Admin API and Usage & Cost API:** manage workspaces, members and keys programmatically. The usage report can
  be grouped by workspace, API key and model; the cost report is in USD. An Admin API key is required, and it is
  unavailable for individual accounts. [A4][A9]
- **Separate organizations** (e.g. a friend's own Console org) are normal, independent customers with their own
  keys and billing.
- **Cloud routes:** Claude in Amazon Bedrock, Google Cloud (Vertex / Agent Platform), Microsoft Foundry, and
  **Claude Platform on AWS** (Anthropic-operated; AWS provides "SigV4 or API key" authentication, IAM access control
  and Marketplace billing) [A6][A7]. Each cloud account or subscription is a separate billing and quota entity.

**Consumer subscriptions (Free/Pro/Max) and Claude Code OAuth: what the sources say**

- Claude Code legal & compliance page [A1], section "Authentication and credential use":
  - "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise
    subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic
    applications."
  - "Developers building products or services that interact with Claude's capabilities, including those using the
    Agent SDK, should use API key authentication … Anthropic does not permit third-party developers to offer
    Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on
    behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or
    session tokens."
  - Explicitly **not** restricted: "how customers provision and manage their own API keys … for use by the
    customer's own authorized users — provided the resulting usage is billed to the key owner … and is not resold or
    intermediated". Also: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary
    with their own Claude subscription."
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent
    SDK."
  - Embedding Claude Code in products (hosted sandboxes, agent infrastructure) requires the Commercial Terms, an
    unmodified binary, and "Each end user must authenticate with their own Anthropic API key, Claude subscription
    plan credentials, or 3P inference provider credential"; customers "may not pay for, resell, or intermediate
    Claude usage on their end users' behalf."
- Agent SDK overview [A2]: "Unless previously approved, Anthropic does not allow third party developers to offer
  claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- Consumer Terms (effective 2025-10-08) [A8]: "You may not share your Account login information, Anthropic API key,
  or Account credentials with anyone else or make your Account available to anyone else." Automated access "through
  a bot, script, or otherwise" is prohibited "except when you are accessing our Services via an Anthropic API Key
  or where we otherwise explicitly permit it."
- Usage Policy (effective 2025-09-15) [A3] prohibits coordinating "malicious activity across multiple accounts to
  avoid detection or circumvent product guardrails" and circumventing "a ban through the use of a different
  account".
- Commercial Terms (effective 2025-06-17) [A10]: "Customer is responsible for all activity under its account";
  reselling only "as expressly approved by Anthropic". The fetched text contained no explicit rate-limit
  circumvention clause (uncertain; may be in referenced documents).
- Enforcement timeline (secondary sources only): server-side restriction of subscription OAuth tokens to Claude Code
  from 2026-01-09, documentation clarification on 2026-02-19, and billing enforcement against third-party tools on
  2026-04-04 [S1][S2]. Treat the dates as reported, not verified against Anthropic primary sources.

### 2.2 OpenAI

- **Projects** let you "manage access and limits, provision service accounts, and track usage", with spend limits
  per project [O4]. "Rate limits are defined at the organization level and at the project level, not user level."
  Usage tiers range from Free to Tier 5 [O5].
- **Admin APIs** cover project administration, API key management, spend limits and alerts, and rate limit
  operations. Admin keys cannot call inference endpoints. Service-account keys can be given an expiry of up to
  365 days (`expires_in_seconds`) [O7].
- **Terms** (primary page returned HTTP 403 to our fetcher; wording taken from the search index, verify manually)
  [O2]: "You may not share your account credentials or make your account available to anyone else"; prohibited:
  "circumventing any rate limits or restrictions", "automatically or programmatically extracting data or Output".
  Business terms and the Services Agreement add: must not "violate or circumvent Usage Limits or otherwise configure
  the Services to avoid Usage Limits".
- **Codex authentication** [O1]: "Sign in with ChatGPT for subscription access" or "Sign in with an API key for
  usage-based access". "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't
  expose Codex execution in untrusted or public environments." The page says nothing about third-party apps reusing
  the ChatGPT login.
- **Third-party harnesses on a ChatGPT subscription:** OpenAI's Codex for Open Source page says "Developers should
  code in the tools they prefer, whether that's Codex, OpenCode, Cline, pi, OpenClaw, or something else" [O6].
  Reports say OpenAI staff publicly endorsed using ChatGPT accounts in third-party harnesses, and that these tools
  reuse the Codex OAuth token against the Codex backend [S3][S4]. We found **no official OAuth program, policy page
  or contractual permission** for third parties. Classified as **grey area**.
- **ChatGPT as a collaborator via MCP:** Developer mode is "Available to Pro, Plus, Business, Enterprise, and
  Education accounts on the web". It supports custom MCP apps with read and write tools (writes need user
  confirmation) over "SSE and streaming HTTP", with "OAuth, No Authentication, and Mixed Authentication" [M4]. The
  server must be publicly reachable over HTTPS (no stdio) [M6].
- **Azure OpenAI / Foundry:** quota is "assigned to your subscription on a per-region, per-model,
  per-deployment-type basis" in TPM. Authentication is by API key or Microsoft Entra ID (keyless recommended) [X1][X2].
- **OpenAI Agents SDK:** API-key based like the platform; no subscription path was found (not researched in depth).

### 2.3 Others

- **Google Gemini API:** "Rate limits are applied per project, not per API key" [G1]. Tiers are tied to the linked
  billing account, and spend is aggregated across linked projects [G2]. More keys in the same project add no quota.
  Whether creating extra projects to multiply free-tier quota breaches Google's terms was **not verified**; treat it
  as not recommended.
- **OpenRouter BYOK:** provider keys are "securely encrypted"; there can be several keys per provider, "tried in the
  order you define"; by default OpenRouter falls back to shared capacity (paid with credits) unless disabled; fee
  is 5% of the normal OpenRouter price [X4]. Each underlying key remains subject to its provider's terms.
- **LiteLLM proxy:** virtual keys with `max_budget`, `budget_duration`, `rpm_limit`, `tpm_limit`, model allow-lists,
  and hierarchical budgets (key/user/team/org) [X5][X6]. Self-hosted gateway; could replace part of our own budget
  code but duplicates ADR-005 routing.
- **GitHub Copilot SDK** (GA 2026-06-02) [X7]: authentication via signed-in user, GitHub OAuth App (`gho_`/`ghu_`/
  `github_pat_`), env token, server-to-server (org billing), or BYOK. With an OAuth app, requests run "on behalf of
  each authenticated user, using their Copilot subscription" [X3][X8]. This is the only mainstream vendor we found
  that documents a **third-party app spending the end user's own subscription**.
- **GitHub Models:** free, rate-limited usage per account, plus paid usage and BYOK [X9].
- **Local models:** Ollama (`http://localhost:11434/v1/`) and LM Studio (`http://localhost:1234/v1`) expose
  OpenAI-compatible APIs and already work with the `openai-compatible` adapter [X10][X11]. No account terms apply;
  model weight licences do.

### 2.4 "Bring your own AI" through MCP

- **MCP authorization** (spec 2025-06-18) [M1]: for HTTP transports, the MCP server is an OAuth 2.1 resource
  server. It MUST publish Protected Resource Metadata (RFC 9728); clients MUST send the `resource` indicator
  (RFC 8707) and use PKCE; servers MUST validate the token audience; "The MCP server MUST NOT pass through the token
  it received from the MCP client." Dynamic Client Registration is SHOULD.
- **Claude Code:** `claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"` or automatic
  OAuth via `/mcp`; scopes are local, project (`.mcp.json`) or user [M2]. A colleague signed in with their own
  Pro/Max plan in the unmodified binary is explicitly allowed [A1].
- **Codex CLI:** `[mcp_servers.x] url = "…"` plus `bearer_token_env_var` for Streamable HTTP [M3] (secondary
  sources; verify against the Codex docs).
- **Cursor:** `mcpServers.<name>.url` plus `headers` (supports `${env:NAME}`), or OAuth 2.1 with PKCE [M5].
- **Claude.ai / Desktop custom connectors:** remote MCP URL, optional OAuth client id/secret; fixed bearer
  credentials possible via request headers. Available on Free (1 connector), Pro, Max, Team and Enterprise [M7].
- **ChatGPT developer mode:** see 2.2. It needs a public HTTPS endpoint; OAuth or no-auth, so a static bearer token
  alone is likely **not** enough for ChatGPT (uncertain) [M4][M6].

Each participant authenticates to their **own** AI vendor; the orchestrator only issues **its own** scoped token to
that client. No AI credential crosses people. This is the cleanest answer to "friends and colleagues with their own
Claude/ChatGPT accounts".

---

## 3. Allowed / not allowed / grey area

| # | Scenario | Classification | Basis |
|---|---|---|---|
| 1 | Several Anthropic API keys or workspaces in **your own** org, with per-workspace spend and rate limits | **Allowed** | [A4][A5] |
| 2 | Several OpenAI projects or keys in **your own** org, with project budgets and limits | **Allowed** | [O4][O5] |
| 3 | Claude via Bedrock, Vertex, Foundry or Claude Platform on AWS with your cloud credentials; Azure OpenAI | **Allowed** | [A6][A7][X1] |
| 4 | Gemini keys from your own projects; OpenRouter BYOK; LiteLLM virtual keys; local models | **Allowed** (the underlying provider terms still apply) | [G1][X4][X5][X10] |
| 5 | Colleague connects **their own unmodified Claude Code** (signed in with their Pro/Max/Team) to our MCP server | **Allowed** | [A1][M2] |
| 6 | Colleague connects their own Codex CLI, Cursor, ChatGPT developer-mode app or Claude.ai custom connector to our MCP server | **Allowed** (a documented feature of each client; each uses their own plan) | [O1][M3][M4][M5][M7] |
| 7 | Third-party app uses the end user's own **GitHub Copilot** subscription via the Copilot SDK OAuth flow | **Allowed** (documented by GitHub) | [X3][X8] |
| 8 | Orchestrator uses a **Claude Free/Pro/Max OAuth token** (directly, via Agent SDK or via extracted Claude Code credentials) | **Not allowed** | [A1][A2] |
| 9 | Orchestrator offers "Log in with Claude" or stores claude.ai credentials or session tokens | **Not allowed** | [A1] |
| 10 | Pooling several Claude Max/Pro subscriptions (own or friends') to get more quota for the orchestrator | **Not allowed** (subscription credentials in third-party apps; account sharing) | [A1][A8] |
| 11 | Rotating keys or accounts across **different** orgs, projects or people **to evade rate or usage limits** | **Not allowed** for OpenAI (explicit); for Anthropic limits are per org, circumvention intent conflicts with the terms' spirit, and no explicit clause was found in the fetched Commercial Terms (uncertain) | [O2][A5][A3] |
| 12 | Using a ban-evading or second account after an account was suspended | **Not allowed** | [A3] |
| 13 | A friend or colleague stores **their own API key** in our instance for projects they take part in, billed to them | **Grey area.** Supported by the "own API keys … for use by the customer's own authorized users" wording [A1]; in tension with the Consumer Terms "may not share … Anthropic API key … with anyone else" [A8] and OpenAI's "share your account credentials" [O2]. Safer variant: the owner creates a dedicated key or workspace/project with a spend cap, enters it themselves, it is never visible to others, is revocable, and is used only for their granted projects. Safest: BYO-AI via MCP (rows 5-6) | [A1][A8][O2] |
| 14 | Orchestrator reuses a **ChatGPT "Sign in with ChatGPT"/Codex OAuth token** server-side | **Grey area, not recommended.** OpenAI signals tolerance for third-party harnesses [O6][S3], but there is no documented third-party program, Codex docs recommend API keys for programmatic use [O1], and the terms forbid programmatic extraction of Output [O2] | [O1][O2][O6] |
| 15 | Hosting the unmodified Claude Code or Codex binary in our sandbox, with each user signing in with their own subscription | **Grey area.** Anthropic describes this "platform hosts Claude Code" case as permitted under Commercial Terms and conditions [A1], but storing the resulting session token server-side may conflict with "may not collect, store, or intermediate". Ask Anthropic sales before building | [A1] |
| 16 | One person owning several consumer Claude/ChatGPT subscriptions and using them manually in native apps | **Unclear.** No explicit prohibition found; limits assume "ordinary, individual usage" [A1]. Not relevant to the orchestrator and not recommended as a design basis | [A1] |
| 17 | Creating many Google Cloud projects to multiply Gemini free-tier quota | **Not verified**; likely against the spirit of per-project limits. Do not build on it | [G1] |

---

## 4. Security and compliance requirements

1. **Credential ownership.** Every provider credential has exactly one owner (a user, or the instance/organization).
   Only the owner (and, for instance credentials, admins) can create, replace or delete it. Nobody, including
   admins, can read it back; the API returns only fingerprint, last-4 characters and status (extends
   `routes.ts:550-589`, ADR-009).
2. **Use-grants instead of sharing.** Other people never receive a key; the owner grants the *router* permission to
   use it for specific projects, with a budget and expiry. Revocation takes effect immediately
   (`reloadProviders`).
3. **Encryption at rest.** Keep AES-256-GCM but move to `v2:<keyId>:iv:tag:ct` with a keyring
   (`ORCH_ENCRYPTION_KEYS`), so the master key can rotate with lazy re-encryption. Consider binding ciphertext to
   `account_id` via AAD so rows cannot be swapped. Secrets stay out of model context and logs (ADR-009 redactor
   patterns).
4. **Credential rotation.** Store `expires_at` and `rotated_at`, support a staged "next key" during rotation,
   verify a new key with a cheap authenticated call before activating it, and mark accounts `invalid` on 401/403
   and notify the owner. OpenAI service-account keys can expire [O7]; Anthropic keys can be archived via the Admin
   API [A4].
5. **Rate limits without evasion.** Self-limits (RPM/TPM/concurrency) per account keep us **below** provider limits.
   On 429: honour `retry-after` and back off. Only then fall back to another *model*, and only within accounts of the
   **same billing owner**. Never switch to another person's account because of a 429. Cross-owner failover only on
   provider outage (5xx/timeouts), only if the grant explicitly allows it, and always visible in the run log.
   Distinguish Anthropic's spend-cap 429 (`enforced_spend_limit_reached`, no `retry-after`) from a rate limit [A5].
6. **Cost attribution.** Every ledger row records `provider_account_id` and the billed owner. Budgets per account
   and per grant. Optional reconciliation with Anthropic's Usage & Cost API (grouped by API key/workspace) and
   OpenAI project usage [A9][O7].
7. **Data protection.** Prompts containing repository code flow to the account owner's provider under **their**
   retention settings (e.g. ZDR on the owner's org). Show which account (and therefore which vendor and org)
   processes a project's data; allow projects to restrict accounts (e.g. "only instance account", "no free tiers").
   GDPR is relevant for German users (not researched in depth).
8. **Audit.** Create/replace/delete/grant/revoke events, and each failover to another account, go into
   `audit_logs`; never include secrets.
9. **MCP (BYO-AI).** Follow the MCP authorization spec: audience-bound tokens, PKCE, no token passthrough [M1].
   Treat external AI content as untrusted (already ADR-030).
10. **Guardrail against forbidden auth types.** The account model offers **no** "Claude subscription" or "ChatGPT
    login" auth type; the UI states why and links [A1]/[A2].

---

## 5. Recommended design

### 5.1 Entities (evolve `provider_configs`)

`provider_accounts` (replaces `provider_configs`, migration keeps ids):

| Field | Purpose |
|---|---|
| `id`, `name` | as today |
| `owner_type` (`instance` \| `user`), `owner_user_id` | who owns and pays |
| `kind` | `anthropic`, `openai`, `google`, `openai-compatible`, later `anthropic-bedrock`, `anthropic-vertex`, `azure-openai`, `anthropic-foundry` |
| `auth_type` | `api_key`, `aws_iam`, `gcp_service_account`, `azure_entra`, `none` (local). No subscription/OAuth-login types. |
| `secret_encrypted` (v2 with key id), `secret_hint` (last 4), `secret_fingerprint` | never returned |
| `base_url`, `region`, `external_ref` (workspace id, OpenAI project id, cloud project/deployment) | routing and reconciliation |
| `monthly_budget_usd`, `daily_budget_usd` | account-level spend cap (the vendor-side cap is still recommended) |
| `rpm_limit`, `tpm_limit`, `max_concurrency` | self-limits below provider limits |
| `status` (`active`, `invalid`, `cooling_down`, `revoked`), `cooldown_until`, `last_error`, `last_verified_at` | health |
| `expires_at`, `rotated_at` | rotation |

`provider_account_grants`: `account_id`, `project_id`, `granted_by`, `budget_usd`, `allowed_tiers` (e.g. only
`fast`/`balanced`), `allow_outage_failover`, `priority`, `expires_at`, `revoked_at`.
Rule: a user-owned account can only be granted by its owner, and only to projects where the owner is a member
(ADR-022 ACL).

`usage_ledger` gains `provider_account_id` and `billed_owner_user_id`. `model_configs.provider_config_id` becomes an
optional *pin* (`preferred_account_id`); the model catalog stays provider-level (ADR-005 "models are data").

### 5.2 Routing (core, IO-free)

1. `selectModel` (unchanged precedence) evaluates availability as "has at least one eligible account for this
   project" instead of `isProviderAvailable(model)` (`router.ts:121`).
2. New `selectAccount(model, scope)`: candidates are accounts with matching kind, `active`, granted to the project
   (or instance-owned and allowed for the project), tier allowed, and account/grant budget headroom above the
   estimate. Order: run pin, then project sponsor grant priority, then the task requester's own grant, then the
   instance account. Tie-break by remaining headroom.
3. `RoutingDecision` carries `account` plus a fallback chain of `(model, account)` pairs, with the rules from §4.5
   (same-owner only on 429; cross-owner only on outage with `allow_outage_failover`).
4. `BudgetScopeKind` gains `account` and `grant` (`budget-guard.ts:1`); `container.budgetScopes` adds them
   (`container.ts:209-218`). `pause` on an exhausted sponsor grant never silently moves to the instance account; it
   raises an approval.
5. Runtime `recordSpend` writes the account id (`runtime.ts:278-297`); events carry the account id and name, never
   secrets.

### 5.3 Collaboration: BYO-AI (ADR-030)

- Keep `ai_identities` + `/mcp` from `docs/plans/project-room.md`. Add `client_kind` (claude-code, codex, cursor,
  chatgpt, claude-ai, copilot, other) for display only.
- Stage A: bearer tokens (works for Claude Code, Codex, Cursor, and Claude.ai via headers) [M2][M3][M5][M7].
- Stage B: OAuth 2.1 authorization server for `/mcp` (PRM, RFC 8707 audience, PKCE, optional DCR) so ChatGPT
  developer mode and Claude.ai connectors can connect interactively [M1][M4][M7]. ChatGPT needs a public HTTPS URL.
- External AI compute is paid by the participant and is not in our ledger. Optionally `report_progress` accepts
  self-reported token and cost figures, flagged as unverified.

### 5.4 Fit with existing ADRs

- **ADR-005:** accounts become data like models; adapters unchanged; routing stays in core. The fallback preference
  "different provider" is refined to "(model, account) pairs under ownership rules".
- **ADR-007 / ADR-022:** grant management follows roles and project membership; viewers see account names and
  budgets, not hints.
- **ADR-009:** extended with key ids, AAD binding, per-owner write access.
- **ADR-021 metrics:** add per-account spend, 429 and invalid counters.
- **ADR-030:** BYO-AI is the preferred path for people who want to use *their subscription*; provider accounts are
  the path for people who want to *sponsor orchestrator compute* with an API key.
- Proposed new ADR (next free number, e.g. ADR-031): "Provider accounts, grants and account-aware routing;
  subscription credentials are out of scope".

### 5.5 Implementation stages

| Stage | Content |
|---|---|
| 0 | Accept this research. Write the ADR. Add the UI and docs note on forbidden auth types. No code change to the auth model. |
| 1 | Migration `provider_configs` to `provider_accounts` (owner, auth_type, status, budgets, self-limits, hints); secret format v2 with keyring; owner-scoped CRUD API with verify-on-save; `usage_ledger.provider_account_id`; audit events. |
| 2 | Core `selectAccount`, `(model, account)` fallback rules, `account` budget scope, 401/429/spend-cap handling with cooldown; Settings "AI accounts" UI (instance vs mine); per-account cost view. |
| 3 | `provider_account_grants` (project sponsorship, tier limits, expiry), approval when a sponsor budget is exhausted, cost report per person/account; optional reconciliation via Anthropic Usage & Cost API and OpenAI usage. |
| 4 | New adapters/auth types: Anthropic via Bedrock, Vertex, Foundry and Claude Platform on AWS; Azure OpenAI (Entra ID). OpenRouter and LiteLLM keep using `openai-compatible`. |
| 5 | ADR-030 stage 3: MCP server + AI identities with bearer tokens, then OAuth 2.1 for ChatGPT and Claude.ai connectors; connection snippets for Claude Code, Codex, Cursor. Optional later: GitHub Copilot SDK integration using each user's own Copilot subscription. |

---

## 6. Open questions

1. Should user-owned API keys be supported at all (grey area, row 13), or only BYO-AI via MCP plus instance-owned
   accounts? If supported: require dedicated keys with a vendor-side spend cap?
2. Is the instance self-hosted for one team or offered to third parties? The latter touches Anthropic's "resell /
   intermediate" rules [A1][A10] and needs legal review.
3. When a sponsor's budget runs out mid-pipeline: pause, ask for approval, or switch to the instance account?
4. Should cross-owner failover exist at all, even for outages? The conservative default is off.
5. Master key rotation procedure and KMS support (cloud KMS instead of an env key)?
6. Data residency and retention: may a project's code be sent to a colleague's provider org with different
   retention settings? GDPR implications?
7. Should the orchestrator ever run hosted Claude Code or Codex with user subscriptions (row 15)? This needs
   clarification from Anthropic/OpenAI first.
8. Is OAuth 2.1 for `/mcp` worth building early (needed for ChatGPT), or is bearer-only enough initially?
9. Verify manually: OpenAI Terms wording (403 during research), OpenAI's stance on Codex OAuth in third-party apps,
   Codex MCP config keys, Google terms on multiple projects.

---

## Sources

Anthropic
- [A1] Claude Code, Legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- [A2] Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- [A3] Anthropic Usage Policy (effective 2025-09-15): https://www.anthropic.com/legal/aup
- [A4] Workspaces: https://platform.claude.com/docs/en/manage-claude/workspaces
- [A5] Rate limits: https://platform.claude.com/docs/en/api/rate-limits
- [A6] Claude in Amazon Bedrock: https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock ; Claude in Microsoft Foundry: https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry ; Claude Code enterprise/3P overview: https://code.claude.com/docs/en/third-party-integrations
- [A7] Claude Platform on AWS: https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws
- [A8] Consumer Terms (effective 2025-10-08): https://www.anthropic.com/legal/consumer-terms
- [A9] Usage and Cost API: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
- [A10] Commercial Terms (effective 2025-06-17): https://www.anthropic.com/legal/commercial-terms

OpenAI
- [O1] Codex authentication: https://learn.chatgpt.com/docs/auth (redirect from https://developers.openai.com/codex/auth)
- [O2] Terms of Use: https://openai.com/policies/row-terms-of-use/ ; Services Agreement: https://openai.com/policies/services-agreement/ ; Business terms: https://openai.com/policies/may-2025-business-terms/ (pages returned 403; wording via search index)
- [O4] Managing projects: https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform
- [O5] Rate limits: https://developers.openai.com/api/docs/guides/rate-limits
- [O6] Codex for Open Source: https://developers.openai.com/community/codex-for-oss
- [O7] Admin APIs: https://developers.openai.com/api/docs/guides/admin-apis ; Administration reference: https://platform.openai.com/docs/api-reference/administration

Google
- [G1] Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- [G2] Gemini API billing: https://ai.google.dev/gemini-api/docs/billing

MCP and clients
- [M1] MCP Authorization spec 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- [M2] Claude Code MCP: https://code.claude.com/docs/en/mcp
- [M3] Codex CLI MCP config (secondary): https://www.usecarly.com/blog/codex-mcp-servers/ ; https://github.com/openai/codex
- [M4] ChatGPT developer mode: https://developers.openai.com/api/docs/guides/developer-mode ; https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- [M5] Cursor MCP: https://cursor.com/docs/mcp
- [M6] ChatGPT MCP overview (secondary): https://coworker.ai/blog/chatgpt-mcp ; https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- [M7] Claude custom connectors (remote MCP): https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

Other vendors and tools
- [X1] Azure OpenAI quota: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota
- [X2] Entra ID keyless auth: https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/configure-entra-id?view=foundry-classic
- [X3] Copilot SDK authentication: https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate
- [X4] OpenRouter BYOK: https://openrouter.ai/docs/guides/overview/auth/byok
- [X5] LiteLLM virtual keys: https://docs.litellm.ai/docs/proxy/virtual_keys
- [X6] LiteLLM budgets and rate limits: https://docs.litellm.ai/docs/proxy/users
- [X7] Copilot SDK GA changelog: https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/
- [X8] Copilot SDK GitHub OAuth setup: https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth
- [X9] GitHub Models billing: https://docs.github.com/en/enterprise-cloud@latest/billing/concepts/product-billing/github-models ; https://github.blog/changelog/2025-06-24-github-models-now-supports-moving-beyond-free-limits/
- [X10] Ollama OpenAI compatibility: https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx
- [X11] LM Studio OpenAI compatibility: https://lmstudio.ai/docs/developer/openai-compat

Secondary reporting (dates and statements not verified against primary sources)
- [S1] https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/
- [S2] https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/ ; https://help.apiyi.com/en/anthropic-claude-subscription-third-party-tools-openclaw-policy-en.html
- [S3] https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/
- [S4] https://explainx.ai/blog/openclaw-chatgpt-plus-pro-openai-anthropic-subscription-2026 ; https://cline.bot/blog/introducing-openai-codex-oauth
