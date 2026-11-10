/**
 * Private bot (owner 2026-11-02: buttons and access "точно как в CAB").
 * Public: /start (welcome + buttons), /myid, /prices, /subscription,
 * /resetpassword. Subscribers (approved, subscription active) and the owner:
 * /menu, /daily, /weekly, /monthly, /unsubscribe (/stop).
 * Owner: approve / block buttons on a new registration.
 * Plain text only (no HTML).
 */
import { randomInt } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { accessStatus, isOwnerChat, isOwnerEmail, ownerChatId, userByChatId, userById, type UserRow } from "../lib/users";
import { buildReport, type ReportKind, type Schedule } from "./reports";
import {
  BLOCKED_TEXT, BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, BUTTONS, MENU_DESCRIPTIONS, alreadySubscribedText, langOf, menuText, myIdText,
  pricesText, privateManageText, privateOnlyText, reportBuildingText, reportFailedText, resetCodeText, resetNoAccountText,
  signalsBackOnText, subscriptionRenewedText, subscriptionStartedText, subscriptionStatusText, unknownCommandText,
  unsubscribeConfirmText, unsubscribedText, welcomeText, type Lang,
} from "./bot-texts";
export { BLOCKED_TEXT, DEACTIVATED_TEXT, PASSWORD_CHANGED_TEXT, subscriptionRenewedText, subscriptionStartedText, welcomeText } from "./bot-texts";
import {
  editMessage, sendMessageKb, telegramCall, type InlineKeyboard, type TelegramMessage, type TelegramUpdate,
} from "./transport";

export { CONTACT } from "./bot-texts";
const TZ = "Asia/Dubai";

export function dashboardUrl(): string {
  const env = process.env.NIHILIST_DASHBOARD_URL?.trim();
  if (env) return env.replace(/\/+$/, "") + "/";
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  // As CAB (fixed site address): the buttons are always there, also when the deployment has no REPLIT_DOMAINS.
  return domain && !domain.includes("replit.dev") ? `https://${domain}/` : PROD_URL;
}
const PROD_URL = "https://crypto-nihillyst.replit.app/";

// ---------------- commands ----------------
type Access = "public" | "subscriber";
type Command = { command: string; aliases?: string[]; access: Access; privateOnly?: boolean; menu?: string };

export const COMMANDS: Command[] = [
  { command: "/start", access: "public", menu: "Start the bot" },
  { command: "/myid", access: "public", menu: "Show Chat ID" },
  { command: "/menu", access: "subscriber" },
  { command: "/daily", access: "subscriber", menu: "Daily report" },
  { command: "/weekly", access: "subscriber", menu: "Weekly report" },
  { command: "/monthly", access: "subscriber", menu: "Monthly digest" },
  { command: "/prices", aliases: ["/pricing"], access: "public", menu: "Pricing" },
  { command: "/subscription", aliases: ["/sub", "/expiry"], access: "public", menu: "Subscription status and dates" },
  { command: "/unsubscribe", aliases: ["/stop"], access: "subscriber", privateOnly: true, menu: "Unsubscribe from signals" },
  { command: "/resetpassword", access: "public", privateOnly: true, menu: "Reset Dashboard password" },
];

export const BOT_MENU = COMMANDS.flatMap((c) => (c.menu ? [{ command: c.command.slice(1), description: c.menu }] : []));
/** The command menu in the user's app language (Telegram picks it by language_code). */
export const botMenu = (lang: Lang) => COMMANDS.flatMap((c) => (c.menu ? [{ command: c.command.slice(1), description: MENU_DESCRIPTIONS[c.command]?.[lang] ?? c.menu }] : []));

export function parseCommand(text: string | undefined): string | null {
  const token = text?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!token?.startsWith("/")) return null;
  const cmd = token.split("@")[0];
  return cmd && cmd !== "/" ? cmd : null;
}

export function findCommand(cmd: string): Command | undefined {
  return COMMANDS.find((c) => c.command === cmd || c.aliases?.includes(cmd));
}

// ---------------- language ----------------
/** Language of every chat seen (nh_state "tg_lang:<chat>"), for messages sent outside a reply (approval, block…). */
const chatLang = new Map<string, Lang>();
async function rememberLang(chatId: string, code: string | undefined): Promise<Lang> {
  const lang = langOf(code);
  if (chatLang.get(chatId) !== lang) {
    chatLang.set(chatId, lang);
    await pool.query(
      `INSERT INTO nh_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`tg_lang:${chatId}`, JSON.stringify(lang)],
    ).catch((err) => logger.warn({ err }, "nihilist: chat language not saved"));
  }
  return lang;
}
/** Language of messages outside a reply: English for everyone (owner 2026-11-10). */
export async function langOfChat(_chatId: string): Promise<Lang> {
  return "en";
}

export function subscriptionStatus(user: UserRow | null, now = Date.now()) {
  if (!user) return { found: false as const };
  const owner = isOwnerEmail(user.email);
  return {
    found: true as const,
    active: accessStatus(user, new Date(now)) === "approved" && user.notify,
    start: user.approved_at ?? user.created_at,
    until: owner ? null : user.subscribed_until,
  };
}

// ---------------- keyboards (as CAB) ----------------
export const subscriptionStatusKeyboard = (lang: Lang): InlineKeyboard => [[{ text: BUTTONS.subscriptionEnd(lang), callback_data: "subscription_status" }]];
const unsubscribeKeyboard = (lang: Lang): InlineKeyboard => [[
  { text: BUTTONS.unsubscribeYes(lang), callback_data: "unsubscribe_yes" },
  { text: BUTTONS.unsubscribeNo(lang), callback_data: "unsubscribe_no" },
]];

/** As CAB: Mini App, website, subscription end date. */
export function welcomeKeyboard(lang: Lang): InlineKeyboard {
  const url = dashboardUrl();
  return [
    [{ text: BUTTONS.openApp(lang), web_app: { url } }],
    [{ text: BUTTONS.openSite(lang), url }],
    ...subscriptionStatusKeyboard(lang),
  ];
}

// ---------------- owner notifications ----------------
export async function notifyOwnerRegistration(
  u: { id: number; name: string; email: string; chatId: string; telegramUsername: string | null },
  resubmitted: "blocked" | "expired" | null,
): Promise<void> {
  const owner = await ownerChatId();
  if (!owner) { logger.warn("nihilist: new registration, owner chat unknown (NIHILIST_OWNER_EMAIL / Chat ID)"); return; }
  const tg = u.telegramUsername ? `@${u.telegramUsername} · ID: ${u.chatId}` : `ID: ${u.chatId}`;
  const head = resubmitted ? "🔐 Repeat Dashboard access request" : "🔐 New Dashboard access request";
  const reason = resubmitted === "blocked"
    ? ["", "The account was blocked — the user asked for access again."]
    : resubmitted === "expired" ? ["", "The subscription expired — the user asked for access again."] : [];
  await sendMessageKb(owner, [head, "", `👤 ${u.name}`, `📧 ${u.email}`, `💬 ${tg}`, ...reason].join("\n"), [[
    { text: "✅ Approve", callback_data: `approve_user:${u.id}` },
    { text: "❌ Block", callback_data: `block_user:${u.id}` },
  ]]);
}

/** A message outside a reply (owner actions): in the language the chat last used with the bot. */
export function sendQuiet(chatId: string | null, text: string | ((lang: Lang) => string), keyboard?: InlineKeyboard): void {
  if (!chatId) return;
  void (async () => {
    const body = typeof text === "string" ? text : text(await langOfChat(chatId));
    await sendMessageKb(chatId, body, keyboard);
  })().catch((err) => logger.warn({ err }, "nihilist: bot message not delivered"));
}

// ---------------- handlers ----------------
async function isSubscriberChat(chatId: string): Promise<{ user: UserRow | null; ok: boolean }> {
  const user = await userByChatId(chatId);
  const ok = (user !== null && accessStatus(user) === "approved") || await isOwnerChat(chatId);
  return { user, ok };
}

export function onDemandSchedule(kind: ReportKind, now: number): Schedule {
  const TZ_MS = 4 * 3_600_000, DAY = 86_400_000;
  if (kind === "daily") {
    const from = Math.floor((now + TZ_MS) / DAY) * DAY - TZ_MS;
    return { kind, at: now, from, to: now, period: -1 };
  }
  return { kind, at: now, from: now - (kind === "weekly" ? 7 : 30) * DAY, to: now, period: -1 };
}

async function handleMessage(m: TelegramMessage): Promise<void> {
  const chatId = String(m.chat.id);
  const isPrivate = m.chat.type === "private";
  const cmd = parseCommand(m.text);
  if (!cmd) return;
  const lang = isPrivate ? await rememberLang(chatId, m.from?.language_code) : langOf(m.from?.language_code);
  const def = findCommand(cmd);
  if (!def) {
    await sendMessageKb(chatId, unknownCommandText(lang));
    return;
  }
  if (def.privateOnly && !isPrivate) {
    await sendMessageKb(chatId, privateOnlyText(lang, def.command === "/resetpassword"));
    return;
  }

  switch (def.command) {
    case "/myid": {
      // As CAB: the Chat ID is a code span — one tap copies it (plain text + entity, no HTML).
      const text = myIdText(lang, chatId, m.from?.id ?? null);
      const offset = text.indexOf(chatId);
      await telegramCall("sendMessage", { chat_id: chatId, text, entities: [{ type: "code", offset, length: chatId.length }] });
      return;
    }
    case "/start": {
      const user = isPrivate ? await userByChatId(chatId) : null;
      let extra = "";
      if (user && accessStatus(user) === "approved" && !user.notify) {
        await pool.query("UPDATE nh_users SET notify = true, notify_since = now(), bot_blocked_at = NULL WHERE id = $1", [user.id]);
        extra = signalsBackOnText(lang);
      } else if (user?.bot_blocked_at) {
        await pool.query("UPDATE nh_users SET bot_blocked_at = NULL WHERE id = $1", [user.id]);
      }
      await sendMessageKb(chatId, welcomeText(lang) + extra, welcomeKeyboard(lang));
      return;
    }
    case "/prices":
      await sendMessageKb(chatId, pricesText(lang));
      return;
    case "/subscription":
      await sendMessageKb(chatId, subscriptionStatusText(lang, subscriptionStatus(await userByChatId(chatId))), subscriptionStatusKeyboard(lang));
      return;
    case "/resetpassword": {
      const user = await userByChatId(chatId);
      if (!user) {
        await sendMessageKb(chatId, resetNoAccountText(lang));
        return;
      }
      const code = String(randomInt(100000, 1000000));
      await pool.query("DELETE FROM nh_password_resets WHERE user_id = $1", [user.id]);
      await pool.query("INSERT INTO nh_password_resets (user_id, code, expires_at) VALUES ($1, $2, now() + interval '15 minutes')", [user.id, code]);
      await sendMessageKb(chatId, resetCodeText(lang, code));
      return;
    }
  }

  const { ok } = await isSubscriberChat(chatId);
  if (!ok) {
    await sendMessageKb(chatId, welcomeText(lang), welcomeKeyboard(lang));
    return;
  }
  switch (def.command) {
    case "/menu":
      await sendMessageKb(chatId, menuText(lang), subscriptionStatusKeyboard(lang));
      return;
    case "/unsubscribe":
      await sendMessageKb(chatId, unsubscribeConfirmText(lang), unsubscribeKeyboard(lang));
      return;
    case "/daily": case "/weekly": case "/monthly": {
      const kind = def.command.slice(1) as ReportKind;
      await sendMessageKb(chatId, reportBuildingText(lang, kind));
      try {
        await sendMessageKb(chatId, await buildReport(onDemandSchedule(kind, Date.now()), lang));
      } catch (err) {
        logger.warn({ err }, "nihilist: on-demand report failed");
        await sendMessageKb(chatId, reportFailedText(lang));
      }
      return;
    }
  }
}

const ownerDate = (d: Date) => d.toLocaleDateString("en-GB", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
const monthLater = (from: Date) => { const d = new Date(from); d.setMonth(d.getMonth() + 1); return d; };

async function handleCallback(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const data = cq.data ?? "";
  await telegramCall("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => undefined);
  const msg = cq.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const lang = msg.chat.type === "private" ? await rememberLang(chatId, cq.from.language_code) : langOf(cq.from.language_code);

  if (data === "subscription_status") {
    await sendMessageKb(chatId, subscriptionStatusText(lang, subscriptionStatus(await userByChatId(String(cq.from.id)))), subscriptionStatusKeyboard(lang));
    return;
  }

  if (data.startsWith("approve_user:") || data.startsWith("block_user:")) {
    if (!await isOwnerChat(cq.from.id)) { await sendMessageKb(chatId, "⛔ Only the owner can do this."); return; }
    const id = Number(data.slice(data.indexOf(":") + 1));
    const before = Number.isSafeInteger(id) && id > 0 ? await userById(id) : null;
    if (!before) { await editMessage(chatId, msg.message_id, "❌ User not found."); return; }
    if (data.startsWith("approve_user:")) {
      const now = new Date();
      const until = monthLater(now);
      const wasActive = accessStatus(before, now) === "approved";
      await pool.query(
        `UPDATE nh_users SET status = 'approved', approved_at = now(), subscribed_until = $2,
           notify = true, notify_since = COALESCE(CASE WHEN $3 THEN notify_since END, now()) WHERE id = $1`,
        [id, until, wasActive],
      );
      await editMessage(chatId, msg.message_id, `✅ ${before.name} approved\n📧 ${before.email}\n📅 until ${ownerDate(until)}`);
      sendQuiet(before.chat_id, wasActive ? subscriptionRenewedText(until) : subscriptionStartedText(until));
    } else {
      await pool.query("UPDATE nh_users SET status = 'blocked', approved_at = NULL WHERE id = $1", [id]);
      await editMessage(chatId, msg.message_id, `❌ ${before.name} blocked\n📧 ${before.email}`);
      if (before.status !== "blocked") sendQuiet(before.chat_id, BLOCKED_TEXT);
    }
    logger.info({ id, data }, "nihilist: user status changed from Telegram");
    return;
  }

  if (msg.chat.type !== "private") {
    await sendMessageKb(chatId, privateManageText(lang));
    return;
  }
  const { user, ok } = await isSubscriberChat(String(cq.from.id));
  if (!ok) { await sendMessageKb(chatId, welcomeText(lang), welcomeKeyboard(lang)); return; }

  if (data === "unsubscribe_confirm") {
    await editMessage(chatId, msg.message_id, unsubscribeConfirmText(lang), unsubscribeKeyboard(lang));
  } else if (data === "unsubscribe_yes") {
    if (user) await pool.query("UPDATE nh_users SET notify = false WHERE id = $1", [user.id]);
    await editMessage(chatId, msg.message_id, unsubscribedText(lang));
  } else if (data === "unsubscribe_no") {
    await editMessage(chatId, msg.message_id, alreadySubscribedText(lang), [[{ text: BUTTONS.unsubscribe(lang), callback_data: "unsubscribe_confirm" }]]);
  }
}

export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  try {
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (err) {
    logger.warn({ err, updateId: update.update_id }, "nihilist: bot update failed");
  }
}

/**
 * Menu and profile texts — English for everyone (owner 2026-11-10). The Russian-language versions set earlier
 * for ru apps are removed, so Russian-language apps also get the English menu and description.
 */
export async function setBotMenu(): Promise<void> {
  const warn = (what: string) => (err: unknown) => logger.warn({ err }, `nihilist: ${what} failed`);
  await telegramCall("setMyCommands", { commands: botMenu("en") }).catch(warn("setMyCommands"));
  await telegramCall("setMyDescription", { description: BOT_DESCRIPTION.en }).catch(warn("setMyDescription"));
  await telegramCall("setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION.en }).catch(warn("setMyShortDescription"));
  await telegramCall("deleteMyCommands", { language_code: "ru" }).catch(warn("deleteMyCommands ru"));
  await telegramCall("setMyDescription", { description: "", language_code: "ru" }).catch(warn("setMyDescription ru"));
  await telegramCall("setMyShortDescription", { short_description: "", language_code: "ru" }).catch(warn("setMyShortDescription ru"));
}

let botUsername: string | null = null;
/** Bot @username for the registration hint (getMe, cached). */
export async function getBotUsername(): Promise<string | null> {
  const env = process.env.NIHILIST_BOT_USERNAME?.trim().replace(/^@/, "");
  if (env) return env;
  if (botUsername || !process.env.TELEGRAM_BOT_TOKEN) return botUsername;
  try {
    const me = await telegramCall<{ username?: string }>("getMe", {});
    botUsername = me.username ?? null;
  } catch { /* unknown for now */ }
  return botUsername;
}
