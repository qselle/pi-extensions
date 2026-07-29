export const MEMORY_FORMAT_VERSION = 1 as const;
export const MAX_MEMORY_CHARS = 4_000;
export const MAX_QUERY_CHARS = 200;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 40;
export const MAX_SEARCH_RESULTS = 20;
export const MAX_SEARCH_SNIPPET_CHARS = 500;

export type MemoryScope = "global" | "project";
export type MemoryReadScope = MemoryScope | "all";

export interface MemorySource {
  kind: "explicit";
  cwd: string;
  sessionId?: string;
}

export interface MemoryRecord {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  source: MemorySource;
}

export type MemoryDocumentScope =
  | { kind: "global" }
  | { kind: "project"; root: string };

export interface MemoryDocument {
  version: typeof MEMORY_FORMAT_VERSION;
  scope: MemoryDocumentScope;
  entries: MemoryRecord[];
}

export interface ScopedMemoryRecord extends MemoryRecord {
  scope: MemoryScope;
  projectRoot?: string;
  expired: boolean;
}

export interface RememberMemoryInput {
  text: string;
  scope: MemoryScope;
  tags?: string[];
  expiresInDays?: number;
}

export interface RememberMemoryResult {
  record: ScopedMemoryRecord;
  created: boolean;
  path: string;
}

export interface ForgetMemoryResult {
  forgotten?: ScopedMemoryRecord;
  path?: string;
}

export interface SearchMemoryInput {
  query: string;
  scope?: MemoryReadScope;
  maxResults?: number;
  includeExpired?: boolean;
}

export interface MemorySearchResult {
  id: string;
  scope: MemoryScope;
  projectRoot?: string;
  snippet: string;
  tags: string[];
  updatedAt: string;
  expiresAt?: string;
  expired: boolean;
  score: number;
}

export interface MemoryScopeStatus {
  scope: MemoryScope;
  projectRoot?: string;
  path: string;
  active: number;
  expired: number;
}

export interface MemoryStatus {
  root: string;
  scopes: MemoryScopeStatus[];
}
