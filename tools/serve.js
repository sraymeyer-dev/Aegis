#!/usr/bin/env node
/**
 * serve.js — a static file server, so the game can be played locally without
 * a bundler. Browsers block module and fetch requests from file:// URLs.
 *
 * Deliberately dependency-free: the whole stack is vanilla ES modules with no
 * build step, and adding a server dependency to run it would undercut that.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 8173);
const ROOT = process.cwd();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let path = normalize(join(ROOT, url === '/' ? 'index.html' : url));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`AEGIS: Horizon Command — http://localhost:${PORT}`);
});
