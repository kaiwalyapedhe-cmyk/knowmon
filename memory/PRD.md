# Cadence CX — PRD

## Original problem
Build a tool combining knowmax.ai (AI knowledge management: KB + smart search, cognitive decision trees, visual how-to guides, omnichannel self-service, LMS with assessments, CRM integrations) and TransMon (omnichannel AI QA: speech analytics, sentiment, CSAT, compliance flags, AutoQA, QA forms, coaching & dashboards). Everything workable across both tools.

## User choices
- All modules; audio upload transcribed by AI (whisper-1); Claude Opus 5.5 (claude-opus-5-5) via Emergent LLM key
- Clerk Emergent-managed sign-in (email+password, Google) with roles admin / qa_auditor / team_lead / agent
- First admins (ADMIN_EMAIL): admin@jswshakti.in, kaiwalya.pedhe@jsw.in
- Name: "Cadence CX"; light theme, JSW-style navy blue (#1B3F94) + red (#E31E24) swooshes

## Architecture
FastAPI (server.py routes, core.py roles/db, ai.py LLM+STT, seed.py demo data) + MongoDB; React + shadcn + recharts; Clerk auth (clerk_auth.py).

## Implemented (Jun 2026)
- AutoQA: upload audio or paste transcript (voice/email/chat/WhatsApp/in-store) → background transcription + Claude scoring on weighted QA forms with auto-fail criteria, sentiment, predicted CSAT, compliance flags w/ quotes, strengths/improvements, recommended KB articles
- QA form builder; interactions list w/ live status; interaction detail
- Dashboard: KPIs, trend, sentiment, criteria, leaderboard, top searches, top articles, training stats (agents see own)
- Coaching: sessions (prefill from interaction), action items (agent can tick), assign KB articles + courses
- Knowledge Hub: search/categories, article CRUD w/ visual steps, Ask AI streaming with cited sources, search logging
- Decision trees: runner (scripts, back/restart), editor w/ link validation, AI generation from SOP
- Training: courses + lessons linked to articles, quizzes (answers hidden for agents), attempts, AI quiz generation
- Public self-service /help: self-service articles + customer-facing AI assistant
- Users & Roles admin page
- Tested: iteration_1 100% backend + frontend

## Iteration 2 (Jun 2026)
- Call playback: recordings stored in Emergent Object Storage, timestamped Whisper segments, click-to-seek transcript, flag quotes jump to moment
- Bulk import: CSV/XLSX (≤200 rows) and up to 50 recordings per batch; AI scoring max 3 concurrent
- Score disputes: agent raises (max 2 reviews), staff accept with new score / reject; /disputes page; history kept
- Daily QA digest: platform cron 8pm Asia/Kolkata → /api/cron/digest → SMTP email to team leads (app role + LDAP group); preview / send-now / logs on Digest & Directory page
- LDAP: company sign-in (12h HS256 session, lockout after 5 failures) alongside Clerk; team lead group → role + digest recipients
- Env: SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM, SMTP_SECURITY(starttls|ssl|none); LDAP_URL, LDAP_BASE_DN, LDAP_BIND_DN, LDAP_BIND_PASSWORD, LDAP_USER_FILTER(optional), LDAP_TEAM_LEAD_GROUP_DN
- Tested: iteration_2 (backend 36/36, UI pass); offline SMTP+LDAP check tests/offline_smtp_ldap_check.py

## Iteration 3 (Jun 2026)
- Calibration sessions: blind multi-reviewer scoring (staff), side-by-side vs AI with spread, owner agrees standard (prefilled average), optional apply to interaction (auto-fail respected, binary 0/100 only)
- Agent self-review: timestamped notes at playback time + reflection on own scored calls; visible to staff, pre-fills coaching notes
- Tested: iteration_3 (backend 100%, blind-reveal bug fixed afterwards)

## Backlog
- P1: CRM integrations (Salesforce/Zendesk/Freshdesk), Chrome extension
- P1: recording retention policy; SMTP + LDAP values pending from user
- P2: AlertDialog for deletes, calendar picker, embeddable chatbot widget, certificates PDF
