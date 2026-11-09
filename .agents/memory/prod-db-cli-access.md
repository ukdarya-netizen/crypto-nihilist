---
name: Production database access
description: Distinguish local development database connections from Replit production read-only queries.
---

The local shell's `DATABASE_URL` points to the writable development database (`heliumdb` was observed with `transaction_read_only=off`). A separately supplied production URL was also unreachable from the workspace, so do not assume production connectivity from the shell. Use the production SQL path for supported read-only queries; do not run a local analysis script against production data unless an approved, reachable production connection method is available.

**Why:** A requested production analysis script would otherwise have connected to the development database while appearing to complete normally; the attempted production endpoint could not be reached from the workspace.

**How to apply:** Before running any local script that reads important data, verify which database its `DATABASE_URL` targets without printing the connection string. If it is dev or the production host is unreachable, stop and use the supported production query interface or obtain an explicitly authorized, reachable read-only production connection.
