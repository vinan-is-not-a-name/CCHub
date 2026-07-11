import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const isWatch = process.argv.includes('--watch');

const outdir = resolve(root, 'dist/client');
mkdirSync(outdir, { recursive: true });
copyFileSync(resolve(root, 'src/client/index.html'), resolve(outdir, 'index.html'));
copyFileSync(resolve(root, 'src/client/style.css'), resolve(outdir, 'style.css'));
// Test-only rendering harness page (inert without ?e2e=1). Shipped alongside
// the app so the render test suite can drive the real container via the server.
copyFileSync(resolve(root, 'src/client/harness.html'), resolve(outdir, 'harness.html'));

const opts = {
  entryPoints: [resolve(root, 'src/client/main.ts'), resolve(root, 'src/client/harness.ts')],
  bundle: true,
  outdir,
  format: 'esm',
  minify: !isWatch,
  sourcemap: isWatch,
};

if (isWatch) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log('esbuild watching client...');
} else {
  await build(opts);
  console.log('client built.');
}
