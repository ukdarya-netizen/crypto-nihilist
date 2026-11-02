---
name: Database publish diff
description: How to interpret Replit's development-to-production schema diff.
---

**Rule:** An empty Publish schema diff only means the development and production database schemas match. It does not prove that every table declared in `lib/db/src/schema` exists in either database. Check the specific table and index in both environments before treating an empty diff as evidence that the feature's storage is ready. Do not rely on application-runtime DDL as a substitute for the supported development-schema and Publish flow.

**Why:** A new rejection-outcome table was declared in the schema while both databases lacked it, so the development-to-production diff remained empty.

**How to apply:** After changing a schema file, query `information_schema` in development and production for the requested objects, then inspect the Publish diff. Report missing source-defined objects explicitly.
