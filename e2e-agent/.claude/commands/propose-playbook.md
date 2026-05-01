# Propose Playbook Change

Queue a change to a markdown playbook for owner approval over Slack. Use when a
sub-agent has discovered a recurring pattern worth capturing — NOT for one-off MR
quirks.

## When to invoke

- Same lesson has come up 2+ times in recent investigations (check the briefing
  or history for patterns)
- A new service / surface needs its own playbook section (e.g., a new MCP server
  pattern)
- An existing playbook recipe is now wrong because the underlying tech changed

## Don't invoke for

- One-off bug fixes specific to a single MR
- Pure typo / grammar fixes (just edit directly if minor)
- Changes that would belong in source code, not a playbook

## Procedure

1. Decide the file and change kind:
   - `playbooks/<existing>.md` + `add_section` for a new recipe
   - `playbooks/<existing>.md` + `edit_section` for a correction
   - `playbooks/<new>.md` + `new_file` for a brand-new playbook
   - `playbooks/<existing>.md` + `delete_section` for retiring outdated info

2. Generate a 5-letter slug for the proposal id (lowercase, no a/l — same
   pattern as permission ids: `[b-km-z]{5}`).

3. Save the proposal to the DB so it survives a restart:
```bash
./scripts/tests.sh proposal --id <slug> --file <path> --kind <kind> \
  --rationale "<1-3 sentences>" \
  --markdown "$(cat <<'EOF'
<full proposed markdown content>
EOF
)"
```

4. Call the channel tool to notify the owner:
```
propose_playbook_change({
  proposal_id: "<slug>",
  file_path: "<path>",
  change_kind: "<kind>",
  rationale: "<1-3 sentences>",
  proposed_markdown: "<full proposed markdown content>"
})
```

5. Wait for the `<channel source="slack_qa" type="playbook_decision" ...>` event.

## On owner approval

When you receive `playbook_decision` with `decision=approved`:

1. Apply the change. The simplest path:
   - For `new_file`: write the proposed markdown directly to the file path
   - For `add_section`: append the markdown to the file (or insert at the
     section boundary marked in the proposal)
   - For `edit_section`: replace the section that the proposal targets
   - For `delete_section`: remove the section

2. Commit (the QA agent has write access to its OWN repo only):
```bash
cd <e2e-agent root>
git add <file>
git commit -m "playbook: <rationale (1 line)>"
```

3. Mark the proposal committed:
```bash
./scripts/tests.sh proposal-decide --id <slug> --status committed --notes "applied and committed"
```

4. Reply on the proposal thread with a confirmation.

## On owner rejection

When you receive `playbook_decision` with `decision=rejected`:

1. Mark the proposal:
```bash
./scripts/tests.sh proposal-decide --id <slug> --status rejected --notes "<reason from owner>"
```

2. Don't try to argue. The owner has context you don't.

## Don't

- Don't apply the change before approval
- Don't push to the remote without explicit owner approval (this skeleton's
  default is local commit only — push policy is set by the owner)
- Don't propose more than 2-3 playbook changes per day. If you find yourself
  wanting to, the playbooks need a redesign, not patches.
