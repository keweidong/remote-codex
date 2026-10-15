# Codex Remote Web

Approved in chat on 2026-10-15: access existing Desktop projects and conversations, read messages/status, queue messages and Continue, QR pairing, revoke devices, optional Cloudflare access. Location: E:\Tools\CodexRemoteWeb. No new Codex login or changes to the existing API provider.

## Architecture

A standalone Node.js 24 service provides two HTTP listeners. The admin listener binds only 127.0.0.1:8765 and needs a random local admin secret. The mobile listener binds 0.0.0.0:8766, serves a responsive Chinese UI, and exposes only explicitly authenticated conversation endpoints. Cloudflared, when started by the local admin, forwards only the mobile port. No author-operated relay or telemetry.

Codex state_5.sqlite and thread_history_1.sqlite are opened read-only; .codex-global-state.json supplements project assignments/titles. History exposes user/assistant messages and a bounded activity summary, never reasoning, raw tool arguments/results or authentication files. Sending uses the installed official codex queue command with shell:false and a resolved thread id/cwd. No direct mutations to Codex databases, history or locks. Shared app-server proxy was unavailable (Windows socket 10050); no second writer is launched. Interrupts and approvals remain in Desktop for v0.1.

## Pairing and access

Admin and phone listeners have separate routes and credentials. Runtime state is under `%LOCALAPPDATA%\CodexRemoteWeb` by default. Admin login exchanges a launcher-only secret for an HttpOnly SameSite=Strict cookie. One-time 5-minute random QR grants are held in memory, use URL fragments, and are exchanged by JSON POST for a 30-day device session. Only hashes of persistent device credentials are stored. Revoke blocks subsequent requests immediately. JSON mutations require a same-origin Origin header, preventing cross-site form submissions; GET endpoints are read-only. Both surfaces use CSP, no-store, no-referrer and frame restrictions. Unauthorized requests never expose project or thread data. A tunnel never publishes admin endpoints. Desktop remains responsible for permissions and approvals; the bridge never changes those policies.

## UX

Admin: readiness, local/LAN address selection, start/stop temporary public tunnel, generate QR, device names and revoke, startup links. Phone: pair/expired screen, searchable projects/chats, status badges, readable user/assistant messages, history pagination, textarea Send and Continue, busy/error/queued states. Show queued as queued, not completed. Status is read from persisted history and can lag; label it as recorded status. Do not render arbitrary HTML from model messages. Poll selected chat every 2.5 seconds, list less frequently, suspend polling in background.

## Interfaces

`createCodexStore({codexHome})` -> sync `listProjects()`, `listThreads({projectId,search,limit})`, `getThread(id,{limit,before})`, `requireThread(id)`, `close()`.

Project: `{id,name,paths,count}`. Thread: `{id,title,cwd,projectId,projectName,updatedAt,status,model}`. History: `{thread,messages:[{id,role,text,phase,createdAt,ordinal}],status,hasMore,nextBefore,activity,warning}`. Unknown ids throw an error with statusCode 404. No global file writes.

Mobile endpoints: `POST /api/pair {token,name}` -> device cookie; `GET /api/session` -> `{device:{id,name},capabilities}`; `GET /api/projects` -> `{projects}`; `GET /api/threads?projectId=&search=` -> `{threads}`; `GET /api/threads/:id?before=` -> History; `POST /api/threads/:id/messages {text,requestId}` -> `{status:'queued',messageId,requestId}`; `POST /api/logout`. Cookies authenticate requests. All errors return `{error:string}`.

Admin endpoints: `POST /admin/login {token}`; `GET /admin/status` -> `{ready,phonePort,lanUrls,localUrl,tunnel:{status,url,error},devices,capabilities}`; `POST /admin/pair {baseUrl}` -> `{url,qr,expiresAt}`; `DELETE /admin/devices/:id`; `POST /admin/tunnel {action:'start'|'stop'}`. baseUrl must match an advertised phone base. Admin routes do not exist on mobile listener. All browser POST/DELETE calls supply JSON plus same-origin Origin.

## Verification

Behavior tests cover SQLite project attribution/history paging without writes, one-time expiry/revocation, credential hashing, unauthenticated rejection, admin isolation, CSRF, shell-safe queue arguments and idempotency. Fixtures isolate Codex state. Live verification reads actual projects/chats only; no unsolicited test messages to existing conversations. Browser check covers local admin, generated pairing, phone-sized rendering and history. Public network and real phone connection remain unverified until user starts the tunnel and scans.
