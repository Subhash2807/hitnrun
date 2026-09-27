#!/usr/bin/env node
'use strict';

/**
 * MCP server for hitnrun.
 *
 * Lets an AI assistant (Claude Code, Claude Desktop, any MCP client) operate the
 * app. It speaks MCP over stdio and forwards each call to the app's loopback
 * control server. It holds no state — the running app is the source of truth.
 *
 * SANDBOX: this process works inside an AI session workspace, which is a
 * separate file from the user's requests. It can READ the user's workspace and
 * COPY things out of it, but it cannot modify or delete anything the user owns.
 * Promoting AI work into the user's workspace is done by the user, in the app.
 *
 * Config:
 *   HITNRUN_PORT   control server port  (default 47600)
 *   HITNRUN_TOKEN  control token, if set in the app's Settings
 *   HITNRUN_LABEL  a name for this session, shown in the app
 *   HITNRUN_CHAT   set by the in-app chat: the chat that started this server,
 *                  so the app can ask the user in that chat when approval is needed
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const PORT = process.env.HITNRUN_PORT || 47600;
const TOKEN = process.env.HITNRUN_TOKEN || '';
const LABEL = process.env.HITNRUN_LABEL || '';
const CHAT = process.env.HITNRUN_CHAT || '';
const BASE = `http://127.0.0.1:${PORT}`;

/** Session handle, established lazily on first use. */
let session = null;

async function callApp(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(CHAT ? { 'X-Hitnrun-Chat': CHAT } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Could not reach hitnrun at ${BASE}. Ask the user to start the app, and check ` +
        `Settings → Agent control server is enabled on port ${PORT}. (${err.message})`
    );
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the raw text */
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        'hitnrun rejected the call (401). A control token is set in the app; put the same value ' +
          'in this server\'s HITNRUN_TOKEN environment variable.'
      );
    }
    // A blocked send is a policy decision, not a failure — surface it plainly.
    if (res.status === 403 && parsed?.blocked) {
      throw new Error(
        `Blocked by the user's AI guardrails: ${parsed.reason}\n` +
          `This is deliberate. Do not try to work around it — tell the user what you wanted to do and let them decide.`
      );
    }
    throw new Error(`hitnrun returned ${res.status}: ${parsed?.error || text || res.statusText}`);
  }
  return parsed;
}

/** Ensure we have a session (and therefore a private workspace) before writing. */
async function ensureSession() {
  if (session) {
    return session;
  }
  session = await callApp('POST', '/ai/sessions', { client: 'mcp', label: LABEL });
  return session;
}

/**
 * Run a call that needs the session. The user can discard a session from the
 * app while this server is still connected; start a fresh one and retry once.
 */
async function withSession(fn) {
  try {
    return await fn(await ensureSession());
  } catch (err) {
    if (!/Unknown AI session/.test(err.message)) throw err;
    session = null;
    return fn(await ensureSession());
  }
}

/** Drop the cached session if the user has discarded it in the app. */
async function checkSession() {
  if (!session) return;
  const sessions = await callApp('GET', '/ai/sessions');
  if (!sessions.some((s) => s.id === session.sessionId)) session = null;
}

const ok = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

const guard = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err.message || String(err));
  }
};

const RECORD_HINT =
  'Add this send to the test doc being recorded, even in manual mode. In auto mode every send is recorded anyway.';

const server = new McpServer({ name: 'hitnrun', version: '1.7.0' });

/* ================================================================ status */

server.registerTool(
  'app_status',
  {
    title: 'Check the app and your sandbox',
    description:
      'Verify hitnrun is running, start your AI session workspace, and report the guardrails in effect. Call this first — it tells you what you are and are not allowed to do.',
    inputSchema: {},
  },
  guard(async () => {
    const health = await callApp('GET', '/health');
    await checkSession();
    const mine = await ensureSession();
    const policy = await callApp('GET', '/ai/policy');
    return {
      app: { ...health, reachableAt: BASE },
      yourSession: { sessionId: mine.sessionId, mode: mine.mode },
      guardrails: policy,
      sandbox:
        'You work in your own AI workspace. You can read the user\'s requests and copy them, ' +
        'but you cannot modify or delete anything the user owns. The user promotes your work themselves. ' +
        'Test docs are the exception: you may read and edit them (titles, notes, pass/fail, order) and drive the recording.',
    };
  })
);

/* ============================================================== approval */

// Only for the in-app chat: Claude Code is started with
// --permission-prompt-tool pointing here, so a tool that needs permission is
// asked about in the chat instead of being refused outright.
if (CHAT) {
  server.registerTool(
    'approve',
    {
      title: 'Ask the user for permission',
      description: 'Used by the CLI to ask the user in the hitnrun chat before running a tool. Do not call it yourself.',
      inputSchema: { tool_name: z.string(), input: z.any().optional(), tool_use_id: z.string().optional() },
    },
    async ({ tool_name, input }) => {
      let allowed = false;
      try {
        ({ allowed } = await callApp('POST', '/ai/approval', { tool: tool_name, input }));
      } catch {
        /* unreachable app: deny */
      }
      const verdict = allowed
        ? { behavior: 'allow', updatedInput: input ?? {} }
        : { behavior: 'deny', message: 'The user did not allow this.' };
      return { content: [{ type: 'text', text: JSON.stringify(verdict) }] };
    }
  );
}

/* ======================================================= reading the user */

server.registerTool(
  'list_user_requests',
  {
    title: "List the user's saved requests",
    description:
      "Read-only listing of the user's own requests, with ids, names, methods, URLs and collections. Use this to find something worth copying into your workspace. You cannot edit these.",
    inputSchema: {},
  },
  guard(() => callApp('GET', '/requests'))
);

server.registerTool(
  'get_user_request',
  {
    title: "Read one of the user's requests",
    description:
      "Read-only view of a single user request, including headers, auth and body. To change anything, copy it into your workspace first with copy_into_my_workspace.",
    inputSchema: {
      request_id: z.string(),
      as_curl: z.boolean().optional().describe('Also return it as a cURL command'),
    },
  },
  guard(({ request_id, as_curl }) => callApp('GET', `/requests/${request_id}${as_curl ? '?curl=1' : ''}`))
);

server.registerTool(
  'list_user_collections',
  {
    title: "List the user's collections",
    description: "Read-only listing of the user's collections and folders, with ids you can pass to copy_into_my_workspace.",
    inputSchema: {},
  },
  guard(() => callApp('GET', '/collections'))
);

server.registerTool(
  'copy_into_my_workspace',
  {
    title: "Copy something from the user's workspace",
    description:
      "Clone a user request, folder or collection into your own AI workspace so you can work on it safely. The user's original is never touched. This is the ONLY way to modify something the user built.",
    inputSchema: {
      source_id: z.string().describe("A request, folder or collection id from the user's workspace"),
    },
  },
  guard(({ source_id }) =>
    withSession((mine) => callApp('POST', '/ai/copy', { sessionId: mine.sessionId, sourceId: source_id }))
  )
);

/* ==================================================== your own workspace */

server.registerTool(
  'my_workspace',
  {
    title: 'Show your workspace',
    description: 'List everything in your AI session workspace: the folders and requests you have created or copied.',
    inputSchema: {},
  },
  guard(() => callApp('GET', '/ai/workspace'))
);

server.registerTool(
  'create_request',
  {
    title: 'Create a request in your workspace',
    description:
      'Create a request in your own AI workspace. Easiest way is to pass a cURL command — it is split into method, URL, params, headers, auth and body automatically.',
    inputSchema: {
      curl: z.string().optional().describe('A cURL command. The simplest way to create a request.'),
      name: z.string().optional(),
      folder_id: z.string().optional().describe('A folder inside your workspace'),
      method: z.string().optional().describe('Used only when curl is not given'),
      url: z.string().optional().describe('Used only when curl is not given'),
      headers: z.array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean().optional() })).optional(),
      params: z.array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean().optional() })).optional(),
      body: z.record(z.any()).optional().describe('e.g. { mode: "raw", rawType: "json", raw: "{}" }'),
    },
  },
  guard((args) =>
    withSession((mine) => callApp('POST', '/ai/requests', { sessionId: mine.sessionId, ...toApi(args) }))
  )
);

server.registerTool(
  'update_request',
  {
    title: 'Update a request in your workspace',
    description:
      'Change parts of a request in your AI workspace. Only fields you pass are touched. Passing curl replaces the whole request. Fails if the id belongs to the user — copy it first.',
    inputSchema: {
      request_id: z.string(),
      curl: z.string().optional(),
      name: z.string().optional(),
      method: z.string().optional(),
      url: z.string().optional(),
      headers: z
        .array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean().optional() }))
        .optional()
        .describe('Replaces the whole header list — include every header you want kept'),
      params: z.array(z.object({ key: z.string(), value: z.string(), enabled: z.boolean().optional() })).optional(),
      pathVars: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
      auth: z.record(z.any()).optional(),
      body: z.record(z.any()).optional(),
    },
  },
  guard(({ request_id, ...patch }) => callApp('PATCH', `/ai/requests/${request_id}`, toApi(patch)))
);

server.registerTool(
  'delete_my_request',
  {
    title: 'Delete one of your own requests',
    description:
      'Delete a request from YOUR AI workspace. This cannot touch anything the user owns — user requests are not deletable through this server at all.',
    inputSchema: { request_id: z.string() },
  },
  guard(({ request_id }) => callApp('DELETE', `/ai/requests/${request_id}`))
);

server.registerTool(
  'create_folder',
  {
    title: 'Create a folder in your workspace',
    description: 'Group your requests into a folder inside your AI session workspace.',
    inputSchema: { name: z.string(), folder_id: z.string().optional().describe('Parent folder') },
  },
  guard(({ name, folder_id }) =>
    withSession((mine) => callApp('POST', '/ai/folders', { sessionId: mine.sessionId, name, folderId: folder_id }))
  )
);

/* ============================================================= execution */

server.registerTool(
  'send_request',
  {
    title: 'Send a request from your workspace',
    description:
      'Run a request from your AI workspace and return status, timing, headers and the decoded body. Subject to the user\'s guardrails: blocked hosts and methods are refused, including across redirects.',
    inputSchema: {
      request_id: z.string(),
      record: z.boolean().optional().describe(RECORD_HINT),
    },
  },
  guard(({ request_id, record }) => callApp('POST', `/ai/requests/${request_id}/send`, record ? { record } : undefined))
);

server.registerTool(
  'send_adhoc',
  {
    title: 'Send a one-off request',
    description:
      'Run a cURL command once without saving it. Same guardrails apply. Use this for a quick check rather than cluttering the workspace.',
    inputSchema: { curl: z.string(), record: z.boolean().optional().describe(RECORD_HINT) },
  },
  guard(({ curl, record }) => callApp('POST', '/ai/send', { curl, ...(record ? { record } : {}) }))
);

/* ========================================================== test docs */

server.registerTool(
  'list_docs',
  {
    title: 'List test docs',
    description:
      "List the user's test documentation: ordered records of the requests sent while testing a feature, with notes and pass/fail per step. Also reports the recording in progress, if any.",
    inputSchema: {},
  },
  guard(() => callApp('GET', '/docs'))
);

server.registerTool(
  'get_doc',
  {
    title: 'Read a test doc',
    description:
      'Read one test doc with every step: the full URL, headers and body sent, the response, the notes, expected result and pass/fail status. Bodies are cut at 8,000 characters unless full_bodies is set. Steps with kind "shot" are screenshots the user took; you get their title, note and status but not the image.',
    inputSchema: {
      doc_id: z.string(),
      full_bodies: z.boolean().optional().describe('Return request and response bodies uncut'),
    },
  },
  guard(({ doc_id, full_bodies }) => callApp('GET', `/docs/${doc_id}${full_bodies ? '?bodies=full' : ''}`))
);

server.registerTool(
  'update_doc',
  {
    title: 'Rename a test doc or edit its summary',
    description: 'Change the name or the summary/description shown at the top of a test doc.',
    inputSchema: { doc_id: z.string(), name: z.string().optional(), description: z.string().optional() },
  },
  guard(({ doc_id, ...patch }) => callApp('PATCH', `/docs/${doc_id}`, patch))
);

server.registerTool(
  'update_doc_step',
  {
    title: 'Edit a step in a test doc',
    description:
      'Write the documentation for one step: a clear title, a note explaining what it shows, the expected result, and whether it passed. Only the fields you pass change.',
    inputSchema: {
      doc_id: z.string(),
      step_id: z.string(),
      title: z.string().optional(),
      note: z.string().optional(),
      expected: z.string().optional(),
      status: z.enum(['untested', 'pass', 'fail']).optional(),
    },
  },
  guard(({ doc_id, step_id, ...patch }) => callApp('PATCH', `/docs/${doc_id}/steps/${step_id}`, patch))
);

server.registerTool(
  'move_doc_step',
  {
    title: 'Reorder a step in a test doc',
    description: 'Move a step to a new zero-based position in its doc.',
    inputSchema: { doc_id: z.string(), step_id: z.string(), index: z.number().int().min(0) },
  },
  guard(({ doc_id, step_id, index }) => callApp('POST', `/docs/${doc_id}/steps/${step_id}/move`, { index }))
);

server.registerTool(
  'delete_doc_step',
  {
    title: 'Remove a step from a test doc',
    description:
      'Remove one step, for example a duplicate or a failed attempt the user does not want documented. Whole docs can only be deleted by the user in the app.',
    inputSchema: { doc_id: z.string(), step_id: z.string() },
  },
  guard(({ doc_id, step_id }) => callApp('DELETE', `/docs/${doc_id}/steps/${step_id}`))
);

server.registerTool(
  'start_recording',
  {
    title: 'Start recording a test doc',
    description:
      'Start documenting a test run. In auto mode every request sent (by you or the user) is added as a step; in manual mode only sends made with record: true, or added by the user. Pass doc_id to continue an existing doc. Only one recording runs at a time; starting one stops the other.',
    inputSchema: {
      name: z.string().optional().describe('e.g. "Login flow – OTP"'),
      mode: z.enum(['auto', 'manual']).optional(),
      doc_id: z.string().optional().describe('Resume recording into this doc instead of starting a new one'),
    },
  },
  guard(({ name, mode, doc_id }) => callApp('POST', '/docs/recording', { name, mode, docId: doc_id }))
);

server.registerTool(
  'stop_recording',
  {
    title: 'Stop recording',
    description: 'Stop the recording in progress. The doc is kept; the user reviews and downloads it in the app.',
    inputSchema: {},
  },
  guard(() => callApp('DELETE', '/docs/recording'))
);

/* ============================================================= variables */

server.registerTool(
  'get_variables',
  {
    title: 'Get resolved variables',
    description:
      "Show the {{variable}} values currently in effect, from the user's active environment. Requests you copy that use {{base_url}} and similar will resolve against these.",
    inputSchema: {},
  },
  guard(() => callApp('GET', '/variables'))
);

server.registerTool(
  'list_environments',
  {
    title: 'List environments',
    description: "Read-only listing of the user's environments and which one is active.",
    inputSchema: {},
  },
  guard(() => callApp('GET', '/environments'))
);

/* ================================================================ the app */

server.registerTool(
  'show_in_app',
  {
    title: 'Show a request or test doc to the user',
    description:
      'Open a request or a test doc in the app window and bring it to the front, so the user can look at what you built. Use this when you want them to review something.',
    inputSchema: { request_id: z.string().describe('A request id, or a doc id (doc_…)') },
  },
  guard(({ request_id }) => callApp('POST', '/ui/open', { requestId: request_id }))
);

server.registerTool(
  'sync_status',
  {
    title: 'Check source-cURL sync status',
    description:
      "Report which requests still match the environment's source cURL and which have stale session headers. Read-only.",
    inputSchema: {},
  },
  guard(() => callApp('GET', '/sync/status'))
);

/* --------------------------------------------------------------- helpers */

/** Map snake_case tool args onto the control API's camelCase fields. */
function toApi(args) {
  const out = {
    curl: args.curl,
    name: args.name,
    method: args.method,
    url: args.url,
    headers: args.headers,
    params: args.params,
    pathVars: args.pathVars,
    auth: args.auth,
    body: args.body,
    folderId: args.folder_id,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol — human-readable output must go to stderr.
  console.error(`[hitnrun-mcp] ready, talking to ${BASE}`);
}

main().catch((err) => {
  console.error('[hitnrun-mcp] fatal:', err);
  process.exit(1);
});
