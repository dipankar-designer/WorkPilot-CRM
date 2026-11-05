// Production build: bundles the API and operator scripts into dist/ (the shared package is
// inlined; npm dependencies stay external) and copies the SQL migrations next to them.
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => d !== '@workpilot/shared');

fs.rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts', 'src/db/migrate.ts', 'src/scripts/grantPlatformAdmin.ts'],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
fs.cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
fs.cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('server build complete');
