import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPage } from "./reader.ts";

const directory = await mkdtemp(join(tmpdir(), "pi-web-reader-"));
const previousPath = process.env.PATH;
try {
  // A controlled executable exercises real process spawning, argument boundaries,
  // stderr, exit failure, buffering and cancellation without network or ax installs.
  await writeFile(join(directory, "ax"), `#!${process.execPath}
const url = process.argv[2];
if (url.includes('/fail')) { console.error('private remote error'); process.exit(22); }
if (url.includes('/wait')) { setTimeout(() => {}, 60000); }
else if (url.includes('/large')) { console.log('x'.repeat(50000)); }
else {
  const text = '\\x1b[31mPage\\x1b[0m\\n' + JSON.stringify(process.argv.slice(2));
  console.log(JSON.stringify({data:[{text}], meta:{state:'more',next_offset:50}}));
  console.error('continue with --offset 50');
}
`, { mode: 0o700 });
  process.env.PATH = directory;
  const result = await readPage({ url: "https://example.com/", mode: "extract", selector: "a[href='$(echo bad)']" });
  assert(result.text.startsWith("Page\n"));
  assert(result.text.includes("a[href='$(echo bad)']"));
  assert(!result.text.includes("\x1b"));
  assert(result.notes.includes("--offset 50"));
  await assert.rejects(readPage({ url: "https://example.com/", mode: "extract", selector: "p", offset: 50 }), /does not advance/);
  const large = await readPage({ url: "https://example.com/large" });
  assert.equal(large.text.length, 40000);
  assert(large.truncated);
  await assert.rejects(readPage({ url: "https://example.com/fail" }), /ax exited with status 22/);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(readPage({ url: "https://example.com/wait" }, controller.signal), /cancelled/); }
  finally { clearTimeout(timer); }
  await rm(join(directory, "ax"));
  await assert.rejects(readPage({ url: "https://example.com/" }), /not installed/);
  console.log("reader process lifecycle verified");
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  await rm(directory, { recursive: true, force: true });
}
