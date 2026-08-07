const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

export const MIN_LOOP_INTERVAL_MS = 60_000;
export const MAX_LOOP_INTERVAL_MS = 3_600_000;

export interface ParsedLoopCommand {
  prompt: string;
  intervalMs: number | null;
}

export function parseDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase() as keyof typeof UNIT_MS;
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const milliseconds = Math.ceil(amount * UNIT_MS[unit]);
  if (milliseconds < MIN_LOOP_INTERVAL_MS || milliseconds > MAX_LOOP_INTERVAL_MS) return undefined;
  return milliseconds;
}

export function parseLoopCommand(value: string): ParsedLoopCommand | undefined {
  let input = value.trim();
  if (!input) return undefined;

  const leading = /^(\S+)\s+([\s\S]+)$/.exec(input);
  if (leading) {
    const intervalMs = parseDuration(leading[1]!);
    if (intervalMs !== undefined) {
      const prompt = stripMatchingQuotes(leading[2]!.trim());
      return prompt ? { prompt, intervalMs } : undefined;
    }
    if (looksLikeDuration(leading[1]!)) return undefined;
  }

  const trailing = /^([\s\S]+?)\s+every\s+(\S+)$/i.exec(input);
  if (trailing) {
    const intervalMs = parseDuration(trailing[2]!);
    if (intervalMs !== undefined) {
      const prompt = stripMatchingQuotes(trailing[1]!.trim());
      return prompt ? { prompt, intervalMs } : undefined;
    }
    if (looksLikeDuration(trailing[2]!)) return undefined;
  }

  if (looksLikeDuration(input)) return undefined;
  input = stripMatchingQuotes(input);
  return input ? { prompt: input, intervalMs: null } : undefined;
}

function looksLikeDuration(value: string): boolean {
  return /^\d+(?:\.\d+)?[smhd]$/i.test(value);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1).trim()
    : value;
}
