# Plan: Platform targets, publishing connectors and Media Studio

Request (2026-09-14, owner, verbatim): "andere Apps anbinden wie TikTok oder YouTube oder Roblox, sodass man dann gleich
ein Projekt da reinbauen kann oder Videos erstellen kann".
Interpretation: (a) build and ship projects directly into platforms (e.g. a Roblox experience); (b) create videos (dev
logs, demos, trailers, content projects) and publish them (YouTube, TikTok, …).

Status: **proposal / research**. Nothing here is implemented. ADR draft in §10 ("ADR-0XX, number assigned at merge").
Research date 2026-09-14; platform rules change often, so every fact below must be re-checked before the matching stage
starts. This is not legal advice. Claims are tagged:
**[V]** verified on an official page during research · **[S]** only from search snippets, secondary sources or an
official page that did not render · **[I]** our own inference. Sources are listed in §13 with short ids ([R3], [Y2] …).

`docs/plans/autopilot.md` and `docs/plans/planning-assistant.md` did not exist when this was written; the autonomy
mapping (§4.11) uses the roadmap description in `docs/STATE.md` and must be aligned once those plans land.

## Zusammenfassung (Deutsch)

* **Machbar, aber nie „vollautomatisch veröffentlichen“.** Alle drei Wunschplattformen haben offizielle APIs. Jede
  Veröffentlichung bekommt ein neues, **nicht abschaltbares** Freigabe-Gate `platform_publish` (auf jeder
  Autonomiestufe, wie die Owner-Regel für neue Dependencies). Der Autopilot darf nur Entwürfe vorbereiten.
* **Roblox (Projekte „reinbauen“):** Code als Dateien (Rojo, Luau), Build und Lint in der Docker-Sandbox, Upload einer
  Place-Version per Open-Cloud-**API-Key** (`Saved` = unsichtbar, `Published` = live), Tests headless über die
  Luau-Execution-API. **Nicht per API:** Experience anlegen, öffentlich schalten, Altersfreigabe-Fragebogen. Das bleibt
  manuell im Creator Dashboard, und das ist gut so. Unbewertete Experiences sind seit 30.09.2025 nur für Entwickler
  spielbar, also ein natürlicher privater Testbereich.
* **YouTube:** Upload nur per OAuth des Kanal-Inhabers (100 Uploads/Tag im eigenen Kontingent). Uploads aus einem
  **nicht auditierten** API-Projekt sind **immer privat**, bis Google das Projekt prüft. Im OAuth-Status „Testing“
  laufen Tokens nach 7 Tagen ab. Pflichtfelder: `containsSyntheticMedia` (KI-Offenlegung), `selfDeclaredMadeForKids`.
  Massenhaft gleichförmige KI-Videos verstoßen gegen Spam- und Monetarisierungsregeln.
* **TikTok:** Ohne Audit **nur privat (SELF_ONLY)** und max. 5 Nutzer/24 h. TikTok lehnt im Audit ausdrücklich Tools ab,
  die nur eigene/Team-Accounts bespielen. Realistischer Weg: **Upload in die TikTok-Inbox als Entwurf**; der Mensch
  finalisiert in der App. Direct Post verlangt feste UX (Privatsphäre ohne Vorauswahl, Musik-Erklärung, Vorschau).
* **Videoerstellung („Media Studio“):** Skript → Storyboard → Assets → Rendern → Review → Veröffentlichen.
  Günstigster, risikoärmster Kern: **Playwright-Bildschirmaufnahme** der gebauten App in der Sandbox (mit Testdaten) +
  **ffmpeg** + optional **TTS** mit KI-Stimmen-Hinweis. KI-Video (Google Veo 3.1 ab ca. 0,05–0,40 $/s, Runway ab
  0,05 $/s) nur mit Budget-Gate. **OpenAI Sora API wird am 24.09.2026 abgeschaltet**, also nicht darauf bauen.
* **Kennzeichnung und Recht:** EU AI Act Art. 50 (Transparenz, Deepfake-Kennzeichnung) gilt seit **02.08.2026**
  (Übergang für maschinenlesbare Markierung bis 02.12.2026, laut Sekundärquellen). YouTube, TikTok, Meta, Steam und
  itch.io verlangen KI-Offenlegung. Keine Stimmklone realer Personen ohne nachgewiesene Einwilligung. Musik nur mit
  dokumentierter Lizenz. Bei Roblox/TikTok ist das Publikum jung (COPPA, UK Children's Code).
* **Architektur:** Port `PublishingConnector` in `packages/core` (IO-frei, inkl. Plattform-Policies), Adapter in
  `packages/integrations/src/platforms/`. **Plattform-Verbindungen gehören einer Person** (verschlüsselt, Grants pro
  Projekt, analog zu den Provider-Accounts). Freigeben darf nur der Verbindungs-Inhaber. Secrets kommen nie in die
  Sandbox oder den Modellkontext.
* **Freigabe mit Vorschau:** Videodatei/Build-Hash, Titel, Beschreibung, Offenlegungs-Labels, Privatsphäre (Standard:
  privat/Entwurf), Zielkonto. Die Freigabe ist an den Hash gebunden; jede Änderung macht sie ungültig. Alles wird
  auditiert. Analytics fließen in MONITOR, lösen aber nie automatisch neue Veröffentlichungen aus.
* **Empfohlener erster Schnitt:** Connector-Grundgerüst + **Roblox: Saved-Version in ein privates Test-Universe per
  API-Key** (kein OAuth, kein Audit, API kann nicht öffentlich schalten). Danach **Demo-Video per Playwright → YouTube
  privat**.
* **Offen:** Speicherort für große Videodateien, ob TikTok-Direct-Post-Audit überhaupt angestrebt wird,
  Remotion-Lizenzkosten vs. ffmpeg, ob Instanz Dritten angeboten wird (verschärft Audits und Recht), rechtliche Prüfung
  der Anbieterrolle nach AI Act.

### Geht / geht nicht / nur mit Audit oder Freigabe

| Plattform | Geht (per offizieller API) | Geht nicht | Nur mit Audit, Verifizierung oder manuellem Schritt |
|---|---|---|---|
| **Roblox** | Rojo-/Lune-Build in Docker; Place-Version `Saved`/`Published` hochladen (API-Key); Luau-Execution-Tests; Assets (Kontingente); DataStores, MessagingService; Universe-Einstellungen außer Sichtbarkeit | Experience per API anlegen; öffentlich/privat oder Altersfreigabe per API setzen; Place-Publish oder Luau per OAuth; Studio unter Linux/Docker (offiziell); Massen-Accounts; API-Keys anderer Nutzer anfordern; Nutzerdaten für KI-Training; „Roblox/Blox“ im Titel | OAuth-App für mehr als 10 Nutzer (Review + ID); Audio über 10 Uploads/Monat und Video (ID-verifiziert); Altersfreigabe-Fragebogen und Livegang (manuell im Dashboard); Restricted 18+ (ID); DevEx, Ads |
| **YouTube** | OAuth-Upload auf den eigenen Kanal (100/Tag); Metadaten, `containsSyntheticMedia`, `selfDeclaredMadeForKids`, `publishAt`; Captions, Playlists; Analytics-/Reporting-API | Service-Accounts; Uploads ohne ausdrückliche Einwilligung; massenhaft gleichförmige KI-Inhalte; realistische KI ohne Offenlegung; irreführende Titel/Thumbnails; API-Daten > 30 Tage speichern (außer Statistiken) | Öffentlich/unlisted (API-Audit, sonst privat); mehr Quota (Audit); langlebige Tokens (Produktionsstatus, ggf. Scope-Verifizierung); eigene Thumbnails (verifizierter Kanal) |
| **TikTok** | Inbox-Upload als Entwurf (User finalisiert in der App, max. 5 offene/24 h); Direct Post nur `SELF_ONLY`; Login Kit, Display API | Voreingestellte Privatsphäre; Posten ohne Einwilligung; Wasserzeichen/Branding; unmarkierte realistische KI; Spam; > 6 Requests/min, ca. 15 Posts/Tag | Öffentlicher Direct Post (Audit; reine Eigen-/Team-Tools werden laut Richtlinie abgelehnt) |
| **Instagram/Facebook Reels** | Reels/Posts für Professional-Accounts (100 API-Posts/24 h) | Private Accounts; automatisierte Account-Erstellung | App Review + Business-Verifizierung für Advanced Access; KI-Label über Metas Offenlegung |
| **Discord** | Bot/Webhook postet Devlog in eigenen Server | Self-Bots (User-Accounts automatisieren) | Verifizierung ab 100 Servern; privilegierte Intents |
| **itch.io** | `butler push` (API-Key) | Überwiegend KI-generierte Projekte mit minimalem menschlichem Anteil; Duplikate | KI-Offenlegungs-Tag (bei Assets Pflicht) |
| **Steam** | SteamPipe-Upload, Beta-Branch live setzen | Default-Branch automatisch live setzen | Steam Direct (100 $), Store-/Build-Review, KI-Offenlegungsfragebogen |
| **App Store / Google Play** | Build-Upload (App Store Connect API / Play Developer API), TestFlight intern, Play-Track `internal` | Apple-Review umgehen; Template-/Klon-Apps (Apple 4.2.6/4.3) | App Review (immer); Play: neue Privatkonten 12 Tester × 14 Tage |
| **Twitch** | Clips, Kanal-Infos, Zeitplan, Chat | Video-Upload per API (existiert nicht) | — |
| **Web-Hosts** (Vercel/Netlify/Cloudflare) | Deploy per gescoptem Token (heute schon über GitHub-Workflow) | Mehrfach-Accounts zur Limit-Umgehung; Vercel Hobby kommerziell | — |
| **KI-Video-APIs** | Veo 3.1 (Gemini API), Runway, Luma | **Sora API ab 24.09.2026**; Personen-Generierung in EU/UK nur eingeschränkt (Veo) | Budget-Gate `high_cost`; Offenlegung + C2PA/SynthID |

---

## 1. Context: code anchors (current working tree)

| Area | Anchor | Relevance |
|---|---|---|
| Stages | `packages/core/src/domain/enums.ts` (`INTAKE … DEPLOY, MONITOR`) | Software projects keep these; Media Studio needs its own stage list (§4.7). |
| Stage planning | `packages/core/src/pipeline/stage-planner.ts:96-103` | DEPLOY runs only at autonomy level 4 and only with `profile.deployWorkflow`. Platform targets must plug in here without lowering that bar. |
| Deploy/monitor handlers | `packages/core/src/orchestrator/delivery.ts:168-207` | `deployStage` calls tool `deploy.run`; on `approval_required` it creates a `production_deploy` approval with a preview payload; `monitorStage` polls the workflow run and blocks on failure. Pattern to reuse for `platform.publish`. |
| Deploy tool | `packages/core/src/orchestrator/tools.ts:162-172` | `minAutonomy: 4`, `gatedAction: 'production_deploy'`, guard restricts to the configured workflow and default branch. |
| Tool names / permissions | `packages/core/src/tools/tool-router.ts:9-28`, `:35-52` | New tools `platform.*`, `media.*` and role permissions go here. |
| Guard chain | `tool-router.ts` `invoke` | permission → autonomy → zod input → guard → approval → budget (`estimateCostUsd`) → execute → audit. |
| Approval policy | `packages/core/src/approval/policy.ts` `requiresApproval` | Today only `production_deploy` below level 4 is hard-coded. `platform_publish` becomes a hard rule at **all** levels (same shape as the owner's `dependency_addition` rule in `docs/plans/plugin-scout.md` §9.3). |
| Gated actions | `packages/core/src/domain/project.ts:4-14` | `external_service` exists but is never detected. Add `platform_stage`, `platform_publish`. |
| Sandbox | `packages/core/src/sandbox/port.ts` (`network: 'none' \| 'registry'`), `packages/integrations/src/sandbox/docker.ts` | Build/record/render happen here, offline; tool installs via registry proxy only. Secrets never enter. |
| Credentials | `packages/db/src/schema.ts:399` (`provider_configs.api_key_encrypted`), `apps/server/src/crypto.ts` (`v1:iv:tag:ct`), `apps/server/src/routes.ts:550-589` | Platform connections follow `docs/research/multi-account-ai.md` §4–5 (owner, grants, secret format v2 with key id + AAD). |
| Integrations layout | `packages/integrations/src/{github,providers,sandbox,demo}` | New sibling `platforms/` and `media/`. |
| Web | `apps/web/src/app/{approvals,settings,projects/[id]}` | Approval preview, Settings → Connections, project tabs Targets/Media. |
| Owner rule | `docs/STATE.md` Roadmap | Every new dependency (Rojo, Lune, Playwright image, ffmpeg, Remotion, C2PA lib, SDKs) needs human approval. |

---

## 2. Findings per platform

### 2.1 Roblox

**Authentication**
* API keys: owned by a user or a group, scoped per experience (or "all experiences" incl. future ones since
  2025-10-15), optional CIDR allow-list, optional expiry; **keys expire automatically after 60 days without use or
  update**; header `x-api-key` [V][R1][R2]. Group-owned key deprecation was announced 2025-11-13 and deferred [V][R3].
* OAuth 2.0 apps: authorization code (+PKCE S256), access token 15 min, refresh token 90 days and single-use; private
  (unreviewed) apps limited to **10 users**; registering needs an ID-verified account; users must be 13+ [V][R4][R5].
  Since 2025-05-30 apps have a category that bounds requestable scopes [V][R6]; the Creator Third Party App Policy
  (updated 2026-09-09) forbids requesting API keys from other users, automating logins/account creation, simulated
  views, cross-experience tracking, selling data and **using user data to train AI** [V][R7].
* **Place publishing and Luau Execution accept API keys only, not OAuth** (OpenAPI security schemes in
  `Roblox/creator-docs`) [V][R8][R9]. Consequence: a Roblox connector is API-key based; the key belongs to one owner.

**Place publishing**
* `POST https://apis.roblox.com/universes/v1/{universeId}/places/{placeId}/versions?versionType=Saved|Published`,
  body `.rbxl` (`application/octet-stream`) or `.rbxlx` (`application/xml`), returns `versionNumber`; scope
  `universe-places:write`; marked beta; **30 req/min per key owner and per IP**; spec max body 10 MB (Studio allows
  larger places; not tested) [V][R8][R10]. Some instance types (EditableImage/Mesh, PartOperation, SurfaceAppearance,
  BaseWrap) are not updated through this API [V][R10].
* **Cannot** create a universe/experience via a public endpoint [V][R10][R9]; `visibility`, `displayName` and
  `ageRating` of the Universe v2 resource are read-only [V][R8]. `PATCH /cloud/v2/universes/{id}` changes other
  settings; `:restartServers` exists [V][R11].

**Other Open Cloud APIs**
* Assets: models, images/decals, audio (≤ 7 min, **100 uploads/month ID-verified, 10 otherwise**), video (≤ 5 min,
  20/day, 13+ ID-verified only); 20 MB; moderation status returned; many types immutable after upload [V][R12].
* DataStores v2 stable; since 2026-07-29 Open Cloud and in-game requests share limits [V][R13][R14].
  MessagingService publish exists; quotas unified 2026-05-11 [V][R15].
* **Luau Execution API** (stable): run a script against a place version on Roblox servers; ≤ 5 min timeout, ≤ 10
  unfinished tasks per place, 24 h task retention, no physics, place scripts do not start, place changes are not saved,
  **DataStore calls hit live data** [V][R9][R16]. Pricing not documented; whether it counts under Extended Services
  billing is unverified [S][R17].

**Toolchain (GitHub releases checked 2026-09-14)** [V][R18]
Rojo 7.7.0 (build `.rbxl` from files, active) · Lune 0.10.5 (standalone Luau runtime, reads/writes place files) ·
Rokit 1.2.0 (tool installer; Aftman archived) · Foreman 1.7.0 · Selene 0.31.0 (lint) · StyLua 2.5.2 (format) ·
Wally (package manager; last release 2023, repo still pushed) · jest-roblox (active) · TestEZ archived ·
run-in-roblox dead (needs local Studio) · `Roblox/place-ci-cd-demo` archived but still the reference CI flow [V][R19].
Community: `rbxcloud` CLI [V][R20].

**Testing**: Studio runs on Windows/macOS only [V][R21]; Linux via Wine (Vinegar) is unofficial and fragile [V][R22].
Headless options: Lune for pure logic and place-file checks; Luau Execution (+ jest-roblox) for engine-level tests.

**Policies**
* Since **2025-09-30 unrated experiences are playable only by the developer and collaborators**; the Maturity &
  Compliance questionnaire is a Creator Dashboard step [V][R23]. Labels Minimal/Mild/Moderate/Restricted; Restricted is
  18+ age-verified and needs an ID-verified creator; wrong answers can lead to takedown [V][R24].
* In-experience generative AI: disclose to users that AI is not human; continuous chatbot interaction or cross-session
  memory requires the Restricted label [V][R25][R26]. **No rule found that static AI-made assets need disclosure** [V
  for absence in the docs read; not exhaustive].
* Community Standards: misleading/duplicative metadata and spam uploads prohibited [S][R27]. "Roblox"/"Blox" not
  allowed in titles of experiences created since 2022-06-22 [V][R28].
* Child safety: facial age check for chat worldwide since January 2026 [V][R29]; private-space social hangouts limited
  to ID-verified 17+ [V][R30]. Monetisation: DevEx 13+, 30 000 earned Robux [V][R31]; rewarded video ads need ID
  verification and ≥ 2 000 monthly visitors [S][R32].

### 2.2 YouTube

* `videos.insert`: OAuth 2.0 scopes `youtube.upload` (or `youtube`, `youtube.force-ssl`, `youtubepartner`); service
  accounts are not supported (`NoLinkedYouTubeAccount`) [V][Y1][Y2]. Resumable upload protocol, file ≤ 256 GB / 12 h;
  > 15 min needs a verified account [V][Y3][Y4].
* **Quota (changed 2026-06-01):** separate buckets; default **100 `videos.insert` calls/day**, 100 `search.list`,
  10 000 units for everything else; `thumbnails.set` 50, `captions.insert` 400, `videos.update` 50 [V][Y5][Y6]
  (spot-checked twice during research). Extension via the audit/quota form [V][Y7].
* **Private until audit:** "All videos uploaded via `videos.insert` from unverified API projects created after
  28 July 2020 will be restricted to private viewing mode" until the project passes a compliance audit [V][Y1][Y7].
* Developer Policies [V][Y8]: privacy policy requirements; users must **expressly consent before actions** are executed
  (III.E.3); **no automated uploads without prior specific and express consent** (III.I); most authorized data may be
  stored ≤ 30 days (statistics and Analytics/Reporting data excepted); deletion within 7/30 days after revocation;
  YouTube may audit.
* Google OAuth "Testing" status: ≤ 100 test users, and for non-basic scopes **authorizations and refresh tokens expire
  after 7 days** [V][Y9]. Sensitive-scope verification needs homepage, privacy policy, demo video, justification
  [V][Y10]; whether `youtube.upload` is classified "sensitive" was not confirmed on a Google page [S].
* `status` fields [V][Y11]: `privacyStatus` (`private|unlisted|public`), `publishAt` (only while private),
  `selfDeclaredMadeForKids`, `containsSyntheticMedia` (altered/synthetic disclosure, added 2024-10-30 [V][Y6]),
  `license`, `embeddable`, `publicStatsViewable`.
* Shorts: no flag; square/vertical up to 3 min uploaded since 2024-10-15 are Shorts; > 1 min Shorts with a copyright
  claim are blocked [V][Y12]. Custom thumbnails need a verified channel [V][Y13]. Captions ≤ 100 MB [V][Y14].
* Analytics API (`yt-analytics.readonly`, `yt-analytics-monetary.readonly`) and Reporting API (daily bulk reports,
  60-day availability) [V][Y15][Y16].
* Policies: spam/deceptive practices explicitly include "using automated tools or AI to churn out high volumes of
  similar content with minimal changes" [V][Y17]; YPP "inauthentic content" (renamed 2025-07-15) covers mass-produced,
  templated AI content [V][Y18]; altered/synthetic disclosure required for realistic content (real people saying things
  they did not, altered events, realistic fake scenes, AI music listed), not for clearly unrealistic content or
  production assistance; YouTube may label automatically, including from C2PA [V][Y19]. Made-for-kids setting is the
  creator's legal responsibility under COPPA [V][Y20]. AI likeness removal requests exist [S][Y21].

### 2.3 TikTok

* **Content Posting API** [V][T1][T2][T3]:
  * *Direct Post* `POST /v2/post/publish/video/init/`, scope `video.publish`; must query
    `/v2/post/publish/creator_info/query/` first (nickname, avatar, allowed privacy levels, interaction flags, max
    duration). `post_info`: `privacy_level`, `disable_comment|duet|stitch`, `brand_content_toggle`,
    `brand_organic_toggle`, **`is_aigc`**. 6 requests/min per user token.
  * *Upload* (`/v2/post/publish/inbox/video/init/`, scope `video.upload`): content lands in the creator's inbox; the
    user finishes editing and posting in the TikTok app; **≤ 5 pending shares per 24 h**.
  * Photo posts (≤ 35 images, `PULL_FROM_URL` from verified domains) [V][T4]. Media transfer: `FILE_UPLOAD` chunks
    5–64 MB, ≤ 4 GB; `PULL_FROM_URL` needs domain verification [V][T5].
* **Unaudited clients:** ≤ 5 posting users per 24 h, accounts must be private at posting time, content `SELF_ONLY`
  [V][T6]. The audit guidelines state clients must be for a wide audience and list "a utility tool to help upload
  contents to the account(s) you or your team manages" as **not acceptable** [V][T6]. Whether inbox uploads are also
  restricted for unaudited clients was not confirmed [S].
* **Required Direct Post UX** [V][T6]: show creator nickname; privacy chosen manually from a dropdown **with no
  default**; comment/duet/stitch unchecked by default; commercial content disclosure ("Your Brand" → "Promotional
  content", "Branded Content" → "Paid partnership"); declaration "By posting, you agree to TikTok's Music Usage
  Confirmation"; preview; send only after express consent; user can edit caption; no added watermarks; ≈ 15 posts/day
  per creator.
* Tokens: access 24 h, refresh 365 days [V][T7]; Login Kit requires HTTPS static redirect URIs [V][T8]; Display API
  (`user.info.basic`, `video.list`) [V][T9].
* Policies: realistic AIGC must be labelled; TikTok auto-labels via C2PA [V][T10][T11]; unoriginal content ineligible
  for For You feed, spam/automation to push repetitive content prohibited [S][T12]; Developer Terms forbid spamming and
  excessive use [V][T13]; minimum age 13, under-16 accounts private by default [V][T14].

### 2.4 Video creation pipeline options

| Option | What | License / cost | Headless in our Docker sandbox | Notes |
|---|---|---|---|---|
| **Playwright video** | `recordVideo` per browser context or `Screencast` API (v1.59+), WebM, saved on context close [V][V1][V2][V3] | Apache-2.0; official image `mcr.microsoft.com/playwright:<version>-noble` [V][V4] | Yes (needs `--ipc=host`/`--init` per docs, which conflicts with our hardened flags → evaluate `--shm-size` instead [I]) | **No audio** [V][V5]; narration added separately |
| **ffmpeg** | compose, trim, mux audio, burn captions, transcode to MP4/H.264 | LGPL by default, GPL with `--enable-gpl`/libx264 [V][V6] | Yes | We only run it, do not distribute it [I] |
| **Remotion** | React-based programmatic video | Free ≤ 3 employees; companies need a license; server rendering = "Automator" $0.01/render, $100/month minimum [V][V7][V8] | Yes (Chrome headless shell) [V][V9] | Best DX; licence cost and a large dependency |
| **Motion Canvas** | TS animation | MIT [V][V10] | No official headless render [V][V11] | Not a fit without browser automation |
| **Revideo** | Motion Canvas fork with headless render | MIT; maintainers moved to a commercial product [V][V12] | Yes | Maintenance risk |
| **editly** | declarative ffmpeg wrapper | MIT, new maintainer [V][V13] | Yes | Simple slideshows/titles |
| **TTS** | OpenAI `gpt-4o-mini-tts` ($0.60/M text in, $12/M audio out), ElevenLabs ($0.05–0.10 per 1K chars), Gemini TTS; Kokoro-82M (Apache-2.0) local; Piper (GPL-3.0, per-voice licences) [V][V14][V15][V16][V17][V18] | see left | Kokoro/Piper yes; APIs via server | OpenAI requires telling listeners the voice is AI-generated [V][V19]; custom/cloned voices need consent recordings/verification [V][V19][V20]; ELVIS Act (TN) in force, NO FAKES Act not law [V][V21][V22] |
| **Google Veo 3.1** (Gemini API) | 4/6/8 s clips, 720p–4K, native audio | Standard $0.40/s (1080p), Fast $0.10–0.30/s, Lite $0.05–0.08/s [V][V23][V24] | API call from server | SynthID watermark; EU/UK/CH/MENA person generation limited to `allow_adult`; output deleted from Google after 2 days [V][V23]; C2PA credentials on Vertex [S][V25] |
| **OpenAI Sora** | — | **API removed 2026-09-24, no replacement** [V][V26] | — | Do not build on it |
| **Runway API** | Gen-4 Turbo $0.05/s, Gen-4.5 $0.12/s, Aleph $0.28/s, Veo 3.1 via Runway $0.20–0.40/s [V][V27] | credits | API call from server | |
| **Luma Ray** | per-clip pricing [V][V28] | | API | |
| **Music** | Lyria 3.5 via Gemini API $0.08/song, SynthID [V][V24][V29]; Pixabay (no standalone redistribution, Content ID claims possible) [V][V30][V31]; FMA per-track CC (NC/ND traps) [V][V32]; Incompetech CC-BY or paid [V][V33]; Suno paid tiers commercial [V][V34]; Udio downloads walled [S][V35]; YouTube Audio Library is for YouTube use [S][V36] | | | Store licence evidence per asset |
| **Provenance** | C2PA via `@contentauth/c2pa-node` (Node 22+, needs signing cert) [V][V37]; MP4 support unverified [S] | | Server-side | YouTube "captured with a camera" label cannot apply to rendered videos [V][V38] |

### 2.5 Other fitting targets (brief)

| Target | Auth | Automatable | Human/review step | Policy notes |
|---|---|---|---|---|
| **Apple App Store Connect** | ES256 JWT API keys, ≤ 20 min tokens [V][O1] | Build Uploads API (WWDC25), TestFlight internal (≤ 100, no review) [V][O2][O3] | App Review for every submission and first external TestFlight build [V][O4]; macOS/Xcode for builds [V][O5] | 4.2.6 template/app-generator apps rejected unless submitted by content provider; 4.3 spam; 5.1.2(i) disclosure + consent for sharing personal data with third-party AI [V][O6][O7] |
| **Google Play Developer API** | service account [S] | `edits.insert` → upload → `tracks.update` (`internal`/closed/open/production, staged rollout) → `edits.commit` [V][O8][O9] | New personal accounts: closed test with ≥ 12 testers for 14 days before production [V][O10]; review | AI-Generated Content policy (deepfakes, scams) [V][O11] |
| **itch.io (butler)** | API key (`BUTLER_API_KEY`) [V][O12] | `butler push` to channels | — | Generative-AI disclosure tags (enforced for assets); projects "predominantly created by AI with minimal human intervention" and near-duplicates disallowed [V][O13][O14] |
| **Steam (SteamPipe)** | dedicated builder account + Steam Guard [V][O15] | upload builds, `SetLive` on beta branches only | **Default branch cannot be set live automatically** [V][O15][O16]; store/build review; $100 Steam Direct fee; coming-soon page ≥ 2 weeks [V][O17][O18] | AI content survey (pre-generated / live-generated incl. guardrails) [V][O19] |
| **Vercel / Netlify / Cloudflare** | scoped, expiring tokens [V][O20][O21][O22] | deploy APIs/CLIs; today already covered by GitHub workflow dispatch | — | AUPs forbid multi-account limit evasion; Vercel Hobby non-commercial [V][O20][O23] |
| **Discord** | bot token / OAuth2; **webhook URL for posting** [V][O24] | post devlogs, release notes | verification at scale [S][O25]; privileged intents review [V][O26] | self-bots forbidden [V][O27] |
| **Instagram / Facebook Reels** | Instagram Login or Facebook Login; professional accounts [V][O28] | Reels/posts, **100 API posts per 24 h** [V][O28] | App Review + Business Verification for Advanced Access [V][O29]; own-account use with app roles under Standard Access [S] | AI disclosure tool for photorealistic video/audio; auto-labels from C2PA/IPTC [V][O30] |
| **Twitch** | OAuth user token [V][O31] | clips, channel info, schedule, chat | — | **No VOD upload API** (removed with v5) [V][O32] |

### 2.6 Legal and safety

* **EU AI Act Art. 50** [V][L1]: providers of generative systems must mark outputs machine-readably (50(2)); deployers
  must disclose deepfakes (50(4)) and AI-generated text published to inform the public on matters of public interest
  unless human-reviewed with editorial responsibility. Applies from **2026-08-02**; the Digital Omnibus on AI did not
  postpone Art. 50 but gives systems placed on the market before 2026-08-02 until **2026-12-02** for 50(2) marking
  [S][L2][L3][L4]. Final Code of Practice on marking and labelling published 2026-06-10 [S][L5]. Fines up to €15 M /
  3 % [V][L6]. Whether this orchestrator is a "provider" (it composes and renders generative output) or only a
  deployer is **unresolved → legal review** [I].
* **Minors:** COPPA amended rule compliance date 2026-04-22 (separate parental consent for third-party disclosure,
  retention policy, security programme) [V][L7][L8]; YouTube made-for-kids is the creator's legal responsibility
  [V][Y20]; UK Online Safety Act children's codes enforceable since 2025-07-25 [V][L9]; ICO Children's Code for services
  likely accessed by under-18s [V][L10]. Roblox and TikTok audiences are young → no data collection in experiences
  built by us beyond platform APIs, no in-experience chatbots unless the owner opts into Restricted.
* **Copyright/music:** purely AI-generated output is not copyrightable in the US; human selection/arrangement can be
  [V][L11]. Content ID claims can hit licensed stock music [V][V31]. Keep licence proofs.
* **Impersonation/likeness:** YouTube impersonation policy [V][L12]; ELVIS Act [V][V21]; TAKE IT DOWN Act platform
  duties since 2026-05-19 (NCII incl. AI forgeries) [V][L13]; 31 US states with election deepfake laws [S][L14].
  Rule: no real-person likeness or voice without recorded consent; no political content in the Media Studio.
* **Advertising:** FTC Endorsement Guides and fake-review rule apply to generated promo content [V][L15][L16].
* **Germany:** commercial YouTube/TikTok channels need an Impressum (§ 5 DDG) [S][L17]. GDPR: screen recordings must
  not contain real personal data [I].
* **Spam/automation:** YouTube fake engagement and spam policies [V][Y17][L18]; automated account creation forbidden on
  Meta, Vercel, Netlify, Roblox; Discord self-bots [V]. → per-connection publish rate caps and near-duplicate checks.
* **Human approval before publishing** is not only our policy: YouTube III.I, TikTok express consent and Direct Post UX
  effectively require it [V][Y8][T6].

---

## 3. Design principles (normative)

1. **Nothing becomes visible to other people without a human decision.** `platform_publish` is a hard gate at every
   autonomy level, cannot be switched off in project gate config, and is decided by the **connection owner** (or a
   delegate named on the grant) because platform terms require the account holder's consent.
2. **Default visibility is the most private option the platform offers**: Roblox `Saved` version / unrated test
   universe, YouTube `private`, TikTok inbox draft (or `SELF_ONLY`), store `internal`/TestFlight internal, Steam beta.
3. **Approval is bound to content**: approval payload carries `artifactSha256` and `metadataDigest`; any change
   (re-render, title edit) invalidates it and requires a new approval. ADR-023 expiry applies.
4. **Secrets never enter the sandbox or model context.** Builds, recordings and renders run in the sandbox without
   credentials; uploads run in server-side adapters. Redactor gets new patterns (Google `ya29.`/`1//` tokens, TikTok
   tokens, Roblox keys; exact formats to confirm).
5. **Platform facts are data, policies are core code**: each platform's defaults, required disclosures, limits and
   manual steps live in an IO-free `PlatformPolicy` so they are testable and reviewable in one place.
6. **Disclosure is explicit, never inferred silently**: the pipeline pre-fills AI-disclosure flags from asset
   provenance (any `ai_generated` asset → `containsSyntheticMedia`/`is_aigc` proposed `true`), the human confirms; the
   system never downgrades a flag the provenance says is required.
7. **Bounded and idempotent**: one upload per approval (idempotency key = approval id); retries resume the same upload
   session or query remote state first; rate caps per connection; failures block with a reason, never re-publish
   blindly.
8. **No new dependency without the owner's approval** (STATE.md): Rojo, Lune, StyLua, Selene, Playwright image,
   ffmpeg image, Remotion, C2PA library, platform SDKs. Prefer plain `fetch` adapters over SDKs.
9. **Manual platform steps are first-class**: the UI shows a checklist (e.g. "Complete Roblox Maturity & Compliance
   questionnaire", "Make experience public in Creator Dashboard", "Finish TikTok draft in app") and records who
   confirmed it.

## 4. Architecture

### 4.1 Overview

```
Project (kind: software | media)
  │  software: INTAKE … CI → DEPLOY (target kind: github_workflow | platform) → MONITOR
  │  media:    INTAKE → SCRIPT → STORYBOARD → ASSETS → RENDER → REVIEW → PUBLISH → MONITOR
  ▼
ToolRouter ── platform.stage / platform.publish / media.* (permission → autonomy → validation →
  │           PlatformPolicy guard → approval (platform_stage|platform_publish|high_cost) → budget → audit)
  ▼
core ports: PublishingConnector · ArtifactStore · MediaGenerator · ConnectionResolver
  ▼
integrations/platforms/{roblox,youtube,tiktok,discord-webhook,itch}  integrations/media/{veo,runway,tts-*}
sandbox (offline): rojo build · lune tests · playwright record · ffmpeg render
```

### 4.2 Core ports (`packages/core/src/platforms/`, IO-free)

Sketch (documentation, not final code):

```ts
export const PLATFORMS = ['roblox', 'youtube', 'tiktok', 'discord_webhook', 'itch'] as const;
export type Platform = (typeof PLATFORMS)[number];

export type Visibility = 'hidden' | 'private' | 'unlisted' | 'public';   // normalised; adapters map to platform values

export interface DisclosureSet {
  aiGenerated: boolean | null;       // YouTube containsSyntheticMedia, TikTok is_aigc, itch/Steam tags
  madeForKids: boolean | null;       // YouTube selfDeclaredMadeForKids — must be explicitly set by a human
  commercial: 'none' | 'own_brand' | 'branded' | null;   // TikTok brand toggles, FTC
  musicLicenses: LicenseRef[];
}

export interface PublishRequest {
  targetId: string;
  artifact: { sha256: string; bytes: number; mime: string; storageKey: string };
  metadata: { title: string; description: string; tags: string[]; locale?: string; thumbnailKey?: string; captionsKey?: string };
  visibility: Visibility;
  disclosure: DisclosureSet;
  platformOptions: Record<string, unknown>;   // validated by the platform policy's zod schema
}

export interface PlatformPolicy {
  platform: Platform;
  defaults(target: PlatformTargetView): Pick<PublishRequest, 'visibility' | 'platformOptions'>;
  /** Pure validation: size/duration limits, required disclosures, forbidden defaults, title rules ("Blox"), rate caps. */
  validate(req: PublishRequest, ctx: PolicyContext): PolicyIssue[];
  /** Which gate applies: uploading a Roblox Saved version = platform_stage; anything user-visible = platform_publish. */
  classify(req: PublishRequest, ctx: PolicyContext): 'platform_stage' | 'platform_publish';
  manualSteps(target: PlatformTargetView): ManualStep[];
}

export interface PublishingConnector {
  readonly platform: Platform;
  verifyConnection(conn: ConnectionHandle): Promise<ConnectionHealth>;
  stage(conn: ConnectionHandle, req: PublishRequest): Promise<RemoteRef>;       // non-public upload
  publish(conn: ConnectionHandle, req: PublishRequest, ref: RemoteRef | null): Promise<RemoteRef>;
  status(conn: ConnectionHandle, ref: RemoteRef): Promise<RemoteStatus>;
  withdraw(conn: ConnectionHandle, ref: RemoteRef): Promise<void>;              // make private / archive where supported
  metrics?(conn: ConnectionHandle, ref: RemoteRef, window: DateRange): Promise<MetricSample[]>;
}

export interface ArtifactStore {             // large files, content-addressed
  put(stream: AsyncIterable<Uint8Array>, mime: string): Promise<{ storageKey: string; sha256: string; bytes: number }>;
  open(storageKey: string): AsyncIterable<Uint8Array>;
}
```

`ConnectionHandle` is an opaque id; only the integrations layer resolves it to a decrypted token via a server-provided
resolver, so core and agents never see secrets. An in-memory fake connector and store go into
`packages/core/src/testing`.

### 4.3 Integrations (`packages/integrations/src/platforms/`, `media/`)

* `roblox.ts`: API-key header; `POST …/versions?versionType=Saved|Published` (binary body from `ArtifactStore`);
  Luau Execution task create/poll/logs; universe read (visibility, ageRating) for the manual-step checklist; honours
  429 `retry-after`; self-limit 20 req/min.
* `youtube.ts`: OAuth token refresh; resumable upload with persisted session URI (resume via `Content-Range: bytes */N`);
  `videos.update` for privacy change on approval; `thumbnails.set`, `captions.insert`; Analytics API reads.
* `tiktok.ts`: `creator_info/query` → inbox upload (`video.upload`) by default; Direct Post only if the client is
  audited (config flag set by an admin with evidence); status polling.
* `discord-webhook.ts`, `itch.ts` (butler runs inside the sandbox **only** if the key could be kept out → it cannot;
  therefore itch uses the server-side `wharf` protocol or stays a manual download link [I]; decide in stage 6).
* `media/veo.ts`, `media/runway.ts`, `media/tts-openai.ts`, local `tts-kokoro` in sandbox: all behind a
  `MediaGenerator` port with `estimateCostUsd` so the tool router budget check applies before the call.
* Tests against local fake HTTP servers (same pattern as `github/octokit.test.ts`), no live network in CI.

### 4.4 Connections and credentials (tie to `docs/research/multi-account-ai.md`)

* `platform_connections` mirror `provider_accounts`: exactly one owner (`user` or `instance`), secret format v2 with key
  id and AAD bound to the connection id, never returned (hint + fingerprint only), verify-on-save, status
  (`active | reauth_required | invalid | revoked`), `expires_at`.
* **Grants** (`platform_connection_grants`) let the owner allow a project to *stage* and/or *request publishes* to
  specific targets (Roblox universe/place allow-list, YouTube channel id, TikTok open_id), with weekly publish caps and
  expiry. A grant never lets anyone else approve; the owner (or named delegates) decide `platform_publish` approvals.
* OAuth (YouTube, TikTok): server routes with `state` + PKCE, minimal scopes (`youtube.upload`; analytics scopes only
  when MONITOR is enabled; TikTok `user.info.basic`, `video.upload`, later `video.publish`), HTTPS redirect URIs.
  Google Testing mode → 7-day refresh expiry → connection flips to `reauth_required` and notifies the owner [V][Y9].
* API key (Roblox): the owner creates a key in the Creator Dashboard scoped to the test universe (and later the live
  universe) with `universe-places:write` and optionally `universe.place.luau-execution-session:write`, CIDR restricted
  to the server's egress IP; the UI warns about the 60-day inactivity expiry and shows last use [V][R1].
* Instance-owned connections are allowed only for admin-managed brand channels; user-owned by default.
* Data retention: YouTube authorized data refreshed or deleted within 30 days except statistics; delete platform data
  within 7 days after a user disconnects [V][Y8]. A periodic purge job enforces this.

### 4.5 Platform targets and project templates

* `platform_targets` per project: `{platform, kind, environment: test | live, config}`; e.g. Roblox
  `{universeId, placeId}`, YouTube `{channelId, defaultPlaylistId}`, TikTok `{openId, mode: inbox | direct}`.
  A `live` target requires a prior successful `test` target run for the same project (Roblox) or is simply the same
  channel with `private` default (YouTube).
* **Roblox Rojo template** (repository template created by the orchestrator through a normal PR, dependency-gated):
  `default.project.json`, `src/{server,client,shared}`, `rokit.toml` pinning rojo/lune/stylua/selene, `selene.toml`,
  `tests/` (Lune unit tests for pure modules) and `tests/engine/*.luau` (Luau Execution smoke tests with jest-roblox,
  optional), `.github/workflows/ci.yml` running format/lint/lune tests/`rojo build`. Project profile commands:
  `install: rokit install` (registry egress → allow-list GitHub releases in the proxy), `lint`, `test`, `build`.
* **Web demo template** (for existing web projects): `demo/` Playwright script with a fixed viewport, synthetic seed
  data, chapter markers; commands `e2e`-like `record` run in the sandbox.
* **Media project template**: `media.yaml` (format, target platforms, language, voice, music policy, budget),
  `script.md`, `storyboard.json`, `assets/licenses.json`. Assets themselves live in the `ArtifactStore`, not in git
  (size, licence, and ADR-006's Git Data API path) [I].

### 4.6 Publish flow (software projects)

1. After CI passes, `DEPLOY` resolves the project's deploy targets. `github_workflow` keeps today's behaviour. A
   `platform` target runs `platform.stage` first when the policy supports staging (Roblox `Saved`), recording
   `versionNumber` in the checkpoint.
2. Optional engine verification: Luau Execution task against the saved version in the **test universe only** (guard
   rejects live universes because DataStore writes are live [V][R9]).
3. `platform.publish` → tool router → `requiresApproval` returns true for `platform_publish` at every level → approval
   row with preview payload (§4.9) → run `WAITING`.
4. On approval by the connection owner: connector publishes (Roblox `Published` on the approved place; YouTube privacy
   change; TikTok inbox upload). Checkpoint stores `remoteRef`; `publication.published` event; audit.
5. `MONITOR`: poll `status` (processing, moderation), then collect metrics on a schedule (§4.10). Moderation rejection
   or failure → `BLOCKED` with reason, never auto-retry with changed content.

Stage-planner rule: platform DEPLOY for a **test** target may run at level ≥ 3 (it is still gated by
`platform_stage` approval unless the owner marks the grant "staging without per-run approval" for that test target);
**live** publish runs at level ≥ 3 as a *request* only, because the approval is always human. This deliberately does
not require level 4, since the gate, not the level, is the control [I; decide in ADR].

Alternative for Roblox without a new adapter (cheapest possible slice): a `roblox-publish.yml` workflow in the project
repo that runs `rojo build` and calls the publish endpoint with a GitHub Actions secret, dispatched by today's
`deploy.run`. Downsides: runs only at level 4, preview has no build artefact, key lives in GitHub not in the owner's
connection, Saved/Published split and Luau tests need workflow inputs. Useful as a stop-gap, not as the target design.

### 4.7 Media Studio pipeline (project kind `media` or a `media` task in a software project)

| Stage | Actor | Output (zod-validated) | Checks / gates |
|---|---|---|---|
| INTAKE | planner | brief: goal, audience, format (`demo`, `devlog`, `trailer`, `short`), platforms, language, duration, budget | audience "kids" → forces human `madeForKids` decision later; political/real-person topics rejected |
| SCRIPT | `media_writer` agent | script with scenes, narration text, on-screen text, claims list | verify: duration estimate within target; claims reference repo facts (changelog, PRs) — no invented features; no real-person names unless consent record exists |
| STORYBOARD | `media_writer` / `media_director` | scenes → shot type (`screen_recording`, `title_card`, `generated_clip`, `stock`, `code_snippet`), timing, source | verify: every shot has a producible source; generated clips counted and cost-estimated |
| ASSETS | tools | recordings (`media.record` in sandbox via Playwright against the built app with seed data), TTS (`media.tts`), generated clips (`media.generate`), music/stock (`media.license_asset`) | budget per production; `high_cost` approval above threshold; licence record mandatory; provenance recorded (`ai_generated`, model, SynthID/C2PA) |
| RENDER | sandbox | `media.render` with ffmpeg (or Remotion if approved): composite, captions (SRT/VTT from script), loudness normalisation, platform variants (16:9, 9:16 ≤ 3 min for Shorts) | deterministic render spec (JSON) stored → re-render reproducible; output hash |
| REVIEW | reviewer agent + human | automated QA: duration, resolution, black frames/silence detection, captions present, text-on-screen spell check, near-duplicate check vs. previous publications, disclosure proposal | human preview in UI; comments create a revision loop (bounded, max 3 renders by default) |
| PUBLISH | orchestrator | publication(s) per target | `platform_publish` approval per platform with preview; default private/draft |
| MONITOR | analyst | metrics snapshots, comment summary (untrusted text) | feeds memory and proposals only |

C2PA signing of rendered output (manifest listing AI-generated ingredients) is a stage-6 feature behind the dependency
gate; until then provenance is recorded in the DB and disclosed via platform fields.

### 4.8 Budgets for generation

* New budget scope `production` (per media production) under project and global scopes; `usage_ledger` gains
  `kind` (`model_tokens | media_generation | tts | render_compute | platform_api`), `unit` and `quantity`
  (e.g. seconds of video, characters) so costs stay in one ledger.
* Estimates before every paid call: Veo `seconds × $/s(model, resolution)`, Runway credits, TTS characters/tokens;
  registry of media prices is data (like `model_configs`), editable in Settings.
* Defaults [I]: `maxProductionCostUsd` $5; generated video disabled until an admin enables a provider; `high_cost`
  approval when a single call > $1 or production estimate > 50 % of its budget.
* Render compute: sandbox time-boxed (default 15 min) and CPU-limited; no GPU assumed.

### 4.9 Approval preview (web + API payload)

`platform_publish` approval payload (stored, rendered read-only):
* Target: platform icon, connection display name/avatar (TikTok requires nickname display [V][T6]), environment
  (test/live), external ids.
* Content: video player (streamed from `ArtifactStore`, signed short-lived URL) or Roblox build summary (place file
  size, version number of the staged `Saved` version, changed scripts diff link to the PR, Luau test result).
* Metadata: title, description, tags, thumbnail, captions — editable **only by creating a new revision** (new digest).
* Visibility: explicit selection; for TikTok a dropdown with **no default** built from `creator_info` [V][T6];
  for YouTube `private` preselected with `unlisted/public` disabled while the API project is unaudited [V][Y1].
* Disclosure: AI-generated (pre-filled from provenance, cannot be unchecked when provenance says required), made for
  kids (no default, required), commercial content toggles, music licences list with proofs, TikTok music usage
  confirmation text.
* Policy result: all `PlatformPolicy.validate` issues (errors block the Approve button), manual steps checklist, rate
  cap status ("2 of 3 publishes this week"), near-duplicate score.
* Cost so far and estimate of remaining steps.
* Approver restriction: only the connection owner/delegate; others see "waiting for <owner>".

### 4.10 Analytics into MONITOR

* YouTube Analytics API (views, watch time, retention, likes) with `yt-analytics.readonly` [V][Y15]; TikTok Display API
  video list/query stats [V][T9]; Roblox: experience analytics via Open Cloud not researched → manual import or later
  [S].
* Snapshots stored in `publication_metrics` (daily, bounded to 90 days by default; statistics are exempt from
  YouTube's 30-day rule, other authorized data is not [V][Y8]).
* Use: project health signal, Project Room digest ("Demo video: 312 views in 7 days"), improvement proposals
  (e.g. "retention drops at 0:40 → shorten intro"). **Never** automatic new publications, title rewrites on live
  videos or engagement actions (comments/likes) — the latter are also restricted by platform automation rules.
* Comments pulled from platforms are untrusted input (prompt injection); only summarised with the standard untrusted
  delimiting, never used as instructions.

### 4.11 Autonomy mapping

| Level | Software → platform target | Media Studio |
|---|---|---|
| 0 Observe | nothing | nothing |
| 1 Suggest | propose a target/template, draft a manual checklist | propose production briefs and scripts |
| 2 Execute | build/test in sandbox (Rojo, Lune), no external writes | script, storyboard, local recordings/renders; paid generation only with `high_cost` approval |
| 3 Autonomous Dev | stage to **test** target (Roblox `Saved`) with `platform_stage` approval (or per-grant pre-approval for test targets); request `platform_publish` | full production up to REVIEW; request `platform_publish` |
| 4 Autonomous Delivery | same as 3 — publishing stays human | same as 3 |
| **Autopilot / away mode** | may prepare drafts, stage to test targets if pre-approved, queue publish requests into the return digest; **never publishes, never changes visibility, never spends beyond the production budget** | same |

### 4.12 Sandbox and network

* Recording/rendering images (Playwright, ffmpeg) are additional sandbox images selected by the project profile, pinned
  by digest, approved as dependencies. Network `none` for record/render (the app under test runs inside the same
  container or a sibling container on an internal network) [I].
* Rojo/Lune/StyLua/Selene installed through the registry proxy with an allow-list for their GitHub release assets or
  pre-baked into a pinned image (preferred: pre-baked, fewer egress rules) [I].
* Playwright's recommended `--ipc=host` conflicts with the hardening in ADR-006; use `--shm-size` and verify in a spike.
* No platform credential, OAuth token or generation API key is ever mounted into a container.

## 5. Data model (migration after ADR-030 / Plugin Scout / provider-accounts migrations)

| Table / change | Fields |
|---|---|
| `platform_connections` | `id`, `owner_type` (`user`\|`instance`), `owner_user_id`, `platform`, `auth_type` (`oauth2`\|`api_key`\|`webhook_url`), `external_account_id`, `display_name`, `avatar_url`, `scopes` jsonb, `secret_encrypted` (v2), `refresh_secret_encrypted`, `token_expires_at`, `secret_hint`, `secret_fingerprint`, `restrictions` jsonb (e.g. `{unauditedApiProject: true, allowedVisibility: ['private']}`), `status`, `last_verified_at`, `last_used_at`, `expires_at`, `created_at`, `updated_at` |
| `platform_connection_grants` | `id`, `connection_id`, `project_id`, `granted_by`, `actions` jsonb (`stage`, `request_publish`, `analytics`), `target_constraints` jsonb, `stage_without_approval_for_test` bool, `max_publishes_per_week`, `delegate_user_ids` jsonb, `expires_at`, `revoked_at`, `created_at` |
| `platform_targets` | `id`, `project_id`, `connection_id`, `platform`, `kind` (`roblox_place`, `youtube_video`, `tiktok_video`, `discord_post`, `itch_channel`), `environment` (`test`\|`live`), `config` jsonb, `enabled`, `created_at` |
| `media_productions` | `id`, `project_id`, `task_id`, `run_id`, `format`, `brief` jsonb, `script` jsonb, `storyboard` jsonb, `render_spec` jsonb, `status`, `revision`, `budget_usd`, `spent_usd`, `created_at`, `updated_at` |
| `media_assets` | `id`, `production_id`, `kind` (`recording`, `narration`, `generated_video`, `generated_image`, `music`, `stock`, `render`, `thumbnail`, `captions`), `source` (`sandbox`, `provider:<id>`, `stock:<site>`, `upload`), `storage_key`, `sha256`, `bytes`, `mime`, `duration_ms`, `width`, `height`, `license` jsonb (`name`, `url`, `attribution`, `proof_storage_key`, `commercial_ok`), `ai_generated` bool, `provenance` jsonb (`model`, `synthid`, `c2pa`, `prompt_hash`), `consent_record_id`, `cost_usd`, `created_at` |
| `consent_records` | `id`, `subject` (person name/role), `kind` (`voice`, `likeness`), `scope`, `evidence_storage_key`, `recorded_by`, `expires_at`, `revoked_at` |
| `publications` | `id`, `project_id`, `target_id`, `connection_id`, `production_id` null, `run_id`, `artifact_sha256`, `metadata` jsonb, `metadata_digest`, `visibility_requested`, `disclosure` jsonb, `approval_id`, `idempotency_key` unique, `status` (`draft`, `staged`, `awaiting_approval`, `approved`, `uploading`, `processing`, `live_private`, `live_public`, `rejected_by_platform`, `failed`, `withdrawn`), `remote_ref` jsonb (`videoId`, `versionNumber`, `publishId`, upload session URI encrypted), `external_url`, `attempts`, `last_error`, `published_at`, `withdrawn_at`, `created_at` |
| `publication_metrics` | `publication_id`, `captured_at`, `metrics` jsonb, `source`; purge after retention |
| `usage_ledger` (columns) | `kind`, `unit`, `quantity`, `production_id` |
| `GATED_ACTIONS` | add `platform_stage`, `platform_publish` (hard rule for the latter) |
| Enums | `TASK_KINDS += 'media'`; project `kind` (`software`\|`media`); roles `media_writer`, `media_director` (or reuse `documentation`/`release`) |

Artifact storage: `ArtifactStore` with a local-disk adapter under `DATA_DIR/artifacts` (content-addressed, quota per
project, default 5 GB [I]) and an S3-compatible adapter later (new dependency → approval).

## 6. Tools and events

* Tools (tool router): `platform.stage` (gated `platform_stage`, min level 3), `platform.publish` (gated
  `platform_publish`, min level 3, approval always), `platform.status` (read), `platform.withdraw` (level 1, operator
  or owner, audited, no approval because it reduces exposure), `platform.metrics.read`, `platform.luau.run` (test
  universe only), `media.record`, `media.render` (sandbox), `media.tts`, `media.generate` (`estimateCostUsd`),
  `media.license_asset` (records licence evidence; no scraping).
* Permissions: `orchestrator` gets `platform.*`; `release` gets `platform.status`; new media roles get `media.*` except
  publish.
* Events: `connection.created|reauth_required|revoked`, `publication.staged|approval_required|published|failed|withdrawn|rejected_by_platform`,
  `production.stage_completed`, `production.render_ready`, `media.cost_recorded`, `publication.metrics_updated`.

## 7. Server routes (`apps/server/src/routes-platforms.ts`, `routes-media.ts`; RBAC + ACL + audit on every mutation)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/connections` | self (own) / admin (instance) | never returns secrets |
| POST | `/api/connections/oauth/:platform/start` | user | returns authorize URL (state + PKCE, minimal scopes) |
| GET | `/api/connections/oauth/:platform/callback` | user | exchanges code, verifies account, stores encrypted |
| POST | `/api/connections/api-key` `{platform, key, label}` | user | verify-on-save (Roblox: read universe the key can access) |
| POST | `/api/connections/:id/verify` · DELETE `/api/connections/:id` | owner | revoke remotely where supported; purge data |
| POST/DELETE | `/api/connections/:id/grants` | owner | project must be one the owner is a member of (ADR-022) |
| GET/POST/PATCH | `/api/projects/:id/targets` | viewer / admin | test vs live; live requires owner grant |
| GET/POST | `/api/projects/:id/productions` | viewer / operator | create brief → task |
| GET | `/api/productions/:id` · `/api/productions/:id/assets` | viewer | licence and provenance included |
| POST | `/api/productions/:id/revise` `{comments}` | operator | bounded revision loop |
| GET | `/api/artifacts/:key/stream` | viewer (ACL) | short-lived signed URL, range requests, `Content-Disposition: inline`, no public access |
| GET | `/api/projects/:id/publications` · `/api/publications/:id` | viewer | status, remote URL, metrics |
| POST | `/api/publications/:id/withdraw` | owner / operator | audited |
| POST | `/api/approvals/:id/decide` (existing) | connection owner/delegate for `platform_publish` | server re-validates policy, digest and connection status before accepting |
| GET/PUT | `/api/settings/media-pricing`, `/api/settings/publishing` | admin | kill switch `PUBLISHING_ENABLED` (default false), per-platform enable |

Config: `PUBLISHING_ENABLED`, `YOUTUBE_OAUTH_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, `PUBLIC_BASE_URL` (OAuth
redirects), `ARTIFACT_DIR`, `ARTIFACT_QUOTA_BYTES`. Metrics: publications by status/platform, platform 429s, upload
bytes, media spend.

## 8. Web UI

* **Settings → Connections**: cards per platform ("Connect YouTube", "Add Roblox API key" with scope checklist, CIDR and
  60-day expiry hint, "TikTok: unaudited, private/draft only"), status badges, grants per project, disconnect.
* **Project → Targets** tab: target list (test/live), last staged/published version, manual-steps checklist with who
  confirmed, "Run Luau smoke test" (test universe), link to Creator Dashboard / YouTube Studio.
* **Project → Media** tab (or Media project home): production board (Brief → Script → Storyboard → Assets → Render →
  Review → Publish), script editor with claim references, storyboard frames, asset table with licence and AI badges,
  cost meter vs budget, render player with timestamped comments, revision history.
* **Approvals**: new `platform_publish` card (§4.9) with player, metadata, disclosure controls, policy issues, approver
  restriction; keyboard-accessible, text badges not colour only.
* **Publications** list per project and global (ACL-filtered) with status, external link, metrics sparkline, withdraw.
* Project Room: status messages for staged/published/failed; `@orchestrator` cannot approve publishes (commands for
  approvals are limited to the connection owner and still open the preview).

## 9. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Accidental public publish (wrong target, wrong visibility) | M | H | hard `platform_publish` gate; owner-only approval; private defaults; test/live separation; digest-bound approval; kill switch |
| 2 | Platform account strike/termination for spam or mass-produced AI content [Y17][Y18][T12][O13] | M | H | weekly publish caps per connection; near-duplicate check; human-authored script edits encouraged; no engagement automation |
| 3 | Missing/incorrect AI disclosure → policy + EU AI Act exposure [Y19][T10][L1] | M | H | provenance-driven disclosure that cannot be downgraded; legal review of provider role; C2PA in stage 6 |
| 4 | Voice/likeness of real people without consent [V21][L12] | L | H | consent_records required for any real-person voice/likeness; no cloning features in v1; stock voices only |
| 5 | Copyright/Content ID claims on music or stock [V31][V32] | M | M | licence records with proofs; allow-listed sources; AI music only from providers with commercial terms; no YouTube Audio Library off-platform |
| 6 | Credential leak (OAuth refresh token, Roblox key) | L | H | v2 encryption with AAD, never in sandbox/context/logs, redactor patterns, CIDR on Roblox keys, minimal scopes, revoke on disconnect |
| 7 | Luau Execution writes live DataStores [R9] | M | H (player data) | Luau runs only against test universes; separate key scoped to test universe; guard in tool |
| 8 | Minors: data collection or unsafe features in Roblox experiences; kids content on YouTube [L7][R25][Y20] | M | H | no in-experience AI chat by default; no external HTTP from experiences with user data; `madeForKids` explicit human choice; templates without analytics SDKs |
| 9 | Unaudited API projects keep uploads private / TikTok audit likely refused [Y1][T6] | H | M | design around private/draft; document manual final step; decide on audits as owner question |
| 10 | 7-day token expiry in Google Testing mode [Y9] | H | L | `reauth_required` status + notification; consider app verification |
| 11 | Media generation cost overrun | M | M | price registry, estimates before calls, production budget, `high_cost` gate, providers disabled by default |
| 12 | Vendor churn (Sora API removal [V26], Revideo maintenance [V12], beta endpoints [R8]) | H | M | `MediaGenerator` port, no single-vendor features, contract tests with recorded fixtures, re-check facts per stage |
| 13 | Duplicate uploads on retry | M | M | idempotency key per approval, persisted resumable session, status query before retry |
| 14 | Large files exhaust disk | M | M | artifact quotas, retention (delete intermediate assets after publish + N days), streaming uploads |
| 15 | Screen recordings leak personal/secret data | M | H | synthetic seed data only, sandbox without secrets, OCR-free but mandatory human preview, redaction of env/config screens in demo scripts |
| 16 | Prompt injection via platform comments/metrics text | M | M | untrusted-data handling as in ADR-030/Plugin Scout; never used as instructions or metadata |
| 17 | Legal duties differ per country (Impressum, AI Act, COPPA, OSA) | M | M | owner-facing checklist per connection; legal review before offering the instance to third parties |
| 18 | New dependencies (Rojo, Playwright, ffmpeg, Remotion, C2PA) add supply-chain risk | M | M | owner approval per dependency (STATE.md); pinned images by digest; Plugin Scout trust signals |

## 10. Stages and acceptance criteria

| Stage | Scope | Acceptance criteria |
|---|---|---|
| **0 — Decisions** | Owner answers §12 questions 1–5; ADR merged with a number; dependency approvals requested for the stage-2 toolchain | ADR in `docs/DECISIONS.md`; STATE.md roadmap entry; no code |
| **1 — Connector framework** | core `platforms/` (ports, `PlatformPolicy` interface, publication state machine, gate classification), `platform_stage`/`platform_publish` gated actions with hard rule, tools `platform.*` with fake connector, `ArtifactStore` (local disk), tables `platform_connections`/`grants`/`targets`/`publications`, secret v2 for connections, connections API (api_key type), approval payload + UI card (generic), audit, kill switch | (a) `platform.publish` is denied with `approval_required` at levels 0–4 even when all project gates are disabled; (b) approval by a user who is not the connection owner/delegate → 403 and audit row; (c) changing title or artifact after approval invalidates it (new approval required); (d) retry after a simulated crash mid-publish does not call the fake connector's `publish` twice (idempotency test); (e) secrets never appear in API responses, logs, events or agent context (redaction tests); (f) `PUBLISHING_ENABLED=false` blocks all external writes; (g) ACL: cross-project access to targets/publications denied under `PROJECT_ACL=enforced`; (h) grants only for projects where the owner is a member |
| **2 — Roblox (recommended first real slice)** | Rojo template, pre-baked pinned toolchain image, sandbox build + StyLua/Selene/Lune tests, Roblox adapter (Saved/Published versions, Luau Execution, universe read), `RobloxPolicy` (10 MB, title rules, test/live separation, manual steps), Targets tab | (a) a template project builds `place.rbxl` in the sandbox with network `none` after install; (b) against a fake Roblox API: `Saved` upload returns and checkpoints `versionNumber`; 429 honours `retry-after`; (c) Luau smoke test runs only for `environment=test` targets (guard test); (d) `Published` happens only after owner approval, on the approved place id, and the published version equals the approved digest; (e) title containing "Blox" is rejected by policy; (f) manual checklist shows "Maturity & Compliance questionnaire" until confirmed; (g) one manual end-to-end run by the owner against a private, unrated test universe documented in STATE.md |
| **3 — Media Studio v1 (no generative video)** | project kind/task kind `media`, SCRIPT/STORYBOARD/ASSETS/RENDER/REVIEW stages, Playwright recording image, ffmpeg render, captions from script, optional TTS (local Kokoro or OpenAI) with AI-voice disclosure, asset licence/provenance records, production budget scope, Media tab + review player | (a) a demo of the orchestrator's own web UI with seed data renders to MP4 (16:9 and 9:16 ≤ 60 s variants) reproducibly from the stored render spec (same hash with same inputs where the encoder is deterministic, otherwise same duration/frames within tolerance); (b) script claims without repo references fail verify; (c) any narration asset marks `ai_generated` and the publication disclosure proposal; (d) budget exhaustion blocks with reason; (e) render container has no secrets and no network (fake exec args test); (f) revision loop stops after the configured maximum |
| **4 — YouTube** | OAuth connection (Testing mode acceptable), resumable upload as `private`, metadata incl. `containsSyntheticMedia` and `selfDeclaredMadeForKids`, thumbnails (if channel verified), captions, `YouTubePolicy` (unaudited → only private), status polling, Analytics snapshots into MONITOR, 30-day purge | (a) fake-API tests: resumable upload resumes after a dropped connection without a second `videos.insert`; (b) `unlisted/public` is rejected by policy while `unauditedApiProject=true`; (c) `madeForKids` null blocks approval; (d) AI-generated asset forces `containsSyntheticMedia=true` in the approved payload; (e) token expiry sets `reauth_required` and blocks the publication with a clear reason; (f) owner performs one real private upload of the stage-3 demo video; quota usage visible in metrics |
| **5 — TikTok + quick wins** | TikTok inbox upload (`video.upload`), creator_info-driven UX, `TikTokPolicy`; Discord webhook post; itch.io decision | (a) privacy dropdown has no default and approval is impossible without a selection; (b) sixth pending inbox upload within 24 h is prevented locally; (c) no watermark/branding added (render spec check); (d) Discord webhook URL stored encrypted and never logged |
| **6 — Generative media and provenance** | `MediaGenerator` adapters (Veo via Gemini API, Runway), media price registry, `high_cost` gate, consent records, music providers with licence evidence, C2PA signing (dependency approval) | (a) estimate is checked before every call and recorded in the ledger with unit/quantity; (b) region rules: person generation option not offered where the provider forbids it; (c) C2PA manifest lists AI ingredients and validates with the reference verifier; (d) prompts mentioning real persons without a consent record are rejected |
| **7 — Optional targets** | Google Play `internal` track, TestFlight internal, Steam beta branch, Instagram Reels (own professional account) | each: publish to the most private track only via connector; production/default-branch/App Review steps stay manual with checklist |

**Recommendation for the first slice: Stage 1 + Stage 2 (Roblox Saved version to a private test universe).**
Reasons: API-key auth (no OAuth server, no Google/TikTok app review), the API cannot change visibility or age rating,
unrated experiences are only playable by the developer, deterministic artefact (place file) that fits the existing
build → test → CI flow, and it directly answers idea (a). It exercises every framework piece (connection secret,
target, stage vs publish gate, preview, idempotency, audit). Main costs: Luau/Rojo template quality and toolchain
dependency approvals.
Second slice: Stage 3 + Stage 4 limited to **screen-recorded demo → YouTube private**, which answers idea (b) with low
risk (private by API rule, no generative video spend). TikTok follows only as inbox drafts.

## 11. Proposed ADR (draft — not in `docs/DECISIONS.md`)

> ## ADR-0XX (number assigned at merge) — Platform publishing connectors and Media Studio; humans always publish
> * **Context:** The owner wants projects shipped directly into platforms (e.g. Roblox) and videos produced and
>   published (YouTube, TikTok). Platform terms require the account holder's express consent for uploads (YouTube
>   Developer Policies III.E.3/III.I, TikTok content sharing guidelines), unaudited API clients are restricted to private
>   content, Roblox cannot create or publicise experiences through the API, and AI-content labelling obligations apply
>   (platform policies, EU AI Act Art. 50 from 2026-08-02). ADR-006 forbids host execution, ADR-009 keeps secrets out
>   of context, ADR-022 scopes projects, ADR-023 expires approvals; the owner requires approval for every new
>   dependency.
> * **Decision:**
>   * Core defines IO-free ports `PublishingConnector`, `ArtifactStore`, `MediaGenerator` and per-platform
>     `PlatformPolicy` (defaults, validation, disclosure requirements, manual steps). Adapters live in
>     `packages/integrations/src/platforms` and `…/media`; they use plain HTTP where possible.
>   * New gated actions `platform_stage` (non-public uploads to test targets) and `platform_publish` (anything visible to
>     others or any upload on behalf of an account holder). `platform_publish` requires human approval at every autonomy
>     level, cannot be disabled, is decided only by the connection owner or a named delegate, and is bound to the
>     artefact hash and metadata digest.
>   * Platform connections are owned by one user (or the instance), stored encrypted (secret format v2), used through
>     per-project grants, never exposed to the sandbox, model context or logs. OAuth with minimal scopes; Roblox via
>     scoped, IP-restricted API keys.
>   * Defaults are the most private option per platform; manual platform steps (Roblox maturity questionnaire and
>     visibility, TikTok in-app finalisation, store release) are explicit checklist items, not automated.
>   * Media Studio is a pipeline (`SCRIPT → STORYBOARD → ASSETS → RENDER → REVIEW → PUBLISH → MONITOR`) with sandboxed
>     recording/rendering, a production budget scope, licence and provenance records per asset, and disclosure flags
>     derived from provenance that humans can confirm but not downgrade.
>   * Autopilot and all autonomy levels may prepare drafts and stage to test targets; none may publish, change
>     visibility or perform engagement actions. Analytics feed MONITOR and proposals only.
>   * Publishing is disabled by default (`PUBLISHING_ENABLED=false`) and enabled per platform by an admin.
> * **Consequences:** New tables (connections, grants, targets, productions, assets, consent records, publications,
>   metrics), ledger columns for non-token costs, artifact storage, new tools/roles/events, route modules and UI tabs;
>   ongoing maintenance of platform policies as terms change; some platforms (TikTok public posts, YouTube public
>   uploads) stay limited until audits, which may not be obtainable for a single-owner tool.
> * **Status:** Proposed (2026-09-14).

Fit: ADR-004 (jobs, idempotency), ADR-005 (media price registry mirrors "models are data"), ADR-006 (sandbox, no host
execution), ADR-008/024 (events), ADR-009 (secrets), ADR-010 (zod outputs for script/storyboard), ADR-022 (ACL),
ADR-023 (expiry), ADR-030 (Project Room messages; external AIs may read productions but not approve), Plugin Scout
`dependency_addition` rule, provider-accounts research (ownership and grants).

## 12. Open questions

1. **First slice**: Roblox first (recommended) or YouTube demo video first?
2. **Audits**: should we apply for the YouTube API compliance audit and Google OAuth verification (public/unlisted
   uploads, long-lived tokens), and is a TikTok Direct Post audit worth attempting given the "own accounts only" rejection
   criterion? Both require a public homepage/privacy policy; is the instance ever offered to third parties?
3. **Artifact storage**: local disk with quotas acceptable for v1, or S3-compatible storage from the start (dependency)?
4. **Rendering stack**: ffmpeg-only (free, more code) vs Remotion (Automator licence ≥ $100/month) vs Revideo
   (maintenance risk)?
5. **TTS and generative video providers**: which providers may be enabled at all (data leaves the instance, costs)?
   Local Kokoro as default voice?
6. **Approver model**: connection owner only, or also project admins for instance-owned brand channels? Two-person rule
   for live targets?
7. **Legal**: is the orchestrator a "provider" under AI Act Art. 50(2) when it composes generated media, requiring
   machine-readable marking (C2PA) by 2026-12-02 at the latest? Impressum handling for commercial channels?
8. **Roblox**: group-owned vs user-owned keys (group keys deprecation deferred); do we need Luau Execution in CI (costs
   unclear) or are Lune tests enough initially? How to handle the 10 MB API limit for larger places?
9. **Roblox analytics** for MONITOR: no Open Cloud analytics researched — manual import acceptable?
10. **Stage-planner level**: allow platform test staging at level 3 (gate as control) or keep all platform work at
    level 4 like today's DEPLOY?
11. **Kids content**: forbid `madeForKids=true` productions entirely in v1 (simplest COPPA posture)?
12. **Facts to re-check before implementation** (marked [S] above): YouTube `youtube.upload` sensitivity class, TikTok
    inbox restrictions for unaudited clients and Community Guidelines wording, Roblox Community Standards wording and
    Luau Execution billing, Meta Standard Access for own accounts, Discord verification threshold, Google Play auth
    method, Digital Omnibus details and Code of Practice date, C2PA MP4 support in `@contentauth/c2pa-node`, Veo C2PA on
    Gemini API (vs Vertex), Remotion licence terms at purchase time.

## 13. Sources

Roblox
- [R1] API keys: https://create.roblox.com/docs/cloud/auth/api-keys
- [R2] API key documentation improvements (2025-10-15): https://devforum.roblox.com/t/open-cloud-api-key-documentation-improvements/4009194
- [R3] Deferred group-owned API key deprecation: https://devforum.roblox.com/t/deferred-api-key-consolidation-deprecating-group-owned-api-keys/4068530
- [R4] OAuth 2.0 registration: https://create.roblox.com/docs/cloud/auth/oauth2-registration ; overview: https://create.roblox.com/docs/cloud/auth/oauth2-overview
- [R5] OAuth 2.0 reference: https://create.roblox.com/docs/cloud/auth/oauth2-reference
- [R6] Changes to Open Cloud API usage policies (2025-05-30): https://devforum.roblox.com/t/changes-to-open-cloud-api-usage-policies/3671058
- [R7] Creator Third Party App Policy: https://en.help.roblox.com/hc/en-us/articles/37924211313044-Creator-Third-Party-App-Policy
- [R8] OpenAPI specs: https://github.com/Roblox/creator-docs (`content/en-us/reference/cloud/openapi.json`, `universes-api/v1.json`, `assets/v1.json`)
- [R9] Allow editing/creating experiences with OAuth (2026-03-27): https://devforum.roblox.com/t/allow-editing-creating-experiences-with-open-cloud-oauth/4541620 ; Luau Execution reference in [R8]
- [R10] Place publishing guide: https://create.roblox.com/docs/cloud/guides/usage-place-publishing ; place files: https://create.roblox.com/docs/projects/place-files
- [R11] Universe resource: https://create.roblox.com/docs/cloud/reference/Universe
- [R12] Assets guide: https://create.roblox.com/docs/cloud/guides/usage-assets
- [R13] Data stores guide: https://create.roblox.com/docs/cloud/guides/data-stores ; throttling: https://create.roblox.com/docs/cloud/guides/data-stores/throttling
- [R14] Unifying data store limits: https://devforum.roblox.com/t/unifying-data-stores-open-cloud-and-game-apis-and-increasing-storage-limits/4739240
- [R15] Unifying MessagingService limits: https://devforum.roblox.com/t/unifying-messagingservice-opencloud-api-and-engine-api-rate-limits/4600993
- [R16] Luau Execution beta announcement: https://devforum.roblox.com/t/beta-open-cloud-engine-api-for-executing-luau/3172185
- [R17] Extended Services: https://create.roblox.com/docs/cloud-services/extended-services
- [R18] Tool repositories: https://github.com/rojo-rbx/rojo · https://github.com/lune-org/lune · https://github.com/rojo-rbx/rokit · https://github.com/Roblox/foreman · https://github.com/UpliftGames/wally · https://github.com/Kampfkarren/selene · https://github.com/JohnnyMorganz/StyLua · https://github.com/Roblox/jest-roblox
- [R19] Place CI/CD demo (archived): https://github.com/Roblox/place-ci-cd-demo
- [R20] rbxcloud CLI: https://sleitnick.github.io/rbxcloud/cli/cli-luau-execution/ ; https://github.com/grand-hawk/action-roblox-luau-execution
- [R21] Studio OS requirements: https://en.help.roblox.com/hc/en-us/articles/203312800-Computer-Hardware-Operating-System-Requirements
- [R22] Vinegar: https://github.com/vinegarhq/vinegar
- [R23] Unrated experiences update: https://devforum.roblox.com/t/important-updates-unrated-experiences-and-changes-to-experience-pages/3899317
- [R24] Content maturity: https://create.roblox.com/docs/production/promotion/content-maturity
- [R25] Generative AI in experiences: https://create.roblox.com/docs/generative-AI
- [R26] Roblox Terms of Use: https://en.help.roblox.com/hc/en-us/articles/115004647846-Roblox-Terms-of-Use
- [R27] Community Standards: https://about.roblox.com/community-standards
- [R28] Name and logo guidelines: https://en.help.roblox.com/hc/en-us/articles/115001708126-Roblox-Name-and-Logo-Community-Usage-Guidelines
- [R29] Age check for chat: https://ir.roblox.com/news/news-details/2026/Roblox-Requires-Users-Worldwide-to-Age-Check-to-Access-Chat/default.aspx
- [R30] Romantic/sexual content policy extension: https://about.roblox.com/newsroom/2025/08/extending-roblox-policy-on-romantic-and-sexual-content
- [R31] DevEx: https://en.help.roblox.com/hc/en-us/articles/203314100-Developer-Exchange-DevEx-Overview-How-to-Submit-Requirements
- [R32] Rewarded video ads: https://create.roblox.com/docs/production/promotion/rewarded-video-ads ; newsroom 2026-07-16: https://about.roblox.com/newsroom/2026/07/build-without-limits-on-roblox

YouTube / Google
- [Y1] videos.insert: https://developers.google.com/youtube/v3/docs/videos/insert
- [Y2] Authentication: https://developers.google.com/youtube/v3/guides/authentication
- [Y3] Resumable uploads: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
- [Y4] Upload size: https://support.google.com/youtube/answer/71673
- [Y5] Quota costs: https://developers.google.com/youtube/v3/determine_quota_cost
- [Y6] Revision history: https://developers.google.com/youtube/v3/revision_history
- [Y7] Quota and compliance audits: https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- [Y8] Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- [Y9] OAuth app publishing status: https://support.google.com/cloud/answer/15549945
- [Y10] Sensitive scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- [Y11] Videos resource: https://developers.google.com/youtube/v3/docs/videos
- [Y12] Shorts length: https://support.google.com/youtube/answer/15424877
- [Y13] thumbnails.set: https://developers.google.com/youtube/v3/docs/thumbnails/set ; custom thumbnails: https://support.google.com/youtube/answer/72431
- [Y14] captions.insert: https://developers.google.com/youtube/v3/docs/captions/insert
- [Y15] Analytics API: https://developers.google.com/youtube/analytics/reference ; https://developers.google.com/youtube/analytics
- [Y16] Reporting API: https://developers.google.com/youtube/reporting/v1/reports
- [Y17] Spam, deceptive practices and scams: https://support.google.com/youtube/answer/2801973
- [Y18] YPP policies (inauthentic content): https://support.google.com/youtube/answer/1311392
- [Y19] Altered or synthetic content disclosure: https://support.google.com/youtube/answer/14328491
- [Y20] Made for kids: https://support.google.com/youtube/answer/9528076 ; https://support.google.com/youtube/answer/9527654
- [Y21] AI likeness (press): https://techcrunch.com/2024/07/01/youtube-now-lets-you-request-removal-of-ai-generated-content-that-simulates-your-face-or-voice ; https://www.axios.com/2025/09/16/youtube-ai-likeness-detection-deepfakes
- Channel upload limits: https://support.google.com/youtube/answer/10383400

TikTok
- [T1] Content Posting API get started: https://developers.tiktok.com/doc/content-posting-api-get-started
- [T2] Direct Post reference: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- [T3] Upload (inbox) reference: https://developers.tiktok.com/doc/content-posting-api-reference-upload-video ; creator info: https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
- [T4] Photo post: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
- [T5] Media transfer: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
- [T6] Content sharing guidelines (incl. audit criteria, UX): https://developers.tiktok.com/doc/content-sharing-guidelines ; audit application: https://developers.tiktok.com/application/content-posting-api
- [T7] Token management: https://developers.tiktok.com/doc/oauth-user-access-token-management
- [T8] Login Kit: https://developers.tiktok.com/doc/login-kit-overview
- [T9] Display API: https://developers.tiktok.com/doc/display-api-overview
- [T10] AI transparency / C2PA: https://newsroom.tiktok.com/en-us/partnering-with-our-industry-to-advance-ai-transparency-and-literacy
- [T11] AIGC update 2025-11-19: https://newsroom.tiktok.com/more-ways-to-spot-shape-and-understand-ai-content?lang=en
- [T12] Community Guidelines (did not render; snippets): https://www.tiktok.com/community-guidelines/en/fyf-standards ; https://www.tiktok.com/community-guidelines/en/integrity-authenticity
- [T13] Developer Terms: https://www.tiktok.com/legal/page/global/tik-tok-developer-terms-of-service/en
- [T14] Youth privacy defaults: https://newsroom.tiktok.com/strengthening-privacy-and-safety-for-youth?lang=en

Video pipeline
- [V1] Playwright browser context options: https://playwright.dev/docs/api/class-browser#browser-new-context
- [V2] Playwright videos: https://playwright.dev/docs/videos
- [V3] Playwright Screencast: https://playwright.dev/docs/api/class-screencast
- [V4] Playwright Docker: https://playwright.dev/docs/docker
- [V5] Audio in recordings (issues): https://github.com/microsoft/playwright/issues/4870 ; https://github.com/microsoft/playwright/issues/16526
- [V6] FFmpeg legal: https://ffmpeg.org/legal.html
- [V7] Remotion license: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- [V8] Remotion pricing: https://www.remotion.pro/license
- [V9] Remotion Docker: https://www.remotion.dev/docs/docker
- [V10] Motion Canvas license: https://github.com/motion-canvas/motion-canvas/blob/main/LICENSE
- [V11] Motion Canvas headless rendering issues: https://github.com/motion-canvas/motion-canvas/issues/415 ; https://github.com/motion-canvas/motion-canvas/issues/1218
- [V12] Revideo status: https://midrender.com/revideo ; https://github.com/midrender/revideo
- [V13] editly: https://github.com/mifi/editly/blob/master/LICENSE ; https://github.com/mifi/editly/discussions/308
- [V14] OpenAI pricing: https://developers.openai.com/api/docs/pricing
- [V15] ElevenLabs API pricing: https://elevenlabs.io/pricing/api
- [V16] Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- [V17] Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M
- [V18] Piper (GPL): https://github.com/OHF-Voice/piper1-gpl
- [V19] OpenAI TTS guide (disclosure, custom voices): https://developers.openai.com/api/docs/guides/text-to-speech ; Voice Engine: https://openai.com/index/expanding-on-how-voice-engine-works-and-our-safety-research/
- [V20] ElevenLabs voice cloning: https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning ; restrictions: https://elevenlabs.io/docs/help-center/product/voices/voice-cloning/are-there-any-restrictions-on-what-voices-i-can-upload-for-voice-cloning
- [V21] ELVIS Act: https://www.tn.gov/governor/news/2024/1/10/tennessee-first-in-the-nation-to-address-ai-impact-on-music-industry.html ; https://www.hklaw.com/en/insights/publications/2024/04/first-of-its-kind-ai-law-addresses-deep-fakes-and-voice-clones
- [V22] NO FAKES Act S.4591: https://www.congress.gov/bill/119th-congress/senate-bill/4591 ; https://www.manatt.com/insights/newsletters/client-alert/congress-reintroduces-the-no-fakes-act-what-s-new-in-the-2026-bill
- [V23] Veo on Gemini API: https://ai.google.dev/gemini-api/docs/veo
- [V24] Gemini API pricing (Veo, Lyria): https://ai.google.dev/gemini-api/docs/pricing
- [V25] Vertex AI content credentials (did not render): https://docs.cloud.google.com/vertex-ai/generative-ai/docs/content-credentials
- [V26] OpenAI deprecations (Sora 2 removal 2026-09-24; re-checked): https://developers.openai.com/api/docs/deprecations
- [V27] Runway API pricing: https://docs.dev.runwayml.com/guides/pricing/
- [V28] Luma API pricing: https://lumalabs.ai/api/pricing
- [V29] Lyria music generation: https://ai.google.dev/gemini-api/docs/music-generation
- [V30] Pixabay license: https://pixabay.com/service/license-summary/
- [V31] Pixabay Content ID claims: https://pixabay.com/blog/posts/how-to-clear-a-youtube-content-id-claim-with-a-pix-190/
- [V32] Free Music Archive license guide: https://freemusicarchive.org/License_Guide ; https://freemusicarchive.org/FAQ_For_Videos/
- [V33] Incompetech licenses: https://incompetech.com/music/royalty-free/licenses/
- [V34] Suno terms: https://suno.com/terms ; WMG settlement: https://www.musicbusinessworldwide.com/warner-music-group-settles-with-suno-strikes-first-of-its-kind-deal-with-ai-song-generator/
- [V35] Udio/Suno licensing (press): https://www.billboard.com/pro/what-suno-udio-licensing-deals-mean-future-ai-music/
- [V36] YouTube Audio Library: https://support.google.com/youtube/answer/3376882
- [V37] C2PA Node: https://opensource.contentauthenticity.org/docs/node-landing/ ; https://www.npmjs.com/package/@contentauth/c2pa-node
- [V38] YouTube "captured with a camera": https://support.google.com/youtube/answer/15446725
- Pexels license: https://www.pexels.com/license/ · OFL FAQ: https://openfontlicense.org/ofl-faq/

Other targets
- [O1] App Store Connect API keys: https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api
- [O2] Build Uploads API: https://developer.apple.com/documentation/appstoreconnectapi/build-uploads ; https://developer.apple.com/videos/play/wwdc2025/324/
- [O3] TestFlight: https://developer.apple.com/testflight/
- [O4] App Review: https://developer.apple.com/distribute/app-review/
- [O5] Xcode requirements: https://developer.apple.com/xcode/system-requirements
- [O6] App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- [O7] Guideline update 2025-11-13: https://developer.apple.com/news/?id=ey6d8onl
- [O8] Play edits: https://developers.google.com/android-publisher/edits
- [O9] Play tracks: https://developers.google.com/android-publisher/tracks ; https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks
- [O10] Play testing requirements for new personal accounts: https://support.google.com/googleplay/android-developer/answer/14151465?hl=en
- [O11] Play AI-generated content policy: https://support.google.com/googleplay/android-developer/answer/14094294?hl=en
- [O12] butler: https://itch.io/docs/butler/
- [O13] itch.io quality guidelines: https://itch.io/docs/creators/quality-guidelines
- [O14] itch.io AI disclosure: https://itch.io/t/4309690/generative-ai-disclosure-tagging
- [O15] Steamworks uploading: https://partner.steamgames.com/doc/sdk/uploading
- [O16] Steam builds: https://partner.steamgames.com/doc/store/application/builds
- [O17] Steam review process: https://partner.steamgames.com/doc/store/review_process
- [O18] Steam Direct: https://partner.steamgames.com/steamdirect
- [O19] Steam content survey: https://partner.steamgames.com/doc/gettingstarted/contentsurvey
- [O20] Vercel tokens: https://vercel.com/docs/accounts/access-tokens ; AUP: https://vercel.com/legal/acceptable-use-policy
- [O21] Netlify API: https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/ ; AUP: https://www.netlify.com/legal/acceptable-use-policy/
- [O22] Cloudflare Workers CI: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- [O23] Vercel fair use: https://vercel.com/docs/limits/fair-use-guidelines
- [O24] Discord application resource: https://docs.discord.com/developers/resources/application
- [O25] Discord app verification (403; snippet): https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified
- [O26] Privileged intent review: https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review
- [O27] Discord self-bots: https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
- [O28] Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/
- [O29] Meta App Review: https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review
- [O30] Meta AI labelling: https://about.fb.com/news/2024/04/metas-approach-to-labeling-ai-generated-content-and-manipulated-media/
- [O31] Twitch API reference: https://dev.twitch.tv/docs/api/reference
- [O32] Twitch videos / upload removal: https://dev.twitch.tv/docs/api/videos/ ; https://discuss.dev.twitch.com/t/does-the-helix-new-api-have-video-upload/15517

Legal
- [L1] AI Act Art. 50: https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50
- [L2] Gibson Dunn on Omnibus: https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/
- [L3] Freshfields on final Omnibus: https://www.freshfields.com/en/our-thinking/blogs/technology-quotient/eu-ai-act-unpacked-34-the-final-digital-omnibus-on-ai-key-amendments-to-the-a-102nber
- [L4] Mayer Brown (2026-07): https://www.mayerbrown.com/en/insights/publications/2026/07/eu-ai-act-news-digital-omnibus-on-ai-new-guidance-on-risk-classification-gpai-and-transparency-obligations
- [L5] Code of Practice on marking/labelling: https://digital-strategy.ec.europa.eu/en/news/commission-publishes-code-practice-marking-and-labelling-ai-generated-content ; https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content
- [L6] AI Act Art. 99: https://artificialintelligenceact.eu/article/99/
- [L7] COPPA rule (Federal Register): https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule
- [L8] COPPA obligations: https://www.davispolk.com/insights/client-update/ftc-prioritizes-coppa-enforcement-new-compliance-obligations-take-effect
- [L9] Ofcom age checks: https://www.ofcom.org.uk/online-safety/protecting-children/age-checks-to-protect-children-online
- [L10] ICO Children's Code: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/introduction-to-the-childrens-code/
- [L11] US Copyright Office Part 2: https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf
- [L12] YouTube impersonation: https://support.google.com/youtube/answer/2801947?hl=en
- [L13] TAKE IT DOWN Act enforcement: https://www.ftc.gov/business-guidance/blog/2026/05/take-it-down-act-enforcement-starts-now-what-know-about-ftc-tida
- [L14] State election deepfake laws: https://azcapitoltimes.com/news/2026/07/21/state-ai-deepfake-laws-face-first-big-test-in-2026-midterm-elections/ ; https://www.citizen.org/news/30-states-now-have-laws-to-regulate-election-deepfakes/
- [L15] FTC endorsement guides: https://www.ftc.gov/news-events/news/press-releases/2023/06/federal-trade-commission-announces-updated-advertising-guides-combat-deceptive-reviews-endorsements
- [L16] FTC fake reviews rule: https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials
- [L17] Impressum for YouTube: https://www.e-recht24.de/impressum/13093-youtube-impressum.html ; https://www.medienanstalt-hessen.de/aufsicht/telemedien-digitale-dienste-internetaufsicht/impressumspflicht/
- [L18] YouTube fake engagement: https://support.google.com/youtube/answer/3399767?hl=en
- DSA: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32022R2065
