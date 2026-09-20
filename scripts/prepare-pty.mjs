// node-pty 1.1.0 ships its macOS prebuilt helper without an executable bit.
// Fix only that package-owned helper during installation, never at job launch.
import { createRequire } from 'node:module';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const helper = join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o100);
}
