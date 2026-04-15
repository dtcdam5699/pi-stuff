# pi-stuff

Small monorepo for two standalone pi extension packages:

- `packages/context-chart` → `pi-context-chart`
- `packages/codex-usage` → `pi-codex-usage`

## Install locally

Install either package directly from this repo:

```bash
pi install ./packages/context-chart
pi install ./packages/codex-usage
```

## Publish separately

From each package directory:

```bash
cd packages/context-chart && npm publish
cd packages/codex-usage && npm publish
```

Then users can install them independently:

```bash
pi install npm:pi-context-chart
pi install npm:pi-codex-usage
```

## Local development in this repo

Project-local pi loaders live here:

- `.pi/extensions/context-chart.ts`
- `.pi/extensions/codex-usage.ts`

They point at the package sources so `/reload` keeps working while developing in this repo.
