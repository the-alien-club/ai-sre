# Versioning — claude-sre (SRE agent)

The agent ships no container image and no Helm chart: it is deployed to its VM by copying
a tagged commit (INSTALL.md). Its version therefore lives in exactly one place.

| File | Field | Notes |
|---|---|---|
| `package.json` | `version` | The only version. Semver: `fix` → patch, `feat` → minor, breaking → major. |
| `package-lock.json` | `version`, `packages[""].version` | Updated together with `package.json` by `npm version`. |

No other repository pins this version: k8s-charts and data-cluster-helm hold only the
agent's RBAC subjects and the Trivy operator's webhook URL, never a version.

## How to bump

```bash
npm version <patch|minor|major> --no-git-tag-version
git commit -am "chore(sre-agent): bump version to X.Y.Z"
```

`--no-git-tag-version` because release tags are created from `main` at deploy time, not on
feature branches. Never put `[skip ci]` in the bump commit: the MR pipeline must run.

## Enforcement

The `check-version-bump` CI job (ci-scripts `version-bump` template) fails an MR whose
branch does not bump `package.json` against its target branch.
