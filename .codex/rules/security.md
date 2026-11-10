# Security Rules

- Treat all project context as private: code, logs, environment files, dumps, URLs, customer records, and credentials.
- Do not reveal secrets or sensitive snippets in summaries, diffs, test output, or examples.
- Do not add telemetry, uploaders, external scanning, remote memory, or automatic context sharing without explicit approval.
- Use local-only tools for security checks. If a tool is missing, report that it was skipped.
- Prefer `.env.example` style placeholders for configuration documentation.
- Be extra careful around authentication, authorization, billing, data export, background jobs, and external API calls.
