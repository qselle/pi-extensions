import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import pty from 'node-pty';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const { Terminal } = headless;
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'pi-ui-runtime-'));
const output = await mkdtemp(join(tmpdir(), 'pi-ui-preview-'));
const term = new Terminal({ cols: 100, rows: 34, allowProposedApi: true, scrollback: 1000 });
const child = pty.spawn(process.execPath, [join(repo, 'scripts/ui-preview-fixture.ts')], {
  cwd: root, cols: 100, rows: 34, name: 'xterm-256color', env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PI_UI_PREVIEW_ROOT: root },
});
let exited = false, raw = '';
child.onExit(() => { exited = true; });
child.onData((data) => { raw += data; term.write(data); });
term.onData((data) => { if (!exited) child.write(data); });
const frames = [];
function screenText() {
  const buffer = term.buffer.active;
  return Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '').join('\n');
}
async function input(command, expected) {
  child.write(command + '\r');
  const until = Date.now() + 5000;
  while (!screenText().includes(expected)) {
    if (exited || Date.now() >= until) throw new Error('UI did not display: ' + expected);
    await delay(25);
  }
}
async function phase(name) {
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    const failure = await readFile(join(root, 'failure'), 'utf8').catch(() => '');
    if (failure) throw new Error(failure);
    const current = await readFile(join(root, 'phase'), 'utf8').catch(() => '');
    if (current === name) return;
    if (exited) throw new Error('Fixture exited before ' + name + ': ' + raw.slice(-6000));
    await delay(50);
  }
  throw new Error('Timeout waiting for ' + name + ': ' + raw.slice(-6000));
}
async function snapshot(name, cols, rows) {
  term.resize(cols, rows); child.resize(cols, rows); await delay(350);
  await new Promise((resolve) => term.write('', resolve));
  const cells = [], lines = [];
  const buffer = term.buffer.active;
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    lines.push(line?.translateToString(true) ?? '');
    const row = [];
    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      row.push({ text: cell.getChars() || ' ', width: cell.getWidth(), fg: cell.getFgColor(), bg: cell.getBgColor(), fgRgb: cell.isFgRGB(), bgRgb: cell.isBgRGB(), fgPalette: cell.isFgPalette(), bgPalette: cell.isBgPalette(), bold: cell.isBold(), italic: cell.isItalic(), inverse: cell.isInverse() });
    }
    cells.push(row);
  }
  frames.push({ name, cols, rows, cells, lines });
  await writeFile(join(output, name + '.txt'), lines.join('\n'));
}
try {
  await phase('gallery');
  await snapshot('web-results-wide', 100, 28);
  await snapshot('web-results-narrow', 60, 28);
  await writeFile(join(root, 'gallery-continue'), 'yes');
  await phase('tools');
  await snapshot('tools-wide', 100, 34);
  await snapshot('tools-narrow', 60, 28);
  child.write('\x0f'); await delay(100);
  await snapshot('tools-expanded', 100, 42);
  child.write('\x0f'); await delay(100);
  await writeFile(join(root, 'tools-continue'), 'yes');
  await phase('active');
  await snapshot('active-wide', 100, 34);
  await snapshot('active-narrow', 60, 28);
  term.resize(100, 34); child.resize(100, 34);
  await writeFile(join(root, 'continue'), 'yes');
  await phase('settled');
  await snapshot('settled-roomy', 180, 48);
  await snapshot('settled-wide', 100, 34);
  await snapshot('settled-narrow', 60, 28);
  child.write('\x14'); await delay(100);
  await snapshot('thinking-expanded', 100, 34);
  child.write('\x14'); await delay(100);
  await input('/overlay hide', 'Workflow overlay hidden');
  await snapshot('workflow-hidden', 60, 28);
  await input('/overlay show', 'Workflow overlay shown');
  await input('/plan card', 'Plan display: card');
  await snapshot('plan-card', 100, 34);
  await input('/plan hide', 'Plan display: hidden');
  await snapshot('plan-hidden', 100, 34);
  await input('/plan compact', 'Plan display: compact');
  await input('/plan', 'Execution plan');
  await snapshot('plan-details-wide', 100, 34);
  await snapshot('plan-details-narrow', 60, 28);
  child.write('q'); await delay(100);
  await input('/transcript stable phrase across wraps', 'Transcript');
  await snapshot('search-narrow', 60, 28);
  child.write('q'); await delay(100);
  await input('/palette telegram', 'Commands ·');
  await snapshot('commands-wide', 100, 34);
  await snapshot('commands-narrow', 60, 28);
  child.write('\x1b'); await delay(100);
  await input('/doctor', 'Doctor · local checks');
  await snapshot('doctor-wide', 100, 34);
  await snapshot('doctor-narrow', 60, 28);
  child.write('q'); await delay(100);
  await input('/loop view', 'loops · snapshot');
  await snapshot('loop-wide', 100, 34);
  await snapshot('loop-narrow', 60, 28);
  child.write('q'); await delay(100); child.write('\x04');
  const exitDeadline = Date.now() + 5000;
  while (!exited && Date.now() < exitDeadline) await delay(25);
  assert(exited, 'The preview must shut down through Pi before inspecting its final result.');
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.networkAttempts, 0);
  const frame = (name) => frames.find((frame) => frame.name === name).lines.join('\n');
  for (const name of ['web-results-wide', 'web-results-narrow']) {
    assert(frame(name).includes('3 sources'));
    assert(frame(name).includes('typescriptlang.org'));
    const gallery = frames.find((item) => item.name === name);
    const messageIndex = gallery.lines.findIndex((line) => line.includes('Find the TypeScript references'));
    assert(messageIndex >= 1, 'The user message and its top padding must remain visible.');
    for (const rowIndex of [messageIndex - 1, messageIndex, messageIndex + 1]) {
      const row = gallery.cells[rowIndex];
      assert(row.every((cell) => cell.bgRgb && cell.bg === 0x504945), 'User message panels must paint their entire width, including padding.');
    }
    const letters = gallery.cells[messageIndex].filter((cell) => cell.text.trim());
    assert(letters.every((cell) => cell.fgRgb && cell.fg === 0xfbf1c7), 'User messages must retain bright cream text.');
  }
  for (const name of ['tools-wide', 'tools-narrow']) {
    assert(frame(name).includes('Explored'));
    assert(frame(name).includes('research.ts'));
    assert(frame(name).includes('2 checks passed'));
    assert(frame(name).includes('Ran command'), 'Shell tools need a clear status heading above their command.');
    assert(frame(name).includes('Ran command · Verify the command output display'), 'The command purpose must share the existing header.');
    assert(frame(name).includes('Ran command · Check both research source files exist'), 'Each command keeps its own purpose.');
    assert(frame(name).includes('command line'), 'The collapsed multiline command must expose its bounded preview.');
    const toolFrame = frames.find((item) => item.name === name);
    const purposeRow = toolFrame.lines.findIndex((line) => line.includes('Verify the command output display'));
    const caption = toolFrame.cells[purposeRow].slice(toolFrame.lines[purposeRow].indexOf('Verify'), toolFrame.lines[purposeRow].trimEnd().length);
    assert(caption.every((cell) => cell.fgRgb && cell.fg === 0xebdbb2 && !cell.bgRgb), 'Command purpose must remain neutral and outside the shaded source panel.');
    const panels = toolFrame.cells.filter((row) => row.some((cell) => cell.bgRgb && cell.bg === 0x3c3836));
    assert(panels.length >= 2, 'Short and multiline commands must have soft shaded panels.');
    assert(panels.every((row) => row.some((cell) => cell.text === '│')), 'Each command row must keep its quiet left gutter.');
  }
  assert(frame('tools-expanded').includes('Missing source files'), 'Expanding tools must reveal the rest of the multiline command.');
  assert(!frame('tools-expanded').includes('command line'), 'Expanded commands must show all available fixture lines.');
  assert(frame('settled-wide').includes('Thinking...'), 'Collapsed thinking must keep Pi\'s default label.');
  assert(frame('settled-wide').includes('│ const sources'));
  assert(frame('settled-wide').includes('typescript · src/research.ts'), 'The native TUI must use the Shiki code display.');
  const settled = frames.find((item) => item.name === 'settled-wide');
  const catCells = settled.cells.flat().filter((cell) => /[\u2801-\u28ff]/u.test(cell.text));
  assert(catCells.length > 0 && catCells.every((cell) => cell.fgRgb && cell.fg === 0xfe8019), 'The cat must remain orange.');
  const orangeBars = settled.cells.filter((row) => row.filter((cell) => cell.text === '─' && cell.fgRgb && cell.fg === 0xfe8019).length > 50);
  assert(orangeBars.length >= 2, 'Both editor bars must use the visible orange accent.');
  const workedRow = frames.find((item) => item.name === 'settled-wide').lines.find((row) => row.includes('Worked for'));
  assert(workedRow?.includes('in 3.5K') && workedRow.includes('out 240') && workedRow.includes('$0.01'), 'Work rules must include readable recorded statistics in compact mode.');
  const telemetryColors = new Set([0xfe8019, 0xa89984, 0xebdbb2, 0x7c6f64]);
  for (const name of ['settled-wide', 'settled-narrow']) {
    const capture = frames.find((item) => item.name === name);
    const receipt = capture.lines.filter((row) => row.includes('in 7K') && row.includes('out 480'));
    assert.equal(receipt.length, 1, 'Final compact statistics must occupy exactly one row.');
    assert(receipt[0].includes('$0.03'));
    const receiptIndex = capture.lines.indexOf(receipt[0]);
    assert(receipt[0].trimStart().startsWith('Turn '), 'The final receipt must identify its whole-turn scope.');
    for (const row of [capture.cells[receiptIndex], capture.cells.at(-1)]) {
      const content = row.filter((cell) => cell.text.trim());
      assert(content.every((cell) => cell.fgRgb && telemetryColors.has(cell.fg)), 'Normal footer and turn statistics must share one accent and neutral palette.');
    }
    assert(!/(?:ttft|\bctx\b|\bR\d|\bW\d|\d+r\/\d+t)/.test(receipt[0]), 'Telemetry labels must be readable words.');
  }
  assert(/finished \d{2}:\d{2}:\d{2}/.test(frame('settled-roomy')), 'Wide turn receipts must label their completion time.');
  assert(frame('thinking-expanded').includes('I will keep source metadata explicit'));

  for (const name of ['active-wide', 'active-narrow', 'settled-wide', 'settled-narrow']) {
    assert(!frame(name).includes('╭ Plan'), 'The default plan must not cover transcript content.');
    assert(frame(name).includes('Plan 1/3 · ● Improve research tools'));
    assert(!frame(name).includes('to expand · /plan'), 'Collapsed receipts must stay on one line.');
  }
  assert(!frame('workflow-hidden').includes('Plan 1/3 · ● Improve research tools'));
  assert(frame('plan-card').includes('╭ Plan 1/3'));
  assert(frame('plan-card').includes('Next  Verify behavior'));
  assert(!frame('plan-card').includes('Plan 1/3 · ● Improve research tools'));
  assert(!frame('plan-hidden').includes('╭ Plan'));
  assert(!frame('plan-hidden').includes('Plan 1/3 · ● Improve research tools'));
  for (const name of ['plan-details-wide', 'plan-details-narrow']) {
    assert(frame(name).includes('Execution plan'));
    assert(frame(name).includes('Improve research tools'));
    assert(frame(name).includes('q/esc close'));
    assert(!frame(name).includes('Plan 1/3 · ● Improve research tools'));
  }
  assert(frame('search-narrow').includes('╭ Transcript'));
  assert(frame('search-narrow').includes('1/1 matches'));
  assert(frame('search-narrow').includes('q/Esc close'));
  for (const name of ['commands-wide', 'commands-narrow']) {
    assert(frame(name).includes('Commands ·'));
    assert(frame(name).includes('/telegram'));
    assert(frame(name).includes('Enter insert'));
    assert(!frame(name).includes('Plan 1/3 · ● Improve research tools'));
  }
  for (const name of ['doctor-wide', 'doctor-narrow']) {
    assert(frame(name).includes('╭ Doctor · local checks'));
    assert(frame(name).includes('checks passed'));
    assert(!frame(name).includes('! Search access') && !frame(name).includes('! Search credentials'), 'Keyless search must not produce a missing-key warning.');
    assert(frame(name).includes('q/Esc close') && frame(name).includes('/ search'));
    assert(!frame(name).includes('following') && !frame(name).includes('t thinking'));
  }
  for (const name of ['loop-wide', 'loop-narrow']) {
    assert(frame(name).includes('╭ loops · snapshot'));
    assert(frame(name).includes('Session loops') && frame(name).includes('1 paused'));
    assert(frame(name).includes('preview-loop · paused'));
    assert(frame(name).includes('q/Esc close') && frame(name).includes('/ search'));
    assert(!frame(name).includes('following') && !frame(name).includes('t thinking'));
  }
  const modal = frames.find((frame) => frame.name === 'search-narrow').lines;
  const top = modal.findIndex((line) => line.startsWith('╭ Transcript'));
  const bottom = modal.findIndex((line, index) => index > top && line.startsWith('╰'));
  assert(top >= 0 && bottom > top, 'The modal must cover the full terminal width.');
  assert(modal[top].endsWith('╮') && modal[bottom].endsWith('╯'));
  assert(modal.slice(top + 1, bottom).every((line) => line.startsWith('│') && line.endsWith('│')));
  await writeFile(join(output, 'frames.json'), JSON.stringify({ result, frames }));
  await writeFile(join(output, 'index.html'), report(frames));
  console.log(JSON.stringify({ preview: join(output, 'index.html'), ...result }));
} finally {
  if (!exited) child.kill();
  const until = Date.now() + 2000;
  while (!exited && Date.now() < until) await delay(25);
  if (!exited) child.kill('SIGKILL');
  term.dispose();
  await writeFile(join(output, 'terminal.ansi'), raw);
  await rm(root, { recursive: true, force: true });
}

function report(frames) {
  const escape = (text) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const palette = ['#282828', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#fbf1c7'];
  const hex = (n) => n.toString(16).padStart(2, '0');
  const color = (value, rgb, indexed, fallback) => {
    if (rgb) return '#' + value.toString(16).padStart(6, '0');
    if (!indexed) return fallback;
    if (value < 16) return palette[value];
    if (value >= 232) return '#' + hex(8 + (value - 232) * 10).repeat(3);
    const levels = [0, 95, 135, 175, 215, 255], n = value - 16;
    return '#' + [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]].map(hex).join('');
  };
  const sections = frames.map((frame) => `<section id="${frame.name}"><h2>${frame.name} <small>${frame.cols} × ${frame.rows}</small></h2><div class="terminal" role="img" aria-label="${frame.name}">${frame.cells.map((row) => `<div class="row">${row.map((cell) => {
    let fg = color(cell.fg, cell.fgRgb, cell.fgPalette, '#ebdbb2');
    let bg = color(cell.bg, cell.bgRgb, cell.bgPalette, '#282828');
    if (cell.inverse) [fg, bg] = [bg, fg];
    return `<span style="width:${cell.width}ch;color:${fg};background:${bg};font-weight:${cell.bold ? 700 : 400};font-style:${cell.italic ? 'italic' : 'normal'}">${escape(cell.text)}</span>`;
  }).join('')}</div>`).join('')}</div><details><summary>Plain terminal text</summary><pre>${escape(frame.lines.join('\n'))}</pre></details></section>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pi UI preview</title><style>
body{margin:32px;background:#181818;color:#ebdbb2;font:16px system-ui}h1,h2{font-weight:550}p,small,summary{color:#a89984}nav{display:flex;gap:16px;flex-wrap:wrap}a{color:#8ec07c}section{margin:40px 0}.terminal{width:max-content;background:#282828;padding:16px;border:1px solid #504945;border-radius:8px;font:15px/1.5 Menlo,Consolas,monospace}.row{white-space:pre;height:1.5em}.row span{display:inline-block;vertical-align:top;white-space:pre}pre{overflow:auto}details{margin-top:12px}</style><h1>Pi UI preview</h1><p>Native Pi in a real PTY, with all extensions and synthetic responses. Static cell captures; no live account, network, or notifications.</p><nav>${frames.map((frame) => `<a href="#${frame.name}">${frame.name}</a>`).join('')}</nav>${sections}</html>`;
}
