# Security Review Skill

Use this when reviewing changes for security risk.

1. Check for accidental secrets, tokens, private URLs, logs, dumps, and customer data.
2. Review authentication, authorization, billing, data export, background job, and external API paths with extra care.
3. Confirm new scripts and automation run locally and do not upload project context.
4. Prefer placeholders in examples and environment templates.
5. Run `make security` when local tools are available.
6. Report findings by severity with file references and clear remediation.

Never paste sensitive values into the final answer.
