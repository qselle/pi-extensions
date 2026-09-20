// Verify the distributable with installed development dependencies, without publishing.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'pi-package-check-'));
const cleanInstall = process.argv.includes('--clean-install');
function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 4_000_000, ...extra });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary, '--cache', join(temporary, 'cache')]));
  const files = new Set(packed.files.map((file) => file.path));
  for (const file of files) {
    assert(!/(?:\.test\.|fixture|benchmark)/.test(file), `Development-only file packaged: ${file}`);
    assert(!/(?:^|\/)(?:node_modules|\.git|\.agents|\.codex|\.env)(?:\/|\.|$)/.test(file), `Local state packaged: ${file}`);
  }
  for (const entry of await readdir(join(repo, 'extensions'), { withFileTypes: true })) if (entry.isDirectory()) {
    assert(files.has(`extensions/${entry.name}/index.ts`), `Missing entry point: ${entry.name}`);
    assert(files.has(`extensions/${entry.name}/README.md`), `Missing documentation: ${entry.name}`);
  }
  for (const file of ['lib/tool-ui.ts', 'lib/transcript/view.ts', 'lib/deferred-tools.ts', 'package.json', 'scripts/prepare-pty.mjs', 'README.md', 'LICENSE']) assert(files.has(file), `Missing ${file}`);
  run('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
  let packageRoot = join(temporary, 'package');
  let fixtureRoot = repo;
  if (cleanInstall) {
    const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
    fixtureRoot = join(temporary, 'consumer');
    await mkdir(fixtureRoot);
    const hostDependencies = Object.fromEntries(Object.keys(manifest.peerDependencies).map((name) => [name, manifest.devDependencies[name]]));
    await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
      ...hostDependencies, [manifest.name]: `file:${join(temporary, packed.filename)}`,
    } }));
    console.log('Installing artifact and pinned host APIs in an isolated consumer directory…');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(temporary, 'cache')], { cwd: fixtureRoot, timeout: 240_000 });
    packageRoot = join(fixtureRoot, 'node_modules', manifest.name);
    await copyFile(join(repo, 'package.integration-fixture.ts'), join(fixtureRoot, 'package.integration-fixture.ts'));
    console.log('Preparing the isolated native terminal dependency…');
    run('npm', ['rebuild', 'node-pty', '--foreground-scripts', '--cache', join(temporary, 'cache')], { cwd: fixtureRoot, timeout: 120_000 });
    run('node', [join(packageRoot, 'scripts/prepare-pty.mjs')], { cwd: fixtureRoot });
    const ptyOutput = run('node', ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const require = createRequire(process.env.PI_TEST_PACKAGE_ROOT + '/package.json');
      const { spawn } = require('node-pty');
      const terminal = spawn(process.execPath, ['-e', "process.stdout.write('clean-pty-ok')"], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
      });
      let output = '';
      const timer = setTimeout(() => { terminal.kill(); process.exit(1); }, 5000);
      terminal.onData((data) => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode !== 0 || !output.includes('clean-pty-ok')) process.exit(1);
        console.log('Fresh native PTY executed and exited successfully');
      });
    `], { cwd: fixtureRoot, env: { ...process.env, PI_TEST_PACKAGE_ROOT: packageRoot } });
    process.stdout.write(ptyOutput);
  } else {
    await symlink(join(repo, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  }
  for (const flags of [[], ['--reverse']]) {
    process.stdout.write(run('bun', ['package.integration-fixture.ts', ...flags], { cwd: fixtureRoot, env: { ...process.env, PI_TEST_PACKAGE_ROOT: packageRoot } }));
  }
  console.log(`Package verified: ${files.size} files, ${packed.unpackedSize} unpacked bytes. ${cleanInstall ? 'Fresh consumer dependencies; temporary install removed on exit.' : 'Reused local dependencies.'} No publication.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
