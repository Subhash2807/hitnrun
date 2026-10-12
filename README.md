# hitnrun

A simple desktop app for testing HTTP APIs, like Postman, but everything stays on
your computer. No account, no cloud.

Works on Windows and macOS.

## Install

Download the installer from the
[releases page](https://github.com/Subhash2807/hitnrun/releases):

- **Windows**: `hitnrun-Setup-<version>.exe`
- **Mac (M1 or newer)**: `hitnrun-<version>-arm64.dmg`

The app isn't signed, so your computer will warn you the first time:

- **Windows**: click **More info → Run anyway**.
- **Mac**: drag hitnrun into Applications, then run this once in Terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/hitnrun.app
  ```

Versions ending in `-beta` are previews of new features.

### Updates

hitnrun checks for new versions by itself. When one is out, an **Update** button
appears at the top of the window: click it, then **Install and restart**. hitnrun
downloads the update, installs it and opens again, keeping your data. On a Mac
there's no need to run the `xattr` command again. If hitnrun is installed for all
users on Windows, you'll be asked for admin permission.

You can also check by hand from **Settings → Check for updates**, or from the menu
(**hitnrun → Check for Updates…** on Mac, **Help → Check for Updates…** on Windows).
Full releases only offer full releases; a beta also offers newer betas.

## What you can do

- **Send any request.** All methods, headers, params, auth, and every kind of body
  (JSON, form data, file upload, GraphQL).
- **Paste a cURL** into the URL bar and it becomes a ready request. **Copy as
  cURL** turns it back.
- **See the code.** The `</>` icon on the right shows the request as cURL,
  JavaScript or Python.
- **Use variables** like `{{token}}` with environments (dev, staging, prod).
- **Write tests** with Postman-style scripts (`pm.test`, `pm.environment.set`).
- **Import Postman collections** from the **+** menu.
- **Auto-save.** There is no Save button; everything is saved as you type.

## Fix expired logins in one click

Copy a fresh request from your browser's Network tab (**Copy as cURL**), then
click the **sync icon** in the top bar and paste it. Each request shows whether
it's up to date:

- 🟢 **In sync**: nothing to do.
- 🟠 **Out of sync**: click it to update its cookies, tokens and host.

To update a whole folder at once, use its **⋯ menu → Sync all with source cURL**.

## Record what you tested

Click **● Record** in the top bar before you start testing a feature. Every
request you send is saved in order, with its full response.

- Mark each step **Pass** or **Fail** and add notes.
- **Download** it as Markdown, HTML, PDF or a Postman collection to share.
  Passwords and tokens are hidden automatically.
- Find your recordings in the **Docs** tab of the sidebar. Each step has a
  **cURL** button that copies exactly what was sent.

**Screenshots.** Testing in the browser too? While recording, click the
**camera** in the top bar and pick a screen or window. The screenshot becomes a
step in the doc, in order with your requests, so you can mark it Pass or Fail
and add notes like any other step.

- Press `Ctrl+Shift+S` (`Cmd+Shift+S` on a Mac) from any app to capture the
  screen you're on, without switching to hitnrun.
- Took one with your system's snipping tool? Use **Paste image** in the
  screenshot window.
- Screenshots are included in HTML and PDF downloads. Markdown downloads put
  them in an images folder next to the `.md` file. They are not masked.
- **Mac:** allow hitnrun in **System Settings → Privacy & Security → Screen
  Recording** the first time. After installing a new version you may need to
  turn it off and on again.

## View and beautify JSON

Click **JSON** at the top (or press `Ctrl+J`) to switch to the JSON viewer. Each
file opens in a tab with two panes: the structure on the left, the raw text on
the right.

- **Add a file** with **+**, then paste your JSON and press **Beautify**
  (`Ctrl+Shift+F`). **Minify** and **Sort keys** are next to it.
- **Click anything on the left** to highlight all of it on the right. Move the
  cursor on the right and the left follows.
- **Filter** the structure by key or value, and right-click a value to copy it,
  its path (like `$.items[0].id`) or its key.
- **Broken JSON?** The status bar says what's wrong and where. Click it to jump
  there.
- **Open .json files** from the folder icon in the sidebar, or drop them on the
  viewer. **Save to a file** is in the toolbar.
- **From a response:** **Open in JSON Viewer**, next to every response, puts
  the body on a new page, beautified, and switches to it (`Ctrl+J` takes you
  back). JSON sent as `text/plain` or with no content type opens too. For HTML,
  images and other non-JSON bodies the button is greyed out. Clicking it again
  shows the same page instead of a copy; send again for a new page.

Numbers and text are kept exactly as written, so a long id like
`12345678901234567890` is never rounded. Files save automatically. Closing a tab
keeps the file in the sidebar list until you delete it.

## Ask AI (beta)

Click **Ask AI** in the top bar (or press `Ctrl+L`) to chat about your APIs.

- Ask *"Why did this fail?"* or *"Explain this response"*. It already sees the
  request you have open and its response.
- Ask it to build or send requests for you.
- Use the **Explain** button on a response to ask in one click.

**What you need:** [Claude Code](https://claude.com/claude-code) installed and
signed in on your computer. hitnrun uses it with your own login, so there are no
API keys to set up. Codex CLI and Gemini CLI also work, but they're experimental.

**It's safe to try.** The AI can read your requests, but it can't change or
delete them. It builds things in its own **AI** tab, and you choose what to keep.
It can't send `DELETE` requests unless you allow them in **Settings → AI
guardrails**.

**You stay in charge.** When the AI needs permission, or a send is blocked by your
guardrails, the chat asks you: **Allow once**, **Allow for this chat**, or
**Deny**. If you don't answer within 4 minutes, it's denied.

## Use it from Claude Code

You can also let Claude Code (in your terminal) work with the app:

1. Open the **AI** tab in the sidebar and click **Set up AI access**.
2. Click **Connect Claude Code**.
3. Start a **new** `claude` session in your terminal and ask, for example,
   *"Create a dummy GET request in hitnrun and send it."*

Keep hitnrun open while you do. To check it's connected, run `claude mcp list`
and look for `hitnrun`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + Enter` | Send |
| `Ctrl + N` | New request (a new file in the JSON viewer) |
| `Ctrl + D` | Duplicate request (or the JSON file) |
| `Ctrl + W` | Close tab |
| `Ctrl + Shift + V` | Paste a cURL as a new request |
| `Ctrl + Shift + C` | Copy as cURL |
| `Ctrl + L` | Open or close Ask AI |
| `Ctrl + J` | Switch between requests and the JSON viewer |
| `Ctrl + Shift + F` | Beautify (in the JSON viewer) |
| `Ctrl + Shift + S` | Screenshot into the recording (works from any app while recording) |
| `Ctrl + =` / `Ctrl + -` / `Ctrl + 0` | Zoom in / out / reset |

On a Mac, use `Cmd` instead of `Ctrl`.

## Your data

Everything is saved in one folder. Copy it to back up.

- **Windows**: `%APPDATA%\hitnrun\`
- **Mac**: `~/Library/Application Support/hitnrun/`

## For developers

To build the app, publish releases, or use its local API, see
[docs/DEVELOPING.md](docs/DEVELOPING.md).
