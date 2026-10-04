---
name: Pending work only
description: DryRun Visualizer continuations should preserve completed phases and implement only unmet requirements.
---

For DryRun Visualizer, inspect the current project state and phase requirements before editing. Preserve completed work and implement only pending requirements in their existing phase order.

**Why:** The user asked: “remember not to repeat already done tasks, do only what is pending.”

**How to apply:** At the start of each DryRun continuation, compare current code and prior phase status against the remaining requirements; do not redo completed work.