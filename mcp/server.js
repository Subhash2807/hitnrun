#!/usr/bin/env node
'use strict';

/**
 * MCP server for API Client.
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
 *   API_CLIENT_PORT   control server port  (default 47600)
 *   API_CLIENT_TOKEN  control token, if set in the app's Settings
 *   API_CLIENT_LABEL  a name for this session, shown in the app
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const PORT = process.env.API_CLIENT_PORT || 47600;
const TOKEN = process.env.API_CLIENT_TOKEN || '';
const LABEL = process.env.API_CLIENT_LABEL || '';
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
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Could not reach API Client at ${BASE}. Ask the user to start the app, and check ` +
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
        'API Client rejected the call (401). A control token is set in the app; put the same value ' +
          'in this server\'s API_CLIENT_TOKEN environment variable.'
      );
    }
    // A blocked send is a policy decision, not a failure — surface it plainly.
    if (res.status === 403 && parsed?.blocked) {
      throw new Error(
        `Blocked by the user's AI guardrails: ${parsed.reason}\n` +
          `This is deliberate. Do not try to work around it — tell the user what you wanted to do and let them decide.`
      );
    }
    throw new Error(`API Client returned ${res.status}: ${parsed?.error || text || res.statusText}`);
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

const server = new McpServer({ name: 'api-client', version: '1.2.0' });

/* ================================================================ status */

server.registerTool(
  'app_status',
  {
    title: 'Check the app and your sandbox',
    description:
      'Verify API Client is running, start your AI session workspace, and report the guardrails in effect. Call this first — it tells you what you are and are not allowed to do.',
    inputSchema: {},
  },
  guard(async () => {
    const health = await callApp('GET', '/health');
    const mine = await ensureSession();
    const policy = await callApp('GET', '/ai/policy');
    return {
      app: { ...health, reachableAt: BASE },
      yourSession: { sessionId: mine.sessionId, mode: mine.mode },
      guardrails: policy,
      sandbox:
        'You work in your own AI workspace. You can read the user\'s requests and copy them, ' +
        'but you cannot modify or delete anything the user owns. The user promotes your work themselves.',
    };
  })
);

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
  guard(async ({ source_id }) => {
    const mine = await ensureSession();
    return callApp('POST', '/ai/copy', { sessionId: mine.sessionId, sourceId: source_id });
  })
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
  guard(async (args) => {
    const mine = await ensureSession();
    return callApp('POST', '/ai/requests', { sessionId: mine.sessionId, ...toApi(args) });
  })
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
  guard(async ({ name, folder_id }) => {
    const mine = await ensureSession();
    return callApp('POST', '/ai/folders', { sessionId: mine.sessionId, name, folderId: folder_id });
  })
);

/* ============================================================= execution */

server.registerTool(
  'send_request',
  {
    title: 'Send a request from your workspace',
    description:
      'Run a request from your AI workspace and return status, timing, headers and the decoded body. Subject to the user\'s guardrails: blocked hosts and methods are refused, including across redirects.',
    inputSchema: { request_id: z.string() },
  },
  guard(({ request_id }) => callApp('POST', `/ai/requests/${request_id}/send`))
);

server.registerTool(
  'send_adhoc',
  {
    title: 'Send a one-off request',
    description:
      'Run a cURL command once without saving it. Same guardrails apply. Use this for a quick check rather than cluttering the workspace.',
    inputSchema: { curl: z.string() },
  },
  guard(({ curl }) => callApp('POST', '/ai/send', { curl }))
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
    title: 'Show a request to the user',
    description:
      'Open a request in the app window and bring it to the front, so the user can look at what you built. Use this when you want them to review something.',
    inputSchema: { request_id: z.string() },
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
  console.error(`[api-client-mcp] ready, talking to ${BASE}`);
}

main().catch((err) => {
  console.error('[api-client-mcp] fatal:', err);
  process.exit(1);
});
