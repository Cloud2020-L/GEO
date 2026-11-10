# GitHub Initial Snapshot Implementation Plan

> Execute in this session. The user approved an independent, sanitized repository under the existing parent directory.

**Goal:** Prepare the current working tree as a new local repository with a single initial commit and no inherited Git history.

**Architecture:** Copy source, tests, dependency manifests, and placeholder configuration templates. Keep credentials, databases, runtime state, internal operational notes, and machine-specific launch settings in the original project only. Replace project deployment hostnames with reserved example.com names in the copy.

**Tech Stack:** Git, Python standard library, and local secret scanning.

## File responsibilities

- `.gitignore`: exclude actual environment files, private documents, keys, sessions, data, and generated artifacts; preserve the frontend System/Logs source and SQL migrations.
- Existing source and tests: preserve current working-tree changes and directory boundaries; deployment hostnames become examples.
- `docs/github-preparation.md`: explain configuration and local verification for this sanitized snapshot.

## Execution

- [x] Inspect tracked/untracked paths, sensitive documents, local environment values, ignore rules, and current changes.
- [x] Create a new sibling directory without copying any `.git` data.
- [x] Copy current files with explicit exclusions and sanitize project deployment domains.
- [x] Refine ignore rules in the new directory only.
- [x] Scan file paths/content and known local credentials; review findings locally.
- [x] Check syntax and file integrity and ensure original files, HEAD, and status remain unchanged.
- [x] Initialize `main` and verify the staged snapshot.
- Create one local initial commit containing this plan and the reviewed snapshot.
- Verify one root commit, clean working tree, and no configured remotes after commit creation; report this final result in the delivery message.

## Risk and rollback

The original repository is retained. Excluded files must be supplied privately for a new deployment. Domain placeholders must be configured for the target environment. Existing demo/initialization credentials in application logic are not production credentials and must be changed before production use. No GitHub remote or upload is configured as part of local preparation.

## Validation

Compare copied bytes against the source except documented sanitization. Check known credential values and secret patterns locally; validate Python syntax and JSON. Check Git ignore rules with representative private paths and real source paths. Verify staged blobs and new repository history before delivery. Report unavailable verification tools honestly.
