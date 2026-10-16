# Mobile model and reasoning selection

User approved adding model/effort controls to existing and new mobile conversations, after the separate new-conversation task was complete. Its uncommitted changes are preserved; a source snapshot exists in the ignored `.state/model-switch-baseline` directory.

## Verified protocol

Codex CLI 0.162.0-alpha.17.2 queue shared flags do not carry model/effort in the queued input. `thread/settings/update` only affects a thread loaded by the same app-server owner. Another desktop owner's writer lock must never be removed or bypassed.

An actual isolated, ephemeral thread confirmed `thread/settings/update` -> `thread/settings/updated.threadSettings` -> `thread/read` reports the selected model and effort; no user message or inference was sent. `turn/start` can steer an already-active turn and was not used as a replacement for queue dispatch in existing conversations.

## Implementation

- [x] Read sanitized model/effort choices from official `model/list`, plus defaults from `config/read`; cache for five minutes and validate selections on the server.
- [x] Add responsive controls to composer/new-conversation dialog, preserve per-chat draft selections, include choices in retry identity, keep inherited request shape compatible.
- [x] New conversations pass explicit model at thread/start and model/effort at first turn/start.
- [x] Existing selected-model input: safely resume only an available thread, await settings confirmation, enqueue through official queue RPC, retain its owner until queue drained and idle. Busy desktop owners reject without sending.
- [x] Preserve existing CLI queue path when model/effort are inherited.
- [x] Block new work during shutdown, including after asynchronous model lookup; reject new HTTP requests before disposing execution clients.
- [x] Run full tests, focused independent review, authenticated live catalog check, and deploy after checking for active owned tasks.

Model settings are session-wide for subsequent turns; they do not form an immutable per-message snapshot. Stop/restart must not unexpectedly replace other task changes. No actual user conversation messages are sent during automated verification.

## Evidence

- Full suite: 96 tests passed, including existing new-thread behavior, per-model effort validation, concurrent message ownership, settings notification ordering, queue confirmation, safe shutdown and retry identity.
- All source/public JavaScript syntax and whitespace checks passed.
- Real read-only catalog returned eight models, default `gpt-6-sol` / `xhigh`; no credentials returned to client.
- A separate temporary `CODEX_HOME` and ephemeral thread confirmed `thread/settings/update` notification and `thread/read` agree on `gpt-6.1-sol` / `high`; zero input messages or inference requests were sent.
- After restart, authenticated `/api/models` returned eight choices; anonymous and revoked-device access returned 401. Both composer and new-thread picker controls were served by the live app. Temporary verification device revoked.
- Existing user-enabled tunnel was restored after restart. Real phone viewport and paid model execution were not exercised.
