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
if (url.includes('/fail-http')) { console.error('ax: error: fetch failed: 401 HTTP Forbidden for ' + url + '?token=secret'); process.exit(22); }
if (url.includes('/fail')) { console.error('private remote error'); process.exit(22); }
if (url.includes('/empty')) { console.log('   '); process.exit(0); }
if (url.includes('/challenge')) { console.log('# Just a moment...'); process.exit(0); }
if (url.includes('/article')) { console.log('This article explains why a server returns Access Denied and how to configure it.'); process.exit(0); }
if (url.includes('/selection-empty')) { console.log(JSON.stringify({data:[],meta:{state:'complete',next_offset:null}})); process.exit(0); }
if (url.includes('/selection-large')) { console.log(JSON.stringify({data:[{text:'x'.repeat(50000)}],meta:{state:'more',next_offset:1}})); console.error('continue with --offset 1'); process.exit(0); }
if (url.includes('/malformed')) { console.log('not an extraction envelope'); process.exit(0); }
if (url.includes('/wait')) { setTimeout(() => {}, 60000); }
else if (url.includes('/large')) { console.log('x'.repeat(50000)); }
else {
  const text = '\\x1b[31mPage\\x1b[0m\\n' + JSON.stringify(process.argv.slice(2));
  console.log(JSON.stringify({data:[{text}], meta:{state:'more',next_offset:50}}));
  console.error('continue with --offset 50');
}
`, { mode: 0o700 });
  process.env.PATH = directory;
  let remoteCalls = 0;
  const remoteReader = async (input: { url: string }) => {
    remoteCalls++;
    return { url: input.url, reader: "exa" as const, access: "keyless" as const, text: "Remote page", notes: "remote notes", truncated: false };
  };
  const result = await readPage({ url: "https://example.com/", mode: "extract", selector: "a[href='$(echo bad)']" });
  assert(result.text.startsWith("Page\n"));
  assert(result.text.includes("a[href='$(echo bad)']"));
  assert(!result.text.includes("\x1b"));
  assert(result.notes.includes("--offset 50"));
  await assert.rejects(readPage({ url: "https://example.com/", mode: "extract", selector: "p", offset: 50 }), /does not advance/);
  const large = await readPage({ url: "https://example.com/large" });
  assert.equal(large.text.length, 40000);
  assert(large.truncated);
  await assert.rejects(readPage({ url: "https://example.com/fail" }), (error: Error) => error.message.includes("ax exited with status 22") && !error.message.includes("private remote error"));
  await assert.rejects(readPage({ url: "https://example.com/fail-http" }), (error: Error) => error.message.includes("remote server returned HTTP 401") && !error.message.includes("token=secret"));
  const fallback = await readPage({ url: "https://example.com/fail-http", reader: "auto" }, undefined, remoteReader);
  assert.equal(fallback.text, "Remote page");
  assert.equal(fallback.fallback?.from, "ax");
  assert.match(fallback.fallback?.reason ?? "", /HTTP 401/);
  assert(!fallback.notes.includes("token=secret"));
  assert.equal(remoteCalls, 1);
  await assert.rejects(readPage({ url: "https://example.com/fail-http", reader: "auto", mode: "outline" }, undefined, remoteReader), /HTTP 401/);
  assert.equal(remoteCalls, 1, "structured reads must not fall back remotely");
  for (const path of ["empty", "challenge"]) {
    await assert.rejects(readPage({ url: `https://example.com/${path}` }), /no readable content|access challenge/);
    const recovered = await readPage({ url: `https://example.com/${path}`, reader: "auto" }, undefined, remoteReader);
    assert.equal(recovered.text, "Remote page");
    assert.match(recovered.fallback?.reason ?? "", /no readable content|access challenge/);
  }
  assert.equal(remoteCalls, 3);
  const article = await readPage({ url: "https://example.com/article", reader: "auto" }, undefined, remoteReader);
  assert.match(article.text, /This article/);
  const empty = await readPage({ url: "https://example.com/selection-empty", reader: "auto", mode: "extract", selector: ".missing" }, undefined, remoteReader);
  assert.equal(empty.pagination?.state, "complete");
  assert.equal(empty.text, "");
  const capped = await readPage({ url: "https://example.com/selection-large", mode: "extract", selector: "main" });
  assert(capped.truncated);
  assert.equal(capped.pagination, undefined, "never skip an incompletely delivered selection");
  assert(!capped.notes.includes("--offset 1"));
  await assert.rejects(readPage({ url: "https://example.com/malformed", reader: "auto", mode: "extract", selector: "p" }, undefined, remoteReader));
  await assert.rejects(readPage({ url: "https://example.com/fail", reader: "auto", selector: "p" }, undefined, remoteReader), /mode=extract/);
  assert.equal(remoteCalls, 3, "successful articles, selections, and invalid input do not use a remote fallback");
  await assert.rejects(readPage({ url: "https://example.com/fail-http", reader: "auto" }, undefined, async () => { throw new Error("HTTP 503 private token=secret"); }), (error: Error) => error.message.includes("HTTP 401") && error.message.includes("HTTP 503") && !error.message.includes("secret"));
  const lateAbort = new AbortController();
  await assert.rejects(readPage({ url: "https://example.com/fail", reader: "auto" }, lateAbort.signal, async () => { lateAbort.abort(); return remoteReader({ url: "https://example.com" }); }));
  assert.equal(remoteCalls, 4);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(readPage({ url: "https://example.com/wait", reader: "auto" }, controller.signal, remoteReader), /cancelled/); }
  finally { clearTimeout(timer); }
  assert.equal(remoteCalls, 4, "cancelled reads must not fall back remotely");
  await rm(join(directory, "ax"));
  await assert.rejects(readPage({ url: "https://example.com/" }), /not installed/);
  const missingFallback = await readPage({ url: "https://example.com/", reader: "auto" }, undefined, remoteReader);
  assert.equal(missingFallback.reader, "exa");
  assert.match(missingFallback.fallback?.reason ?? "", /not installed/);
  assert.equal(remoteCalls, 5);
  console.log("reader process lifecycle verified");
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  await rm(directory, { recursive: true, force: true });
}
