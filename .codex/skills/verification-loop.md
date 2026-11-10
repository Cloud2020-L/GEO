# Verification Loop Skill

Use this before handing off substantial work.

1. Identify the affected surface: backend, frontend, scripts, docs, security, or deployment.
2. Run the smallest useful command for that surface.
3. If the change is cross-cutting or safety-sensitive, run `make check`.
4. Inspect failures and fix issues that are in scope.
5. Re-run the failed command after a fix.
6. Report commands run, results, skipped tools, and remaining risk.

Local verification should not upload code, logs, environment variables, or scan results.
