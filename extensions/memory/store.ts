import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { sensitiveMemoryReason } from "./secrets.ts";
import {
  MAX_MEMORY_CHARS,
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SNIPPET_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MEMORY_FORMAT_VERSION,
  type ForgetMemoryResult,
  type MemoryDocument,
  type MemoryDocumentScope,
  type MemoryReadScope,
  type MemoryRecord,
  type MemoryScope,
  type MemoryScopeStatus,
  type MemorySearchResult,
  type MemoryStatus,
  type RememberMemoryInput,
  type RememberMemoryResult,
  type ScopedMemoryRecord,
  type SearchMemoryInput,
} from "./types.ts";

export type MemoryMutationQueue = <T>(path: string, work: () => Promise<T>) => Promise<T>;

export interface MemoryStoreOptions {
  root: string;
  cwd: string;
  projectRoot?: string;
  sessionId?: string;
  now?: () => Date;
  newId?: () => string;
  mutationQueue?: MemoryMutationQueue;
}

const localMutationTails = new Map<string, Promise<void>>();

/** Serialize mutations to the same store within this Pi process. */
export async function queueLocalMutation<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = localMutationTails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const tail = previous.catch(() => undefined).then(() => current);
  localMutationTails.set(path, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (localMutationTails.get(path) === tail) localMutationTails.delete(path);
  }
}

export class MemoryStore {
  readonly root: string;
  readonly cwd: string;
  readonly projectRoot: string;
  private readonly sessionId?: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly mutationQueue: MemoryMutationQueue;

  constructor(options: MemoryStoreOptions) {
    this.root = resolve(options.root);
    this.cwd = resolve(options.cwd);
    this.projectRoot = resolve(options.projectRoot ?? findProjectRoot(this.cwd));
    this.sessionId = options.sessionId;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `m_${randomUUID()}`);
    this.mutationQueue = options.mutationQueue ?? queueLocalMutation;
  }

  pathFor(scope: MemoryScope): string {
    if (scope === "global") return join(this.root, "global.json");
    return join(this.root, "projects", projectStoreFilename(this.projectRoot));
  }

  async remember(input: RememberMemoryInput): Promise<RememberMemoryResult> {
    const text = normalizeMemoryText(input.text);
    const reason = sensitiveMemoryReason(text);
    if (reason) throw new Error(`Refusing to persist memory that looks like a ${reason}.`);
    const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
    const expiresInDays = normalizeExpirationDays(input.expiresInDays);
    const path = this.pathFor(input.scope);

    return this.mutationQueue(path, async () => {
      const document = await this.readDocument(path, documentScope(input.scope, this.projectRoot));
      const timestamp = this.now();
      const now = timestamp.toISOString();
      const existing = document.entries.find((entry) => entry.text === text);
      let record: MemoryRecord;
      let created: boolean;
      if (existing) {
        record = {
          ...existing,
          tags: tags ?? existing.tags,
          updatedAt: now,
          expiresAt: expiresInDays === undefined
            ? existing.expiresAt
            : expirationDate(timestamp, expiresInDays),
        };
        document.entries = document.entries.map((entry) => entry.id === existing.id ? record : entry);
        created = false;
      } else {
        record = {
          id: this.newId(),
          text,
          tags: tags ?? [],
          createdAt: now,
          updatedAt: now,
          expiresAt: expiresInDays === undefined ? undefined : expirationDate(timestamp, expiresInDays),
          source: {
            kind: "explicit",
            cwd: this.cwd,
            sessionId: this.sessionId,
          },
        };
        assertRecord(record);
        if (document.entries.some((entry) => entry.id === record.id)) {
          throw new Error(`Memory ID collision: ${record.id}`);
        }
        document.entries.push(record);
        created = true;
      }
      await this.writeDocument(path, document);
      return { record: scopedRecord(record, input.scope, this.projectRoot, timestamp), created, path };
    });
  }

  async forget(id: string, scope: MemoryReadScope = "all"): Promise<ForgetMemoryResult> {
    assertMemoryId(id);
    for (const selected of expandScopes(scope)) {
      const path = this.pathFor(selected);
      const result = await this.mutationQueue(path, async () => {
        const document = await this.readDocument(path, documentScope(selected, this.projectRoot));
        const index = document.entries.findIndex((entry) => entry.id === id);
        if (index < 0) return undefined;
        const [record] = document.entries.splice(index, 1);
        await this.writeDocument(path, document);
        return record;
      });
      if (result) {
        return {
          forgotten: scopedRecord(result, selected, this.projectRoot, this.now()),
          path,
        };
      }
    }
    return {};
  }

  async read(id: string, scope: MemoryReadScope = "all"): Promise<ScopedMemoryRecord | undefined> {
    assertMemoryId(id);
    const now = this.now();
    for (const selected of expandScopes(scope)) {
      const document = await this.readDocument(
        this.pathFor(selected),
        documentScope(selected, this.projectRoot),
      );
      const record = document.entries.find((entry) => entry.id === id);
      if (record) return scopedRecord(record, selected, this.projectRoot, now);
    }
    return undefined;
  }

  async search(input: SearchMemoryInput): Promise<MemorySearchResult[]> {
    const query = normalizeQuery(input.query);
    const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(input.maxResults ?? 8)));
    const now = this.now();
    const candidates: ScopedMemoryRecord[] = [];
    for (const selected of expandScopes(input.scope ?? "all")) {
      const document = await this.readDocument(
        this.pathFor(selected),
        documentScope(selected, this.projectRoot),
      );
      for (const entry of document.entries) {
        const record = scopedRecord(entry, selected, this.projectRoot, now);
        if (!record.expired || input.includeExpired) candidates.push(record);
      }
    }

    return candidates
      .map((record) => rankRecord(record, query))
      .filter((result): result is MemorySearchResult => Boolean(result))
      .sort((left, right) => right.score - left.score
        || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        || left.id.localeCompare(right.id))
      .slice(0, maxResults);
  }

  async status(): Promise<MemoryStatus> {
    const now = this.now();
    const scopes: MemoryScopeStatus[] = [];
    for (const scope of expandScopes("all")) {
      const path = this.pathFor(scope);
      const document = await this.readDocument(path, documentScope(scope, this.projectRoot));
      let active = 0;
      let expired = 0;
      for (const record of document.entries) {
        if (isExpired(record, now)) expired += 1;
        else active += 1;
      }
      scopes.push({
        scope,
        projectRoot: scope === "project" ? this.projectRoot : undefined,
        path,
        active,
        expired,
      });
    }
    return { root: this.root, scopes };
  }

  private async readDocument(path: string, expectedScope: MemoryDocumentScope): Promise<MemoryDocument> {
    await assertSafeDirectoryIfPresent(this.root);
    await assertSafeDirectoryIfPresent(dirname(path));
    const metadata = await lstatOptional(path);
    if (!metadata) return { version: MEMORY_FORMAT_VERSION, scope: expectedScope, entries: [] };
    if (metadata.isSymbolicLink()) throw new Error(`Refusing to follow symlinked memory file: ${path}`);
    if (!metadata.isFile()) throw new Error(`Memory store is not a file: ${path}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot parse memory store ${path}: ${reason}`);
    }
    return parseDocument(parsed, expectedScope, path);
  }

  private async writeDocument(path: string, document: MemoryDocument): Promise<void> {
    assertDocument(document, document.scope, path);
    await ensureSafeDirectory(this.root);
    await ensureSafeDirectory(dirname(path));
    const existing = await lstatOptional(path);
    if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace symlinked memory file: ${path}`);
    if (existing && !existing.isFile()) throw new Error(`Memory store is not a file: ${path}`);

    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      await chmod(path, 0o600).catch(() => undefined);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

export function projectStoreFilename(projectRoot: string): string {
  const root = resolve(projectRoot);
  const name = slugifyProjectName(basename(root) || parse(root).root || "root");
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `${name}-${digest}.json`;
}

export function normalizeMemoryText(input: string): string {
  if (typeof input !== "string") throw new Error("Memory text must be a string.");
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("Memory text cannot be empty.");
  if (Array.from(text).length > MAX_MEMORY_CHARS) {
    throw new Error(`Memory text exceeds the ${MAX_MEMORY_CHARS.toLocaleString("en-US")}-character limit.`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new Error("Memory text contains unsupported control characters.");
  }
  return text;
}

export function normalizeTags(input: string[]): string[] {
  if (!Array.isArray(input)) throw new Error("Memory tags must be an array.");
  const tags = [...new Set(input.map((tag) => {
    if (typeof tag !== "string") throw new Error("Every memory tag must be a string.");
    return tag.replace(/\s+/g, " ").trim().toLowerCase();
  }).filter(Boolean))];
  if (tags.length > MAX_TAGS) throw new Error(`A memory can have at most ${MAX_TAGS} tags.`);
  if (tags.some((tag) => Array.from(tag).length > MAX_TAG_CHARS)) {
    throw new Error(`Memory tags are limited to ${MAX_TAG_CHARS} characters.`);
  }
  return tags;
}

function normalizeExpirationDays(input: number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isInteger(input) || input < 1 || input > 3_650) {
    throw new Error("expires_in_days must be an integer from 1 to 3650.");
  }
  return input;
}

function normalizeQuery(input: string): string {
  if (typeof input !== "string") throw new Error("Memory query must be a string.");
  const query = input.replace(/\s+/g, " ").trim();
  if (!query) throw new Error("Memory query cannot be empty.");
  if (Array.from(query).length > MAX_QUERY_CHARS) {
    throw new Error(`Memory query exceeds the ${MAX_QUERY_CHARS}-character limit.`);
  }
  return query;
}

function rankRecord(record: ScopedMemoryRecord, query: string): MemorySearchResult | undefined {
  const phrase = query.toLocaleLowerCase();
  const terms = [...new Set(phrase.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
  const text = record.text.toLocaleLowerCase();
  const tags = record.tags.map((tag) => tag.toLocaleLowerCase());
  const searchable = `${text}\n${tags.join(" ")}`;
  const phraseMatches = searchable.includes(phrase);
  if (!phraseMatches && (terms.length === 0 || !terms.every((term) => searchable.includes(term)))) return undefined;

  const tagText = tags.join(" ");
  let score = text.includes(phrase) ? 150 : tagText.includes(phrase) ? 60 : 0;
  score += terms.reduce((sum, term) => sum + (text.includes(term) ? 10 : 0), 0);
  score += terms.reduce((sum, term) => sum + (tags.includes(term) ? 20 : 0), 0);
  if (record.scope === "project") score += 1;
  return {
    id: record.id,
    scope: record.scope,
    projectRoot: record.projectRoot,
    snippet: searchSnippet(record.text, phrase, terms),
    tags: record.tags,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    expired: record.expired,
    score,
  };
}

function searchSnippet(text: string, phrase: string, terms: string[]): string {
  if (Array.from(text).length <= MAX_SEARCH_SNIPPET_CHARS) return text;
  const folded = text.toLocaleLowerCase();
  let match = folded.indexOf(phrase);
  if (match < 0) match = Math.min(...terms.map((term) => folded.indexOf(term)).filter((index) => index >= 0));
  if (!Number.isFinite(match)) match = 0;
  const start = Math.max(0, match - Math.floor(MAX_SEARCH_SNIPPET_CHARS / 3));
  const end = Math.min(text.length, start + MAX_SEARCH_SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function normalizeTagsFromDocument(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error("record tags must be an array of strings");
  }
  return normalizeTags(value as string[]);
}

function parseDocument(raw: unknown, expectedScope: MemoryDocumentScope, path: string): MemoryDocument {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("root must be an object");
    const input = raw as Record<string, unknown>;
    if (input.version !== MEMORY_FORMAT_VERSION) {
      throw new Error(`unsupported version ${String(input.version)}`);
    }
    assertScope(input.scope, expectedScope);
    if (!Array.isArray(input.entries)) throw new Error("entries must be an array");
    const entries = input.entries.map(parseRecord);
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`duplicate record ID ${entry.id}`);
      ids.add(entry.id);
    }
    return { version: MEMORY_FORMAT_VERSION, scope: expectedScope, entries };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid memory store ${path}: ${reason}`);
  }
}

function parseRecord(raw: unknown): MemoryRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("record must be an object");
  const input = raw as Record<string, unknown>;
  assertMemoryId(input.id);
  if (typeof input.text !== "string") throw new Error("record text must be a string");
  const text = normalizeMemoryText(input.text);
  const sensitiveReason = sensitiveMemoryReason(text);
  if (sensitiveReason) throw new Error(`record text looks like a ${sensitiveReason}`);
  const tags = normalizeTagsFromDocument(input.tags);
  const createdAt = assertIsoTimestamp(input.createdAt, "createdAt");
  const updatedAt = assertIsoTimestamp(input.updatedAt, "updatedAt");
  const expiresAt = input.expiresAt === undefined ? undefined : assertIsoTimestamp(input.expiresAt, "expiresAt");
  if (!input.source || typeof input.source !== "object" || Array.isArray(input.source)) {
    throw new Error("record source must be an object");
  }
  const source = input.source as Record<string, unknown>;
  if (source.kind !== "explicit") throw new Error("record source kind must be explicit");
  if (typeof source.cwd !== "string" || !source.cwd) throw new Error("record source cwd must be a string");
  if (source.sessionId !== undefined && typeof source.sessionId !== "string") {
    throw new Error("record source sessionId must be a string");
  }
  return {
    id: input.id as string,
    text,
    tags,
    createdAt,
    updatedAt,
    expiresAt,
    source: { kind: "explicit", cwd: source.cwd, sessionId: source.sessionId as string | undefined },
  };
}

function assertDocument(document: MemoryDocument, expectedScope: MemoryDocumentScope, path: string): void {
  parseDocument(document, expectedScope, path);
}

function assertScope(raw: unknown, expected: MemoryDocumentScope): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scope must be an object");
  const scope = raw as Record<string, unknown>;
  if (scope.kind !== expected.kind) throw new Error(`scope must be ${expected.kind}`);
  if (expected.kind === "project" && scope.root !== expected.root) {
    throw new Error(`project scope root must be ${expected.root}`);
  }
}

function assertRecord(record: MemoryRecord): void {
  parseRecord(record);
}

function assertMemoryId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^m_[A-Za-z0-9-]{6,80}$/.test(value)) {
    throw new Error("Memory ID is invalid.");
  }
}

function assertIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function documentScope(scope: MemoryScope, projectRoot: string): MemoryDocumentScope {
  return scope === "global" ? { kind: "global" } : { kind: "project", root: projectRoot };
}

function scopedRecord(record: MemoryRecord, scope: MemoryScope, projectRoot: string, now: Date): ScopedMemoryRecord {
  return {
    ...record,
    scope,
    projectRoot: scope === "project" ? projectRoot : undefined,
    expired: isExpired(record, now),
  };
}

function isExpired(record: MemoryRecord, now: Date): boolean {
  return Boolean(record.expiresAt && Date.parse(record.expiresAt) <= now.getTime());
}

function expirationDate(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
}

function expandScopes(scope: MemoryReadScope): MemoryScope[] {
  if (scope === "all") return ["project", "global"];
  return [scope];
}

function slugifyProjectName(value: string): string {
  const slug = value.toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "project";
}

async function lstatOptional(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertSafeDirectoryIfPresent(path: string): Promise<void> {
  const metadata = await lstatOptional(path);
  if (!metadata) return;
  if (metadata.isSymbolicLink()) throw new Error(`Refusing to use symlinked memory directory: ${path}`);
  if (!metadata.isDirectory()) throw new Error(`Memory path is not a directory: ${path}`);
}

async function ensureSafeDirectory(path: string): Promise<void> {
  const existing = await lstatOptional(path);
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`Refusing to use symlinked memory directory: ${path}`);
    if (!existing.isDirectory()) throw new Error(`Memory path is not a directory: ${path}`);
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const created = await lstat(path);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Memory directory was not created safely: ${path}`);
  }
  await chmod(path, 0o700).catch(() => undefined);
}
