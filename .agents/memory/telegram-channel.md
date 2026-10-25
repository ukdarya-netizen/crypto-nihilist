---
name: Telegram channel
description: The user's selected destination for Crypto Nihilist signal delivery.
---

For Crypto Nihilist signal forwarding, the user selected `@nihilystcryptotrading` as the destination channel.

**Why:** the user specified this channel as the destination for bot signals.

**How to apply:** use this destination when configuring Telegram delivery for the published app. The development workspace intentionally disables Telegram polling unless forced.

For live signal events with no eligible Telegram recipient, leave delivery unmarked. Automatic recovery is allowed only while the event is no more than 15 minutes old; older events must not be replayed automatically.

**Why:** the user explicitly said not to resend a stale ALT signal. A short freshness window still allows recovery when a channel is configured shortly after a signal is created.

**How to apply:** preserve the pending state without creating deliveries when no recipient exists, and require explicit review for any older replay.
