# Python Patterns Skill

Use this when implementing or reviewing Python behavior in this repository.

1. Read the nearest route, service, model, schema, and test files.
2. Identify the existing boundary for the change: API route, service method, persistence layer, queue worker, or utility.
3. Keep business rules in the same layer used by neighboring code.
4. Prefer explicit validation and typed data shapes where the project already uses them.
5. Avoid broad refactors unless they are required for the requested behavior.
6. Run focused tests first, then broader checks if the change touches shared paths.

Security reminder: do not introduce real secrets, production credentials, or customer data into fixtures or examples.
