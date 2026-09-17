# API Client

A local, personal HTTP API testing desktop app. Runs on Windows and macOS.

Everything is stored on your machine in a single JSON file. No account, no cloud,
no team features, no telemetry.

---

## Running it

```bash
npm install
npm run dev      # hot-reloading development window
npm start        # build once, then run the app
npm test         # 47 headless tests of the engine, parser and agent API
```

### Building installers

```bash
npm run dist:win     # -> release/API Client Setup 1.0.0.exe
npm run dist:mac     # -> release/API Client-1.0.0.dmg   (must be run on a Mac)
npm run dist:linux   # -> release/API Client-1.0.0.AppImage
```

macOS builds have to be produced on macOS — Apple's toolchain cannot be run from
Windows. The code itself is platform-independent; only the packaging step is.

---

## What it does

**Requests** — all HTTP methods, query params, path variables, headers, request
body as raw (JSON / XML / HTML / text / JS), form-data with file uploads,
x-www-form-urlencoded, binary file, or GraphQL.

**Auth** — bearer token, basic, API key (header or query), or inherited from the
collection.

**Everything auto-saves.** There is no Save button. Edits are written to disk
~300ms after you stop typing.

**Paste a cURL command into the URL bar** and it becomes a fully populated
request — method, URL, query params, headers, auth, and body all split into the
right places. Works with `\` (Unix) and `^` (Windows) line continuations,
`$'...'` quoting, `-F`, `-d`, `--data-urlencode`, `-G`, `-u`, and more.
`Ctrl/Cmd+Shift+V` imports from the clipboard directly.

**Copy as cURL** on any request (`Ctrl/Cmd+Shift+C`) regenerates the command,
with `{{variables}}` resolved.

**Duplicate** any request from the sidebar, the ⋯ menu, or `Ctrl/Cmd+D`.

**Bulk edit** — headers, query params, path variables and form fields each have a
row-by-row grid *and* a bulk text mode. Toggle with the link in the section
header.

```
Content-Type:application/json
Authorization:Bearer {{token}}
//X-Debug:1                      <- the // prefix disables a row
```

**Variables** — `{{name}}` anywhere, resolved from the active environment, then
collection variables, then globals. Dynamic values like `{{$guid}}`,
`{{$timestamp}}`, `{{$randomInt}}` also work. Unresolved names are reported
above the response instead of silently becoming empty strings.

**Scripts** — pre-request and test scripts with a `pm.*` API and a chai-style
`expect`, so you can chain auth flows:

```js
// Tests tab on your login request
pm.test('login works', () => pm.response.to.have.status(200));
pm.environment.set('token', pm.response.json().access_token);
```

Then use `{{token}}` in every other request.

**Response** — pretty / raw / preview views, headers, parsed cookies, test
results, and the script console. Timing and size on every send. Redirects are
followed manually so each hop is recorded.

### Keyboard

| | |
|---|---|
| `Ctrl/Cmd + Enter` | Send |
| `Ctrl/Cmd + N` | New request |
| `Ctrl/Cmd + D` | Duplicate request |
| `Ctrl/Cmd + Shift + C` | Copy as cURL |
| `Ctrl/Cmd + Shift + V` | Import cURL from clipboard |
| `Ctrl/Cmd + W` | Close tab |

---

## Driving it from Claude Code or another terminal agent

The app runs a small HTTP control server on **127.0.0.1:47600** (loopback only —
nothing outside your machine can reach it). An agent can create requests, fix
mistakes in them, run them, and read the decoded response.

Changes made through the API appear in the open window immediately, and edits you
make in the window are what the API reads back. There is one source of truth.

Start with the self-describing index:

```bash
curl 127.0.0.1:47600
```

### The calls that matter

```bash
# Create a request from a cURL command — saved and opened in a tab
curl -X POST 127.0.0.1:47600/requests \
  -H 'Content-Type: application/json' \
  -d '{"curl":"curl -X POST https://api.example.com/login -H \"Content-Type: application/json\" -d \"{\\\"u\\\":\\\"me\\\"}\""}'
# -> { "id": "req_ab12…", "method": "POST", "url": "…", "curl": "…" }

# Fix one field without touching the rest
curl -X PATCH 127.0.0.1:47600/requests/req_ab12 \
  -H 'Content-Type: application/json' \
  -d '{"headers":[{"key":"Authorization","value":"Bearer {{token}}","enabled":true}]}'

# Run it — returns the decoded body, not base64
curl -X POST 127.0.0.1:47600/requests/req_ab12/send
# -> { "status": 200, "timeMs": 143, "json": {...}, "headers": {...}, "tests": [...] }

# Try something without saving it
curl -X POST 127.0.0.1:47600/send \
  -H 'Content-Type: application/json' \
  -d '{"curl":"curl https://api.example.com/health"}'
```

### Full endpoint list

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | endpoint index |
| `GET` | `/health` | liveness + request count |
| `GET` | `/state` | the entire workspace |
| `GET` | `/collections` | list collections |
| `POST` | `/collections` | `{ name }` |
| `DELETE` | `/collections/:id` | delete |
| `POST` | `/collections/:id/folders` | `{ name }` |
| `GET` | `/requests` | flat list of every saved request |
| `GET` | `/requests/:id` | one request; `?curl=1` adds its cURL form |
| `POST` | `/requests` | `{ curl }` or a request model → create + autosave |
| `PATCH` | `/requests/:id` | partial update; `{ curl }` replaces the whole thing |
| `POST` | `/requests/:id/duplicate` | duplicate in place |
| `DELETE` | `/requests/:id` | delete |
| `POST` | `/requests/:id/send` | run it |
| `POST` | `/send` | run without saving |
| `POST` | `/curl/parse` | parse only, save nothing |
| `GET` | `/environments` | list |
| `POST` | `/environments` | `{ name, values }` — values may be an object |
| `PATCH` | `/environments/:id` | update |
| `POST` | `/environments/:id/activate` | make active |
| `GET` | `/variables` | resolved variable scope |
| `PUT` | `/variables/:key` | `{ value, scope }` |
| `GET` | `/history` | recent runs (`?limit=`) |
| `POST` | `/ui/open` | `{ requestId }` — open in a tab and focus the window |

Port, on/off, and an optional access token are all in **Settings**. The token is
off by default; when set, send it as `Authorization: Bearer <token>`.

---

## How it fits together

```
electron/
  main.js            window, menus, IPC wiring
  workspace.js       the workspace — single source of truth, auto-saving
  http-engine.js     raw node:http/https — no CORS, real timings, manual redirects
  curl.js            cURL parse + generate (one implementation, shared)
  resolve.js         {{variable}} resolution, request -> wire spec
  runner.js          resolve -> pre-script -> send -> tests -> history
  scripts.js         node:vm sandbox, pm.* API, chai-style expect
  control-server.js  the loopback API agents drive
  preload.js         the only renderer <-> Node bridge
src/                 React UI (Vite)
test/smoke.js        headless tests for all of the above
```

Requests are sent from the **main process**, not the browser window. That is why
there is no CORS to work around, why duplicate response headers survive intact,
and why TLS verification can be turned off per request.

The renderer never has Node access: `contextIsolation` is on, `nodeIntegration`
is off, and a strict CSP blocks any external resource load.

Your data lives in one file:

- Windows — `%APPDATA%\API Client\workspace.json`
- macOS — `~/Library/Application Support/API Client/workspace.json`

Back it up by copying that file.

---

## Not included

Deliberately, since this is a personal local tool: mock servers, monitors, cloud
sync, team workspaces, and gRPC / WebSocket / MQTT clients. The HTTP engine is
the whole product.
