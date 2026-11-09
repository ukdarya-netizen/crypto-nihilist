---
name: Production database access
description: Distinguish local development database connections from Replit production read-only queries.
---

The local shell's `DATABASE_URL` points to the writable development database (`heliumdb` was observed with `transaction_read_only=off`). Do not assume a local API analysis script runs against production. Use the production SQL path for supported read-only queries; do not run a local script against production data unless an approved production connection method is available.

**Why:** A requested production analysis script would otherwise have connected to the development database while appearing to complete normally.

**How to apply:** Before running any local script that reads important data, verify which database its `DATABASE_URL` targets without printing the connection string. If it is dev, stop and use the supported production query interface or obtain an explicitly authorized, read-only production connection.
