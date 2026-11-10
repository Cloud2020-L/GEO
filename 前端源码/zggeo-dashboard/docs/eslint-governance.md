# ESLint Governance

## Current Baseline

The project currently uses ESLint 8 with `.eslintrc.js`.

Required local checks:

```bash
npm run lint
npm run format:check
npm run typecheck
```

Required delivery checks:

```bash
npm run verify:build
```

`npm run lint` runs with `--quiet`, so only ESLint errors block delivery. Use `npm run lint:all` to inspect warnings.

## Rule Layers

### Blocking Rules

These rules should stay as delivery blockers because they have low false-positive risk:

- `react-hooks/rules-of-hooks`
- `no-param-reassign`
- `no-plusplus` with loop afterthoughts allowed
- `import/no-extraneous-dependencies`
- JSX quote consistency

### Accepted Project Style

These rules are disabled because they conflict with the current dashboard code style or duplicate TypeScript behavior:

- `no-shadow`
- `no-use-before-define`
- `@typescript-eslint/no-use-before-define`
- `no-nested-ternary`
- `arrow-body-style`
- `class-methods-use-this`
- `no-underscore-dangle`
- `no-continue`
- `react/no-unescaped-entities`
- `prefer-destructuring`
- `no-console`

### Historical Debt

These rules are useful, but should not be enabled globally until the codebase is prepared:

- `import/no-cycle`
- `import/no-unresolved`
- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/ban-types`

Before enabling import resolution rules, configure Vite alias resolution for ESLint. Before enabling `no-explicit-any`, start with service-layer and shared-component changes before page-level legacy code.

## Warning Baseline

At the time this document was added, `npm run lint:all` reported:

- 0 errors
- 32 warnings

Main warning categories:

- unused variables
- React Hooks dependency warnings
- a small number of `no-alert` warnings
- non-null assertion warnings in legacy page logic

Warnings are visible in `lint:all`, but are not delivery blockers until a specific rule is promoted to error.

## Dependency Policy

Only keep ESLint packages that are actually used by `.eslintrc.js`.

`eslint-config-react-app` is intentionally not used by this project and should not be reintroduced unless the project explicitly migrates to that preset.

## ESLint 9 Policy

Do not upgrade directly to ESLint 9 in a mixed feature branch.

Migration to flat config should be handled as a separate task after:

- `npm run verify:build` passes.
- warning categories are reviewed.
- unused ESLint dependencies are removed.
- import resolver strategy is decided.
