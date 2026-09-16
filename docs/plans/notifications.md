# Plan: Notifications and approvals from the phone

Request (2026-09-16, feature 1 of the newly approved backlog): when the autopilot parks an approval, a budget nearly
runs out, CI goes red, a workflow run finishes or fails, or a room message mentions you, the owner gets a message via
push, e-mail, Telegram or Discord and can approve or reject with one tap. This makes away mode (ADR-034) usable.

Status: **proposal / research**. Nothing here is implemented. Proposed decision: **ADR-038** (draft in §13).

## Zusammenfassung (Deutsch)

* **Ein Kern, viele Kanäle.** Domain-Events (bereits persistiert, ADR-008/024) werden durch eine reine
  Routing-Funktion in `packages/core` zu Benachrichtigungen pro Nutzer. Kanäle (In-App, Web Push, Telegram, Discord,
  E-Mail) sind Adapter in `packages/integrations`; Zustellung läuft über die vorhandene Job-Queue mit Retries und
  Dead Letters.
* **In-App zuerst:** Die Glocke wandert aus dem AI-Hub-Header in den globalen Header, mit Ungelesen-Zähler über SSE
  und einer Seite `/notifications`. Neue Events sind inhaltsfrei und gehen nur an den Empfänger.
* **Telegram ist der beste erste Handy-Kanal:** keine neue Abhängigkeit (nur `fetch`), echte Buttons mit
  plattform-verifizierten Callbacks, und dank `getUpdates` (Long Polling) funktioniert es auch, wenn die App nur
  lokal läuft und vom Handy aus nicht erreichbar ist.
* **Web Push ist machbar ohne Paket:** RFC 8291 (Verschlüsselung) und RFC 8292 (VAPID) lassen sich mit
  `node:crypto` umsetzen (~300 Zeilen plus Tests gegen die RFC-Testvektoren). Alternative: Paket `web-push`, das nach
  ADR-031 deine Freigabe braucht. Auf iOS nur ab 16.4 und nur als Home-Bildschirm-App; iOS kennt keine
  Aktions-Buttons in Benachrichtigungen, der Tap öffnet eine Bestätigungsseite.
* **E-Mail später:** SMTP ohne Bibliothek ist unrealistisch. Optionen: Provider-HTTP-API (Resend/Postmark) per
  `fetch` (kein npm-Paket, aber ein externer Dienstleister) oder `nodemailer` (Abhängigkeit, Freigabe nötig). E-Mail
  bekommt nur Hinweise und „In der App öffnen", keine Ein-Klick-Freigabe.
* **Discord zweistufig:** Webhooks sind nur Einbahnstraße (Team-Kanal-Hinweise). Buttons brauchen eine Discord-App mit
  Interactions-Endpoint (Ed25519-Signatur, mit `node:crypto` prüfbar) und einen öffentlich erreichbaren Server.
* **Sichere Freigabe von außen:** einmalige, kurzlebige Aktions-Tokens (nur Hash gespeichert), gebunden an Freigabe,
  Entscheidung, Nutzer und einen Digest des Freigabe-Inhalts. Nie Freigabe per GET-Link; entweder Bestätigungsseite
  mit Login-Session + POST + Origin-Prüfung oder ein signierter Telegram-/Discord-Callback. Rechte (Rolle, ACL,
  Owner für Deploy) werden beim Klick erneut geprüft; alles wird auditiert.
* **Empfohlene Policy für riskante Gates:** Stufe A (Ein-Tipp remote): `publish_changes`, `architecture_change`,
  `high_cost`. Stufe B (nur Bestätigungsseite in der eingeloggten App): `database_migration`, `external_service`,
  `critical_infrastructure`. Stufe C (keine Remote-Freigabe, nur volle Freigabeseite): `production_deploy` (inkl.
  Merges), `dependency_addition`, `secrets_permissions`, `destructive_data`. **Ablehnen ist überall per Ein-Tipp
  erlaubt** (fail-safe). Remote-Freigaben sind standardmäßig aus.
* **Einstellungen:** pro Nutzer × Ereignis × Kanal (sofort/Sammelmeldung/aus), Ruhezeiten mit Zeitzone,
  Stummschalten pro Projekt, Drosselung und Zusammenfassen gleichartiger Meldungen, deutsche Texte als Standard.
* **Sperrbildschirm-Datenschutz:** keine Secrets, kein Code, keine Modellausgaben, keine Raum-Nachrichtentexte und
  keine Links aus Repository-Text in externen Kanälen; Vorschau-Stufe „minimal" versteckt sogar den Projektnamen.
* **Empfohlener erster Schnitt:** Stufe 1 (Benachrichtigungszentrum + globale Glocke + Event-Routing + Präferenzen +
  Ruhezeiten + Zustell-Pipeline mit Fake-Kanal + gemeinsamer `decideApproval`-Service), direkt gefolgt von Stufe 2
  (Telegram mit Verknüpfung, Hinweisen, Ein-Tipp-Ablehnen und Stufe-A-Freigabe hinter einem Schalter). Keine neue
  Abhängigkeit in beiden Stufen.
* **Deine Entscheidungen:** (1) Web Push selbst implementieren oder `web-push` freigeben, (2) E-Mail über
  Provider-API, `nodemailer` oder vorerst gar nicht, (3) Reihenfolge der Kanäle (Vorschlag: Telegram → Web Push →
  E-Mail → Discord), (4) Remote-Freigabe-Policy (Stufen A/B/C oben, Standard aus), (5) ob Projektnamen auf dem
  Sperrbildschirm erscheinen dürfen, (6) wie die App vom Handy aus erreichbar ist (LAN, Tailscale, öffentlich).

---

## 1. Goals and non-goals

Goals

1. A person who is away learns within a minute that something needs them (parked approval, budget warning, red CI,
   finished or failed run, mention), on the channel they chose.
2. Safe decisions from the phone: reject always, approve where the gate's risk allows it, never by a bare link.
3. One in-app notification centre (bell, unread count, list) that is the source of truth; external channels are
   copies of it.
4. No secrets, code or model output leaves the instance through a notification.
5. No new dependency unless the owner approves it (ADR-031).

Non-goals (this plan): native mobile apps; SMS; Slack (possible later as a webhook channel); chat-style replies to the
orchestrator from Telegram (that is the `@orchestrator` command work of ADR-030); marketing e-mail; notifying people
who are not users of the instance.

## 2. What exists today (verified in code, `main` at `92f3ca9`)

| Area | Where | Relevance |
|---|---|---|
| Typed domain events, persisted then published; SSE with `Last-Event-ID` replay; LISTEN/NOTIFY fan-out carrying ids only | `packages/core/src/events/types.ts`, `apps/server/src/container.ts` (`PersistentEventRecorder`), `apps/server/src/routes.ts` (`/api/events/stream`), `apps/server/src/event-fanout.ts`; ADR-008, ADR-024 | The `events` table (bigserial id) is a natural outbox. The SSE filter `eventVisible` is project-based only; there is no per-user event audience yet. |
| Relevant events | `approval.required` (with `mode`), `approval.decided` (incl. `expired`), `ci.failed` (with `classification`), `budget.exhausted`, `task.completed/failed/blocked`, `deployment.completed`, `autopilot.session.stopped/killed`, `autopilot.run.parked`, `room.message` (content-free) | No event for "budget nearly exhausted", no mention concept, no workflow-run events (ADR-037 Workflows is only claimed). |
| Approval decision | `POST /api/approvals/:id/decide` in `routes.ts`: global `admin` role, `acl.assertProject(..., 'admin')`, `production_deploy` approve owner-only, compare-and-set `status = 'pending'` in `DrizzleApprovalRepository.decide`, then `orchestrator.onApprovalDecided`, then audit `approval.approved/rejected` | The checks live inline in the route. A remote decision path must reuse exactly these checks, so they move into one service (§6.1). Merges run under the `production_deploy` gate (`orchestrator/tools.ts`). |
| Approval expiry | `apps/server/src/approval-expiry.ts`, ADR-023, deferred `expires_at` from ADR-034 | Tokens must never outlive the approval. |
| Autopilot | ADR-034, `packages/core/src/autopilot/*`, `docs/plans/autopilot.md` §7.4 (optional outbound webhook, not built), quiet hours for scheduling | This plan replaces §7.4 with real channels. |
| Auth and sessions | `apps/server/src/auth.ts`: GitHub OAuth, DB sessions (SHA-256 of a 256-bit token), `SameSite=Lax`, `Secure` on HTTPS, CSRF by exact `Origin` match for mutating requests except `/api/webhooks/*` | Confirm page POSTs get CSRF protection for free; new webhook routes must live under `/api/webhooks/`. |
| RBAC / ACL | `requireRole`, `apps/server/src/acl.ts` (ADR-022) | Recipient selection and decision-time checks must use the same effective-role rule. |
| Secrets | `apps/server/src/crypto.ts`: AES-256-GCM `v1:iv:tag:ct`, `signValue`/`verifySignedValue`, `hashToken`; ADR-009 | Bot tokens, push subscription keys, chat ids and e-mail addresses are stored encrypted. |
| Rate limits | `@fastify/rate-limit` global 600/min; per-route configs (`routes-room.ts` keyed by user) | Same pattern for token redemption and webhooks. |
| Job queue | `packages/db/src/job-queue.ts`: `SKIP LOCKED`, leases, exponential backoff with jitter (5 s … 10 min), `maxAttempts`, dead-letter, active dedupe keys, `fail(..., { retryable: false })` | Delivery retries and dead letters need no new machinery. |
| Observability | `/api/metrics` registry, log redaction (ADR-021) | Add delivery counters; redact Telegram bot tokens, which appear in request URLs. |
| Web shell | `apps/web/src/components/shell.tsx` header (breadcrumbs, `AutopilotButton`, `LiveIndicator`, theme, user menu); **the bell exists only in the AI Hub header** (`components/hub/HubHeader.tsx`) as a link to `/approvals` with the pending count | The bell moves into the global header and becomes the notification centre. |
| PWA | No `manifest`, no service worker, `apps/web/public` has only `logos/`; `next.config.ts` sets `X-Frame-Options`, `nosniff`, `Referrer-Policy: same-origin` | Everything for Web Push is new. |
| Dependencies | server: fastify, cookie, rate-limit, zod; integrations: provider SDKs, octokit | No mail, push or chat library present. |

## 3. Research

> Legend: **[V]** verified in the cited official document during this research; **[S]** from secondary sources or
> memory, not verified against the primary document. Sources are listed in §15.

### 3.1 Web Push (VAPID, Push API, service worker)

**Protocol.** A push message is an HTTP `POST` to the subscription endpoint with `TTL` (seconds), an optional `Urgency`
(`very-low | low | normal | high`) and an optional `Topic` (≤ 32 base64url characters; a newer message with the same
topic replaces the pending one). Responses: 201 with `Location`; 404 for an expired or deleted subscription; 410 when
delivery failed permanently; 429 should carry `Retry-After`; a push service must not answer 413 for bodies up to
4096 bytes. Both 404 and 410 mean "delete the subscription". [V][W1]

**Encryption (RFC 8291).** ECDH on P-256 between a fresh application-server key pair and the user agent's public key;
a 16-octet auth secret; `PRK_key` via HKDF with info `"WebPush: info" 0x00 ‖ ua_public(65) ‖ as_public(65)`; a content
encryption key (16 octets) with info `"Content-Encoding: aes128gcm" 0x00` and a nonce (12 octets) with info
`"Content-Encoding: nonce" 0x00`; the RFC 8188 `aes128gcm` header `salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(65 = as_public)`;
one record with padding delimiter `0x02`, which leaves roughly 3993 bytes of plaintext inside 4096. [V][W2] The RFC
includes a worked example with fixed keys, salt and expected output that an implementation can test byte for byte.
[S][W2] (the example exists; its exact section was not re-checked)

**VAPID (RFC 8292).** An ES256 JWT with `aud` = origin of the push resource, `exp` ≤ 24 h after the request and `sub`
a `mailto:` or `https:` URI, sent as `Authorization: vapid t=<jwt>, k=<base64url uncompressed P-256 public key>`; the
push service may answer 403 for a bad token. [V][W3]

**`node:crypto` is sufficient.** Node 24 has `hkdfSync(digest, ikm, salt, info, keylen)`, `createECDH('prime256v1')`
(65-byte uncompressed public key), `createCipheriv('aes-128-gcm')` with `getAuthTag()`, and
`sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })`, which returns the raw 64-byte `r ‖ s` signature a JWS
needs; `generateKeyPairSync('ec', { namedCurve: 'P-256' })` creates VAPID keys. These calls were run locally on Node
24.19.0. [V][W4]

**Option A: own implementation, no dependency.** About 120 lines for `aes128gcm` encryption, 60 for the VAPID JWT and
80 for the HTTP client with error mapping, plus about 200 lines of tests (RFC example vector, decrypt round trip with a
generated user-agent key pair, JWT verification with `crypto.verify`). Estimated effort: two to three days including a
manual check against Chrome, Firefox and an iOS home-screen app. Risk: subtle byte-layout mistakes, which the RFC
example vector and a real-browser test catch. No network-facing parsing is involved; the server only encrypts and
signs.

**Option B: the `web-push` npm package.** Version 3.6.7 (published 2024-01-16), MPL-2.0, Node ≥ 16; runtime
dependencies `http_ece`, `asn1.js`, `jws`, `https-proxy-agent`, `minimist`. The repository is not archived and gets
dependency updates (September 2026), but there has been no release for about 2.7 years. [V][W5] It needs owner approval
under ADR-031 for itself and its transitive packages. MPL-2.0 is a file-level copyleft licence, different from this
repository's MIT licence; using it as an unmodified dependency is normally fine, but the owner should know.
**Recommendation: option A.**

**iOS and iPadOS.** Web Push arrived in iOS/iPadOS 16.4 for web apps added to the Home Screen only; the manifest
`display` must be `standalone` or `fullscreen`; permission must be requested in response to a direct user
interaction; delivery needs no Apple Developer membership; servers should allow `*.push.apple.com`; the Badging API is
supported; notifications show on the Lock Screen, in Notification Center and on a paired Apple Watch. [V][W6]
iOS/iPadOS 18.4 added **Declarative Web Push**: a JSON payload `{"web_push": 8030, "notification": {"title", "body",
"navigate", …}}` that is shown without running a service worker; a service worker, if present, may replace it. [V][W7]
Sending declarative-compatible payloads makes iOS delivery more robust and costs little; whether other browsers ship it
was not verified.

**Browser capabilities that shape the design (MDN compat data).** `showNotification`: Chrome 42, Firefox 44, Safari 16,
Safari iOS 16.4. **Notification `actions` (buttons) are not supported in Safari or Safari iOS** (Chrome 48, Firefox
152); `requireInteraction`, `renotify`, `image`, `vibrate` and `badge` are unsupported in Safari as well;
`pushsubscriptionchange` is unsupported on Safari iOS and partial in Firefox. [V][W8] Consequence: buttons inside push
notifications would only work on Chromium and Firefox, so the portable design is "tap opens the confirm page"; action
buttons may be a progressive enhancement that also only opens the confirm page. `PushManager.subscribe` must use
`userVisibleOnly: true` in Chrome/Edge and takes the VAPID public key as `applicationServerKey`; Firefox requires a user
gesture. [V][W9] The compat data lists `notificationclick` as unsupported on Safari iOS, which looks like a data gap
because WebKit documents tap navigation; it must be checked on a device. [S][W8]

**Android.** Chrome on Android supports the Push API and notification actions per the compat data. [V][W8] The usual
assumption that Chrome endpoints live on `fcm.googleapis.com`, and the exact install-prompt criteria, were not verified
in an official source. [S] The endpoint allow-list is therefore configuration with a documented default.

**Next.js.** The official PWA guide (doc version 16.3.5) uses `app/manifest.ts` returning `MetadataRoute.Manifest` with
`display: 'standalone'`, registers the service worker with `scope: '/'` and `updateViaCache: 'none'`, uses `web-push`
in its example, and recommends these headers for the worker: `Content-Type: application/javascript; charset=utf-8`,
`Cache-Control: no-cache, no-store, must-revalidate`, `Content-Security-Policy: default-src 'self'; script-src 'self'`.
The guide is inconsistent about the worker's path (`lib/service-worker.js` in the registration example, `/sw.js` in the
headers example); this plan serves a static `public/sw.js` so the header rule matches. Testing push locally needs HTTPS
(`next dev --experimental-https`). [V][W10]

### 3.2 Telegram Bot API

* `sendMessage` text is 1–4096 characters; `editMessageText` and `editMessageReplyMarkup` exist; an inline keyboard
  button's `callback_data` is 1–64 bytes; a `CallbackQuery` has `id`, `from` (the Telegram user), `message` and `data`;
  the bot **must** call `answerCallbackQuery` (clients show a progress indicator until then; `text` ≤ 200 characters).
  [V][T1]
* `setWebhook` accepts `secret_token` (1–256 characters of `A-Z a-z 0-9 _ -`), sent back in
  `X-Telegram-Bot-Api-Secret-Token`; webhook ports are 443, 80, 88 and 8443; Telegram retries non-2xx responses for a
  while and then gives up. [V][T1] `getUpdates` long polling needs no inbound endpoint and cannot be used while a
  webhook is set. [S][T1]
* Deep linking: `https://t.me/<bot>?start=<parameter>`, parameter ≤ 64 characters of `A-Z a-z 0-9 _ -`, base64url
  recommended for binary data. [V][T2] A 32-byte random code in base64url is 43 characters and fits.
* Bots cannot start conversations; the user must message the bot first. [V][T3] Linking through `/start <code>`
  satisfies this.
* Limits: about 30 messages per second overall, at most 1 message per second per chat, 20 per minute in groups;
  exceeding them yields 429. [V][T4] The 429 error carries `parameters.retry_after`. [S][T1]
* Bot chats are not end-to-end encrypted. [S] Hence the privacy rules in §8.

### 3.3 Discord

* **Webhooks** (`POST /webhooks/{id}/{token}`, `content` ≤ 2000 characters) are one-way: "Non-application-owned
  webhooks cannot send interactive components", so a plain channel webhook cannot carry approve buttons. [V][D1]
* **Interactions endpoint:** requests carry `X-Signature-Ed25519` and `X-Signature-Timestamp`; the app verifies the
  signature over `timestamp + body` and answers 401 when it is invalid (Discord deliberately sends invalid signatures to
  test this); PING (type 1) is answered with `{"type":1}`. [V][D2] The initial response must arrive within 3 seconds;
  interaction tokens stay valid for 15 minutes; response types 7 `UPDATE_MESSAGE` and 6 `DEFERRED_UPDATE_MESSAGE` apply
  to component interactions; guild interactions carry `member`, DMs carry `user`. [V][D3]
* **Buttons:** `custom_id` 1–100 characters and unique per message; label ≤ 80 characters; up to 5 buttons per row.
  [V][D4]
* **DMs:** `POST /users/@me/channels` with `recipient_id`; Discord warns that DMs should be initiated by a user action
  and that opening many quickly can get a bot rate-limited or blocked. [V][D5] Whether a DM needs a shared guild or a
  user-installed app was not verified. [S]
* **Ed25519 with `node:crypto`:** `crypto.verify(null, Buffer.from(timestamp + body), key, signature)` works with the
  raw 32-byte public key wrapped as SPKI DER (prefix `302a300506032b6570032100`), as JWK
  `{ kty: 'OKP', crv: 'Ed25519', x }`, or with the `raw-public` format on Node ≥ 24.15; tested locally. [V][W4]
* Consequence: Discord approvals need a Discord application, a bot token and a public HTTPS endpoint that answers within
  3 seconds. That is more setup than Telegram, so Discord comes last; webhook-only notifications are cheap.

### 3.4 E-mail

* **Resend:** `POST https://api.resend.com/emails` with `Authorization: Bearer`; fields `from`, `to` (≤ 50), `subject`,
  `html` or `text`, custom `headers`; `Idempotency-Key` header (≤ 256 characters, 24 h). [V][E1]
* **Postmark:** `POST https://api.postmarkapp.com/email` with `X-Postmark-Server-Token`; fields `From`, `To`, `Subject`,
  `HtmlBody`/`TextBody`, `MessageStream`, `Headers`; ≤ 50 recipients. [V][E2]
* **Amazon SES v2** `SendEmail` (`POST /v2/email/outbound-emails`, JSON, 429 when throttled) [V][E3] needs AWS Signature
  V4 request signing [S]: doable with `node:crypto`, but more work and more to get wrong than a bearer-token API.
* **nodemailer:** version 10.0.10 (2026-09-14), licence MIT-0, **no runtime dependencies**, Node ≥ 20. [V][E4] Still a
  new dependency under ADR-031, but a small one, and it enables plain SMTP to any server.
* **SMTP without a library** (STARTTLS, AUTH, dot-stuffing, MIME, bounces) is not worth writing.
* **One-click unsubscribe (RFC 8058):** `List-Unsubscribe` with one HTTPS URI plus
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; the mail receiver POSTs; both headers must be DKIM-signed. [V][E5]

### 3.5 Security references for remote actions

* OWASP: stateful applications should use the synchronizer token pattern; Fetch Metadata (`Sec-Fetch-Site`) can be a
  primary CSRF signal with a fallback for old browsers; SameSite is defence in depth; "Do not use GET requests for state
  changing operations". [V][S1] The existing exact-`Origin` check stays; the confirm endpoint additionally rejects
  `Sec-Fetch-Site` values other than `same-origin` when the header is present, and the action token acts as the
  per-request synchronizer token.
* RFC 8058 §1: anti-spam software fetches resources in mail automatically, and a sender cannot tell an automatic
  request from a human one, which is why a `GET` must not perform the action. [V][E5]
* Microsoft Defender for Office 365 Safe Links scans URLs before delivery, detonates URLs without reputation in the
  background and checks them again at click time. [V][S2] An e-mailed approval link that acted on `GET` would be
  triggered by the scanner.

### 3.6 Lock-screen privacy

* iOS "Show Previews" can be Always (previews on the Lock Screen even when the phone is locked), When Unlocked or
  Never. [V][P1] Web push notifications appear on the Lock Screen, in Notification Center and on a paired Apple Watch.
  [V][W6]
* Android lets users choose how much notification content appears on the lock screen, and apps can mark content as
  sensitive. [V][P2]
* The platform defaults were not verified. [S] The plan therefore assumes content can be read on a locked phone.

## 4. Event catalogue and routing

### 4.1 Notification kinds

| Kind | Source event(s) | Default recipients | Default channels | Actionable |
|---|---|---|---|---|
| `approval.requested` | `approval.required` | users who could decide it now: global `admin`/`owner` with project access (ADR-022); `production_deploy` owners only | in-app + all active external | yes (§7) |
| `approval.resolved` | `approval.decided` (approved, rejected, expired) | recipients of the matching `approval.requested` | in-app; external only edits/withdraws earlier messages | no |
| `approval.expiring` | scheduler: pending approval within 12 h of expiry (`expires_at` or TTL) | same as requested | in-app + external | yes |
| `budget.warning` | **new event** `budget.threshold_reached` at 80 % and 90 % of a scope (global daily, project, autopilot session) | admins/owner; project scope also project admins | in-app + external | no |
| `budget.exhausted` | `budget.exhausted` | same | in-app + external | no |
| `ci.failed` | `ci.failed` with classification `code` (infra failures only in-app) | project operators+ who are members, plus the task's requester when known | in-app; external opt-in | no |
| `run.finished` / `run.failed` | `task.completed`, `task.failed`, `task.blocked`, `deployment.completed`; later ADR-037 `workflow.run.*` | project operators+ (opt-in), session starter for autopilot runs | in-app; external opt-in (failed: default on for session starter) | no |
| `autopilot.stopped` | `autopilot.session.stopped`, `autopilot.session.killed` | session starter, owner | in-app + external; security kill breaks through quiet hours | no |
| `room.mention` | **new event** `room.mention` (see §4.3) | the mentioned user, if they can still read the project | in-app + external opt-in | no |
| `channel.problem` | delivery dead-lettered or channel disabled (410, bot blocked) | the channel owner | in-app only | no |

### 4.2 Routing is a pure function

`routeEvent(event, directory, now) → NotificationIntent[]` in `packages/core/src/notifications/router.ts`:

* `directory` is a read-only snapshot passed in by the caller: users with global roles, memberships of the event's
  project, per-user preferences, project mutes. Core stays IO-free.
* Recipient eligibility re-implements nothing: the effective project role rule from `acl.ts` (`lowerRole`, owners and
  admins see everything, `PROJECT_ACL=off` means everybody) moves into a pure `effectiveProjectRole()` in core, used by
  both the server ACL and the router (small refactor, covered by the existing `acl.test.ts`).
* Each intent carries `kind`, `severity` (`info | warning | critical`), `projectId`, `refs` (ids only), whitelisted
  `params` (numbers, enum values, ids, and at most two sanitised short strings such as task title and project name),
  a `dedupeKey` (e.g. `approval.requested:<approvalId>`) and a `groupKey` for coalescing (e.g.
  `ci.failed:<projectId>:<prNumber>`).
* Only human authors produce mentions; events without a project go to owners/admins only.

### 4.3 New events

* `budget.threshold_reached { scope, scopeId, percent: 80 | 90, usedUsd, limitUsd }`: emitted by `AgentRuntime` after
  recording spend when a scope crosses a threshold (the guard already computes the numbers); dedupe per scope, period
  and threshold is done by the notification dedupe key, so a repeated emit is harmless.
* `room.mention { conversationId, messageId, recipientUserId }`: `RoomService` extracts `@login` tokens (linear
  scanner, max 10 per message), resolves them against project members passed in by the caller, stores
  `refs.mentions` and emits one content-free event per mentioned user. The body never enters the event.
* `notification.created { notificationId, recipientUserId, unread }` and `notification.read { recipientUserId, unread }`:
  content-free, for the bell.

**Audience filter.** Events with `payload.recipientUserId` are delivered on SSE and returned by `/api/events` only to
that user, whatever their role (admins included). `eventVisible` gains a user argument; the change is tested in
`acl.test.ts` with an admin who must not see another user's `notification.created`.

### 4.4 From events to notifications (durable, multi-instance)

The router does not subscribe to the in-process bus (a crash between publish and handling would lose the
notification). It treats `events` as an outbox:

1. A `notification.route` job (singleton by dedupe key, enqueued by the worker tick) locks the cursor row
   (`settings` key `notifications.cursor`, `SELECT … FOR UPDATE`), reads up to 500 events with
   `id > cursor AND created_at < now() - 5 s`, loads the directory, runs `routeEvent`, inserts notifications with
   `ON CONFLICT (user_id, dedupe_key) DO NOTHING`, creates deliveries, and advances the cursor in the same transaction.
2. The 5-second lag covers bigserial ids that commit out of order (a known gap in id-cursor replay; ADR-024 has the
   same trade-off). A late event older than the lag window is still picked up because the query is by id; only an
   event committed more than 5 s after a higher id would be skipped, which the notification `dedupe_key` makes safe to
   re-scan: every 10 minutes the job re-scans the last 15 minutes of ids.
3. PGlite (single process) runs the same code.

## 5. Data model (one migration, `0004_notifications` or the next free number)

| Table | Columns | Notes |
|---|---|---|
| `notification_settings` | `user_id` pk, `locale` (`de` default, `en`), `time_zone` (IANA), `quiet_hours` jsonb `[{days, from, to}]`, `digest` jsonb `{interval: 'hourly' \| 'daily', at: '08:00'}`, `preview_level` (`minimal` \| `standard`), `remote_approvals` bool default false, `updated_at` | one row per user, created lazily |
| `notification_preferences` | `user_id`, `kind`, `channel_kind`, `mode` (`instant` \| `digest` \| `off`), `break_through_quiet_hours` bool; unique (`user_id`, `kind`, `channel_kind`) | only overrides are stored; defaults live in core |
| `notification_project_mutes` | `user_id`, `project_id`, `until` null, `created_at`; unique (`user_id`, `project_id`) | approvals still reach the in-app centre when muted |
| `notification_channels` | `id`, `user_id`, `kind` (`web_push` \| `telegram` \| `discord_dm` \| `discord_webhook` \| `email`), `label`, `status` (`pending` \| `active` \| `disabled` \| `failed`), `target_encrypted` (push subscription JSON, Telegram chat and user id, Discord user id or webhook URL, e-mail address), `target_fingerprint` (sha256 for uniqueness and lookup, e.g. Telegram user id), `created_at`, `verified_at`, `last_success_at`, `consecutive_failures`, `disabled_reason` | unique (`kind`, `target_fingerprint`); max 10 channels per user |
| `notification_link_codes` | `code_hash` pk, `user_id`, `kind`, `expires_at` (10 min), `used_at` | Telegram deep-link codes, e-mail verification |
| `notifications` | `id`, `user_id`, `project_id` null, `kind`, `severity`, `params` jsonb (whitelisted), `refs` jsonb, `source_event_id`, `dedupe_key`, `group_key`, `actionable`, `created_at`, `read_at`, `resolved_at`; unique (`user_id`, `dedupe_key`); index (`user_id`, `read_at`, `created_at desc`) | the in-app centre; retention 90 days |
| `notification_deliveries` | `id`, `notification_id`, `channel_id`, `status` (`queued` \| `held` \| `batched` \| `sending` \| `sent` \| `failed` \| `dead` \| `suppressed` \| `withdrawn`), `not_before`, `attempts`, `provider_ref` (Telegram `chat_id:message_id`, Discord message id), `last_error` (redacted, ≤ 500 chars), `sent_at`, `created_at`; unique (`notification_id`, `channel_id`) | a digest delivery references several notifications through `notification_digest_items` |
| `notification_digest_items` | `delivery_id`, `notification_id` | |
| `approval_action_tokens` | `id` (public token id), `token_hash` unique, `approval_id`, `user_id`, `decision` (`approve` \| `reject` \| `open`), `approval_digest`, `channel_kind`, `delivery_id`, `created_at`, `expires_at`, `used_at`, `used_via`, `used_ip` | single use by compare-and-set; purged 7 days after expiry |

`approval_digest` = sha256 over the canonical JSON of (`approval.id`, `action`, `risk`, `details`, `requestedAt`,
`runId`). It is a pure core function, so no `approvals.version` column is needed: approvals are immutable apart from
their status, and a re-requested gate is a new row. If a future change makes approval details mutable, the digest
catches it.

Instance-level channel configuration (Telegram bot token, Discord public key and bot token, e-mail provider key, VAPID
private key when not given by environment) is stored encrypted in `settings` under `notifications.*`, edited by
admins only, audited, never returned by the API (hint of the last 4 characters only).

## 6. Core (IO-free), integrations, server

### 6.1 Core: `packages/core/src/notifications/`

| File | Content |
|---|---|
| `types.ts` | `NotificationKind`, `ChannelKind`, `Severity`, `NotificationIntent`, `PreferenceMode`, `PreviewLevel`, `RemoteApprovalMode` |
| `router.ts` | `routeEvent` (§4.2) |
| `preferences.ts` | `DEFAULT_PREFERENCES` matrix, `resolvePreference(user, kind, channel, project)` including mutes |
| `schedule.ts` | `planDelivery(intent, prefs, settings, now) → { notBefore, mode: 'instant' \| 'held' \| 'batched' \| 'suppressed' }`; quiet hours evaluated with `Intl.DateTimeFormat` in the user's time zone (DST-safe, same approach as autopilot quiet hours); throttle `maxPerHour` per user and channel (default 20; overflow becomes a digest); coalescing by `groupKey` within 10 minutes ("3 CI-Fehler in Projekt X") |
| `render.ts` | `renderNotification(kind, params, locale, previewLevel, channel) → { title, body, url, tag }`; German and English template tables; `sanitizeInline` + `redactSecrets` on every string param; strips URLs from untrusted strings; length caps per channel (push title 60, body 140; Telegram 600) |
| `remote-approval.ts` | `remoteApprovalMode(action, risk, channel, instancePolicy, userSettings) → 'one_tap' \| 'confirm_page' \| 'in_app_only'` (§7.3) and `approvalDigest(approval)` |
| `approval-decision.ts` | `authorizeDecision({ user, approval, projectRole, decision, via }) → ok \| { code, reason }`: the checks that live inline in `routes.ts` today (global admin, project admin, owner for `production_deploy`, pending status, remote tier). The existing route and every remote path call it |
| `ports.ts` | `NotificationChannel` (below), `NotificationRepository`, `ActionTokenRepository`, `NotificationDirectory` |
| `testing/fake-channels.ts` | `RecordingChannel` (captures rendered messages, scriptable failures: retryable, `retryAfterMs`, permanent, `disableChannel`) |

```ts
export interface NotificationChannel {
  readonly kind: ChannelKind;
  send(message: RenderedMessage, target: ChannelTarget, actions: ChannelAction[]): Promise<SendResult>;
  /** Edits or withdraws an earlier message where the platform allows it (Telegram, Discord). */
  update?(providerRef: string, message: RenderedMessage): Promise<SendResult>;
}
export type SendResult =
  | { ok: true; providerRef: string | null }
  | { ok: false; retryable: boolean; retryAfterMs?: number; disableChannel?: boolean; error: string };
```

### 6.2 Integrations: `packages/integrations/src/notifications/`

All adapters take an injected `fetch` and clock, never log targets or tokens, use `AbortSignal.timeout(10_000)`, and
refuse redirects (`redirect: 'error'`).

| Adapter | Notes |
|---|---|
| `web-push/ece.ts`, `web-push/vapid.ts`, `web-push/channel.ts` | RFC 8291 `aes128gcm` encryption and RFC 8292 VAPID JWT with `node:crypto` (option A, §3.1), or a thin wrapper around `web-push` (option B). Endpoint allow-list (§9, T9). 404/410 → `disableChannel`; 429/5xx → retry with `Retry-After`; 413 → permanent (bug) |
| `telegram.ts` | `sendMessage` (plain text, no `parse_mode`, so repository text cannot inject markup), inline keyboard, `editMessageText`/`editMessageReplyMarkup`, `answerCallbackQuery`, `setWebhook` with `secret_token`, `getUpdates` long polling. 429 → `parameters.retry_after`; 403 (bot blocked) → `disableChannel` |
| `discord-webhook.ts` | one-way posts to a channel webhook with `allowed_mentions: { parse: [] }`; no approvals |
| `discord-interactions.ts` | Ed25519 verification with `crypto.verify(null, timestamp + body, publicKey, signature)` (public key imported as JWK/SPKI), PING/PONG, button components; DM sending via bot token (stage 5) |
| `email/resend.ts` or `email/postmark.ts` | HTTP API via `fetch` behind an `EmailSender` port; text + minimal HTML, no remote images, no tracking; `List-Unsubscribe` header to the settings page |

### 6.3 Server (`apps/server`)

New modules following ADR-016: `notifications.ts` (composition: channels from config, router job, delivery job,
Telegram poller), `routes-notifications.ts`, `routes-approval-actions.ts`, `routes-notification-webhooks.ts`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/me/notifications?before=&unread=&kind=` | session | list (≤ 50), ids and whitelisted params; the web renders text |
| GET | `/api/me/notifications/unread-count` | session | badge |
| POST | `/api/me/notifications/read` `{ ids } \| { all: true }` | session | mark read; emits `notification.read` |
| GET, PUT | `/api/me/notification-settings` | session | settings, preference overrides, mutes |
| GET | `/api/me/notification-channels` | session | channel list with status, never targets |
| DELETE | `/api/me/notification-channels/:id` | session | remove (Telegram: also a goodbye message) |
| POST | `/api/me/notification-channels/:id/test` | session, 5/h | test message |
| GET | `/api/notifications/web-push/key` | session | VAPID public key |
| POST | `/api/me/notification-channels/web-push` `{ subscription, label }` | session, 10/h | register; endpoint allow-list, key length checks |
| POST | `/api/me/notification-channels/telegram/link` | session, 5/h | returns `https://t.me/<bot>?start=<code>`; code 32 random bytes, hash stored, 10 min |
| POST | `/api/me/notification-channels/email` | session, 3/h | stores pending address, sends verification link (confirm page + POST) |
| GET | `/api/approval-actions/:token` | session | **read-only** validation: returns approval summary, allowed decisions and the remote mode for this user; never consumes |
| POST | `/api/approval-actions/:token/decide` `{ decision, approvalDigest, comment? }` | session + Origin (existing CSRF hook) + 10/min per user | redeem (§7.2) |
| POST | `/api/webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` compared in constant time, 300/min | updates: `/start <code>`, `callback_query` |
| POST | `/api/webhooks/discord/interactions` | Ed25519 signature + timestamp within 5 min, raw body, 300/min | PING, button interactions |
| GET, PUT | `/api/admin/notifications` | admin | enable channels instance-wide, bot token, provider key, remote approval policy ceiling; audited |

`POST /api/approvals/:id/decide` keeps its contract and calls the shared `decideApproval` service
(`apps/server/src/approval-decisions.ts`): load approval → `authorizeDecision` (core) → repository compare-and-set →
`orchestrator.onApprovalDecided` → audit `approval.approved|rejected` with `via` (`web`, `push_confirm`,
`email_confirm`, `telegram`, `discord`) and `tokenId` → withdraw open action tokens and outstanding external messages for
this approval.

### 6.4 Worker and delivery

| Job | Dedupe key | Max attempts | Behaviour |
|---|---|---|---|
| `notification.route` | `notifications:route` | 3 | §4.4; enqueued by the worker tick every tick |
| `notification.deliver` | `notification-delivery:<deliveryId>` | 6 (backoff 5 s … 10 min from `job-queue.ts`) | load delivery, re-check recipient eligibility (a user who lost access gets nothing), re-check quiet hours, render, issue action tokens (§7), `channel.send`; `Retry-After` beats the queue backoff via `runAt`; permanent error → `fail(..., { retryable: false })` |
| `notification.digest` | `notification-digest:<userId>:<channelId>:<window>` | 6 | bundles `batched` deliveries into one message, no action buttons (links to the centre) |
| `notification.withdraw` | `notification-withdraw:<approvalId>` | 4 | edits Telegram/Discord messages to "Bereits entschieden von <login>" and removes buttons; push replaces the notification by `tag` only if the user opted in (it costs a visible notification on iOS) |
| `notification.expiring` | part of the tick | – | finds approvals ≤ 12 h before expiry |
| `telegram.poll` | `telegram:poll` | ∞ (lease-based) | only with `TELEGRAM_MODE=polling`: one long-poll loop per instance, holder guarded by the job lease so only one instance polls |

Dead letters: when the queue dead-letters a delivery job the delivery becomes `dead`, `consecutive_failures`
increments, three dead deliveries in a row set the channel to `failed`, and a `channel.problem` notification appears
in-app. Metrics (ADR-021): `orch_notifications_created_total{kind}`,
`orch_notification_deliveries_total{channel,outcome}`, `orch_remote_approval_attempts_total{via,outcome}`.
`WorkerPool.processNext` claims the new job types like `intelligence.jobTypes`.

Configuration: `NOTIFICATIONS_ENABLED` (default on in development, off in production until configured),
`WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` (`mailto:` or `https:`),
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_MODE=polling|webhook`, `TELEGRAM_WEBHOOK_SECRET`, `DISCORD_PUBLIC_KEY`,
`DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `EMAIL_PROVIDER=resend|postmark`, `EMAIL_API_KEY`, `EMAIL_FROM`,
`REMOTE_APPROVALS=off|reject_only|tiered` (instance ceiling, default `reject_only`), `ACTION_TOKEN_TTL_MINUTES`
(default 30, max 120). Environment values win over stored settings; the log redactor learns the Telegram
`/bot<token>/` URL shape.

## 7. Secure one-tap approvals from outside the app

### 7.1 Action tokens

* **Opaque, not self-contained.** 32 random bytes (base64url, 43 characters), only `sha256(token)` stored, exactly
  like sessions (ADR-007). A signed stateless token (JWT/HMAC) would still need a database row for single use and
  revocation, so the signature buys nothing and adds key management.
* **Bound** in the row to `approval_id`, `user_id`, `decision`, `approval_digest`, `channel_kind` and `delivery_id`.
* **Short-lived:** `expires_at = min(now + ACTION_TOKEN_TTL_MINUTES, approval expiry)`. Default 30 minutes; a
  notification read later than that shows "Link abgelaufen – in der App öffnen", which links to the approval page.
* **Single use:** `UPDATE approval_action_tokens SET used_at = now(), used_via = $via WHERE token_hash = $h AND
  used_at IS NULL AND expires_at > now() RETURNING *`. Only one of two concurrent redemptions gets a row.
* **Revocation:** all open tokens of an approval are invalidated when it is decided or expires, when the user's role or
  membership changes, when the channel is removed and on logout-everywhere.
* Per message: a push or e-mail carries one `open` token (link to the confirm page); Telegram/Discord messages carry
  one `approve` and one `reject` token id in the button payload (Telegram `callback_data` is limited to 64 bytes, so
  the payload is `a:<token>` or `r:<token>` = 45 bytes).

### 7.2 Redemption paths

**Confirm page (push, e-mail, "open in app" links).**

1. The link is `https://<APP_ORIGIN>/a/<token>`. `GET` renders a page and calls
   `GET /api/approval-actions/:token`, which only validates. Link scanners and prefetchers that follow `GET` links can
   therefore never decide anything (§3.5).
2. The page requires a session in that browser. Without one it redirects to login and back (`next` limited to
   same-origin paths). The token user must equal the session user; otherwise the answer is 404, as for a foreign
   approval under ADR-022.
3. The page shows server-loaded facts only: project, action in words, risk, requester (run/task), requested at,
   expiry, the dependency or gate findings summary, and the full app origin in the header. Nothing from the link except
   the token.
4. The decision is a `POST` with the session cookie, the existing exact-`Origin` CSRF check, the token and the
   `approvalDigest` the page received. A digest mismatch (the approval changed) is 409 and the page reloads.
5. Response pages carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, no third-party resources, and the
   token is removed from the address bar with `history.replaceState` after load.

**Platform-verified callbacks (Telegram, Discord).**

1. Webhook authenticity: Telegram secret-token header (constant-time compare) or long polling (no inbound endpoint at
   all); Discord Ed25519 signature over `timestamp + rawBody` with a 5-minute timestamp window.
2. The sender identity comes from the platform payload: Telegram `callback_query.from.id`, Discord `member.user.id`
   or `user.id`. It must equal the identity stored on the user's linked channel, and the chat must be a private chat
   (group chats are notification-only).
3. Replay: token single use; additionally `callback_query.id` / interaction id are remembered for 24 h (unique index
   in a small `notification_callback_ids` table or the audit log) so a replayed update is acknowledged and ignored.
4. After the decision the bot answers the callback (Telegram requires `answerCallbackQuery`) and edits the message to
   "Freigegeben von @login um 14:32" without buttons.

**Always at decision time:** `authorizeDecision` re-checks global role, project role, owner-only `production_deploy`,
pending status, not expired, the remote mode for this action, channel still active, user remote approvals enabled.
Every attempt, successful or not, is audited as `approval.remote_attempt` with `via`, `tokenId`, outcome and IP (for
the confirm page), never the token. Rate limits: 10 redemptions per user per minute, 30 failed token lookups per IP
per 10 minutes (then 429), and a daily cap of 20 remote approvals per user (rejects are not capped).

### 7.3 Remote approval policy (recommendation)

| Tier | Gated actions | Remote approve | Remote reject | Why |
|---|---|---|---|---|
| **A** | `publish_changes`, `architecture_change`, `high_cost` | one tap in Telegram/Discord; confirm page for push and e-mail | one tap | Reversible: a PR is not a merge, cost is capped by budgets, architecture changes still go through review and CI |
| **B** | `database_migration`, `external_service`, `critical_infrastructure` | confirm page only, in an authenticated app session, after the details have been displayed | one tap | Reversible with effort; the decider must see paths and reasons, which a chat message must not contain |
| **C** | `production_deploy` (includes merges), `dependency_addition`, `secrets_permissions`, `destructive_data` | **never remote**: the notification only offers "In der App prüfen" and deciding happens on `/approvals` with the full findings list | one tap | Irreversible or supply-chain relevant (ADR-031: the human has to actually look at package names, sources and lockfile findings) |

Rules around the table:

* `risk = high` moves an action one tier stricter; nothing ever moves looser.
* Instance ceiling `REMOTE_APPROVALS` (`off`, `reject_only` default, `tiered`) and the per-user
  `remote_approvals` switch (default off) can only restrict.
* Rejecting is fail-safe (the run blocks with a reason, ADR-023 retry path), so it is always one tap.
* Optional step-up for tier C inside the app (open question 4): require a session created within the last 15 minutes.
  This is weak with GitHub OAuth, because GitHub signs a logged-in user in again without a prompt; strong step-up would
  need WebAuthn, which is a separate feature.

### 7.4 Phishing-resistant wording

* Every external message names the instance ("AI Orchestrator · <host>") and ends with the same fixed footer:
  "Wir fragen nie nach Passwörtern, Tokens oder Codes. Entscheide nur in der App unter <host> oder mit den Buttons
  in diesem Chat."
* Links point only to `APP_ORIGIN`, never shortened, never to repository-provided URLs.
* Untrusted strings (task titles, project names, package names) are sanitised, capped at 80 characters, stripped of
  URLs and rendered as quoted data ("Aufgabe: „…"") so a task titled "DRINGEND: sofort freigeben" cannot look like
  system text. Telegram messages use plain text without `parse_mode`.
* Buttons use explicit verbs with the object: "Freigeben: Architekturänderung", "Ablehnen". No "OK".
* The confirm page never asks for credentials; login goes through the normal login page.
* Telegram linking shows the bot's `@username` in the settings page and the linked Telegram name back in the app, so
  a user notices a wrong bot.

## 8. Preferences, quiet hours, digests, privacy, localisation

* **Defaults** (per kind × channel, in core): approvals and autopilot stops instant everywhere the user has a channel;
  budget warnings instant; CI failures and run results in-app only; mentions in-app plus instant on external channels.
  In-app is always on for actionable kinds (cannot be turned off, only muted per project for non-actionable ones).
* **Quiet hours:** per user, time zone, weekday windows. Deliveries become `held` until the window ends; in-app entries
  are still created. Break-through per kind is opt-in; the only default break-through is a security-denial kill of an
  autopilot session. Approvals whose expiry falls inside the quiet window get an `approval.expiring` before it starts.
* **Digest:** `mode = digest` or throttle overflow collects deliveries into hourly or daily bundles per channel with
  counts per kind and project, and one link to `/notifications`. Digests never carry action buttons.
* **Dedupe and throttling:** unique (`user_id`, `dedupe_key`); coalescing by `group_key` within 10 minutes updates the
  existing unread in-app entry (count + latest time) and edits the Telegram message instead of sending a new one; hard
  cap 20 external messages per user per channel per hour.
* **Project mute:** hides non-actionable kinds of that project from external channels and marks them read-muted
  in-app; optional `until`.
* **Lock-screen privacy:** notification bodies contain only ids, enum words, counts, and at most project name and task
  title (sanitised). Never: secrets, code, diffs, file paths, CI logs, model output, room message bodies, e-mail
  addresses, cost details beyond "80 % des Tagesbudgets". `preview_level = minimal` reduces push titles to
  "Neue Freigabe wartet" / "Neue Benachrichtigung" and hides project names (recommended default for push, open
  question 5). Telegram and e-mail content is stored by the platform or provider, which the settings page states.
* **Localisation:** German is the default locale (the product UI is German-first, e.g. the AI Hub and the autopilot
  digest "Während du weg warst"); English templates exist for every key. Templates are code, not model output. Dates
  are formatted with `Intl` in the user's time zone. The rendered text is produced at send time, so a locale change
  applies to future messages.

## 9. Security threat model

| # | Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| T1 | Leaked action link (forwarded e-mail, screenshot, browser history, logs) is used by someone else | M | H | session required on the confirm page and must match the token user; tokens single use, 30 min, hashed at rest; `no-store`, `no-referrer`, token removed from the URL; server logs record route templates, not URLs with tokens (request logging uses `routeOptions.url`) |
| T2 | Link scanners or prefetchers trigger a decision | H | H | `GET` never mutates; decisions only by `POST` with Origin check or platform-verified callbacks |
| T3 | CSRF on the confirm endpoint | L | H | existing exact-`Origin` check, `SameSite=Lax` cookie, token in body path, digest in body |
| T4 | Forged Telegram/Discord webhook calls | M | H | secret token header (constant time) or polling; Ed25519 verification with timestamp window; raw-body parsing like the GitHub webhook |
| T5 | Replay of a callback or POST | M | M | single-use CAS on the token, callback id memory, approval status CAS in the repository |
| T6 | Compromised Telegram/Discord account or stolen unlocked phone approves | M | H | tier policy (C never remote, B only in-app), remote approvals off by default, daily cap, instant audit + in-app notice "Freigabe per Telegram durch dich" to all the user's other channels, one-click "unlink all channels" |
| T7 | Telegram chat hijack during linking (guessing or intercepting the `/start` code) | L | H | 256-bit code, 10 min, single use, bound to the logged-in user who created it; the app shows the linked Telegram name and requires confirming it before the channel becomes active |
| T8 | Privilege change between notification and tap (demoted, removed from project, approval re-requested) | M | M | `authorizeDecision` at decision time, token revocation on role/membership change, digest binding |
| T9 | SSRF through a client-supplied push endpoint | M | H | endpoint must be `https:` on a configurable allow-list of push services (default `*.push.apple.com` [V][W6], plus `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com` [S], to be confirmed against real subscriptions in stage 3), resolved address must be public, no redirects, 10 s timeout, body ≤ 4 KB |
| T10 | Phishing that imitates notifications | M | H | §7.4 wording, fixed origin, no credentials ever requested, confirm page shows full origin; e-mail only from a verified sending domain with SPF/DKIM/DMARC at the provider |
| T11 | Sensitive data on lock screens or at third-party platforms | H | M | privacy rules in §8, `minimal` preview default for push, whitelisted params, render snapshot tests |
| T12 | Injection through untrusted strings (markup, bidi, fake buttons, links) | M | M | `sanitizeInline`, URL stripping, plain-text Telegram, `allowed_mentions: { parse: [] }` on Discord, React text nodes in-app |
| T13 | Notification flood (runaway CI failures, mention spam) or cost through e-mail provider | M | L | coalescing, per-user caps, digest overflow, mentions only from humans (≤ 10 per message), room post rate limit already 30/min |
| T14 | Bot token or provider key leak via logs or API | M | H | encrypted at rest, env preferred, redaction of `/bot<token>/` URLs and `Authorization` headers, admin API returns hints only, audit on change |
| T15 | Cross-user leak of notification events over SSE or `/api/events` | M | M | `recipientUserId` audience filter also for admins; content-free events; list API always scoped to the session user |
| T16 | Service worker abuse (malicious `notificationclick` URL, stale SW) | L | M | SW opens only same-origin paths from `data.url` it validates; `sw.js` served with `Cache-Control: no-cache` and a strict CSP; no `importScripts` from other origins |
| T17 | A notification path grants approvals the in-app path would deny | L | H | a single `authorizeDecision` used by every path, contract test that runs the same matrix through all five `via` values |

## 10. Web UI (`apps/web`)

* **Global bell** (`components/notifications/bell.tsx`) in the shell header between `AutopilotButton` and
  `LiveIndicator`; the AI Hub header reuses it instead of its own link. Badge from `unread-count`, refreshed on
  `notification.created`/`notification.read` SSE events through the existing `LiveEventsProvider`. Popover with the
  latest 20 (kind icon, text from local templates, time, project), "Alle als gelesen markieren", link "Alle anzeigen".
  Accessible name "Benachrichtigungen, 3 ungelesen". Pending approvals appear first with "Prüfen".
* **`/notifications`**: filters (Ungelesen, Freigaben, CI, Läufe, Autopilot, Erwähnungen, Budget), infinite list by
  cursor, resolved approvals greyed out with the decision.
* **`/settings/notifications`**: channels ("Push auf diesem Gerät aktivieren" with a user-gesture permission request;
  an iOS hint "Zum Home-Bildschirm hinzufügen" when `display-mode: standalone` is false on iOS; Telegram "Verbinden"
  deep link with status polling; Discord; E-Mail with verification), kind × channel matrix, quiet hours with time zone
  picker, digest, preview level, "Freigaben von unterwegs erlauben" with the tier table from §7.3 in plain German,
  project mutes, test message, "Alle Kanäle trennen".
* **`/a/[token]`** confirm page (§7.2): compact, mobile-first, large buttons, shows "Diese Seite fragt nie nach
  Passwörtern", disabled approve button with explanation for tier C.
* **PWA:** `app/manifest.ts` (name, short name, `start_url: '/'`, `display: 'standalone'`, theme and background
  colours, 192/512 px and maskable icons as PNG files in `public/icons/`), `public/sw.js` with `push`
  (`showNotification(title, { body, tag, data: { url } })`), `notificationclick` (focus an existing client or
  `clients.openWindow` for same-origin paths only) and `pushsubscriptionchange` (re-subscribe and POST). The pure URL
  validation and payload parsing live in `lib/push/*.ts` so vitest covers them; `sw.js` stays a small wrapper.
  `next.config.ts` adds headers for `/sw.js` (`Cache-Control: no-cache, no-store, must-revalidate`,
  `Content-Security-Policy: default-src 'self'; script-src 'self'`).

## 11. Stages and acceptance criteria

| Stage | Scope | Acceptance criteria |
|---|---|---|
| **0 — Groundwork** (part of stage 1 PR) | `effectiveProjectRole` and `authorizeDecision` in core; `decideApproval` service used by the existing route; `approvalDigest`; audience filter for events | (a) existing approval, ACL and expiry tests stay green unchanged; (b) a matrix test proves the route and `authorizeDecision` agree for every role × action × status; (c) an admin does not receive another user's `notification.created` on SSE or `/api/events` |
| **1 — In-app centre (recommended first slice, part 1)** | migration; router job with cursor; `routeEvent` for approvals, budget (incl. new `budget.threshold_reached`), CI, runs, autopilot; preferences, mutes, quiet hours, throttle, coalescing; delivery pipeline with `RecordingChannel`; `/api/me/notifications*`; global bell, `/notifications`, settings page without external channels | (a) `approval.required` creates exactly one notification per eligible user, none for a viewer or a non-member operator under `PROJECT_ACL=enforced`; (b) re-running the router over the same events creates no duplicates; (c) a worker crash after insert but before the cursor update produces no duplicate and no loss; (d) quiet hours across a DST change hold and release deliveries at the right instant (fake clock); (e) 25 `ci.failed` in 5 minutes for one PR become one coalesced entry and ≤ 1 external message; (f) budget warning at 80 % and 90 % fires once per scope and day; (g) bell count updates within one SSE event; (h) render snapshots contain no secret patterns, paths or URLs from untrusted params |
| **2 — Telegram (first slice, part 2)** | bot configuration (admin), deep-link linking with confirmation, polling and webhook modes, notifications, withdraw/edit on decision, one-tap reject, tier-A one-tap approve behind `REMOTE_APPROVALS=tiered` and the user switch | (a) against a fake Bot API server: link → `/start <code>` → pending → confirmed in app → active; an expired or reused code fails; (b) webhook with a wrong secret → 401 and nothing processed; (c) callback from a different `from.id` → ignored, audited; (d) tier C approve button never rendered, and a forged `a:` payload for a tier C approval is denied; (e) double tap → one decision, second callback answered "bereits entschieden"; (f) user demoted between send and tap → denied; (g) 403 "bot was blocked" disables the channel and creates `channel.problem`; (h) 429 `retry_after` respected; (i) no bot token in logs (log capture test) |
| **3 — Web Push + PWA + confirm page** | manifest, service worker, subscription API, RFC 8291/8292 implementation (or `web-push` after approval), endpoint allow-list, `/a/[token]` confirm page | (a) encryption reproduces the RFC 8291 worked example byte for byte with its fixed keys and salt; (b) VAPID JWT verifies with `crypto.verify` and has `aud` = push service origin, `exp` ≤ 24 h; (c) `GET /api/approval-actions/:token` never consumes (called 5 times, then POST still works); (d) POST without session 401, other user's token 404, wrong Origin 403, digest mismatch 409, expired 410, second POST 409; (e) endpoint `http://169.254.169.254/` or a non-allow-listed host rejected; (f) 410 from the push service removes the subscription; (g) manual device checklist in STATE.md: Android Chrome, iOS ≥ 16.4 home-screen app, desktop Chrome/Firefox/Safari |
| **4 — E-mail** (only after the owner's choice) | `EmailSender` port with one provider adapter or `nodemailer`; address verification; notifications and digests with "In der App öffnen" links (confirm page) | (a) verification link GET does not verify, POST on the page does; (b) no action tokens with `approve` decision are ever put into e-mail; (c) provider 429/5xx retried, 4xx permanent; (d) `List-Unsubscribe` points to the settings page |
| **5 — Discord** | webhook channel (instance or user level, one-way); optional app with interactions endpoint and DM buttons (tier A, reject) | (a) Ed25519 verification rejects a tampered body and a timestamp older than 5 minutes; PING answered with PONG; (b) webhook posts use `allowed_mentions: { parse: [] }`; (c) webhook URL stored encrypted and never logged |
| **6 — Mentions and polish** | `@login` mentions in the room (`refs.mentions`, `room.mention`), `approval.expiring`, digests, ADR-037 workflow events once they exist, retention job | (a) `@someone` who is not a project member creates nothing; (b) an agent or external AI message with mentions creates nothing; (c) mention notification text contains no message body; (d) expiring reminder fires once, 12 h before expiry, not inside quiet hours |

The autopilot plan §7.4 (outbound webhook) is superseded by stage 5's webhook channel; the autopilot plan should point
here when this ADR is accepted.

## 12. Test strategy

* **Core (vitest, pure):** routing matrix per kind × role × membership × `PROJECT_ACL`; preference resolution incl.
  mutes; `planDelivery` with a fake clock over DST changes in `Europe/Berlin`; throttle and coalescing; render
  snapshots in `de` and `en` for both preview levels with hostile params (bidi characters, `ghp_` tokens, URLs, 10 KB
  titles); `remoteApprovalMode` table; `authorizeDecision` matrix; `approvalDigest` stability and sensitivity.
* **Fake channels:** `RecordingChannel` in `packages/core/src/testing` (scriptable success, retryable failure with
  `retryAfterMs`, permanent failure, `disableChannel`). Server tests compose the container with fake channels, exactly
  like the in-memory GitHub.
* **Integrations:** adapters against local fake HTTP servers (the pattern used for provider and GitHub adapters):
  Telegram API shapes and errors, Discord webhook and interaction responses, e-mail provider responses. Web Push
  encryption against the RFC 8291 Appendix A vector, a decrypt round trip with a generated user-agent key pair, VAPID
  signature verification. Ed25519 verification with a generated key pair and tampered inputs. Endpoint allow-list with
  hostile URLs.
* **Database (PGlite):** notification dedupe under two concurrent router runs; cursor lock; token single use with two
  concurrent redemptions (exactly one row returned); cascade on user deletion; retention purge.
* **Server API:** confirm-page flow (§11 stage 3 d), Telegram webhook and polling handlers, rate limits (429), audit
  entries for every attempt, SSE audience isolation, admin configuration never returns secrets.
* **Worker:** retry with `Retry-After`, dead letter → channel `failed` + `channel.problem`, withdraw after a decision
  made in the web UI.
* **Web:** pure libraries (`lib/push/*`, notification text templates, settings form validation) with vitest; the
  known gap of component tests (STATE.md) remains; screenshot QA of bell, centre, settings and confirm page at 375 px
  in light and dark.
* **Manual:** real devices once per channel before a stage is marked done, recorded in `docs/STATE.md`.

## 13. Proposed ADR-038 (draft — not yet in `docs/DECISIONS.md`)

Numbering: ADR-031 dependency gate, 032 provider accounts (reserved), 033 planning assistant, 034 autopilot, 035 plugin
scout, 036 platform connectors, 037 workflows (claimed) → this plan proposes **ADR-038**. If a parallel draft claims
the same number, the later merge renumbers.

> ## ADR-038 — Notifications and remote approvals
> * **Context:** Away mode (ADR-034) parks approvals and stops sessions, but nobody learns about it until they open the
>   app. The owner wants push, e-mail, Telegram or Discord messages and one-tap decisions from the phone. Every new
>   dependency needs approval (ADR-031); approvals are admin-only with owner-only production deploys (ADR-007,
>   ADR-022) and expire (ADR-023).
> * **Decision:**
>   * The persisted `events` table is the outbox. A pure `routeEvent` in core turns events into per-user
>     notifications, using the ADR-022 effective-role rule; a cursor job with a commit lag and dedupe keys makes routing
>     at-least-once without duplicates. In-app notifications are the source of truth; channel deliveries are jobs on
>     the existing queue with retries and dead letters.
>   * Channels are adapters behind a `NotificationChannel` port: in-app, Telegram, Web Push, e-mail, Discord. No
>     library is added without owner approval; Telegram, Discord and e-mail providers are called with `fetch`, Web Push
>     crypto uses `node:crypto` unless the owner approves `web-push`.
>   * Notification events are content-free and have a recipient audience that SSE and the event API enforce for every
>     role. External messages carry only whitelisted, sanitised parameters: no secrets, code, paths, logs, model output
>     or message bodies.
>   * Remote decisions use opaque single-use action tokens (hash stored, ≤ 30 min, bound to approval, user, decision
>     and approval digest). A `GET` never decides. Decisions happen by `POST` from an authenticated session with the
>     CSRF origin check, or by a platform-verified Telegram/Discord callback from the linked account in a private
>     chat. Every path calls one `authorizeDecision` at decision time and is audited with `via`.
>   * Remote approval tiers: A (`publish_changes`, `architecture_change`, `high_cost`) one tap; B
>     (`database_migration`, `external_service`, `critical_infrastructure`) confirm page in the app only; C
>     (`production_deploy`, `dependency_addition`, `secrets_permissions`, `destructive_data`) never remote. High risk
>     moves one tier stricter. Reject is always one tap. Instance default `reject_only`, user default off.
>   * Preferences per user × kind × channel with quiet hours, digests, coalescing, caps and per-project mutes; German
>     default locale.
> * **Consequences:** New tables (§5), job types and routes. Telegram works without a public endpoint through long
>   polling. iOS users must install the web app to the home screen for push. The autopilot plan's outbound webhook
>   becomes a Discord/webhook channel. Approving production deploys and new dependencies still requires opening the app.
> * **Status:** Proposed

## 14. Open questions for the owner

1. **Web Push implementation:** own RFC 8291/8292 code with `node:crypto` (recommended, no dependency, about two to
   three days including test vectors) or approve `web-push` and its transitive packages under ADR-031?
2. **E-mail:** provider HTTP API (Resend or Postmark; account, API key, sending domain with SPF/DKIM; content passes
   through the provider), `nodemailer` with your own SMTP server (dependency approval), or no e-mail for now
   (recommended until Telegram and push are in use)?
3. **Channel order:** Telegram → Web Push → e-mail → Discord (recommended), or push first?
4. **Remote approval policy:** accept tiers A/B/C as proposed? Should tier B also be allowed by one tap? Do you want a
   15-minute fresh-login requirement for tier C decisions on the phone, knowing that GitHub OAuth makes it weak?
5. **Lock-screen previews:** may project names and task titles appear on the lock screen (`standard`) or should push
   default to `minimal`?
6. **Reachability:** how does your phone reach the app (LAN only, Tailscale/WireGuard, public domain with HTTPS)?
   Web Push confirm pages and Telegram/Discord webhooks need it; Telegram long polling does not.
7. **Recipients:** should operators receive approval notifications even though only admins can decide today?
8. **Third-party data:** is it acceptable that Telegram, Discord or an e-mail provider see notification metadata
   (project name, action type, times)?
9. **Token lifetime:** 30 minutes by default acceptable, or shorter/longer?
10. **Team channels:** should a project be able to post to a shared Telegram group or Discord channel (notifications
    only, no buttons)?

## 15. Sources

Checked 2026-09-16.

- [W1] RFC 8030, Generic Event Delivery Using HTTP Push: https://www.rfc-editor.org/rfc/rfc8030.html
- [W2] RFC 8291, Message Encryption for Web Push: https://www.rfc-editor.org/rfc/rfc8291.html
- [W3] RFC 8292, VAPID for Web Push: https://www.rfc-editor.org/rfc/rfc8292.html
- [W4] Node.js 24 crypto documentation: https://nodejs.org/docs/latest-v24.x/api/crypto.html
- [W5] `web-push` package: https://registry.npmjs.org/web-push and https://github.com/web-push-libs/web-push
- [W6] WebKit, "Web Push for Web Apps on iOS and iPadOS": https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- [W7] WebKit, "Meet Declarative Web Push": https://webkit.org/blog/16535/meet-declarative-web-push/ and "WebKit Features in Safari 18.4": https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- [W8] MDN browser-compat-data: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/ServiceWorkerRegistration.json and https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/ServiceWorkerGlobalScope.json; MDN `showNotification`: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification
- [W9] MDN `PushManager.subscribe`: https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- [W10] Next.js, Progressive Web Apps guide: https://nextjs.org/docs/app/guides/progressive-web-apps
- [T1] Telegram Bot API: https://core.telegram.org/bots/api
- [T2] Telegram bot features, deep linking: https://core.telegram.org/bots/features
- [T3] Telegram, bots introduction: https://core.telegram.org/bots
- [T4] Telegram Bots FAQ (limits): https://core.telegram.org/bots/faq
- [D1] Discord webhook resource: https://docs.discord.com/developers/resources/webhook
- [D2] Discord interactions overview: https://docs.discord.com/developers/interactions/overview
- [D3] Discord, receiving and responding to interactions: https://docs.discord.com/developers/interactions/receiving-and-responding
- [D4] Discord component reference: https://docs.discord.com/developers/components/reference
- [D5] Discord user resource (Create DM): https://docs.discord.com/developers/resources/user
- [E1] Resend, send email: https://resend.com/docs/api-reference/emails/send-email
- [E2] Postmark email API: https://postmarkapp.com/developer/api/email-api
- [E3] Amazon SES v2 SendEmail: https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- [E4] `nodemailer` package: https://registry.npmjs.org/nodemailer
- [E5] RFC 8058, one-click unsubscribe: https://www.rfc-editor.org/rfc/rfc8058.html
- [S1] OWASP CSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- [S2] Microsoft Defender for Office 365, Safe Links: https://learn.microsoft.com/en-us/defender-office-365/safe-links-about
- [P1] Apple, change notification settings on iPhone: https://support.apple.com/guide/iphone/change-notification-settings-iph7c3d96bab/ios and https://support.apple.com/en-us/108781
- [P2] Android lock-screen notifications: https://support.google.com/android/answer/9079661 and https://developer.android.com/design/ui/mobile/guides/home-screen/notifications

Not verified (marked [S] in §3): the exact section of the RFC 8291 worked example; Telegram `retry_after` on 429 and the
mutual exclusivity of `getUpdates` and webhooks; encryption of bot chats; Chrome endpoint hosts and install-prompt
criteria; Discord DM prerequisites; the SES Signature V4 requirement on the cited page; `notificationclick` on Safari
iOS; iOS and Android lock-screen defaults; whether browsers other than Safari ship Declarative Web Push.
