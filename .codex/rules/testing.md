# Testing Rules

- Run the smallest relevant verification first; broaden to `make check` for risky or cross-cutting changes.
- Keep tests deterministic and local. Do not require production services or real credentials.
- For Python behavior changes, prefer `pytest` tests under `后端源码/ai-service/tests`.
- For frontend changes, use existing npm scripts under `前端源码/zggeo-dashboard` when available.
- If a tool is not installed or an environment dependency is missing, state exactly what was skipped.
- Do not hide failing checks. Report the failing command and the useful failure summary.
