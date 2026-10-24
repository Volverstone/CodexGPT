import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zipFiles } from './zip.js';
import { validateCloudConfig } from '../src/cloud.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(path.join(root, file), 'utf8');
const [template, styles, model, cloud, app, icon] = await Promise.all([
  'src/index.template.html', 'styles.css', 'src/model.js', 'src/cloud.js', 'app.js', 'icon.svg',
].map(read));
// A classic inline script also works in file:// and srcdoc previews, without module fetches.
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
if (!!url !== !!key) throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in the build environment.');
const config = url && key ? validateCloudConfig({ url, key }) : {};
const inline = source => source.replace(/^import .* from .*;\s*/gm, '').replace(/^export /gm, '');
const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
const script = `(() => {\n'use strict';\nglobalThis.CLASSROOM_CONFIG = ${configJson};\n${inline(model)}\n${inline(cloud)}\n${inline(app)}\n})();`;
const portable = template
  .replace('<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest">', `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}" type="image/svg+xml">`)
  .replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${styles}</style>`)
  .replace('<script type="module" src="/app.js"></script>', () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`);
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'index.html'), portable);
// Hosts can serve this directory directly, including from a subdirectory.
await writeFile(path.join(root, 'dist/index.html'), portable.replace('</head>', '<meta name="classroom-hosted" content="true">\n</head>'));
await Promise.all(['icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest', 'sw.js'].map(file => copyFile(path.join(root, file), path.join(root, 'dist', file))));
const files = await Promise.all(['index.html', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest', 'sw.js'].map(async name => ({ name, data: await readFile(path.join(root, 'dist', name)) })));
const archive = zipFiles(files);
await Promise.all(['classroom-netlify.zip', 'classroom-site.zip'].map(name => writeFile(path.join(root, name), archive)));
console.log('Built standalone index.html, dist/, and Netlify-ready ZIP archives with index.html at the archive root.');
