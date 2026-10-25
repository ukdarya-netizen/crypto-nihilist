---
name: Dashboard JSX dev transform
description: A Vite development-plugin parsing constraint affecting generic JSX component tags.
---

In this dashboard, the Replit Vite development metadata transform can break JSX components written with explicit type arguments such as `<Segmented<boolean> ... />`. Prefer type inference plus a narrowly typed callback when needed.

**Why:** the transform injects metadata attributes into the JSX opening tag and produces syntax the JSX parser rejects, even though production builds may still pass.

**How to apply:** when a page works in production build but fails in the dev preview with a JSX parse error at a generic component tag, remove the tag's explicit type arguments and preserve the callback's intended type.
