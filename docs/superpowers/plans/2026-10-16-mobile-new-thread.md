# Mobile New Conversation Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with tests first.

**Goal:** Let a paired phone create a persistent Codex conversation inside a selected existing project and show that conversation in Codex Desktop.

**Architecture (corrected after desktop verification):** The mobile endpoint validates an existing project and uses official `codex app-server --stdio`. `thread/start` binds the canonical project ID and returns a desktop-visible source, then `turn/start` submits the initial message. The client remains connected until the turn completes. Request results are persisted for idempotency; Codex SQLite files are never edited directly. `codex exec` was rejected because its `exec` source is omitted by desktop default listing.

**Tech Stack:** Node.js 24 ESM, built-in HTTP/SQLite/crypto/test runner, plain HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-15-codex-remote-design.md` plus the approved mobile new-conversation design in chat.

## Global Constraints

- Use the same `CODEX_HOME` as Codex Desktop and `ephemeral:false` so the new session is persisted and discoverable by Desktop.
- Accept only project ids already returned by the read-only store and use an existing registered project root as `cwd`.
- Spawn with `shell:false`; the initial prompt is JSON text sent over stdio and is never interpreted as a command.
- Keep device/request idempotency and fail closed when creation status is unknown.
- Preserve existing project listing, queue sending, history filtering, and pairing behavior.

### Task 1: Persistent session creator

**Files:** Create `src/session-creator.js`, `test/session-creator.test.js`; modify `src/codex-store.js`.

- Add `requireProject(id)` to expose a validated project record.
- Implement `SessionCreator.create({projectId,text,requestId,deviceId})` with App Server initialization, `thread/start`, and `turn/start`; persist request results, reject invalid/missing project roots, and stop active children after the first turn or shutdown.
- Test shell-safe arguments, project validation, duplicate coalescing, request-id conflicts, and CLI failure/timeout behavior with a controlled child fixture.

### Task 2: HTTP route and process integration

**Files:** Modify `src/server.js`, `src/main.js`, `test/server.test.js`.

- Add `POST /api/projects/:projectId/threads` with same-origin and paired-device checks.
- Return `{status:'created',threadId,requestId,projectId,cwd}` after `thread.started`; reject unknown projects and cross-origin requests.
- Construct and stop `SessionCreator` alongside the existing queue.

### Task 3: Mobile creation flow

**Files:** Modify `public/index.html`, `public/app.js`, `public/style.css`.

- Show all projects, including projects with zero existing chats.
- Add a project-aware “新建会话” dialog requiring the first message, generate a request id, call the new endpoint, refresh the list, and open the returned thread.
- Keep phone layout usable with safe-area spacing and clear creation errors.

### Task 4: Verification and documentation

**Files:** Modify `README.md` and the design/spec note if behavior wording needs updating.

- Run focused tests, the complete Node test suite, and `node --check` for source/public JavaScript.
- Verify the implementation does not include `--ephemeral` and documents Desktop synchronization and the requirement to use the same `CODEX_HOME`.
