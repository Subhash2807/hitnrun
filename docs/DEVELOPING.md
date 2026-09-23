# Developing hitnrun

For using the app, see the [README](../README.md).

- [Run from source](#run-from-source)
- [Build installers](#build-installers)
- [Publish a release](#publish-a-release)
- [Mac notes](#mac-notes)
- [Connect an AI with MCP](#connect-an-ai-with-mcp)
- [How the AI is sandboxed](#how-the-ai-is-sandboxed)
- [The in-app AI chat](#the-in-app-ai-chat)
- [The local API](#the-local-api)
- [Code layout](#code-layout)

## Run from source

You need [Node](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev      # development window with hot reload
npm start        # build once and run
npm test         # headless tests
```

## Build installers

```bash
npm run dist:win     # release/hitnrun-Setup-<version>.exe
npm run dist:mac     # release/hitnrun-<version>-arm64.dmg  (only on a Mac)
npm run dist:linux   # release/hitnrun-<version>.AppImage
```

- On Windows, turn on **Developer Mode** (Settings → System → For developers)
  first, or electron-builder can't unpack its signing tools.
- Mac builds have to be made on a Mac.
- The icon is `build/icon.png`, drawn by `npm run icon`.

## Publish a release

Pushing a version tag makes GitHub Actions build the installers and attach them
to a release (`.github/workflows/release.yml`):

```bash
git tag v1.6.0 && git push origin v1.6.0
```

A tag with a hyphen, like `v1.6.0-beta.1`, is published as a pre-release.

## Mac notes

The simplest way to run it on a Mac is from source (`npm install && npm start`),
which avoids Gatekeeper entirely.

The `.dmg` is unsigned. If macOS still won't open it after removing the
quarantine flag (see the README), sign it yourself:

```bash
codesign --force --deep --sign - "/Applications/hitnrun.app"
```

Or right-click the app → **Open** → **Open**.

The Mac packaging steps haven't been tested on a real Mac yet.

## Connect an AI with MCP

hitnrun includes an MCP server (`mcp/server.js`) so Claude Code, Claude Desktop
or any MCP client can use the app. The app and the AI must run on the same
computer, because the app only listens on `127.0.0.1`.

1. Start hitnrun.
2. In the sidebar, open **AI → Set up AI access**.
3. Run the command it shows. It looks like:

   ```bash
   claude mcp add hitnrun --scope user --env HITNRUN_PORT=47600 -- node "<path>/mcp/server.js"
   ```

- The setup screen has a separate command for **PowerShell**, because PowerShell
  swallows the `--`.
- An installed copy doesn't need Node: the MCP server runs on the app's own
  binary (`ELECTRON_RUN_AS_NODE`).
- To remove it: `claude mcp remove hitnrun --scope user`.

## How the AI is sandboxed

Every AI session works in its own workspace, saved in a separate file
(`ai-workspace.json`).

| The AI can | The AI cannot |
|---|---|
| Read your requests, collections and variables | Edit or delete your requests |
| Copy a folder into its own workspace and change the copy | Add anything to your collections |
| Create, edit, send and delete its own requests | Move its own work into your workspace |
| Read and annotate test docs | Delete a whole doc |

To keep something the AI made, click **Add** on it in the AI tab. There is no API
for this, so an agent can't do it for itself.

**Guardrails** (Settings → AI guardrails) apply only to AI sends:

- **Blocked methods**: `DELETE` by default.
- **Blocked hosts**: for example `api.prod.com, *.internal.company.com`.

They're checked before the request leaves the machine, and again on every
redirect. **Settings → Let AI edit my requests** removes the wall if you ever
want that. It's off by default.

## The in-app AI chat

The **Ask AI** panel (beta) doesn't call a model API. It runs a CLI installed on
the machine, in headless mode, with hitnrun's MCP server attached, so the sandbox
above applies to it too.

| CLI | Status | How it's run |
|---|---|---|
| Claude Code | Supported | `claude -p` with streaming JSON, no built-in tools, only hitnrun's MCP tools |
| Codex CLI | Experimental | `codex exec --json`, read-only sandbox |
| Gemini CLI | Experimental | `gemini -p` with streaming JSON, shell and file-writing tools off |
| Custom command | Experimental | any command; `{prompt}` marks where the message goes |

- Each message also carries the open request, its last response and the active
  environment.
- Claude Code stays running between messages. Other CLIs start once per message
  and resume the conversation.
- Chats are saved in `chats.json`.
- Codex, Gemini and the custom command haven't been tested with a real install.

The adapters are in `electron/chat-providers.js`. Adding a CLI means writing how
to start it and how to read its output.

## The local API

The app runs an HTTP server on `127.0.0.1:47600`. It's only reachable from your
own computer. Agents use it to create, edit and run requests; changes show up in
the window straight away.

`curl 127.0.0.1:47600` lists every endpoint. The port, on/off switch and an
optional access token are in **Settings**. With a token, send
`Authorization: Bearer <token>`.

```bash
# Create a request from a cURL command
curl -X POST 127.0.0.1:47600/requests -H 'Content-Type: application/json' \
  -d '{"curl":"curl https://httpbin.org/get"}'

# Change one field
curl -X PATCH 127.0.0.1:47600/requests/req_ab12 -H 'Content-Type: application/json' \
  -d '{"headers":[{"key":"Authorization","value":"Bearer {{token}}","enabled":true}]}'

# Send it (the response body comes back decoded)
curl -X POST 127.0.0.1:47600/requests/req_ab12/send

# Send without saving
curl -X POST 127.0.0.1:47600/send -H 'Content-Type: application/json' \
  -d '{"curl":"curl https://httpbin.org/get"}'
```

### All endpoints

| Method | Path | What it does |
|---|---|---|
| `GET` | `/` | list of endpoints |
| `GET` | `/health` | is the app running |
| `GET` | `/state` | the whole workspace |
| `GET` `POST` | `/collections` | list, or create `{ name }` |
| `DELETE` | `/collections/:id` | delete |
| `POST` | `/collections/:id/folders` | add a folder `{ name }` |
| `GET` | `/requests` | every saved request |
| `GET` | `/requests/:id` | one request (`?curl=1` adds its cURL) |
| `POST` | `/requests` | create from `{ curl }` or a request object |
| `PATCH` | `/requests/:id` | change some fields |
| `POST` | `/requests/:id/duplicate` | duplicate |
| `DELETE` | `/requests/:id` | delete |
| `POST` | `/requests/:id/send` | send it |
| `POST` | `/send` | send without saving |
| `POST` | `/curl/parse` | parse a cURL, save nothing |
| `GET` `POST` | `/environments` | list, or create `{ name, values }` |
| `PATCH` | `/environments/:id` | change |
| `POST` | `/environments/:id/activate` | make active |
| `GET` | `/variables` | resolved variables |
| `PUT` | `/variables/:key` | set `{ value, scope }` |
| `GET` | `/history` | recent sends (`?limit=`) |
| `GET` `PUT` | `/sync/source` | read or set the source cURL |
| `GET` | `/sync/status` | which requests are out of sync |
| `POST` | `/requests/:id/sync` | update one request from the source cURL |
| `POST` | `/collections/:id/sync` | update a whole collection or folder |
| `POST` | `/ui/open` | open a request or doc in the app `{ requestId }` |
| `GET` | `/docs` | test docs and the current recording |
| `GET` `PATCH` | `/docs/:id` | read (`?bodies=full` for full bodies) or rename |
| `PATCH` `DELETE` | `/docs/:id/steps/:stepId` | edit or remove a step |
| `POST` | `/docs/:id/steps/:stepId/move` | reorder `{ index }` |
| `GET` `POST` `PATCH` `DELETE` | `/docs/recording` | read, start, change or stop recording |

Any send also accepts `record: true` to add it to the current recording.

## Code layout

```
electron/
  main.js            window, menus, wiring
  workspace.js       your requests, auto-saved (workspace.json)
  http-engine.js     sends requests: no CORS, real timings, manual redirects
  curl.js            reads and writes cURL commands
  resolve.js         fills in {{variables}}
  runner.js          runs a request: scripts, send, tests, history
  scripts.js         the pm.* script sandbox
  control-server.js  the local API
  ai-workspace.js    the AI's separate workspace
  guardrails.js      blocked methods and hosts for AI sends
  sync.js            source cURL syncing
  docs.js            test docs and recording (docs.json)
  doc-export.js      Markdown / HTML / PDF / Postman export, hides secrets
  codegen.js         cURL / fetch / Python snippets
  postman.js         Postman import
  chat.js            the Ask AI chat (chats.json)
  chat-providers.js  one adapter per AI CLI
  preload.js         the only bridge between the window and Node
mcp/server.js        the MCP server
src/                 the React UI
test/                headless tests
```

Requests go out from the main process, not the browser window. That's why there's
no CORS, and why SSL checks can be turned off per request. The window has no Node
access (`contextIsolation` on, `nodeIntegration` off, strict CSP).

## Not included, on purpose

Mock servers, monitors, cloud sync, team workspaces, and gRPC / WebSocket / MQTT.
