'use strict';

/**
 * Sample cURL commands, exercised through the running app's /send endpoint.
 * Run with the app open: node test/samples.js
 */

const PORT = process.env.CONTROL_PORT || 47600;

const SAMPLES = [
  ['simple GET', `curl https://httpbin.org/get`],

  ['GET with query params', `curl 'https://httpbin.org/get?search=hello world&page=2&sort=desc'`],

  ['POST JSON + headers + bearer', `curl -X POST 'https://httpbin.org/post' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Request-Id: abc-123' \\
  -H 'Authorization: Bearer tok_live_9f8e7d6c' \\
  -d '{"name":"Jane Doe","email":"jane@example.com","active":true,"tags":["a","b"]}'`],

  ['PUT', `curl -X PUT https://jsonplaceholder.typicode.com/posts/1 \\
  -H 'Content-Type: application/json' \\
  -d '{"id":1,"title":"updated","body":"new body","userId":1}'`],

  ['DELETE', `curl -X DELETE https://jsonplaceholder.typicode.com/posts/1`],

  ['PATCH', `curl -X PATCH https://httpbin.org/patch -H 'Content-Type: application/json' -d '{"status":"archived"}'`],

  ['basic auth (-u)', `curl -u admin:hunter2 https://httpbin.org/basic-auth/admin/hunter2`],

  ['urlencoded form', `curl -X POST https://httpbin.org/post \\
  -H 'Content-Type: application/x-www-form-urlencoded' \\
  -d 'username=jane&password=s3cret&remember=1'`],

  ['multipart form-data', `curl -X POST https://httpbin.org/post \\
  -F 'title=My upload' \\
  -F 'category=docs'`],

  ['-G moves data to query', `curl -G https://httpbin.org/get -d 'q=cats' -d 'limit=5'`],

  ['redirect following', `curl -L 'https://httpbin.org/redirect/2'`],

  ['gzip response', `curl --compressed https://httpbin.org/gzip`],

  ['404 status', `curl https://httpbin.org/status/404`],

  ['slow response (2s)', `curl https://httpbin.org/delay/2`],

  ['sets cookies', `curl 'https://httpbin.org/cookies/set?session=abc123&theme=dark'`],

  ['GraphQL', `curl -X POST https://countries.trevorblades.com/graphql \\
  -H 'Content-Type: application/json' \\
  -d '{"query":"query { country(code: \\"IN\\") { name capital currency } }"}'`],

  ['Windows ^ continuation', `curl "https://httpbin.org/post" ^
  -H "Content-Type: application/json" ^
  -d "{\\"from\\":\\"windows\\"}"`],

  ['large JSON (scroll test)', `curl https://jsonplaceholder.typicode.com/photos`],
];

function post(path, body) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  let ok = 0;
  let bad = 0;

  for (const [label, curl] of SAMPLES) {
    try {
      const res = await post('/send', { curl });
      if (res && res.status) {
        const size = res.size?.decoded ?? 0;
        console.log(`  ${String(res.status).padEnd(3)} ${String(res.timeMs + 'ms').padStart(7)} ${String(size + 'B').padStart(9)}  ${label}`);
        ok++;
      } else {
        console.log(`  ERR              ${label} -> ${res?.error?.message || 'no response'}`);
        bad++;
      }
    } catch (err) {
      console.log(`  ERR              ${label} -> ${err.message}`);
      bad++;
    }
  }

  console.log(`\n${ok} reached the server, ${bad} failed`);
})();
