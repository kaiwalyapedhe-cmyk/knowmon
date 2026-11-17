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

## Backlog
- P1: persist call audio (object storage) + player with timestamped transcript; bulk/CSV import of interactions; CRM integrations (Salesforce/Zendesk/Freshdesk), Chrome extension
- P1: QA calibration / dispute workflow; scheduled daily digest email
- P2: AlertDialog for deletes, calendar picker, embeddable chatbot widget, certificates PDF
