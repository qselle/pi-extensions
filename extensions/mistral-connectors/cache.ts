import type { Connector } from "./catalog.ts";

export const CACHE_FILE = "mistral-connectors-cache.json";
/** Same lifetime as Mistral Vibe's bootstrap cache. */
export const CACHE_TTL_MS = 10 * 60 * 1000;

/** Version 1 matches the reference extension, so an existing cache keeps working. */
export interface ConnectorCache {
  version: 1;
  fetchedAt: number;
  /** Hash of the API root and key, so switching accounts invalidates the cache. */
  account: string;
  connectors: Connector[];
  /** Last background refresh failure after `fetchedAt`; cleared by the next success. */
  lastError?: string;
}

export function parseCache(raw: unknown): ConnectorCache | undefined {
  const value = raw as Partial<ConnectorCache> | undefined;
  if (value?.version !== 1 || typeof value.fetchedAt !== "number" || typeof value.account !== "string" || !Array.isArray(value.connectors)) return undefined;
  return value as ConnectorCache;
}

export function age(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}
