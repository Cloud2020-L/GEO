# Python Rules

- Backend code lives primarily under `后端源码/ai-service`; read adjacent modules and tests before changing behavior.
- Prefer straightforward Python with explicit names, small functions, and clear error paths.
- Keep framework usage consistent with the surrounding FastAPI, service, model, queue, and persistence patterns.
- Avoid import-time network calls, database writes, or environment-dependent side effects.
- For behavior changes, add or update focused tests near the affected feature.
- Never hard-code secrets, tokens, customer data, private URLs, or production-only values.
