# hitnrun

A local, personal HTTP API testing desktop app. Runs on Windows and macOS.

Everything is stored on your machine in a single JSON file. No account, no cloud,
no team features, no telemetry.

---

## Download

Grab the installer for your machine from the
[latest release](https://github.com/Subhash2807/hitnrun/releases/latest):

| Platform | File |
|---|---|
| Windows 10/11 (x64) | `hitnrun-Setup-<version>.exe` |
| macOS, Apple Silicon (M1 and later) | `hitnrun-<version>-arm64.dmg` |

Both builds are **unsigned**, so the OS will warn you the first time:

- **Windows** — SmartScreen says *"Windows protected your PC"*. Click
  **More info → Run anyway**.
- **macOS** — open the dmg, drag hitnrun into Applications, then run this once
  before launching it:

  ```bash
  xattr -dr com.apple.quarantine /Applications/hitnrun.app
  ```

  See [Building a real .dmg](#building-a-real-dmg) if it still refuses to open.

Installers are built by GitHub Actions (`.github/workflows/release.yml`) whenever
a version tag is pushed:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

---

## Running it

```bash
npm install
npm run dev      # hot-reloading development window
npm start        # build once, then run the app
npm test         # 128 headless tests of the engine, parser, sandbox and agent API
```

### Building installers

```bash
npm run dist:win     # -> release/hitnrun-Setup-1.4.0.exe
npm run dist:mac     # -> release/hitnrun-1.4.0-arm64.dmg   (must be run on a Mac)
npm run dist:linux   # -> release/hitnrun-1.4.0.AppImage
```

The app icon is `build/icon.png`, rendered by `npm run icon` (a sky-blue disc with
a white H, matching the mark in the top bar); electron-builder makes the `.ico`
and `.icns` from it.

macOS builds have to be produced on macOS — Apple's toolchain cannot be run from
Windows. The code itself is platform-independent; only packaging is.

On Windows, `dist:win` needs **Developer Mode** enabled
(Settings → System → For developers), otherwise electron-builder cannot extract
its code-signing toolchain — it contains symlinks that a normal account may not
create.

## Running it on a Mac

### The simple way — from source

Nothing is packaged or signed, so nothing fights Gatekeeper. Install
[Node](https://nodejs.org) (20 or newer), then:

```bash
git clone https://github.com/Subhash2807/hitnrun.git && cd hitnrun
npm install
npm start
```

`npm start` builds and launches. For day-to-day use, make an alias:

```bash
alias hitnrun='cd ~/hitnrun && npm start'
```

### Building a real .dmg

On the Mac, in the same checkout:

```bash
npm run dist:mac
```

Output lands in `release/`. Pick the arch that matches the machine — `arm64`
for Apple Silicon (M1–M4), `x64` for Intel.

The build is **unsigned**, because signing needs a paid Apple Developer
certificate. That is fine for your own machines, but macOS will object the
first time. Two fallbacks, in order:

```bash
# 1. Strip the quarantine flag the download added
xattr -dr com.apple.quarantine "/Applications/hitnrun.app"

# 2. Apple Silicon only, if it still refuses to launch: ad-hoc sign it
codesign --force --deep --sign - "/Applications/hitnrun.app"
```

You can also right-click the app → **Open** → **Open** to approve it once.

> Not verified by the author: everything above was developed and tested on
> Windows. The code has no platform-specific logic beyond the title bar and
> quit behaviour, but the macOS packaging and Gatekeeper steps have not been
> run. Expect to iterate on the signing fallbacks.

### Connecting an AI on the Mac

Exactly the same as anywhere else — the app and Claude Code must both be on
that Mac. Open **Sidebar → AI → Set up AI access**; the command is generated
with that machine's paths, including the `.app` bundle path if you installed
the dmg. Use the bash command, not the PowerShell one.

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

**Copy as cURL** on any request (the `>_` icon, or `Ctrl/Cmd+Shift+C`) regenerates the command,
with `{{variables}}` resolved.

**See the code** — the icon rail on the right of every request opens a **Code snippet**
panel (also *View code* in the ⋯ menu): the request as cURL, JavaScript `fetch` or
Python `requests`, with a Copy button. `{{variables}}` stay as written unless you tick
*Fill in variables*. The ⓘ icon shows the request's id, location and timestamps.

**Import a Postman collection** (v2.0 / v2.1) from the sidebar's **+** menu or
*File → Import Postman Collection…* — folders, headers, auth and bodies come across.

**Duplicate** any request from the sidebar, the ⋯ menu, or `Ctrl/Cmd+D`.

**Bulk edit** — headers, query params, path variables and form fields each have a
row-by-row grid *and* a bulk text mode. Toggle with the link in the section
header.

```
Content-Type:application/json
Authorization:Bearer {{token}}
//X-Debug:1                      <- the // prefix disables a row
```

**Environments** — every workspace has a built-in **Global** environment, active
from the start, so a variable or a source cURL always has somewhere to go. It
cannot be deleted; add more environments for staging, production and so on.

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

### Source cURL — refreshing an expired session

The daily problem this solves: you copy a request out of your browser's Network
tab, and a few hours later its cookies and tokens expire. Re-pasting headers
into twenty requests by hand is the worst part of API testing.

Instead, give an **environment** a single **source cURL**: click the sync icon
in the top bar, next to the environment picker. It opens with whatever cURL is
on your clipboard, saves to the active environment (Global by default) and
activates it. The icon turns blue once a source is set. Every request then
shows a chip telling you whether it still matches:

| | |
|---|---|
| 🟢 **In sync** | headers and host match the source |
| 🟠 **Out of sync** | click it to refresh — hover first to see exactly what will change |
| ⚪ **Not synced** | this request is excluded (⋯ → *Exclude from source sync*) |

Drifted requests also get a small amber dot in the sidebar.

**Scope is always yours to choose.** The chip syncs the one request you're
looking at. A folder or collection ⋯ → *Sync all with source cURL* syncs
everything inside it, recursively.

What a sync does:

- **Headers** are replaced by the source's set. A request **with a body keeps its
  own `Content-Type` / `Content-Length`**, because the browser request almost
  never has the right one for your payload.
- **The origin** (scheme + host + port) is replaced by the source's. The path,
  query params, path variables, method and body are left completely alone —
  `https://old.example.com/v2/orders?limit=10` becomes
  `https://www.google.com/v2/orders?limit=10`.
- **Auth** is set to *None* if the source carries an `Authorization` header, so
  the two can't emit conflicting headers.

A URL built on a variable (`{{base_url}}/v2/orders`) has no literal host, so
only its headers sync — the URL is untouched.

Because scope is explicit, the origin rewrite is unconditional within it: group
requests per service in folders and sync the folder you mean.

To refresh everything after a new login: copy the new cURL, click the top-bar
sync icon, save, then ⋯ → *Sync all* on the collection.

**Response** — pretty / raw / preview views, headers, parsed cookies, test
results, and the script console. Timing and size on every send. Redirects are
followed manually so each hop is recorded. Folding a JSON object or array shows
how much it hides — `"users": [ 3 items ]`, `"address": { 5 keys }`.

**Layout** — the split icon beside the sync chip puts the response below the
request or beside it. Drag the divider to resize; both the layout and the split
are remembered.

**Folders** can be renamed and deleted from their ⋯ menu.

### Test docs — a record of what you tested

Press **● Record** (top bar) before you start testing a feature. Every request you
send is written down in order — the complete URL with variables filled in, the
headers and body that went out, and the full response — so at the end you have
something to hand over instead of trying to remember what you clicked.

- **Auto** mode records every send. **Manual** mode records only the responses you
  add with **+ Add to doc**. Switch modes, pause or stop from the red recording chip.
  One recording runs at a time; you can resume any doc later.
- Docs live in their own **Docs** sidebar tab (it appears once you record something)
  and open in the main area like a request. Rename steps, drag to reorder, delete the
  ones you don't need, mark each **Pass / Fail**, and add an *expected result* and a
  note. Headers and bodies are collapsed until you open them.
- **Download** as **Markdown** (collapsed `<details>` sections, pastes into GitHub,
  Jira, Confluence), a single-file **HTML** page, **PDF**, or a **Postman collection**
  that re-runs the steps in order. Secrets — Authorization, cookies, API keys, tokens,
  password fields — are masked by default, keeping the last four characters.
- Claude can record too: its sends land in the doc (marked *Claude*), and over MCP it
  can read docs and write the step titles, notes, expected results and pass/fail for
  you. Deleting a whole doc stays in your hands.

### Keyboard

| | |
|---|---|
| `Ctrl/Cmd + Enter` | Send |
| `Ctrl/Cmd + N` | New request |
| `Ctrl/Cmd + D` | Duplicate request |
| `Ctrl/Cmd + Shift + C` | Copy as cURL |
| `Ctrl/Cmd + Shift + V` | Import cURL from clipboard |
| `Ctrl/Cmd + W` | Close tab |
| `Ctrl/Cmd + =` / `-` / `0` | Zoom in / out / reset (remembered) |

---

## Letting an AI assistant use the app

The assistant talks to the app over **127.0.0.1**, so both must run on the
**same machine**. There is no remote mode — this is deliberate, and it is why
nothing off-machine can drive your requests.

On whichever machine you are using:

1. Install and start hitnrun.
2. Install Claude Code there.
3. Open **Sidebar → AI → Set up AI access** and copy the command it shows.
   The path is generated for *that* machine, so it is always correct.

```bash
claude mcp add hitnrun --scope user --env HITNRUN_PORT=47600 \
  -- node "<path>/mcp/server.js"
```

Then ask: *"Check hitnrun is running, then build me a request for
https://httpbin.org/get and send it."*

Claude Desktop takes the equivalent JSON, shown on the same screen.

**PowerShell users:** that command fails if pasted into PowerShell, which
consumes the `--` separator before the CLI sees it. The setup screen has a
PowerShell-safe variant behind a disclosure — or just use Git Bash / cmd.

**An installed copy needs no Node.** Electron ships a Node runtime, and the
setup screen wires the MCP server to run through the app's own binary via
`ELECTRON_RUN_AS_NODE`. Running from source uses the Node on your PATH instead.

To remove it again: `claude mcp remove hitnrun --scope user`.

### The AI works in its own workspace

An assistant **cannot modify or delete anything you own**. It gets a separate
workspace, stored in a separate file (`ai-workspace.json`), so the isolation
survives bugs rather than depending on checks being right everywhere.

| The AI can | The AI cannot |
|---|---|
| Read your requests, collections and variables | Edit or delete any request you own |
| Copy your folder into its own workspace and work on the copy | Write anything into your collections |
| Create, edit, send and delete **its own** requests | Promote its own work into your workspace |
| See which requests have drifted from the source cURL | Reach a blocked host or method |

Each AI session gets its own folder under the **AI** tab, labelled with the
client and start time. (Settings can switch this to one shared folder.)

**Promotion is yours alone.** When the AI builds something useful, you click
**Add** on it and choose which collection it joins. There is no API route for
promotion at all — it exists only in the UI, so an agent cannot promote itself.
Discarding a session deletes everything it made and touches nothing of yours.
Use the trash icon on a session, on any single AI request or folder, or at the
top of the AI tab to discard every session at once. A connected assistant just
starts a fresh session on its next call.

### Guardrails

**Settings → AI guardrails.** These apply to AI sessions only — requests you
send yourself are never checked.

- **Blocked methods** — `DELETE` by default.
- **Blocked hosts** — e.g. `api.prod.com, *.internal.company.com`.
  `*.prod.com` covers subdomains and the bare domain; a plain hostname matches
  only itself.

Both are denylists: everything unnamed stays allowed, so ordinary testing is
frictionless while the irreversible things are impossible.

Blocks are enforced in the main process before the request leaves the machine,
and **re-checked on every redirect hop** — otherwise a 302 from an allowed host
onto production would walk straight through the host list.

A blocked call returns a clear refusal telling the assistant not to work around
it and to ask you instead.

> Worth knowing: workspace isolation protects your *saved requests*. Guardrails
> are what protect the *APIs you're testing*. If the AI copies a folder, it
> copies your live session headers with it — which is the point, and also why
> the production host list matters.

**Settings → Let AI edit my requests** lowers the wall deliberately if you ever
want an agent editing your workspace in place. Off by default.

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
| `PUT` | `/sync/source` | `{ curl, environmentId? }` — set the source cURL; omit `curl` to clear |
| `GET` | `/sync/source` | the active environment's source |
| `GET` | `/sync/status` | which requests are in sync vs drifted, and why |
| `POST` | `/requests/:id/sync` | pull headers + host from the source |
| `POST` | `/collections/:id/sync` | sync every request in a collection or folder |
| `POST` | `/ui/open` | `{ requestId }` — open a request or doc in a tab and focus the window |
| `GET` | `/docs` | test docs and the current recording |
| `GET` | `/docs/:id` | one doc with every step (`?bodies=full` for uncut bodies) |
| `PATCH` | `/docs/:id` | `{ name?, description? }` |
| `PATCH` | `/docs/:id/steps/:stepId` | `{ title?, note?, expected?, status }` |
| `DELETE` | `/docs/:id/steps/:stepId` | remove a step |
| `POST` | `/docs/:id/steps/:stepId/move` | `{ index }` |
| `GET` `POST` `PATCH` `DELETE` | `/docs/recording` | read, start (`{ name, mode, docId? }`), change (`{ mode?, paused? }`), stop |

Any send route also takes `record: true` to add that send to the recording even in manual mode.

Which makes the whole session refresh a two-liner from a terminal:

```bash
# paste a fresh browser cURL onto the active environment
curl -X PUT 127.0.0.1:47600/sync/source \
  -H 'Content-Type: application/json' \
  -d '{"curl":"curl https://www.example.com/api ..."}'

# bring every request in a collection up to date
curl -X POST 127.0.0.1:47600/collections/col_abc/sync
# -> { "synced": 12, "alreadyInSync": 3, "exempt": 1, "details": [...] }
```

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
  docs.js            test docs: recording and steps (docs.json)
  doc-export.js      Markdown / HTML / Postman export, secret masking
  codegen.js         cURL / fetch / Python snippets for the Code panel
  postman.js         Postman collection import
  preload.js         the only renderer <-> Node bridge
src/                 React UI (Vite)
test/*.js            headless tests for all of the above
```

Requests are sent from the **main process**, not the browser window. That is why
there is no CORS to work around, why duplicate response headers survive intact,
and why TLS verification can be turned off per request.

The renderer never has Node access: `contextIsolation` is on, `nodeIntegration`
is off, and a strict CSP blocks any external resource load.

Your data lives in one folder:

- Windows — `%APPDATA%\hitnrun\`
- macOS — `~/Library/Application Support/hitnrun/`

`workspace.json` holds your requests, `docs.json` your test docs and
`ai-workspace.json` the AI sessions. Back them up by copying those files.

---

## Not included

Deliberately, since this is a personal local tool: mock servers, monitors, cloud
sync, team workspaces, and gRPC / WebSocket / MQTT clients. The HTTP engine is
the whole product.
