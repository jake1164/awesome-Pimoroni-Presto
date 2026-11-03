// A local stand-in for GitHub (raw files, API tree, repository page) used by the unit and browser tests, so image
// discovery is tested end to end without touching the network. Not used in production.

import http from 'node:http';
import zlib from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A valid PNG (browsers can render it): solid colour, or deterministic noise when `noise` is set (a larger file). */
export function makePng(width, height, [r, g, b] = [200, 60, 60], { noise = false } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  let seed = 12345;
  const raw = Buffer.concat(Array.from({ length: height }, () => {
    if (noise) for (let i = 1; i < row.length; i += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; row[i] = seed >> 16; }
    return Buffer.from(row);
  }));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `repos` maps "owner/repo" to `{ files: { 'README.md': string | Buffer, 'images/a.png': Buffer }, social?: url }`.
 * Options: `rateLimitApi` answers API calls like an exhausted GitHub limit.
 */
export async function startFixtureServer(repos, { port = 0, rateLimitApi = false } = {}) {
  const hidden = new Set();
  const requests = [];
  const authHeaders = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push(url.pathname);
    if (req.headers.authorization) authHeaders.push(`${url.pathname.split('/')[1]}:${req.headers.authorization}`);
    const parts = url.pathname.split('/');
    const kind = parts[1];
    // /raw|web/<owner>/<repo>/...  and  /api/repos/<owner>/<repo>/...
    const [owner, repoName, ...rest] = kind === 'api' ? parts.slice(3) : parts.slice(2);
    const repo = repos[`${owner}/${repoName}`];
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', ...headers });
      res.end(body);
    };
    if (!repo) return send(404, 'text/plain', 'not found');
    if (kind === 'raw') {
      const file = decodeURIComponent(rest.slice(1).join('/')); // first segment is the branch
      const content = repo.files[file];
      if (content === undefined || hidden.has(file)) return send(404, 'text/plain', 'not found');
      const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.md') ? 'text/plain' : 'application/octet-stream';
      return send(200, repo.contentTypes?.[file] ?? type, content);
    }
    if (kind === 'api' && rest[0] === 'contents') {
      // GET /api/repos/<owner>/<repo>/contents/<dir>: one directory, not recursive.
      if (rateLimitApi) return send(403, 'application/json', '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0' });
      const folder = decodeURIComponent(rest.slice(1).join('/')).replace(/\/$/, '');
      if (repo.files[folder] !== undefined) return send(200, 'application/json', JSON.stringify({ type: 'file', path: folder }), { 'x-ratelimit-remaining': '50' });
      const entries = Object.entries(repo.files)
        .filter(([file]) => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'))
        .map(([file, content]) => ({ name: file.split('/').pop(), path: file, type: 'file', size: content.length }));
      if (entries.length === 0) return send(404, 'application/json', '{"message":"Not Found"}', { 'x-ratelimit-remaining': '50' });
      return send(200, 'application/json', JSON.stringify(entries), { 'x-ratelimit-remaining': '50' });
    }
    if (kind === 'api') {
      if (rateLimitApi) return send(403, 'application/json', '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0' });
      const tree = Object.entries(repo.files).map(([path, content]) => ({ path, type: 'blob', size: content.length }));
      return send(200, 'application/json', JSON.stringify({ tree }), { 'x-ratelimit-remaining': '50' });
    }
    if (kind === 'web') {
      const meta = repo.social ? `<meta property="og:image" content="${repo.social}">` : '';
      return send(200, 'text/html', `<!doctype html><html><head>${meta}</head><body></body></html>`);
    }
    return send(404, 'text/plain', 'not found');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    // "localhost" and "127.0.0.1" are different origins on the same server, so the API origin can be told apart.
    endpoints: { githubRaw: `${origin}/raw`, githubApi: `${origin.replace('127.0.0.1', 'localhost')}/api`, githubWeb: `${origin}/web` },
    requests,
    authHeaders,
    /** Makes a repository file answer 404 from now on (an upstream image that disappears). */
    hide: (file) => hidden.add(file),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
