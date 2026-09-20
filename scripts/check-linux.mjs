// Opt-in Linux validation. Requires an already-running local Docker engine.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cleanInstall = process.argv.includes('--clean-install');
if (process.argv.slice(2).some((argument) => argument !== '--clean-install')) {
  throw new Error('Usage: bun run check:linux [--clean-install]');
}
const image = 'node:26.8.2-bookworm';
const probe = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 10000 });
if (probe.status !== 0 || probe.stdout.trim() !== 'linux') {
  throw new Error('Start a local Linux Docker engine before running check:linux. No engine is started automatically.');
}
const endpoint = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', timeout: 10000 });
if (endpoint.status !== 0 || !endpoint.stdout.trim().startsWith('unix://') || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) {
  throw new Error('check:linux requires the current local Unix-socket Docker context with no environment overrides.');
}

const snapshot = await mkdtemp(join(tmpdir(), 'pi-linux-check-'));
const container = `pi-extensions-check-${process.pid}-${Date.now()}`;
let child;
let interrupted = false;
const interrupt = () => { interrupted = true; child?.kill('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
const command = [
  'mkdir /work', 'cp -R /source/. /work/', 'cd /work',
  'npm install --global bun@1.3.14 --no-audit --no-fund',
  'bun install --frozen-lockfile',
  'npm rebuild node-pty --foreground-scripts',
  'node scripts/prepare-pty.mjs',
  'bun run check', cleanInstall ? 'bun run check:install' : 'bun run check:package',
].join(' && ');
try {
  const roots = (await readdir(repo)).filter((name) =>
    ['extensions', 'lib', 'scripts', 'docs', 'themes', 'package.json', 'bun.lock', 'tsconfig.json', 'README.md', 'LICENSE', '.npmignore'].includes(name)
    || name.endsWith('.test.ts') || name.endsWith('-fixture.ts'));
  for (const name of roots) await cp(join(repo, name), join(snapshot, name), {
    recursive: true,
    filter: (source) => !['node_modules', '.git', '.agents', '.codex', '.DS_Store'].includes(basename(source))
      && !basename(source).startsWith('.env') && !source.endsWith('.log'),
  });
  if (interrupted) throw new Error('Linux validation cancelled before launch');
  console.log(`Running Linux validation in ${image}; source snapshot is read-only.`);
  child = spawn('docker', ['run', '--rm', '--name', container,
    '--mount', `type=bind,source=${snapshot},target=/source,readonly`,
    image, 'bash', '-lc', command], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`Linux validation exited with ${code}`);
} finally {
  // Remove only this invocation's container, including if a command fails.
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore', timeout: 10000 });
  await rm(snapshot, { recursive: true, force: true });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
