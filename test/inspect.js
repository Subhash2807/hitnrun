'use strict';

/**
 * Layout probe. Attaches to the running app over the Chrome DevTools Protocol
 * and evaluates JS inside the window, so we can measure real scroll geometry
 * instead of guessing at CSS.
 *
 * Usage: start the app with --remote-debugging-port=9222, then
 *        node test/inspect.js "<expression>"
 */

const DEBUG_PORT = process.env.DEBUG_PORT || 9222;

async function targets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return res.json();
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP evaluate timed out'));
    }, 15000);

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result?.exceptionDetails) {
        return reject(new Error(msg.result.exceptionDetails.exception?.description || 'evaluation threw'));
      }
      resolve(msg.result?.result?.value);
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(new Error('CDP socket error: ' + (err.message || 'unknown')));
    });
  });
}

(async () => {
  const expression = process.argv[2];
  if (!expression) {
    console.error('usage: node test/inspect.js "<js expression>"');
    process.exit(1);
  }

  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) {
    console.error('No page target found. Is the app running with --remote-debugging-port?');
    process.exit(1);
  }

  const value = await evaluate(page.webSocketDebuggerUrl, expression);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
