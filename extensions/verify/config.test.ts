import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SPILL_TOKEN_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  agentDirectory,
  emptyConfig,
  globToRegExp,
  loadConfig,
  matchCheck,
  parseConfig,
  relativePosixPath,
} from "./config.ts";

describe("globToRegExp", () => {
  const matches = (pattern: string, path: string) => globToRegExp(pattern).test(path);

  test("* does not cross directory boundaries", () => {
    expect(matches("*.ts", "a.ts")).toBe(true);
    expect(matches("*.ts", "src/a.ts")).toBe(false);
  });

  test("**/ matches zero or more directories", () => {
    expect(matches("**/*.ts", "a.ts")).toBe(true);
    expect(matches("**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(matches("extensions/**/*.ts", "extensions/verify/config.ts")).toBe(true);
    expect(matches("extensions/**/*.ts", "themes/x.ts")).toBe(false);
  });

  test("? matches a single non-separator character", () => {
    expect(matches("a?.ts", "ab.ts")).toBe(true);
    expect(matches("a?.ts", "a/.ts")).toBe(false);
  });

  test("regex metacharacters are literal", () => {
    expect(matches("a+b.ts", "a+b.ts")).toBe(true);
    expect(matches("a+b.ts", "aab.ts")).toBe(false);
    expect(matches("src/(x).ts", "src/(x).ts")).toBe(true);
  });

  test("leading ./ is ignored", () => {
    expect(matches("./src/*.ts", "src/a.ts")).toBe(true);
  });

  test("anchors both ends", () => {
    expect(matches("src/*.ts", "other/src/a.ts")).toBe(false);
    expect(matches("src/*.ts", "src/a.ts.bak")).toBe(false);
  });
});

describe("relativePosixPath", () => {
  test("makes paths repo-relative with POSIX separators", () => {
    expect(relativePosixPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });
  test("keeps already-relative paths", () => {
    expect(relativePosixPath("src/a.ts", "/repo")).toBe("src/a.ts");
  });
});

describe("parseConfig", () => {
  test("parses checks, normalizing match to an array", () => {
    const config = parseConfig({ checks: [{ match: "**/*.ts", command: "bun test {dir}" }] }, "global");
    expect(config?.enabled).toBe(true);
    expect(config?.source).toBe("global");
    expect(config?.checks[0]).toEqual({
      match: ["**/*.ts"],
      command: "bun test {dir}",
      name: "check 1",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    expect(config?.spillTokenLimit).toBe(DEFAULT_SPILL_TOKEN_LIMIT);
  });

  test("keeps a custom name, timeout, and spill limit", () => {
    const config = parseConfig({
      spillTokenLimit: 500,
      checks: [{ name: "tests", match: ["a/*.ts", "b/*.ts"], command: "x", timeoutMs: 1234 }],
    }, "project");
    expect(config?.checks[0]?.name).toBe("tests");
    expect(config?.checks[0]?.match).toHaveLength(2);
    expect(config?.checks[0]?.timeoutMs).toBe(1234);
    expect(config?.spillTokenLimit).toBe(500);
  });

  test("clamps an absurd timeout", () => {
    const config = parseConfig({ checks: [{ match: "*", command: "x", timeoutMs: 99_999_999 }] }, "global");
    expect(config?.checks[0]?.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  test("honors enabled:false", () => {
    expect(parseConfig({ enabled: false, checks: [{ match: "*", command: "x" }] }, "global")?.enabled).toBe(false);
  });

  test("drops invalid checks and returns undefined when none remain", () => {
    expect(parseConfig({ checks: [{ match: "*" }, { command: "x" }, 7, null] }, "global")).toBeUndefined();
    expect(parseConfig({ checks: [] }, "global")).toBeUndefined();
    expect(parseConfig({}, "global")).toBeUndefined();
    expect(parseConfig("nope", "global")).toBeUndefined();
  });

  test("keeps valid checks alongside invalid ones", () => {
    const config = parseConfig({ checks: [{ match: "" }, { match: "*.ts", command: "x" }] }, "global");
    expect(config?.checks).toHaveLength(1);
  });
});

describe("matchCheck", () => {
  const config = parseConfig({
    checks: [
      { name: "ts", match: "extensions/**/*.ts", command: "bun test {dir}" },
      { name: "rust", match: "**/*.rs", command: "cargo check" },
    ],
  }, "global")!;

  test("returns the first matching check", () => {
    expect(matchCheck(config, "extensions/verify/config.ts")?.name).toBe("ts");
    expect(matchCheck(config, "src/main.rs")?.name).toBe("rust");
  });

  test("returns undefined with no match", () => {
    expect(matchCheck(config, "README.md")).toBeUndefined();
  });

  test("returns undefined when disabled", () => {
    expect(matchCheck({ ...config, enabled: false }, "extensions/verify/config.ts")).toBeUndefined();
  });

  test("an empty config never matches", () => {
    expect(matchCheck(emptyConfig(), "a.ts")).toBeUndefined();
  });
});

describe("loadConfig", () => {
  const project = { checks: [{ name: "project", match: "*.ts", command: "project-cmd" }] };
  const global = { checks: [{ name: "global", match: "*.ts", command: "global-cmd" }] };

  function reader(files: Record<string, unknown>) {
    // Keys are full paths: ".pi/verify.json" also ends with "verify.json".
    return (path: string) => files[path];
  }

  test("prefers project config for a trusted project", () => {
    const config = loadConfig({
      cwd: "/repo",
      projectTrusted: true,
      agentDir: "/agent",
      readConfig: reader({ "/repo/.pi/verify.json": project, "/agent/verify.json": global }),
    });
    expect(config.source).toBe("project");
    expect(config.checks[0]?.command).toBe("project-cmd");
  });

  test("ignores project config when the project is untrusted, and says so", () => {
    const config = loadConfig({
      cwd: "/repo",
      projectTrusted: false,
      agentDir: "/agent",
      readConfig: reader({ "/repo/.pi/verify.json": project, "/agent/verify.json": global }),
    });
    // Project config is an executable command; untrusted means never run it.
    expect(config.source).toBe("global");
    expect(config.checks[0]?.command).toBe("global-cmd");
    expect(config.untrustedProjectConfig).toBe(true);
  });

  test("untrusted project config with no global config yields a disabled config", () => {
    const config = loadConfig({
      cwd: "/repo",
      projectTrusted: false,
      agentDir: "/agent",
      readConfig: reader({ "/repo/.pi/verify.json": project }),
    });
    expect(config.enabled).toBe(false);
    expect(config.checks).toEqual([]);
    expect(config.untrustedProjectConfig).toBe(true);
  });

  test("falls back to global config when no project config exists", () => {
    const config = loadConfig({
      cwd: "/repo",
      projectTrusted: true,
      agentDir: "/agent",
      readConfig: reader({ "/agent/verify.json": global }),
    });
    expect(config.source).toBe("global");
    expect(config.untrustedProjectConfig).toBeUndefined();
  });

  test("returns an inert config when nothing is configured", () => {
    const config = loadConfig({ cwd: "/repo", projectTrusted: true, agentDir: "/agent", readConfig: () => undefined });
    expect(config).toEqual(emptyConfig());
  });

  test("falls back to global when project config is malformed", () => {
    const config = loadConfig({
      cwd: "/repo",
      projectTrusted: true,
      agentDir: "/agent",
      readConfig: reader({ "/repo/.pi/verify.json": { checks: "nope" }, "/agent/verify.json": global }),
    });
    expect(config.source).toBe("global");
  });
});

describe("config directory resolution", () => {
  test("resolves the agent directory through Pi rather than hardcoding .pi", () => {
    expect(agentDirectory()).toBe(getAgentDir());
  });

  test("reads the project config from Pi's configured directory name", () => {
    const requested: string[] = [];
    loadConfig({
      cwd: "/repo",
      agentDir: "/agent",
      projectTrusted: true,
      readConfig: (path: string) => {
        requested.push(path);
        return undefined;
      },
    });

    expect(requested).toContain(join("/repo", CONFIG_DIR_NAME, "verify.json"));
    expect(requested).toContain(join("/agent", "verify.json"));
  });
});
