import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('_site');
const prefix = (process.env.HTTP_BASE_PATH || '').replace(/\/+$/, '');
const port = Number(process.env.HTTP_PORT || 4173);
if (prefix && !/^\/[a-zA-Z0-9_/-]+$/.test(prefix)) throw new Error('Invalid preview base path');
const types = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.ipynb':'application/json','.css':'text/css','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.woff':'font/woff','.woff2':'font/woff2','.zip':'application/zip','.whl':'application/zip','.txt':'text/plain','.md':'text/plain'};
http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (prefix && !url.pathname.startsWith(prefix + '/')) { res.writeHead(404).end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(prefix.length));
    let file = path.resolve(root, '.' + relative);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await fs.readFile(file);
    const headers = {'Content-Type':types[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-store'};
    // Match the supported Pages deployment: Service Worker + Comlink.
    // The pinned kernel's COI/Atomics transport has a synchronous-wait race.
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404, {'Content-Type':'text/plain'}).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Local course site listening on ${port}${prefix || '/'}`));
