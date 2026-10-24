import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname !== '/' && !/^\/(index\.html|styles\.css|app\.js|icon\.svg|icon-(192|512)\.png|manifest\.webmanifest|sw\.js|src\/(model|cloud)\.js)$/.test(pathname)) {
      res.writeHead(404).end('Not found'); return;
    }
    const file = path.join(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    let body = await readFile(file);
    if (file.endsWith('index.html')) body = Buffer.from(body.toString().replace('</head>', '<meta name="classroom-hosted" content="true">\n</head>'));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 3000)}/`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.text()).includes('<title>Класс — журнал учеников</title>')) {
        console.log(`Класс уже запущен на порту ${process.env.PORT || 3000}. Используйте работающий экземпляр.`);
        return;
      }
    } catch { /* Report a port occupied by another application below. */ }
    console.error(`Порт ${process.env.PORT || 3000} занят. Выберите другой: PORT=3001 npm start`);
  } else console.error(`Не удалось запустить сервер: ${error.message}`);
  process.exitCode = 1;
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Classroom running on port ${server.address().port}`));
