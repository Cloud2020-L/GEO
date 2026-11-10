# TDD Workflow Skill

Use this when the user asks for a test-driven change.

1. Restate the intended behavior in one or two concrete examples.
2. Add or update the smallest failing test that captures the behavior.
3. Run the focused test and confirm the failure is meaningful.
4. Implement the minimal code change.
5. Re-run the focused test, then relevant broader checks.
6. Refactor only after tests pass, keeping the diff focused.

Do not use production credentials, real customer data, or external services to drive tests.
