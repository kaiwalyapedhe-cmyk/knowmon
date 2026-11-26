# Cadence CX — Rust backend (PostgreSQL)

A Rust rewrite of the FastAPI service in `../backend`, built with **Axum + SQLx + PostgreSQL**.
It serves the same `/api` contract, so the existing React app in `../frontend` runs against it
unchanged (the server also serves `frontend/build` as a single-page app).

The Python service is untouched and still runnable on MongoDB — this is an additional
implementation that stores everything in PostgreSQL.

## Layout

```
src/main.rs         router assembly, CORS, SPA static serving, schema + seeding
src/config.rs       env configuration (+ .env rewriting for the integrations screen)
src/db.rs           SQLx data layer: filter/update compilers, CRUD, schema, indexes
src/auth.rs         PBKDF2 passwords, HS256 sessions, Clerk RS256 verification, role extractors
src/ldap.rs         Active Directory search/bind (ldap3)
src/ai.rs           scoring / answers / tree+quiz generation
src/storage.rs      call-recording object storage proxy
src/mailer.rs       SMTP (lettre)
src/seed.rs         demo data + governance backfill
src/models.rs       request payloads
src/util.rs         JSON document type used by the data layer
src/routes/         users, qa (forms + QA ops), interactions (AutoQA + calibration),
                    kb (knowledge + governance), misc (trees, training, coaching, dashboard),
                    digest, integrations, auth_ldap, clerk
tests/smoke.py      end-to-end API checks (50 assertions)
```

## Data model

One table per entity — `users`, `interactions`, `qa_forms`, `qa_form_versions`,
`qa_sampling_policies`, `qa_assignments`, `score_audit`, `calibrations`, `articles`,
`article_versions`, `kb_feedback`, `kb_audit`, `kb_searches`, `trees`, `courses`, `attempts`,
`coaching`, `digest_logs`, `cron_runs`, `ldap_failures`.

Each row holds the entity as a **`jsonb` payload** plus an extracted `id`; nested structures
(rubric criteria, tree nodes, quiz questions, audit trails) stay inside the payload, while every
top-level field is queryable as `data -> 'field'`. The service creates the schema and these
indexes on startup (`db::ensure_indexes`, idempotent):

- `id` unique (where not null), a GIN index on the payload for fast filtering,
- expression indexes for the hot paths — `interactions(created_at)`, `interactions(agent_id)`,
  `qa_assignments(assigned_at)`, `qa_assignments(evaluator_id, status)`, `coaching(agent_id)`,
  `kb_audit(article_id, at)`, `score_audit(interaction_id, at)`, `digest_logs(at)`,
  `article_versions(article_id, version)`, `qa_form_versions(form_id, version)`,
  `kb_feedback(article_id, user_id)`, `users(env, user_id)`.

Queries are real SQL: equality, `$in`/`$nin` (including array membership), `$ne`, `$exists`,
`$gte`/`$gt`/`$lte`/`$lt`, `$or`, and regex search compile to parameterised `jsonb` predicates;
updates support `$set` (with dotted nested paths), `$unset`, `$push`, `$pull` and `$inc`.

## Running

```bash
cd backend-rs
export DATABASE_URL="postgres://user:password@127.0.0.1:5432/cadence_cx"
export PORT=8050
export LDAP_JWT_SECRET="<same secret as the Python service>"
cargo run --release
```

Create the database first (`createdb cadence_cx`); tables, indexes and demo data are created on
startup when the tables are empty.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (default `postgres://postgres:postgres@127.0.0.1:5432/cadence_cx`) |
| `DB_POOL_MAX` | connection pool size (default 10) |
| `STATIC_DIR` | SPA build directory (default `../frontend/build`) |
| `DEV_LOGIN` | `true` enables the local username/password dev fallback |
| `ENV_FILE` | `.env` file the integrations screen rewrites (default `../backend/.env`) |
| `LLM_BASE_URL`, `LLM_MODEL`, `EMERGENT_LLM_KEY` | OpenAI-compatible endpoint for scoring/answers |
| `WEBHOOK_CRON_SECRET` | Bearer secret for `POST /api/cron/digest` |
| `CORS_ORIGINS` | Comma-separated origins, or `*` |

### Build prerequisites

`sqlx` uses rustls, which compiles `ring` — a C crate. The build needs a working C compiler
**and** a project path without spaces (MinGW's linker mis-handles `D:\My Work`). On this machine
the bundled Rust-MinGW is missing `cc1`, so the build used a portable winlibs toolchain plus a
space-free target directory:

```bash
export PATH="$LOCALAPPDATA/Temp/cadence-mingw/mingw64/bin:$PATH"
export CC="$LOCALAPPDATA/Temp/cadence-mingw/mingw64/bin/gcc.exe"
export CXX="$LOCALAPPDATA/Temp/cadence-mingw/mingw64/bin/g++.exe"
export AR="$LOCALAPPDATA/Temp/cadence-mingw/mingw64/bin/ar.exe"
export CARGO_TARGET_DIR="$LOCALAPPDATA/Temp/cadence-target"
cargo build
```

With MSVC Build Tools or a complete MinGW installed, plain `cargo build` works as usual.

## API surface (all under `/api`)

- **users** — `/me`, `/users` (+ create/reset-password/status/role/delete), `/users/me/password`, `/people`
- **QA forms** — `/qa-forms` CRUD, `/qa-forms/{id}/versions[/{vid}[/restore]]`
- **QA operations** — `/qa-ops/policies` CRUD, `/qa-ops/sample`, `/qa-ops/assignments`,
  `/qa-ops/overview`, `/qa-ops/score-history/{id}`
- **AutoQA** — `/interactions` (multipart upload), `/interactions/bulk-audio`, `/interactions/bulk-sheet`,
  `/interactions/{id}` (+ `/audio`, `/rescore`, `/self-review`, `/dispute[/resolve]`),
  `/disputes`, `/calibrations` (+ `/score`, `/close`)
- **knowledge** — `/kb/articles` CRUD, `/kb/categories`, `/kb/ask` (SSE), `/kb/governance`,
  `/kb/articles/{id}/versions…`, `/submit|approve|publish|archive|reopen`, `/feedback`, `/audit`,
  `/public/kb[/{id}]`, `/public/ask`
- **content & analytics** — `/trees` (+ `/run`, `/generate`), `/courses` (+ `/generate-quiz`, `/attempt`),
  `/attempts`, `/coaching`, `/dashboard`
- **ops** — `/digest/preview|send|logs`, `/cron/digest`, `/integrations[/ldap|/smtp|/test]`,
  `/auth/ldap/config|login`, `/clerk/config`, `/__clerk/*`

## Behaviour notes

- **AI**: with `LLM_BASE_URL` + a key set, calls go to an OpenAI-compatible `/chat/completions`
  endpoint; otherwise scoring/answers use the same offline deterministic path the shipped
  Python build exercised (its `emergentintegrations` client is a stub in this repo).
- **Auth**: LDAP sessions are HS256 JWTs; Clerk tokens are verified locally against Clerk's JWKS
  with pure-Rust RSA. Password hashes stay PBKDF2-SHA256 and are compatible with existing users.
- **Governance**: editing a published article keeps it published and bumps the version; new
  articles start as `draft`. Every edit, transition and restore writes a version snapshot and an
  audit entry; score changes from disputes/calibration are recorded in `score_audit`.
- **Digest**: India time is computed as a fixed UTC+5:30 offset (no tz database dependency).

## Verification

`tests/smoke.py` runs 50 checks against a live server + PostgreSQL 18 (seeding, dashboard,
sampling + SLA, assignment dedupe, interaction upload/audio/CSV import, article lifecycle,
versions, feedback, audit, trees, quiz scoring, coaching, calibration with binary criteria,
digest preview, integrations, role enforcement, local password login, 404/401 paths). A second
pass covered dispute raise/resolve (score 92 → 88 with a `score_audit` entry), the tree run
counter, and knowledge search.

Not exercised in this environment: a real LDAP bind, a real SMTP send, Clerk sign-in, a real LLM
endpoint, `.xlsx` import (CSV path tested), and container deployment.
