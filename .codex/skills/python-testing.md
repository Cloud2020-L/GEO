# Python Testing Skill

Use this when adding, repairing, or running Python tests.

1. Read existing tests under `后端源码/ai-service/tests` before adding new test style.
2. Name tests around observable behavior and business rule outcomes.
3. Prefer local fakes or monkeypatching over live network, production database, or real external APIs.
4. Cover permission, billing, persistence, and failure paths when those areas are touched.
5. Run the narrowest relevant `pytest` command first.
6. If the local environment lacks `pytest` or required services, record what was skipped and why.

Suggested commands:

```bash
pytest 后端源码/ai-service/tests
make test
make check
```
