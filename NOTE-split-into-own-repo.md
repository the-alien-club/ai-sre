# NOTE: split `e2e-agent/` into its own repo

The `e2e-agent/` subdirectory was scaffolded on the `claude/e2e-testing-agent-LyiAf`
branch of `the-alien-club/ai-sre` for ease of review. It is a sibling project to
the SRE agent, not a feature of it.

When the skeleton is approved and the team is ready to run it on its own VM, split
it out into its own repo (e.g. `the-alien-club/ai-qa` or `the-alien-club/e2e-agent`):

```bash
# From the ai-sre repo, after merging this branch to main:
git subtree split --prefix=e2e-agent -b e2e-agent-split

# Create the new repo on GitHub, then:
git push git@github.com:the-alien-club/e2e-agent.git e2e-agent-split:main

# Once the new repo exists, remove e2e-agent/ from ai-sre:
git rm -r e2e-agent/
git commit -m "Move e2e-agent to its own repo"
```

After splitting:
- Move `NOTE-split-into-own-repo.md` (this file) to the new repo's root and
  update it to record the split.
- The new repo's `start-agent.sh`, `ecosystem.config.cjs`, and `.mcp.json` already
  assume they live at the repo root, so no path rewrites needed.
- Provision a separate VM (or reuse the SRE VM with a different PM2 app name) —
  the two agents can coexist as long as their webhook ports don't collide.
