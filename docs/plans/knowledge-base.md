# Plan: Wissensbasis (knowledge base) — searchable project memory for every agent

Request (2026-09-16, feature 2 of the approved backlog): a searchable project memory built from the repository (code,
docs, ADRs, STATE, plans), decisions and decision memory, room conversations and uploaded files. Pipeline agents, the
autopilot decision ladder (rung "memory/precedent"), workflows, the planning assistant and external AIs through the
planned MCP server (ADR-030) all use it. It is a nav item "Wissensbasis" in the owner's mockups; the UI copy is German.

Status: **proposal / research**. Nothing here is implemented. Proposed decision: **ADR-039** (draft in §14).
Research date: 2026-09-16. Code references are to `main` at `cd8db47` plus the open PRs #30 (board, leases) and #31
(autopilot decision ladder), which both add a migration `0004`.

## Zusammenfassung (Deutsch)

* **Eine Wissensbasis pro Projekt, streng getrennt.** Quellen (Repo-Dokumente, ADRs, STATE, Pläne, Entscheidungen,
  später Code, Raum-Chats und Uploads) werden in Abschnitte („Chunks") zerlegt, bereinigt, Secrets entfernt und mit
  Quellenangabe (Pfad + Zeilen, Entscheidungs-ID, Nachrichten-ID) gespeichert. Jede Abfrage ist auf genau die Projekte
  beschränkt, die Nutzer, Agent oder externe KI sehen dürfen (ADR-022), auch über MCP.
* **Volltextsuche funktioniert heute schon ohne neue Abhängigkeit.** Getestet mit dem installierten PGlite 0.5.8
  (PostgreSQL 18.3): `german`- und `english`-Konfigurationen, `websearch_to_tsquery`, GIN-Index, `ts_rank_cd` und
  `ts_headline` laufen. `pg_trgm` und `unaccent` liegen als `@electric-sql/pglite/contrib/*` im selben Paket.
* **pgvector ist NICHT im installierten Paket.** Seit PGlite 0.5 ist es das separate npm-Paket
  `@electric-sql/pglite-pgvector` (0.0.9, Peer-Dependency exakt `@electric-sql/pglite@0.5.8`). Das ist eine neue
  Abhängigkeit und braucht nach ADR-031 deine Freigabe. Für Produktion bräuchte es zusätzlich ein Postgres-Image mit
  pgvector (`postgres:17` im Compose-File hat es nicht).
* **Vektorsuche trotzdem ohne neues Paket möglich:** Embeddings als `bytea` speichern und projektweise im Speicher per
  Kosinus vergleichen (brute force). Für typische Projekte (bis ca. 50 000 Chunks) reicht das. pgvector mit HNSW wird
  ein austauschbarer Adapter hinter demselben Port, sobald du ihn freigibst.
* **Embeddings über die vorhandenen SDKs:** OpenAI (`text-embedding-3-small`, $0,02 pro 1 Mio. Tokens), Google
  (`gemini-embedding-2`, $0,20), OpenAI-kompatibel für **Ollama lokal** (kostenlos, Daten verlassen den Rechner nicht)
  und Mistral. Anthropic hat keine eigene Embeddings-API (bestätigt in der Anthropic-Doku, empfiehlt Voyage). Voyage
  ginge ohne npm-Paket per `fetch`, ist aber ein neuer externer Dienst. Ein ganzes Repo wie dieses kostet mit
  OpenAI-small grob einen Cent.
* **Hybride Suche:** Volltext + Vektor, zusammengeführt mit Reciprocal Rank Fusion (k = 60), dann gewichtet nach
  Autorität (akzeptierte ADRs und STATE > Entscheidungen > Pläne > Code/Doku > Uploads > Chat) und Aktualität.
  Superseded ADRs und abgelehnte Entscheidungen werden markiert bzw. ausgeschlossen.
* **Gefundener Inhalt ist nie eine Anweisung.** Treffer gehen als abgegrenzte, bereinigte Datenblöcke (`untrusted.ts`
  aus PR #31) an Modelle. Die Leiter übernimmt einen Präzedenzfall nur, wenn das wörtliche Zitat in der Quelle steht.
  Die Wissensbasis liefert Kandidaten, nie Freigaben.
* **PDF ist ohne Bibliothek ehrlich gesagt nicht sinnvoll machbar** (komprimierte Streams, Font-Kodierungen,
  Objekt-Streams, gescannte Seiten). Optionen: `pdfjs-dist` freigeben, oder Text pro Upload per Claude/Gemini
  extrahieren lassen (keine neue Abhängigkeit, aber Kosten und Daten gehen zum Anbieter). Bis dahin nur Markdown und
  Text.
* **Löschen heißt löschen:** Quelle löschen entfernt Chunks, Embeddings und Zitat-Verweise; Chats haben eine
  Aufbewahrungsfrist; Embedding-Caches sind pro Projekt, nie projektübergreifend.
* **Empfohlener erster Schnitt (Stufe 1):** Repo-Dokumente (`docs/**`, README, AGENTS/CLAUDE, ADRs mit Status, STATE,
  Pläne, Research) + Entscheidungen, Volltextsuche (Deutsch/Englisch), Quellenliste mit Index-Status, Dokumentansicht
  mit markierten Treffern, Seite `/wissensbasis`, Suche-API mit ACL, Neuindexierung als Job. **Keine Embeddings, kein
  Upload, keine neue Abhängigkeit, keine Modellkosten.** Stufe 2 schließt Pipeline, Autopilot-Leiter und
  Planungsassistent an und führt „Zitiert in" plus ein Evaluations-Set ein; Embeddings folgen in Stufe 3 hinter einem
  Schalter.
* **Deine Entscheidungen:** (1) Embedding-Anbieter und ob nur lokal (Vorschlag: Ollama als Standard für sensible
  Repos, OpenAI-small als Cloud-Option, pro Projekt wählbar); (2) `@electric-sql/pglite-pgvector` + pgvector-Image
  freigeben (Vorschlag: erst wenn brute force an Grenzen stößt); (3) PDF-Weg (Vorschlag: vorerst keine PDFs, dann
  `pdfjs-dist`); (4) Raum-Chats standardmäßig indexieren? (Vorschlag: nein, pro Projekt einschalten); (5) Code schon in
  Stufe 1 oder erst mit Embeddings (Vorschlag: Stufe 3); (6) Aufbewahrung für Chat-Chunks (Vorschlag: 365 Tage).

---

## 1. Goals and non-goals

**Goals**

1. One per-project corpus with typed sources, stable citations and an index status the owner can see.
2. One retrieval API (`KnowledgeRetriever`) used by the pipeline, the autopilot ladder, the planning assistant,
   workflows and MCP, so ranking, ACL, redaction and citation logging are implemented once.
3. Works on the embedded PGlite of the dev machine and on production PostgreSQL with the same SQL (ADR-002).
4. Useful without any model provider (full-text search), better with embeddings, never dependent on one vendor
   (ADR-005).
5. Bounded cost, bounded work per job, no unbounded loops (AGENTS.md rule 4).

**Non-goals (for this plan)**

* Answer generation ("chat with your docs") as a separate product. Consumers already have agents; the knowledge base
  returns cited passages. The planning assistant's Ask mode is where answers happen.
* Web crawling, Confluence/Notion/Drive connectors (would be `external_service` decisions and need their own plan).
* Image understanding and OCR (later; Gemini Embedding 2 and Voyage multimodal exist, see §3.2).
* Cross-project search for non-admins. Admins may search several projects explicitly; there is no instance-wide
  shared corpus.
* Writing to the knowledge base from model output. Only deterministic indexers and humans (uploads) add sources.

## 2. What exists today (verified in code)

| Area | Where | What it means here |
|---|---|---|
| Repository index | `packages/core/src/repo-index/indexer.ts`, table `repo_files` (path, blob `sha`, size, `summary`, `summary_sha`, symbols, imports) | Blob SHAs give free change detection: a source is stale when `repo_files.sha` differs from the indexed version. Only source-code extensions are fetched for symbols today; docs are listed in the tree but not fetched. |
| Context builder | `packages/core/src/context/context-builder.ts` | Deterministic keyword ranking (path, symbols, summaries, hints, import neighbours) and greedy token packing; `redactSecrets` on everything; `isContextEligible` excludes lockfiles, binaries, `node_modules`, sensitive paths. The chunker reuses `isContextEligible`; keyword extraction already has German stopwords. |
| File summaries | ADR-014, `packages/core/src/context/file-summarizer.ts` | sha-keyed summaries; the knowledge base can index a summary as an extra "file overview" chunk for code files that are too large to chunk in full. |
| Decision memory | `decisions` (question, `question_key`, options, evidence, decision, reason, confidence, `supersedes_id`); PR #31 adds `status` `active | provisional | confirmed | rejected` and provenance | One chunk per decision; `rejected` is excluded, `provisional` is down-weighted and labelled. |
| Memories | `memories` (scope, kind, key, content, tags) | Mostly machine caches (`analysis:<sha>`). Only `kind = 'research'` and human-authored kinds are indexed; caches are not. |
| Precedent finder | PR #31 `packages/core/src/autopilot/precedents.ts`: `parseAdrSections`, `buildPrecedents`, `retrievePrecedents` (keyword overlap), `quoteAppearsIn` | Rung (a) today loads `docs/DECISIONS.md` and STATE and ranks by keywords. The knowledge base replaces only the *retrieval* step; parsing and quote verification stay. |
| Untrusted blocks | PR #31 `packages/core/src/autopilot/untrusted.ts`; `room/content.ts` `sanitizeMessageBody` | Reused verbatim for delimiting retrieved content and for sanitising stored chunk text. |
| Conversations | `conversations`, `conversation_messages` (ADR-030 addendum): plain-text body ≤ 8 000 chars, redacted, threads, `seq` | Room chat is already sanitised and redacted at write time; chunks cite `messageId`s. |
| Providers | `packages/integrations/src/providers/*`, `ModelProvider` port has only `generateStructured` | No embedding method yet. Installed SDKs: `openai@7.15.0` has `embeddings.create` with `dimensions`; `@google/genai@2.22.0` has `models.embedContent` with `outputDimensionality`; `@anthropic-ai/sdk@0.125.0` has no embeddings resource (checked `resources/*.d.ts`). |
| Jobs | `jobs` table, `JobQueue.enqueue({ type, payload, dedupeKey, maxAttempts })` (ADR-004) | Ingestion is a set of small, deduplicated jobs. |
| Budgets | `usage_ledger` allows rows with `project_id` and no `agent_run_id` | Embedding spend is recorded like model spend and counts against project budgets. |
| HTTP | `apps/server/src/app.ts` `bodyLimit: 2 MiB`; no `@fastify/multipart` | Uploads use a raw-body route with its own `bodyLimit` and a content-type parser (Fastify core), so no multipart dependency is needed. |
| Web | `apps/web/src/components/shell.tsx` nav + `SECTION_LABELS`; `lib/hub/types.ts` already names the category "Wissensbasis/RAG" | New section `/wissensbasis` in the same shell. |
| Database | `packages/db/src/client.ts` creates `new PGlite(dataDir)` without extensions; compose uses `postgres:17` | Contrib extensions and pgvector would have to be passed in `extensions`; the production image has no pgvector. |
| Migrations | `0000`–`0003` on `main`; PRs #30 and #31 both add `0004` | The knowledge base migration takes the next free number at implementation time (likely `0005` or `0006`). |

## 3. Research

### 3.1 Vector search on PostgreSQL and PGlite

**PGlite and pgvector (verified against `node_modules` and the docs):**

* The installed package is `@electric-sql/pglite@0.5.8` (`package-lock.json`), which reports `PostgreSQL 18.3 (PGlite
  0.5.8) on wasm32-unknown-emscripten` (probed with `select version()`).
* Its `exports` contain `.`, `./template`, `./live`, `./worker`, `./nodefs`, `./opfs-ahp`, `./basefs` and
  `./contrib/*`. There is **no** `./vector` export and no vector archive in `dist/`. `CREATE EXTENSION vector` fails
  with `extension "vector" is not available`.
* The PGlite docs list pgvector as a separate package: `import { vector } from '@electric-sql/pglite-pgvector'`
  [P1]. On npm, `@electric-sql/pglite-pgvector@0.0.9` (Apache-2.0, ~63 KB unpacked, created 2026-06-02, same
  maintainers and repository as PGlite) has the peer dependency `@electric-sql/pglite: 0.5.8`, pinned exactly. Every
  PGlite update would need a matching pgvector package update.
* Older write-ups show `@electric-sql/pglite/vector`; that path belonged to earlier PGlite releases and does not exist
  in 0.5.8.
* **Conclusion:** pgvector on PGlite = new dependency → ADR-031 owner approval. The pgvector version compiled into the
  package was not verified (unverified).
* Contrib extensions **are** in the installed package: `pg_trgm` and `unaccent` loaded via
  `PGlite.create({ extensions: { pg_trgm, unaccent } })` and worked (`similarity('wissensbasis','wisensbasis') =
  0.786`, `unaccent('Übersicht Größe') = 'Ubersicht Grosse'`). They are useful for typo-tolerant title search without
  a new dependency, but need the extension option in `client.ts` and `CREATE EXTENSION` on production PostgreSQL
  (both ship with standard `postgres:17` contrib).

**Production PostgreSQL:** the `postgres:17` image in `docker-compose.yml` does not include pgvector. Options are the
`pgvector/pgvector:pg17` image or a managed Postgres with pgvector. An image swap is a supply-chain change of the
same kind ADR-031 guards, so it is listed as an owner decision.

**pgvector facts** (pgvector README, current version 0.8.6 [P2]):

| Topic | Fact |
|---|---|
| Dimensions | `vector` stores up to 16 000 dims; HNSW and IVFFlat index `vector` up to 2 000 dims, `halfvec` up to 4 000, `bit` up to 64 000. |
| HNSW | Better speed/recall trade-off, slower build, more memory, no training step (can be created on an empty table). Defaults `m = 16`, `ef_construction = 64`, `hnsw.ef_search = 40`. |
| IVFFlat | Faster build, less memory, lower recall; needs data before the index is built (k-means); `lists ≈ rows/1000` up to 1 M rows, `probes` default 1. |
| Filtering | Filters apply after the approximate index scan, so `WHERE project_id = …` can return fewer than `LIMIT` rows; iterative index scans (0.8.0+, `strict_order` / `relaxed_order`) mitigate this. |

For this product HNSW is the right index if pgvector is approved: corpora grow incrementally, there is no good moment
for IVFFlat training, and per-project filtering needs iterative scans. With 3 072-dim models (OpenAI large, Gemini)
the index needs `halfvec` or reduced dimensions; the plan standardises on **≤ 1 024 dims** (all candidate models
support it natively or via Matryoshka truncation), which fits `vector` HNSW.

**Fallback without pgvector (recommended for stage 3):** embeddings stored as `bytea` (little-endian float32,
normalised) and searched by exact cosine in the server process:

* 20 000 chunks × 1 024 dims = ~78 MB as float32; a project-scoped query is ~20 M multiply-adds, estimated tens of
  milliseconds in V8 (estimate, to be benchmarked in stage 3). With 512 dims both halve.
* Exact search has perfect recall and no filtering problem (the project filter is applied before scoring).
* The in-memory matrix is loaded lazily per project, invalidated by an index generation counter, and evicted LRU
  under a global memory cap (default 256 MB). A project above `KNOWLEDGE_BRUTE_FORCE_MAX_CHUNKS` (default 50 000)
  degrades to lexical-only search with a visible notice until pgvector is approved.
* The `VectorIndex` port hides the choice; the pgvector adapter is a later drop-in (same `project_id` filter,
  `hnsw.iterative_scan = relaxed_order`).

**Full-text search (verified in PGlite 0.5.8):**

* `pg_ts_config` contains `german`, `english`, `simple` and 20+ other Snowball configurations.
  `to_tsvector('german', 'Die Entscheidungen wurden getroffen')` → `'entscheid':2 'getroff':4 'wurd':3`.
* `websearch_to_tsquery('german', '"Wissensbasis Suche" -chat or ADR')` →
  `'wissensbasis' <-> 'such' & !'chat' | 'adr'`. PostgreSQL docs: websearch syntax supports quotes, `or` and `-`, and
  "will never raise syntax errors, which makes it possible to use raw user-supplied input for search" [P3].
* A `tsvector` column filled per row with its own configuration (`to_tsvector($cfg::regconfig, $text)`) and a GIN
  index worked: a German query matched the German row, an English query the English row, a `simple` query a code
  identifier row. The query must compute the tsqueries once (`tsv @@ (q_de || q_en || q_simple)`), not per row, so the
  GIN index can be used.
* `ts_rank_cd` (cover density, uses proximity) is preferred over `ts_rank`; normalisation `32` scales to 0–1 [P3].
* `ts_headline` works but "uses the original document, not a tsvector summary, so it can be slow" and its output "is
  not guaranteed to be safe for direct inclusion in web pages" [P3]. Snippets are therefore computed only for the
  top-k hits, and the web renders them as text with highlight ranges, never as HTML.
* Tokeniser caveat found in the probe: `ADR-031` becomes `'adr' & '-031'`, and `findByQuestionKey` stays one token.
  The chunker appends normalised alias terms to a separate weight-D field (`adr031`, `adr-031`; `find by question key`
  for camelCase/snake_case identifiers), so both spellings match.

**Hybrid ranking:** Reciprocal Rank Fusion, `score(d) = Σ 1 / (k + rank_i(d))` with `k = 60`, as introduced by
Cormack, Clarke and Büttcher (SIGIR 2009) [P4]. RRF is rank-based, so BM25-like `ts_rank_cd` values and cosine
similarities never need calibration against each other. Each list contributes its top 50.

### 3.2 Embedding providers through the existing adapters

| Provider | Model (Sept 2026) | Dims | Max input | Price / 1 M tokens | Path in this repo | Source |
|---|---|---|---|---|---|---|
| OpenAI | `text-embedding-3-small` | 1 536 default, `dimensions` parameter | 8 192 | ~$0.02 | `openai` SDK `embeddings.create` (typed in the installed 7.15.0) | [E1] |
| OpenAI | `text-embedding-3-large` | 3 072 default, `dimensions` | 8 192 | ~$0.13 | same | [E1] |
| Google | `gemini-embedding-2` (text, image, video, audio, PDF) | 128–3 072 (768/1 536/3 072 recommended), auto-normalised when truncated | 8 192 | $0.20 standard, $0.10 batch; free tier exists but free-tier data is used to improve Google products | `@google/genai` `models.embedContent` with `outputDimensionality` | [E2], [E3] |
| Google | `gemini-embedding-001` (text) | 128–3 072, manual normalisation below 3 072; task types incl. `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`, `CODE_RETRIEVAL_QUERY` | 2 048 | not on the current pricing page (unverified, may be deprecated) | same | [E2], [E3] |
| Ollama (local) | `qwen3-embedding`, `embeddinggemma`, `bge-m3`, `nomic-embed-text(-v2-moe)`, `mxbai-embed-large`, `snowflake-arctic-embed2`, `granite-embedding` … | model-specific | model-specific | $0 (local compute) | `openai-compatible` adapter: Ollama's `/v1/embeddings` supports `model`, `input` (string or array), `encoding_format`, `dimensions` | [E4], [E5] |
| Mistral | `mistral-embed` (1 024 dims, norm 1); a code embedding model exists | 1 024 | unverified | unverified | `openai-compatible` if the endpoint accepts the OpenAI request shape (unverified; verify before enabling) | [E6] |
| Anthropic | **none** — "Anthropic does not offer its own embedding model" and points to Voyage AI | — | — | — | — | [E7] |
| Voyage AI | `voyage-4-large` $0.12, `voyage-4` $0.06, `voyage-4-lite` $0.02, `voyage-code-3` $0.12, `voyage-context-4` $0.12; 200 M free tokens; batch −33 %; `rerank-2.5` $0.05 | 1 024 default (256/512/2 048), 32 K context, `input_type` query/document | 32 000 | see left | No SDK in the repo; a small `fetch` adapter needs no npm package but is a new external service and a new provider kind (ADR-005 adapter + owner decision) | [E7], [E8] |

Notes:

* **Gemini Embedding 2 aggregates multiple inputs in one request into a single embedding** [E2]. The adapter must send
  one content per call (or use the batch API), otherwise a batch of chunks silently becomes one vector. This needs a
  regression test with a fake Gemini server.
* **Query vs document embeddings:** Gemini task types and Voyage `input_type` embed queries and documents
  differently; the `Embedder` port takes `purpose: 'query' | 'document'` and adapters without the concept ignore it.
* **Model identity:** an embedding is only comparable with vectors from the same model *and* the same dimension
  count. `embedder_id = "<provider>/<model>@<dims>"` is stored on every vector and on the project's active index.
* **Model change / re-embedding strategy:** a project has one *active* embedder and optionally one *building*
  embedder. Changing the model starts a background re-embed into the building generation (content-hash dedupe means
  only distinct chunks are embedded, and cost is estimated and shown before start); queries keep using the active
  generation (plus lexical) until the building one reaches 100 %, then the pointer flips atomically and the old vectors
  are garbage-collected. Cost for this repository (docs ≈ 60 K tokens, TypeScript sources ≈ 0.5 M tokens, estimate)
  is about $0.01 with OpenAI small or Voyage lite, ~$0.10 with Gemini Embedding 2 — so re-embedding is cheap for
  typical repos and the flip strategy is about availability, not money.
* **Privacy:** cloud embedding sends every indexed chunk (already redacted) to the provider. For sensitive repos the
  project setting `knowledge.embedder.localOnly = true` restricts the choice to `openai-compatible` accounts whose base
  URL is loopback or a private network address (checked when saved), i.e. Ollama. The Gemini free tier is excluded
  for all projects because of its data-use term [E3].
* **Recommendation:** default for new projects: lexical only (no provider needed). When the owner enables embeddings:
  Ollama (`qwen3-embedding` or `embeddinggemma`, dims per model, ≤ 1 024) for local-only projects, OpenAI
  `text-embedding-3-small@1024` as the cloud default (cheapest cloud option already supported by an installed SDK and
  a configured account type). Gemini is a supported alternative. Voyage only if the owner wants the best retrieval
  quality and accepts a new external service.

### 3.3 Ingestion

**Chunking (no new dependencies, all linear-time scanners):**

| Content | Strategy | Size | Citation |
|---|---|---|---|
| Markdown / prose | Heading-aware: split at `#`–`###`; keep the heading path ("DECISIONS.md › ADR-031 — Every new dependency …") as chunk title (tsvector weight A) and prepend it to the embedded text; never split inside fenced code blocks or tables; oversize sections split at paragraph boundaries with one-paragraph overlap | target 300–800 tokens, hard cap 1 200 | path, start/end line, commit sha |
| `docs/DECISIONS.md` | One chunk per ADR section including addenda (reuse `parseAdrSections` from PR #31), metadata `adrId`, `status`; very long ADRs split by bullet groups with the ADR title repeated | ≤ 1 200 | path, lines, `adrId` |
| Code (stage 3) | "AST-lite": boundaries at top-level declarations found with the existing `SYMBOL_PATTERNS` (column-0 `export`/`function`/`class`/`def`/`func`/`fn` …) plus a brace/indent depth scanner that ignores strings and comments; adjacent small declarations merged; oversize declarations split into 80-line windows with 10-line overlap; first chunk carries the import block; identifiers expanded into alias terms (camelCase/snake_case) | target 200–600 tokens | path, start/end line, symbols |
| Decisions | One chunk: question, decision, reason, options, evidence refs; title = question | ≤ 1 200 | `decisionId` |
| Room conversations (stage 4) | Per thread (root + replies) or, for the top-level timeline, windows of consecutive messages with a gap < 2 h, never mixing threads; bot notices (`author_type = system/orchestrator`) excluded by default | ≤ 600 tokens | `conversationId`, `messageIds[]` |
| Uploads (md/txt, stage 4) | As Markdown/prose; plain text by blank-line paragraphs | as prose | `uploadId`, line range (PDF: page) |

**Dedupe and incremental re-index:**

* Source level: `knowledge_sources.version` = blob sha (repo), `updated_at`/status hash (decisions), last `seq`
  (conversations), sha256 (uploads). Unchanged version → skip.
* Chunk level: `content_hash = sha256(normalised chunk text)`. Re-chunking a changed file keeps rows whose hash still
  exists (their ids, citations and embeddings survive), inserts new ones and deletes the rest.
* Embedding level: vectors keyed by `(project_id, embedder_id, content_hash)`, so moving a paragraph or renaming a file
  costs no new embeddings. There is no cross-project cache (§3.5).
* Triggers: the ANALYZE stage already refreshes the repository index; when `headSha` changes the orchestrator
  enqueues `knowledge.sync_repo` (dedupe `knowledge:repo:<project>`), which diffs `repo_files` against
  `knowledge_sources`. GitHub push webhooks for the default branch and a manual "Neu indexieren" button enqueue the same
  job. Decision creation/review emits an event that enqueues `knowledge.sync_decision`. Nothing polls.
* Bounded work: ≤ 200 sources fetched per job run (the repo indexer bounds fetches at 300), ≤ 2 000 chunks per source,
  ≤ 500 chunks embedded per job; the job re-enqueues itself with a cursor until done (each step is one durable job,
  ADR-004).

**PDF text extraction — honest assessment:**

* Node.js has no PDF parser. A hand-written extractor would need: xref tables and PDF 1.5 cross-reference/object
  streams, `FlateDecode` (possible with `node:zlib`), content-stream operators (`Tj`, `TJ`, `'`, `"`, text matrices for
  word order), font encodings, `ToUnicode` CMaps, CID fonts, encrypted files, and it would still return nothing for
  scanned pages (OCR). Realistically 1 000+ lines of security-sensitive parsing with poor quality on real-world PDFs.
  **Not recommended.**
* **Option A — `pdfjs-dist`** (Mozilla PDF.js, Apache-2.0, v6.3.289, no runtime dependencies listed, but ~35 MB
  unpacked; `engines: node >=22.13.0 || >=24`): mature text extraction with positions and page numbers; must run in a
  worker thread with time and memory limits. Needs owner approval (ADR-031). `unpdf` (MIT, 2.1 MB, v1.8.1) wraps a
  serverless PDF.js build; also a new dependency (and its bundled PDF.js version was not verified).
* **Option B — provider extraction:** Claude accepts PDFs (max 32 MB request, 100 pages below a 1 M context window,
  600 above; "1,500–3,000 tokens per page" plus page images billed as vision input) [E9]; Gemini Embedding 2 embeds PDF
  input directly but returns vectors, not text, so it cannot feed full-text search or citations [E2]. Extraction through
  a model costs tokens per upload, sends the document to the provider and is not byte-reproducible, but needs no new
  package. It would require a document input on the `ModelProvider` port.
* **Recommendation:** stage 4 ships Markdown and plain text only; PDFs are rejected with "PDF wird noch nicht
  unterstützt". The owner chooses A (preferred: deterministic, local, page citations) or B (opt-in per upload with a cost
  preview) as stage 4b.

**Upload safety:**

* Size: 10 MiB per file (route-level `bodyLimit`), 200 MiB stored text per project, 20 uploads per user per hour.
* Type by content, not by name: UTF-8 validation for text/Markdown (reject invalid UTF-8 and NUL bytes); PDF only by
  `%PDF-` magic once supported. No archives: ZIP (and therefore DOCX/XLSX/PPTX) is rejected, which also removes the
  zip-bomb class. If Office formats come later, decompression must use `node:zlib` with `maxOutputLength`, a total
  expansion ratio cap and entry-count limits.
* Extracted text is capped (2 M characters per upload) before chunking, so a small compressed PDF cannot expand into
  unbounded work.
* No antivirus engine is bundled. The mitigation is structural: uploads are never executed, never served inline
  (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `text/plain` for the extracted text) and by
  default the original bytes are **not stored** — only the redacted extracted text and its sha256. Storing originals
  (needed for re-extraction after a better PDF parser) is an opt-in project setting.
* Filenames are sanitised with `sanitizeInline` and never used as paths.

### 3.4 Retrieval quality

* **Citations:** every hit carries a typed citation: `{ kind: 'repo', path, startLine, endLine, commitSha }`,
  `{ kind: 'decision', decisionId }`, `{ kind: 'conversation', conversationId, messageIds }`,
  `{ kind: 'upload', uploadId, startLine?, page? }`. Repo citations point to the commit that was indexed; the viewer
  shows "Stand: <sha7>, aktuell <sha7>" when the branch has moved.
* **Authority weighting** (multiplier on the fused score; defaults, tuned only with the evaluation set):

  | Source | Weight | Label |
  |---|---|---|
  | ADR with status *Accepted*, `docs/STATE.md`, `docs/ARCHITECTURE.md` | 1.5 | "verbindlich" |
  | Decisions `active` / `confirmed` | 1.3 | "Entscheidung" |
  | Plans (`docs/plans/**`), research (`docs/research/**`), AGENTS/CLAUDE/README | 1.1 | "Plan" / "Doku" |
  | Code | 1.0 | "Code" |
  | Uploads | 0.9 | "Upload" |
  | Decisions `provisional` | 0.8 | "vorläufig" |
  | Room chat | 0.7 | "Chat" |
  | ADR *Superseded* / *Deprecated* / *Proposed* | 0.5 | "abgelöst" / "Vorschlag" |
  | Decisions `rejected`, sources `failed`/`deleted` | excluded | — |

* **Freshness:** chat and uploads decay with a half-life (default 180 days, `weight × 0.5^(age/halfLife)`, floor 0.3);
  ADRs, STATE and decisions do not decay (authority comes from status, not age). Repo sources whose indexed sha lags the
  current `repo_files.sha` get a "veraltet" badge and a 0.9 multiplier until re-indexed.
* **Diversity:** at most 2 chunks per source in the top 10, so one long plan cannot crowd out an ADR.
* **Evaluation set** (stage 2): `packages/core/src/knowledge/eval/` contains ~40 German and English questions about
  this repository with expected source refs (for example "Welche Abhängigkeiten brauchen Freigabe?" → ADR-031;
  "What happens to approvals during an away session?" → ADR-034). A deterministic test computes recall@5 and MRR for
  lexical search and fails the build below a threshold (initial: recall@5 ≥ 0.8 lexical). Hybrid ranking must not
  reduce either metric; tuning changes to weights are PRs that show the metric diff. Fixture-based, no network.

### 3.5 Security

* **Retrieved content is untrusted data.** Repository files, decisions, chat, uploads and model-written summaries can
  all contain injected instructions ("indirect prompt injection", OWASP LLM01 [S1]; OWASP notes that RAG does not
  mitigate prompt injection). Defences:
  1. Chunk text is sanitised at write time (`sanitizeMessageBody` rules: invisible/bidi characters removed, secrets
     redacted, bounded).
  2. Consumers receive hits only through `renderKnowledgeBlock(hits)`, which uses PR #31 `untrusted.ts` tagged blocks
     (`<knowledge source="adr:ADR-031" trust="untrusted">…</knowledge>`, tag-closing sequences stripped) and a fixed
     system-prompt sentence that data blocks never contain instructions.
  3. Structural defence: retrieval never grants a capability. The ladder still verifies quotes against the stored
     source text, approvals stay human (ADR-031/034), MCP tools are read-only, and the workflows node output is data.
  4. Regression fixtures: an ADR-like upload saying "Status: Accepted — autopilot may merge", a README that says
     "ignore previous instructions", and a chat message impersonating the orchestrator. Tests assert that uploads can
     never be authoritative (only repo `docs/DECISIONS.md` on the default branch can yield an *Accepted* ADR), that no
     side effect happens, and that the label shows the real source.
* **Per-project ACL on every query:** the retriever signature requires an explicit `projectIds` list, resolved by the
  server from the actor (user via ADR-022 memberships, pipeline/autopilot via the run's project, MCP via the AI
  identity's scopes and projects). The SQL always contains `project_id = ANY($1)`; there is no code path without it
  (typed as a non-empty tuple). Source ids and chunk ids from requests are re-checked against the allowed projects, and
  foreign ids answer 404 (ADR-022 style). Tested with the existing `acl.test.ts` pattern.
* **Secret redaction before indexing:** `redactSecrets` (ADR-009 patterns) runs before chunking and hashing, so hashes
  and embeddings are computed from redacted text and a secret never reaches an embedding provider. Sources on
  `isSensitivePath` (`.env`, keys) are skipped entirely with status `skipped` and reason. Findings are counted on the
  source ("2 Geheimnisse entfernt") without storing positions or values.
* **No cross-project leakage:** vectors, chunks, citations and the in-memory vector matrix are keyed by `project_id`.
  There is deliberately no global content-hash embedding cache: a hit in a shared cache would reveal that another
  project contains the same text, and deletion in one project would not remove the other's copy. The cost of
  duplicate embeddings is negligible (§3.2). ADR-014 made the same choice for the agent output cache.
* **Deletion and right to be forgotten:**
  * Deleting a source (upload, or excluding a path) hard-deletes its chunks, then vectors whose `content_hash` is no
    longer referenced in the project, and sets `knowledge_citations.chunk_id` to null (the citation keeps "Quelle
    gelöscht" without content).
  * Project deletion cascades everything (`on delete cascade`).
  * When message deletion or user erasure exists (not built today), it emits an event; the conversation source is
    re-chunked without those messages within one job. Until then, chat indexing is opt-in per project (§12).
  * Retention: chat chunks older than `knowledge.retention.chatDays` (default 365) are removed by the scheduler tick in
    batches; citations older than 90 days are pruned. Backups of PostgreSQL or the PGlite data directory keep deleted
    content until they rotate; this is documented in `SECURITY.md` when stage 4 ships.
* **Audit:** upload, delete, reindex and settings changes write audit entries. Searches are audited only for MCP calls
  (identity, project, query sha256, hit count — no query text, no content).

## 4. Architecture

```mermaid
flowchart LR
  subgraph Sources
    R[repo_files + GitHub content] --> I
    D[decisions] --> I
    C[conversation_messages] --> I
    U[uploads] --> I
  end
  I[Ingestion jobs\nknowledge.sync_*] --> K[Chunker\npure]
  K --> S[(knowledge_sources\nknowledge_chunks + tsv)]
  K --> E[Embedder port\nopenai / google / openai-compatible / fake]
  E --> V[(knowledge_vectors)]
  Q[KnowledgeRetriever] --> S
  Q --> VI[VectorIndex port\nbrute force / pgvector]
  VI --> V
  Q --> F[fuse: RRF + authority + freshness + diversity]
  F --> P[Pipeline context] & L[Autopilot ladder rung a] & A[Planning assistant] & W[Workflows node] & M[MCP tool] & UI[/wissensbasis]
  F --> CI[(knowledge_citations)]
```

### 4.1 Core (IO-free) — `packages/core/src/knowledge/`

| File | Contents |
|---|---|
| `types.ts` | `SourceKind` (`repo_doc`, `repo_adr`, `repo_state`, `repo_plan`, `repo_code`, `decision`, `memory`, `conversation`, `upload`), `SourceStatus` (`pending`, `indexing`, `indexed`, `failed`, `skipped`, `stale`), `Authority`, `Citation` union, `KnowledgeHit`, `SearchFilters` (kinds, authority min, paths prefix, date range, status of ADR), zod schemas for API and MCP inputs. |
| `ports.ts` | `KnowledgeStore` (upsert source, replace chunks by hash diff, list/get sources, get chunks, lexical search, delete source, GC vectors, record citations, stats), `Embedder` (`id`, `dims`, `maxInputTokens`, `embed(texts, purpose, signal) → { vectors: Float32Array[], usage: { inputTokens } }`), `VectorIndex` (`search(projectId, embedderId, query, k, allowedSourceIds?)`, `invalidate(projectId)`), `KnowledgeRetriever` (`search(request) → KnowledgeHit[]`). |
| `chunk-markdown.ts` | Heading-aware splitter with code-fence/table awareness, line numbers, overlap; ADR mode via `parseAdrSections`. |
| `chunk-code.ts` | AST-lite splitter (declaration boundaries, depth scanner, windows), identifier alias terms. |
| `chunk-records.ts` | Decisions, memories, conversation windows. |
| `normalize.ts` | Sanitise + redact + hash; `aliasTerms` (ADR ids, camelCase/snake_case); language guess `german | english | simple` (stopword ratio, code → `simple`). |
| `rank.ts` | `rrf(lists, k = 60)`, `authorityWeight`, `freshness`, `diversify`, `rankHits` — pure and unit-tested. |
| `retriever.ts` | `DefaultKnowledgeRetriever(store, vectorIndex?, embedder?, budget?)`: lexical top 50, optional vector top 50 (query embedding cached per request), fuse, snippets for top k, citation recording. Degrades to lexical on embedder error, budget pause or missing index, with `degraded: reason` in the result. |
| `ingest.ts` | `planRepoSync(repoFiles, sources, rules) → { toIndex, toDelete, unchanged }`, `indexSource(...)` orchestration over ports, bounded batches. |
| `render.ts` | `renderKnowledgeBlock(hits, tokenBudget)` using `untrusted.ts`; token packing like `buildContext`. |
| `rules.ts` | Default include rules per stage (stage 1: `docs/**/*.md`, `README*`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` excluded by default because of size and low value), `isContextEligible`, per-project include/exclude globs. |

### 4.2 Integrations — `packages/integrations/src/knowledge/`

| Adapter | Notes |
|---|---|
| `OpenAIEmbedder` | `client.embeddings.create({ model, input: string[], dimensions, encoding_format: 'float' })`; batches ≤ 96 inputs and ≤ 8 192 tokens per input (truncate by estimate, flag truncated chunks); maps errors to the existing `ProviderError` kinds. Used for `openai` and `openai-compatible` (Ollama, Mistral after verification). Credential resolution reuses `DefaultProviderResolver` credentials. |
| `GoogleEmbedder` | `ai.models.embedContent({ model, contents, config: { outputDimensionality, taskType } })`, one content per call for `gemini-embedding-2` (aggregation caveat), bounded concurrency; normalises vectors for `gemini-embedding-001`. |
| `VoyageEmbedder` (optional, only if approved) | `fetch` to `https://api.voyageai.com/v1/embeddings` with `input_type`; new provider kind `voyage`. |
| `FakeEmbedder` (in `packages/core/src/testing`) | Deterministic: hashed bag-of-words into `dims` buckets + synonym table, normalised; zero cost; configurable failures and latency. |
| `BruteForceVectorIndex` (`packages/db`) | Loads `knowledge_vectors` for a project/embedder into one `Float32Array`, dot product, heap top-k; generation counter; memory cap. |
| `PgvectorIndex` (`packages/db`, only if approved) | `embedding vector(1024)` column + HNSW `vector_cosine_ops`; `SET LOCAL hnsw.iterative_scan = relaxed_order`. |

Embedding models are **data** (ADR-005 spirit) but not router models: settings key `knowledge.embedders` holds
`{ id, provider, providerConfigId, modelId, dims, maxInputTokens, pricePerMTok, localOnly }` entries, seeded disabled.
They never enter `ModelRouter.select`, so an embedding model can never be routed a chat request.

### 4.3 Data model (one migration, next free number at implementation time, likely `0005`/`0006`)

| Table | Columns | Indexes / notes |
|---|---|---|
| `knowledge_sources` | `id`, `project_id` (fk cascade), `kind`, `external_ref` (path, decision id, conversation id, upload id), `title`, `authority`, `status`, `status_reason`, `version`, `indexed_version`, `commit_sha`, `language`, `bytes`, `chunk_count`, `token_count`, `secret_findings`, `metadata` jsonb (adr id/status, decision status, message seq range, media type), `created_by`, `indexed_at`, `created_at`, `updated_at` | unique (`project_id`, `kind`, `external_ref`); (`project_id`, `status`); (`project_id`, `kind`, `updated_at`) |
| `knowledge_chunks` | `id`, `project_id`, `source_id` (fk cascade), `ordinal`, `title` (heading path), `content` (sanitised, redacted), `alias_terms`, `content_hash`, `tokens`, `ts_config` (text: `german`/`english`/`simple`), `tsv` tsvector (`setweight(title,'A') || content || setweight(alias,'D')`, computed in the insert statement), `start_line`, `end_line`, `page`, `message_ids` jsonb, `created_at` | GIN (`tsv`); (`project_id`, `source_id`, `ordinal`); (`project_id`, `content_hash`) |
| `knowledge_vectors` (stage 3) | `project_id`, `embedder_id`, `content_hash`, `dims`, `vector` bytea (float32 LE, normalised), `created_at` | PK (`project_id`, `embedder_id`, `content_hash`). A pgvector column is added by a separate, optional migration only after approval. |
| `knowledge_index_state` (stage 3) | `project_id` PK, `active_embedder_id`, `building_embedder_id`, `building_progress` jsonb, `generation` int, `updated_at` | Pointer flip on re-embed completion; `generation` invalidates in-memory matrices across instances (read on query, cheap). |
| `knowledge_uploads` (stage 4) | `id`, `project_id`, `source_id`, `uploaded_by`, `filename`, `media_type`, `bytes`, `sha256`, `original` bytea null (opt-in), `created_at` | unique (`project_id`, `sha256`) → duplicate upload returns the existing source |
| `knowledge_citations` (stage 2) | `id`, `project_id`, `source_id` (fk set null), `chunk_id` (fk set null), `consumer_type` (`run`, `agent_run`, `decision`, `decision_request`, `conversation_message`, `planning_turn`, `workflow_run`, `mcp_call`), `consumer_id`, `query_hash`, `rank`, `score`, `created_at` | (`project_id`, `source_id`, `created_at`); (`consumer_type`, `consumer_id`); pruned after 90 days |

Project settings (`ProjectSettingsSchema`, zod, defaults backward compatible): `knowledge.enabled` (default true),
`knowledge.sources` (`repoDocs` true, `decisions` true, `code` false, `conversations` false, `uploads` true),
`knowledge.includeGlobs`/`excludeGlobs`, `knowledge.embedder` (`null` | embedder id), `knowledge.localOnly`,
`knowledge.retention.chatDays` (365), `knowledge.dailyEmbeddingBudgetUsd` (1.00).

### 4.4 Jobs

| Job type | Dedupe key | Does |
|---|---|---|
| `knowledge.sync_repo` | `knowledge:repo:<project>` | Diff `repo_files` vs sources by include rules, fetch ≤ 200 changed files via `GitHubPort.getFileContent` at `headSha`, chunk, replace chunks, mark removed paths deleted; re-enqueue with cursor. |
| `knowledge.sync_decision` | `knowledge:decision:<decisionId>` | Upsert one decision source (or delete when rejected). |
| `knowledge.sync_conversation` (stage 4) | `knowledge:conv:<conversationId>` | Re-chunk windows after the last indexed `seq`, debounced 5 minutes via `runAt`. |
| `knowledge.ingest_upload` (stage 4) | `knowledge:upload:<uploadId>` | Validate, extract, redact, chunk. |
| `knowledge.embed` (stage 3) | `knowledge:embed:<project>:<embedder>` | Embed ≤ 500 missing content hashes per run under the budget; re-enqueue; flip pointer when a building generation completes. |
| `knowledge.gc` (scheduler tick) | `knowledge:gc` | Unreferenced vectors, chat retention, citation pruning — each bounded to 1 000 rows per tick. |

Status transitions emit content-free events `knowledge.source.indexed|failed|deleted` and
`knowledge.index.progress` (project id, counts) on the existing bus/SSE (ADR-008/024), ACL-filtered.

### 4.5 Server — `apps/server/src/routes-knowledge.ts` (ADR-016 pattern, one line in `app.ts`)

| Route | Role | Notes |
|---|---|---|
| `GET /api/projects/:id/knowledge/search?q=&kinds=&authority=&path=&from=&to=&limit=` | viewer | `q` ≤ 500 chars; `limit` ≤ 50; rate limit 60/min per user; returns hits with snippet highlight ranges, citation, labels, `degraded` flag. |
| `GET /api/knowledge/search` (multi-project) | viewer | Same, over the user's accessible projects or an explicit `projectIds` subset; each hit shows its project. |
| `GET /api/projects/:id/knowledge/sources?status=&kind=&cursor=` | viewer | Index status list with counts. |
| `GET /api/projects/:id/knowledge/sources/:sourceId` | viewer | Source metadata + chunks (content) for the viewer; `?highlight=chunkId`. |
| `GET /api/projects/:id/knowledge/sources/:sourceId/citations` | viewer | "Zitiert in": consumers linked to runs, decisions, messages, planning turns. |
| `POST /api/projects/:id/knowledge/reindex` `{ scope: 'all' | 'repo' | 'decisions' | sourceId }` | operator | Enqueues jobs; audit `knowledge.reindex`. |
| `POST /api/projects/:id/knowledge/uploads` (raw body, `Content-Type` + `X-Filename`) | operator | Route `bodyLimit` 10 MiB, rate limit, audit `knowledge.upload` (filename, bytes, sha256). |
| `DELETE /api/projects/:id/knowledge/sources/:sourceId` | operator (uploads), admin (repo exclusions) | Repo sources are "excluded" (adds an exclude glob) rather than deleted, otherwise the next sync re-adds them; audit `knowledge.delete`. |
| `GET/PUT /api/projects/:id/knowledge/settings` | viewer / admin | Embedder choice validated against `localOnly`; changing the embedder returns a cost estimate and requires `confirm: true`. |

Every project-scoped route asserts access first (404 for foreign projects), mutations require the CSRF origin check
and write audit entries, like every other route.

### 4.6 Web UI (German) — `/wissensbasis`

* **Nav:** "Wissensbasis" (icon book) between "Decisions" and "Costs"; breadcrumb label "Wissensbasis". Also a project
  tab "Wissen" deep-linking to the page with the project filter.
* **Suche:** one search field ("Wissensbasis durchsuchen …", supports `"Phrase"`, `oder`/`or`, `-ausschließen` —
  hint text explains it), project selector (only accessible projects), filter chips: Quelle (ADRs, STATE/Architektur,
  Entscheidungen, Pläne & Research, Doku, Code, Chat, Uploads), Status (verbindlich / vorläufig / abgelöst),
  Zeitraum, Pfad-Präfix. Result cards: title (heading path), source label + authority badge, snippet with `<mark>`
  ranges rendered from offsets (text nodes only), citation line ("docs/DECISIONS.md · Z. 382–437 · Stand cd8db47"),
  "Zitiert in 3". Empty state: "Keine Treffer. Tipp: weniger Begriffe oder andere Quelle wählen." Degraded state:
  "Nur Volltextsuche — Embeddings nicht verfügbar (<Grund>)".
* **Quellen:** table with Name, Typ, Status (Indexiert / Wartet / Läuft / Fehler / Übersprungen / Veraltet), Chunks,
  Geheimnisse entfernt, Zuletzt indexiert, Aktionen (Neu indexieren, Ausschließen/Löschen). Header shows totals and a
  progress bar during indexing (SSE). Button "Alles neu indexieren".
* **Hochladen** (stage 4): drop zone "Markdown- oder Textdatei hierher ziehen (max. 10 MB)", per-file progress, errors
  in German ("Datei ist keine gültige UTF-8-Textdatei", "PDF wird noch nicht unterstützt"), notice "Hochgeladene Dateien
  sind nie verbindlich und werden vor der Indexierung von Geheimnissen bereinigt."
* **Dokumentansicht:** `/wissensbasis/quellen/[sourceId]?chunk=`: full sanitised text as plain text with line
  numbers, the matching chunk highlighted and scrolled into view, chunk boundaries as subtle separators, side panel
  with metadata (Commit, Status, ADR-Status, Sprache) and **"Zitiert in"** (list of runs, decisions, planning turns,
  room messages with links, newest first). Repo sources link to GitHub at the indexed commit.
* **Einstellungen** (project settings tab "Wissen"): source toggles, include/exclude globs, embedder select ("Aus
  (nur Volltext)", "Lokal: Ollama …", "OpenAI text-embedding-3-small"), "Nur lokale Embeddings" switch, retention,
  daily embedding budget, re-embed cost preview dialog.
* Accessibility and QA like the AI Hub: keyboard-reachable filters, `aria-live` for result counts, screenshots light
  /dark/375 px; pure logic (`lib/knowledge/filter.ts`, `url-state.ts`, highlight range rendering) unit-tested with
  vitest.

## 5. Integration points

| Consumer | Integration | Bounds |
|---|---|---|
| **Pipeline** (PLAN, DESIGN; ANALYZE optional) | New input section "Projektwissen" built by `renderKnowledgeBlock` from a query of task title + goal + acceptance criteria (+ plan approach in DESIGN), filters `kinds ≠ conversation` by default. Citations recorded with `consumer_type = agent_run`. In stage 3, code-chunk hits add their paths as `hints` to `rankFiles` (bounded boost), leaving the file packing unchanged. | ≤ 6 hits, ≤ 1 500 tokens (project setting), no model call for lexical retrieval. |
| **Autopilot ladder rung (a)** (PR #31) | `PrecedentFinder` asks the retriever for candidates with `kinds ∈ {repo_adr, repo_state, decision}` and `authority ≥ decision`, then runs the existing `precedent_check` and `quoteAppearsIn` against the **stored chunk text at the indexed commit**. When the knowledge base is disabled or empty, the current `retrievePrecedents` path is the fallback. Only repo ADRs from the default branch can be authoritative; uploads and chat never settle a question. | Top 5 candidates as today; one fast-tier call unchanged. |
| **Planning assistant** (ADR-033 draft) | Consistency check step 1 ("deterministic retrieval") and the context sources table call the retriever; Ask mode answers cite hits; the context manifest lists chunk ids. | Per-turn token budget of the assistant. |
| **Workflows** (ADR-037, claimed) | Read-only node "Wissensbasis durchsuchen": inputs `query`, `filters`, `limit` (≤ 10); output `hits[]` with citations as data; the workflow's project is the only allowed project. Built when the workflow engine exists. | Node counts as a tool call in the workflow budget; no model cost for lexical. |
| **MCP** (ADR-030 stage 3) | Tools `knowledge_search { projectId, query, filters?, limit ≤ 10 }` and `knowledge_get_source { projectId, sourceId, chunkIds? }`; scope `knowledge:read`; identity project list ∩ requested project; results carry `trust: "untrusted"` and citations; rate limit 30/min per identity; audit with query hash. No upload, delete or reindex over MCP. | Response ≤ 16 K characters. |
| **Room** | `@orchestrator wissen <frage>` (after ADR-030 commands) posts the top 3 citations as a system message, no model text. | Room rate limits. |
| **Health scan** (ADR-013) | Signal "Dokumentation veraltet": ADRs referencing paths that no longer exist (deterministic, from chunk metadata). | Optional, later. |

## 6. Budgets and costs

* **Lexical search and ingestion of text:** no model cost; CPU and storage only. Estimated storage for this
  repository's docs: ~1 500 chunks, < 10 MB including the tsvector and GIN index (estimate).
* **Embeddings:** `EmbeddingRuntime` wraps every `Embedder` call: `BudgetGuard.check` on scopes global → project and
  the project's `knowledge.dailyEmbeddingBudgetUsd`; `degrade` = skip embedding (lexical still works), `pause` = job
  re-enqueued for the next day. Spend is written to `usage_ledger` (`provider`, `model_id`, `input_tokens`,
  `cost_usd`, `project_id`, no agent run) and appears on the costs page as "Wissensbasis".
* **Query embeddings:** one short embedding per search (~20 tokens); cached per `(project, embedder, sha256(query))`
  for 10 minutes in memory to absorb repeated UI searches; counted in the ledger in aggregated rows per hour to avoid
  one ledger row per keystroke (the UI searches on submit, not on keypress).
* **Estimates** (prices §3.2, token counts estimated): this repository fully (docs + TS code ≈ 0.6 M tokens) → ~$0.012
  with OpenAI small, ~$0.12 with Gemini Embedding 2, $0 with Ollama; a large monorepo of 50 M tokens → ~$1 (OpenAI
  small) / ~$10 (Gemini). Re-embedding after a model change costs the same once.
* **Autopilot sessions:** retrieval inside a session uses the session budget scope only for embeddings; lexical is free.

## 7. Stages, acceptance criteria and tests

| Stage | Scope | Acceptance criteria |
|---|---|---|
| **1 — Governance docs + full-text search (recommended first slice)** | Migration (`knowledge_sources`, `knowledge_chunks`); core types, ports, Markdown/ADR/decision chunkers, normalise/alias terms, lexical retriever with authority weights and diversity; `knowledge.sync_repo` for docs include rules (fetching docs via `GitHubPort`, reusing `repo_files` shas), `knowledge.sync_decision`; routes search, sources, source detail, reindex, settings (sources toggles only); web `/wissensbasis` with search, filters, sources list with status, document viewer with highlighted chunk; demo seed indexes this repository's docs. No embeddings, no uploads, no new dependency. | (a) "Welche Abhängigkeiten brauchen eine Freigabe?" returns ADR-031 as the first hit with a line-range citation; (b) the same in English; (c) a superseded or proposed ADR is labelled and ranked below the accepted one; (d) a doc changed on the default branch is re-indexed after the next ANALYZE, unchanged docs are not fetched again; (e) a secret in a doc is redacted in chunks and counted on the source; `.env` files are skipped; (f) an operator without membership gets 404 for another project's search, sources and source detail (ACL tests for every route); (g) rejected decisions never appear; (h) hostile inputs (100 K-char heading lines, unterminated code fences, 50 K `#` lines) chunk in < 1 s; (i) web search state lives in the URL; typecheck + build + screenshot QA. |
| **2 — Consumers + citations + evaluation** | `knowledge_citations`; `renderKnowledgeBlock`; pipeline PLAN/DESIGN section; ladder rung (a) candidate retrieval (with fallback); planning assistant retrieval hook (if built); "Zitiert in" panel; evaluation set with recall@5/MRR gate. | (a) a DESIGN run cites ADR-031 when the task adds a dependency, and the citation appears under "Zitiert in"; (b) a poisoned upload-like fixture with fake "Status: Accepted" never becomes authoritative in the ladder; (c) knowledge disabled → pipeline and ladder behave exactly as before (existing scenario tests unchanged); (d) eval recall@5 ≥ 0.8 lexical, results printed in CI log; (e) retrieved text in prompts is always inside `<knowledge>` blocks (snapshot test). |
| **3 — Embeddings behind a flag + code** | `KNOWLEDGE_EMBEDDINGS=off|on` (instance) + project embedder setting; `Embedder` port, OpenAI/openai-compatible/Google adapters, fake embedder; `knowledge_vectors`, `knowledge_index_state`, `knowledge.embed` job, `BruteForceVectorIndex`, RRF fusion, re-embed with pointer flip, cost preview; `EmbeddingRuntime` budget + ledger; code chunking and code sources toggle. | (a) with the fake embedder a synonym query ("Paketfreigabe") finds ADR-031 that lexical misses, and fused results never drop a lexical top-3 hit below rank 6; (b) embedder outage → `degraded` lexical results, no error to the user; (c) budget pause stops embedding and resumes next day; (d) model change keeps serving old vectors until the new generation is complete, then flips; old vectors are GC'd; (e) `localOnly` rejects a cloud embedder and a public base URL; (f) adapters tested against local fake OpenAI/Ollama/Gemini servers through the real SDKs, including the Gemini aggregation caveat; (g) brute-force benchmark recorded (20 K × 1 024 dims) and the chunk cap enforced; (h) eval metrics with hybrid ≥ lexical. |
| **4 — Conversations, uploads, deletion** | Room/conversation indexing (opt-in), `knowledge.sync_conversation`; uploads (md/txt) route, `knowledge_uploads`, UI upload; delete/exclude; retention GC; SECURITY.md note. **4b** (after owner decision): PDF via `pdfjs-dist` in a worker thread or provider extraction. | (a) chat chunks cite message ids and open the room at that message; (b) disabling chat indexing deletes chat chunks within one GC cycle; (c) upload rejects invalid UTF-8, NUL bytes, ZIP magic, > 10 MiB, and names like `../../x`; (d) deleting an upload removes chunks and unreferenced vectors and leaves "Quelle gelöscht" citations; (e) retention removes old chat chunks in bounded batches; (f) upload of a file containing an API key stores only redacted text and reports the finding. |
| **5 — MCP, workflows, optional pgvector** | MCP tools with ADR-030 stage 3 identities; workflows node when ADR-037 exists; `PgvectorIndex` + optional migration + compose image **only if approved**; optional Voyage adapter / reranker only if approved. | (a) MCP identity without `knowledge:read` or membership gets an authorization error and an audit entry; (b) MCP results carry citations and `trust: untrusted`; (c) workflows node cannot query another project; (d) pgvector adapter passes the same retriever contract tests as brute force, with iterative scans enabled for filtered queries. |

**Test strategy:**

* **Core (vitest, no IO):** chunkers with golden fixtures (this repo's `DECISIONS.md` snapshot, German/English
  Markdown, TypeScript/Python/Go code, hostile inputs with timing bounds); `rank.ts` property tests (RRF monotonicity,
  diversity cap, exclusions); `planRepoSync` diffs; `renderKnowledgeBlock` tag stripping; retriever contract tests run
  against an in-memory `KnowledgeStore` and `FakeEmbedder` in `packages/core/src/testing/memory-knowledge.ts`.
* **Fake embedders:** deterministic hashed bag-of-words with a small synonym map, so semantic-looking behaviour is
  reproducible; a `FailingEmbedder` (auth, 429, timeout) and a `SlowEmbedder` for degradation and budget tests. No test
  calls a real provider.
* **DB (PGlite in memory):** migration applies; tsvector insert and GIN search in `german`/`english`/`simple`;
  hash-diff chunk replacement keeps ids; cascade deletes; vector GC; brute-force index against stored vectors.
* **Integrations:** adapters against local fake HTTP servers through the real SDKs, as `providers.test.ts` does today.
* **Server:** route tests for RBAC, ACL (cross-project 404 for every route), CSRF, rate limits, upload validation,
  audit entries without content; MCP authorization tests in stage 5.
* **Pipeline scenarios:** knowledge enabled/disabled parity; citation recording; poisoned fixtures produce no side
  effects.
* **Evaluation:** fixture corpus + questions → recall@5 and MRR, asserted in CI; the report is printed for PR diffs.

## 8. Dependencies and order

* **No new npm dependency in stages 1–4a.** pgvector for PGlite, a pgvector Postgres image, a PDF library and a Voyage
  integration are separate owner decisions (§12), each behind a port so nothing else waits for them.
* Stage 1 needs nothing unmerged. It should land after PRs #30/#31 settle the `0004` numbering.
* Stage 2's ladder integration needs PR #31 (`precedents.ts`, `untrusted.ts`, decision statuses) merged; the planning
  assistant hook waits for that feature.
* Stage 5 MCP waits for ADR-030 stage 3 (AI identities, `/mcp`); the workflows node waits for ADR-037.
* Notifications (ADR-038 draft) may later add "Indexierung fehlgeschlagen" as an in-app notice; not required.

## 9. Trade-offs

| Choice | Alternative | Why |
|---|---|---|
| Postgres FTS first | Embeddings first | Zero cost, zero dependency, deterministic, testable, works offline; ADR/STATE queries are keyword-heavy. Embeddings add recall for paraphrases later. |
| Brute-force vectors in-process | pgvector now | pgvector is a new dependency on PGlite (exact peer pin) and needs a different production image. Exact search is fast enough for typical project sizes and has no filter/recall pitfalls. |
| Per-project vectors, no global cache | Global content-hash cache | Avoids cross-project inference and simplifies deletion; duplicate cost is cents. |
| Chunks store redacted text | Store raw, redact on read | A secret never reaches embeddings, hashes, logs or backups of the index. Cost: a redaction pattern added later needs a reindex (a "Neu indexieren" run). |
| Separate embedder registry | Embedding models in `model_configs` | Keeps the chat router untouched; embedding models have different fields (dims, purpose). |
| Uploads never authoritative | Let admins mark uploads as binding | Authority must come from reviewed repository history (ADR process), not from a file anyone with operator rights can drop in. |

## 10. Risks

* **Snippet XSS:** `ts_headline` output is not safe HTML [P3] → offsets, text rendering only.
* **Stale citations:** line numbers drift after commits → commit sha on every repo citation; viewer shows the indexed
  version.
* **PGlite memory:** GIN indexes and in-memory vector matrices share the single server process → memory caps, chunk
  caps, and a documented recommendation to use PostgreSQL for large corpora.
* **Tokeniser mismatch for German compounds** ("Abhängigkeitsfreigabe" vs "Freigabe"): Snowball does not split
  compounds → alias terms, `pg_trgm` title similarity as a secondary lexical list (contrib, no new package), and
  embeddings in stage 3.
* **Over-trust in retrieval by agents:** mitigated by labels, quote verification in the ladder, and unchanged approval
  gates.

## 11. Non-goals repeated for clarity

No auto-approval from knowledge, no instance-wide shared corpus, no web crawling, no model-written content stored as a
source, no upload of archives, no MCP write tools.

## 12. Open questions for the owner (with recommendation)

1. **Embedding provider and local-only?** Recommendation: embeddings off by default; per project choice between
   Ollama (local, default for sensitive repos, `localOnly` on) and OpenAI `text-embedding-3-small@1024` (cloud).
   Gemini supported but not default (higher price). Voyage only if you want a new external service for best quality.
2. **Approve `@electric-sql/pglite-pgvector` + a pgvector Postgres image?** Recommendation: not now; revisit when a
   project exceeds ~50 000 chunks or brute-force latency exceeds 200 ms in the stage 3 benchmark.
3. **PDF support:** `pdfjs-dist` (new dependency), provider extraction (cost + data leaves), or none for now?
   Recommendation: none in the first stages, then `pdfjs-dist` in a worker thread.
4. **Index room chats by default?** Recommendation: no; opt-in per project, bot notices excluded, retention 365 days.
5. **Code in stage 1?** Recommendation: no; docs/ADRs/decisions first, code with embeddings in stage 3 (the context
   builder already covers code for the pipeline).
6. **Keep original upload bytes?** Recommendation: no by default (only redacted text); opt-in per project once PDFs
   need re-extraction.
7. **Who may upload and delete?** Recommendation: upload and delete own uploads = project operator; exclude repo paths
   and delete others' uploads = admin/owner.
8. **Multi-project search in the UI for admins?** Recommendation: yes, explicit project selection, each hit labelled.

## 13. Sources

* [P1] PGlite extensions — https://pglite.dev/extensions/ (pgvector as `@electric-sql/pglite-pgvector`, contrib paths)
  · npm `@electric-sql/pglite-pgvector` metadata via `npm view` (0.0.9, peer `@electric-sql/pglite: 0.5.8`,
  Apache-2.0) · installed `node_modules/@electric-sql/pglite/package.json` (0.5.8 exports) and local probes.
* [P2] pgvector README — https://github.com/pgvector/pgvector (0.8.6; dimension limits, HNSW/IVFFlat, iterative scans)
* [P3] PostgreSQL docs, Controlling Text Search — https://www.postgresql.org/docs/current/textsearch-controls.html
* [P4] Cormack, Clarke, Büttcher: Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods,
  SIGIR 2009 — https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
* [E1] OpenAI embeddings guide — https://developers.openai.com/api/docs/guides/embeddings · installed
  `openai@7.15.0` `resources/embeddings.d.ts`
* [E2] Gemini API embeddings — https://ai.google.dev/gemini-api/docs/embeddings · installed `@google/genai@2.22.0`
  `embedContent` typings
* [E3] Gemini API pricing — https://ai.google.dev/gemini-api/docs/pricing
* [E4] Ollama OpenAI compatibility — https://docs.ollama.com/api/openai-compatibility
* [E5] Ollama embedding models — https://ollama.com/search?c=embedding
* [E6] Mistral text embeddings — https://docs.mistral.ai/studio/knowledge-rag/embeddings/text_embeddings (endpoint
  shape, limits and price not confirmed on the fetched page: unverified)
* [E7] Anthropic embeddings guide — https://platform.claude.com/docs/en/build-with-claude/embeddings
* [E8] Voyage AI pricing — https://docs.voyageai.com/docs/pricing
* [E9] Claude PDF support — https://platform.claude.com/docs/en/build-with-claude/pdf-support
* [S1] OWASP GenAI, LLM01 Prompt Injection — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
* npm metadata via `npm view`: `pdfjs-dist@6.3.289` (Apache-2.0, ~35 MB unpacked), `unpdf@1.8.1` (MIT, ~2.1 MB).

## 14. Proposed ADR (draft; add to `docs/DECISIONS.md` when accepted)

**ADR-039 — Knowledge base: per-project cited retrieval, full-text first, embeddings behind a port**

* **Context:** Agents, the autopilot ladder, the planning assistant, workflows and external AIs each need project
  knowledge (ADRs, STATE, plans, decisions, code, chat, uploads). Today each consumer does its own keyword retrieval
  (`context-builder.ts`, PR #31 `precedents.ts`, planning-assistant `consistency.ts`). The embedded PGlite 0.5.8 has
  full-text search in German and English, but pgvector is a separate package (`@electric-sql/pglite-pgvector`) and
  therefore a new dependency under ADR-031. Anthropic offers no embeddings API.
* **Decision:**
  * One knowledge base per project in `knowledge_sources` and `knowledge_chunks` (tsvector per chunk with its own text
    search configuration and a GIN index). Chunks store sanitised, secret-redacted text with typed citations (path +
    lines + commit, decision id, message ids, upload id).
  * One `KnowledgeRetriever` port in `packages/core/src/knowledge` serves every consumer. Every query takes an explicit,
    non-empty list of allowed project ids resolved from the actor (ADR-022, AI identity scopes for MCP).
  * Ranking: lexical (`websearch_to_tsquery`, `ts_rank_cd`) and, when enabled, vector results fused with Reciprocal
    Rank Fusion (k = 60), then authority weights (accepted ADRs, STATE, ARCHITECTURE > decisions > plans/docs > code >
    uploads > provisional decisions > chat > superseded ADRs; rejected decisions excluded), freshness decay for chat
    and uploads, and at most two chunks per source in the top 10.
  * Embeddings are optional, per project, behind an `Embedder` port (OpenAI, OpenAI-compatible incl. Ollama, Google;
    fakes in tests), stored per project as normalised float32 `bytea` keyed by (project, embedder id with dimensions,
    content hash), searched exactly in process behind a `VectorIndex` port. No cross-project embedding cache. Model
    changes build a new generation and flip atomically. Spend goes through the budget guard and the usage ledger.
    pgvector, a pgvector production image, Voyage and PDF libraries require separate owner approval (ADR-031).
  * Retrieved content is untrusted: delivered only in delimited data blocks, never authoritative unless it is an
    accepted ADR, STATE or an active/confirmed decision from the repository/database, and never able to approve,
    trigger tools or change settings. The decision ladder keeps verifying quotes against stored source text.
  * Ingestion runs as bounded, deduplicated jobs triggered by repository index changes, decision events, conversation
    activity (opt-in) and uploads (Markdown/text; size, type and expansion limits, no archives). Deletion removes chunks
    and unreferenced vectors; chat chunks have a retention period.
* **Consequences:** Consumers share one retrieval implementation, citations become visible ("Zitiert in"), and the
  feature works without any provider or new dependency. Large corpora (> ~50 000 chunks per project) fall back to
  lexical search until pgvector is approved. A new secret pattern requires a reindex to apply to existing chunks. PDFs
  are unsupported until a parsing approach is approved.
* **Status:** Proposed (2026-09-16)
