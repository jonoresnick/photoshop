// Inlines the Vite build into one HTML file (no external assets), for hosting as a single page.
// Usage: npm run build && node scripts/build-artifact.mjs [out.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
let html = readFileSync(resolve(dist, 'index.html'), 'utf8');

html = html.replace(/<link rel="stylesheet"[^>]*href="\.?\/?([^"]+)"[^>]*>/g, (_, href) =>
  `<style>\n${readFileSync(resolve(dist, href), 'utf8')}\n</style>`);
html = html.replace(/<script type="module"[^>]*src="\.?\/?([^"]+)"[^>]*><\/script>/g, (_, src) => {
  const js = readFileSync(resolve(dist, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">\n${js}\n</script>`;
});
// The host supplies its own document skeleton.
html = html
  .replace(/<!doctype html>/i, '')
  .replace(/<\/?html[^>]*>|<\/?head>|<\/?body>/gi, '')
  .replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/gi, '');
// Scripts in <head> would run before the markup exists; move them to the end.
const scripts = [];
html = html.replace(/<script type="module">[\s\S]*?<\/script>/g, m => (scripts.push(m), ''));
html = html.trim() + '\n' + scripts.join('\n') + '\n';

const out = resolve(process.argv[2] ?? 'dist/mini-photoshop.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
