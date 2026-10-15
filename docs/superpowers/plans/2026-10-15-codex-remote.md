# Codex Remote Web Implementation Plan

> For agentic workers: Use subagent-driven-development for independent units, with root integration and review.

**Goal:** Operate existing Desktop conversations through a paired mobile webpage.
**Architecture:** Read-only SQLite adapter plus official queue CLI, separate admin/mobile HTTP listeners, optional locally owned cloudflared child.
**Tech Stack:** Node.js 24 ESM, built-in HTTP/SQLite/crypto/test runner, qrcode 1.5.4, plain HTML/CSS/JS.
**Spec:** ../specs/2026-10-15-codex-remote-design.md

## Global constraints

- Work only in E:\Tools\CodexRemoteWeb; preserve Codex and DSH installations/configuration.
- No API secrets, raw reasoning or arbitrary RPC/file access on mobile.
- New user text uses official codex queue; never start a second conversation writer.
- Pairing is mandatory, temporary tunnel opt-in, admin port never tunneled.

## Task 1: Read-only desktop adapter

Files: src/codex-store.js, test/codex-store.test.js. Implement the exact spec store interface. Fixture two projects and root/subagent threads with userMessage/agentMessage/tool/reasoning items. Assert correct project attribution, root-only list, safe message projection, ascending history, before pagination, unknown-id rejection and unchanged database rows. Run `node --test test/codex-store.test.js` before and after implementation.

## Task 2: Phone and admin UI

Files: public/index.html, public/admin.html, public/app.js, public/admin.js, public/style.css. Consume the exact JSON endpoints in the spec. Use DOM textContent for messages, no CDN assets, responsive split view and single-column phone navigation. Admin #token login clears fragment; phone #pair exchange clears fragment; show unauthorized/expiry and queued states accurately. Verify visually against the running service after integration.

## Task 3: Pairing, transport, HTTP service

Files: src/auth.js, src/queue.js, src/tunnel.js, src/server.js, src/main.js, test/auth.test.js, test/server.test.js, test/queue.test.js. Tests first: grant is single-use and expires, device revocation persists, disk contains hashes not bearer credentials; real HTTP routes reject unauthenticated access and cross-origin mutations and never serve admin routes on phone listener. Queue tests spawn a controlled executable fixture to prove arbitrary text remains one argument and retry idempotency prevents duplicate dispatch. Implement exact spec interfaces, bounded bodies/output/timeouts and fail-closed errors.

## Task 4: Run and deliver

Files: Start-Codex-Remote.cmd, start.ps1, stop.ps1, README.md. Start hidden owned Node process, record pid safely, open local authenticated admin URL, expose no secrets in logs. Stop only process matching recorded project command line. Run all tests and node syntax checks, real read-only store smoke check, and browser pairing/history check. Record deployment limitations and user startup instructions. No production conversation messages used for smoke tests.

## Progress

- [x] User approved scope and location.
- [x] Inspected installed CLI, SQLite schema and current metadata shape.
- [x] Task 1: read-only adapter and fixture tests.
- [x] Task 2: responsive Chinese admin/phone pages and safe text rendering.
- [x] Task 3: authentication, HTTP isolation, queue and optional tunnel.
- [x] Task 4: launcher/stopper, docs, seven tests, syntax checks, live read-only HTTP pairing/history/revocation; browser visual interaction and actual phone/tunnel remain unverified.

## Pre-flight review

Tasks 1 and 3 share the store interface; Task 2 and 3 share JSON endpoints listed verbatim in the spec. Each owns separate files. Fixture tests use temporary databases and do not modify the user's Codex state. This is a new isolated project, so no existing checkout/worktree is reused. Approval to implement the specified design also covers its implementation plan; no repeated confirmation is needed.

## Review and verification record

- Implementation agents could not run due to service HTTP 429; root completed their units.
- Independent security/code review found a lost requestId on chat switches/reloads. Fixed with per-thread/text sessionStorage submission tracking, reviewed again successfully, and added a regression test.
- `npm.cmd test`: 7 tests passed. All src/public JS passed `node --check`.
- Live smoke: read-only actual Codex data, 20 projects with chats, 98 root threads; selected history readable. Public script/style routes returned 200. Temporary device `本机界面验证` paired and then revoked; its subsequent project request returned 401. No real conversation message submitted.
- Start and graceful stop scripts exercised; service restarted and currently listening. Public tunnel not started. Management page requested in Codex browser; browser-control capability was unavailable for completing visual interaction, so screenshots/layout and actual phone pairing are not claimed as tested.
- Runtime state lives in `%LOCALAPPDATA%\CodexRemoteWeb`, separate from the source checkout. Only the phone port is optionally tunneled.
