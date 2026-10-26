# Operator entry points. Run from an operator machine, never from the agent VM.

.PHONY: test rollback-write-access

test:
	npm test

# Restore the agent's write access after the Rundeck cutover; see the script header.
#   make rollback-write-access VM=<host> CONFIRM=yes [CONTEXTS="ctx1 ctx2"] [DRY_RUN=1]
rollback-write-access:
	@test -n "$(VM)" || { echo "Required: VM=<agent VM host>"; exit 1; }
	@test "$(CONFIRM)" = yes || { echo "Required: CONFIRM=yes (changes RBAC on production clusters)"; exit 1; }
	scripts/rollback-write-access.sh --vm "$(VM)" --yes \
		$(if $(CONTEXTS),--contexts "$(CONTEXTS)") \
		$(if $(DRY_RUN),--dry-run)
