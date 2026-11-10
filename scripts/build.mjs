import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
// The server uses a deliberately small subset of ESM (named local imports and
// declarations). Bundle those modules into closures without third-party tooling.
const modules = new Map();
const chunks = [];
function bundle(filename) {
  filename = resolve(filename);
  if (modules.has(filename)) return modules.get(filename);
  const namespace = `module${modules.size}`;
  modules.set(filename, namespace);
  let source = readFileSync(filename, 'utf8');
  source = source.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g, (_, names, relative) => {
    if (!relative.startsWith('.')) throw new Error(`External server dependency: ${relative}`);
    const dependency = bundle(resolve(dirname(filename), relative));
    return `const { ${names.replace(/\bas\b/g, ':')} } = ${dependency};`;
  });
  const exports = [];
  source = source.replace(/\bexport\s+(?=(?:async\s+)?function\s|const\s|let\s|class\s)/g, (match, offset, full) => {
    const name = /^(?:async\s+)?(?:function|const|let|class)\s+([\w$]+)/.exec(full.slice(offset + match.length))?.[1];
    if (!name) throw new Error(`Unsupported export in ${filename}`);
    exports.push(name);
    return '';
  });
  source = source.replace(/export\s*\{([^}]+)\};?/g, (_, names) => { exports.push(...names.split(',').map(x => x.trim()).filter(Boolean)); return ''; });
  if (/^\s*(import|export)\s/m.test(source)) throw new Error(`Unsupported ESM syntax in ${filename}`);
  chunks.push(`const ${namespace} = (() => {\n${source}\nreturn { ${exports.join(', ')} };\n})();`);
  return namespace;
}
const appModule = bundle('src/app.mjs');
const assets = {};
for (const [url, file, type] of [
  ['/', 'public/index.html', 'text/html'], ['/index.html', 'public/index.html', 'text/html'],
  ['/app.js', 'public/app.js', 'text/javascript'], ['/styles.css', 'public/styles.css', 'text/css'],
  ['/samples/leads.json', 'data/leads.json', 'application/json'], ['/samples/bookings.json', 'data/bookings.json', 'application/json']
]) assets[url] = { body: readFileSync(file, 'utf8'), type: `${type}; charset=utf-8` };
const seed = { leads: JSON.parse(readFileSync('data/leads.json', 'utf8')), bookings: JSON.parse(readFileSync('data/bookings.json', 'utf8')) };
const entry = `${chunks.join('\n\n')}\nconst assets = ${JSON.stringify(assets)};\nconst seed = ${JSON.stringify(seed)};
let app;
export default {
  async fetch(request, env) {
    if (!env.DB) return new Response('Database binding is not configured.', { status: 503 });
    app ??= ${appModule}.createApp({ db: env.DB, seed, assets: async request => {
      const asset = assets[new URL(request.url).pathname];
      if (!asset) return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : asset.body, { headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' } });
    } });
    return app(request);
  }
};\n`;
mkdirSync('dist/server', { recursive: true });
mkdirSync('dist/.openai', { recursive: true });
writeFileSync('dist/server/index.js', entry);
writeFileSync('dist/.openai/hosting.json', readFileSync('.openai/hosting.json', 'utf8').replace(/^\uFEFF/, ''));
console.log(`Built Worker: ${Buffer.byteLength(entry).toLocaleString()} bytes, no runtime dependencies.`);
