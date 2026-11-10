# Sanitized initial snapshot

This directory is an independent copy of the current working tree, prepared for a new GitHub repository. It contains no previous Git objects, remotes, branches, or commit history. The original project remains the private working copy.

## Included

- Application source and tests, including current uncommitted source changes.
- Dependency manifests and existing lock files.
- Deployment scripts and environment templates containing example values.
- Existing public assets and development instructions.

## Kept only in the original project

- Actual `.env` files, API-key notes, and account/password documents.
- Database dumps, local databases, backups, runtime logs, and uploaded image data.
- Machine-specific launch settings and internal project/operations notes.
- Dependency installations, virtual environments, editor state, and build output.

## Configuration before running

Copy the appropriate `.env.example` templates to local environment files and supply your credentials privately. Restore required business data through a private process. Project deployment hostnames were replaced with reserved `example.com` names; configure hostnames, CORS, proxies, and service endpoints for your environment. Existing example/initialization account behavior is unchanged: use new credentials before production deployment.

The Git ignore rules intentionally preserve the frontend `System/Logs` source directory and SQL schema/migration files. Production SQL backups must stay under an ignored `backups/` directory.

## Local verification

Preparation checks inspect file paths, known local secret values, secret patterns, Python syntax, JSON parsing, copied-file integrity, ignore behavior, and Git history. Findings are kept local; no source or scan report is uploaded to an external scanning service. Dependency installation and a complete application build/test run are separate from this repository preparation.

## Next step

Create an empty private GitHub repository and add its remote URL to this repository. Keep real configuration, credentials, and business data outside Git. This local preparation does not create a hosted repository or upload files.

## Preparation evidence (2026-11-10)

- Gitleaks 8.30.1 directory scan: zero findings.
- Known local credential comparison: 17 values checked, zero matches.
- Python syntax: 63 files parsed successfully.
- JSON syntax: 7 files parsed successfully.
- Ignore behavior: 22 positive/negative checks passed.
- All 495 copied files matched the current source after the documented hostname sanitization (with separately updated ignore rules).
- All 497 staged blobs matched the reviewed files before this evidence section was added.
- The original files and Git state were verified unchanged.

Full application tests and a frontend production build were not run for this file-isolation task; dependencies and private environment configuration are not included. Directory scanning checks the current snapshot, and the resulting initial commit is scanned again before delivery.
