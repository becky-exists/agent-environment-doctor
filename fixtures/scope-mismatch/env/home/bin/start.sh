#!/bin/bash
# Launch script. Injects the same rule text a second time through --append-system-prompt.
# Not collected in Phase 0 (launch-script collection is frozen pending independent review).
# Kept in the fixture so the second injection path exists when collection is switched on.
exec claude --channels telegram --append-system-prompt "$(cat ~/.claude/rules/channels-only.md)"
