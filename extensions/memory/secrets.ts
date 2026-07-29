interface SensitivePattern {
  label: string;
  pattern: RegExp;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i },
  { label: "OpenAI-style API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "Slack token", pattern: /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{12,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/ },
  {
    label: "credential assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_+\/.=-]{12,}/i,
  },
];

/** Best-effort rejection of common credentials. This is a guardrail, not a DLP system. */
export function sensitiveMemoryReason(text: string): string | undefined {
  return SENSITIVE_PATTERNS.find(({ pattern }) => pattern.test(text))?.label;
}
