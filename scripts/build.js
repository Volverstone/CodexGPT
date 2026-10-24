import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8');
const [template, styles, model, app, icon] = await Promise.all([
  'src/index.template.html', 'styles.css', 'src/model.js', 'app.js', 'icon.svg',
].map(read));
// A classic inline script also works in file:// and srcdoc previews, without module fetches.
const script = `(() => {\n'use strict';\n${model.replace(/^export /gm, '')}\n${app.replace(/^import .* from .*;\s*/m, '')}\n})();`;
const portable = template
  .replace('<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">', `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}" type="image/svg+xml">`)
  .replace('<link rel="stylesheet" href="/styles.css">', `<style>${styles}</style>`)
  .replace('<script type="module" src="/app.js"></script>', `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`);
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'index.html'), portable);
// Hosts can serve this directory directly, including from a subdirectory.
await writeFile(path.join(root, 'dist/index.html'), portable.replace('</head>', '<meta name="classroom-hosted" content="true">\n</head>'));
await Promise.all(['icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest', 'sw.js'].map(file => copyFile(path.join(root, file), path.join(root, 'dist', file))));
console.log('Built standalone index.html and static hosting files in dist/. No external dependencies.');
