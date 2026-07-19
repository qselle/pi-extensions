# Repository guidelines

- Keep each extension in `extensions/<name>/` with an `index.ts` entry point.
- Write focused, maintainable TypeScript and use Pi's public extension API.
- Add or update focused tests for behavior changes.
- Document commands, configuration, dependencies, and platform limitations in each extension's README.
- Put third-party runtime packages in `dependencies`; Pi-provided APIs are supplied by the host.
- Avoid OS-specific behavior unless the extension documents it explicitly.
- Do not commit dependencies, generated output, logs, secrets, or machine-local state.
