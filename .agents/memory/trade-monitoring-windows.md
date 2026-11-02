---
name: Crypto Nihilist trade monitoring windows
description: User intent for open-position and post-close observations.
---

Crypto Nihilist needs persistent metrics while trades are open and for 72 hours after actual close so the user can evaluate whether moving the stop to break-even is worthwhile. The user corrected the agent that open snapshots and post-close tracking had already been built; do not assume the feature is missing because there is no separately named table. Inspect the cadence, anchor event, and stored rows before changing it.

**Why:** the user had explicitly requested this several days earlier and corrected the agent for overlooking existing work.

**How to apply:** distinguish open-position samples, samples after BE, and a 72-hour window anchored to actual close. Preserve existing tracking and avoid duplicate tables unless the current implementation is verified to lack the requested window.
