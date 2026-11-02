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
  editMessage, sendMessageKb, telegramCall, type InlineKeyboard, type TelegramMessage, type TelegramUpdate,
} from "./transport";

export const CONTACT = "@The_Lucy_x";
const TZ = "Asia/Dubai";

export function dashboardUrl(): string | null {
  const env = process.env.NIHILIST_DASHBOARD_URL?.trim();
  if (env) return env.replace(/\/+$/, "") + "/";
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  return domain ? `https://${domain}/` : null;
}

// ---------------- commands ----------------
type Access = "public" | "subscriber";
type Command = { command: string; aliases?: string[]; access: Access; privateOnly?: boolean; menu?: string };

export const COMMANDS: Command[] = [
  { command: "/start", access: "public", menu: "Начать работу с ботом" },
  { command: "/myid", access: "public", menu: "Показать Chat ID" },
  { command: "/menu", access: "subscriber" },
  { command: "/daily", access: "subscriber", menu: "Дневной отчёт" },
  { command: "/weekly", access: "subscriber", menu: "Недельный отчёт" },
  { command: "/monthly", access: "subscriber", menu: "Месячный дайджест" },
  { command: "/prices", aliases: ["/pricing"], access: "public", menu: "Тарифы" },
  { command: "/subscription", aliases: ["/sub", "/expiry"], access: "public", menu: "Статус и даты подписки" },
  { command: "/unsubscribe", aliases: ["/stop"], access: "subscriber", privateOnly: true, menu: "Отписаться от сигналов" },
  { command: "/resetpassword", access: "public", privateOnly: true, menu: "Сбросить пароль Dashboard" },
];

export const BOT_MENU = COMMANDS.flatMap((c) => (c.menu ? [{ command: c.command.slice(1), description: c.menu }] : []));

export function parseCommand(text: string | undefined): string | null {
  const token = text?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!token?.startsWith("/")) return null;
  const cmd = token.split("@")[0];
  return cmd && cmd !== "/" ? cmd : null;
}

export function findCommand(cmd: string): Command | undefined {
  return COMMANDS.find((c) => c.command === cmd || c.aliases?.includes(cmd));
}

// ---------------- texts ----------------
export function welcomeText(): string {
  return [
    "🚀 NIHILYST — сигналы по ордер-блокам и слому структуры",
    "",
    "Вход от ордер-блока старшего ТФ (4h / 1D) после слома структуры на младшем (30m / 1h). Лонги и шорты.",
    "",
    "Что ты получаешь внутри:",
    "",
    "✅ Сигналы со входом и стопом.",
    "✅ Сопровождение сделки — безубыток, трейлинг-стоп, закрытие.",
    "✅ Дневной, недельный и месячный отчёты.",
    "✅ Dashboard — открытые позиции, история сигналов, статистика.",
    "",
    "📱 Доступ через Mini App прямо в Telegram",
    "Регистрация, позиции и история — всё открывается внутри Telegram. Нажми кнопку «📱 Открыть NIHILYST» ниже.",
    "",
    "💎 Доступ ограничен",
    "Бот работает в закрытом режиме: сигналы приходят только после регистрации в Dashboard и одобрения доступа.",
    "",
    "🆔 Как узнать Chat ID",
    "Нажми кнопку «Показать Chat ID» в меню бота — бот отправит твой Chat ID. Его нужно указать при регистрации.",
    "",
    "💰 Подключение — 100 USDT / месяц",
    `По вопросам оплаты и доступа — ${CONTACT}`,
  ].join("\n");
}

export const PRICES_TEXT = [
  "💎 NIHILYST — Тарифы",
  "",
  "💰 1 месяц — 100 USDT",
  "",
  "Что входит:",
  "• Сигналы 24/7 — лонги и шорты",
  "• Сопровождение каждой сделки",
  "• Отчёты: день, неделя, месяц",
  "• Dashboard с позициями и статистикой",
  "",
  `Для оплаты или вопросов — ${CONTACT}`,
].join("\n");

export const ALREADY_SUBSCRIBED_TEXT = [
  "✅ У тебя уже есть доступ!",
  "",
  "Сигналы приходят автоматически. Используй /menu для отчётов.",
].join("\n");

export const MENU_TEXT = [
  "📋 Доступные команды",
  "",
  "/daily — Дневной отчёт",
  "/weekly — Недельный отчёт",
  "/monthly — Месячный дайджест",
  "/subscription — Начало и окончание подписки",
  "/prices — Тарифы",
  "/unsubscribe — Отписаться",
].join("\n");

const UNSUBSCRIBE_CONFIRM_TEXT = [
  "❓ Точно хочешь отписаться?",
  "",
  "Сигналы перестанут приходить. Снова подключиться — через /start.",
].join("\n");

const longDate = (d: Date) => d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });

export function subscriptionStartedText(until: Date | null): string {
  return [
    "🎉 Ваша подписка активирована!",
    "",
    "Доступ к сигналам, аналитике и Dashboard открыт.",
    "Добро пожаловать в NIHILYST.",
    ...(until ? ["", `📅 Подписка активна до: ${longDate(until)}`] : []),
    "",
    "Открой меню бота и нажми /start, чтобы увидеть все возможности.",
    "",
    "🔑 Забыли пароль от Dashboard?",
    "Нажми /resetpassword в меню бота — придёт одноразовый код для сброса.",
  ].join("\n");
}

export function subscriptionRenewedText(until: Date | null): string {
  return ["🔄 Ваша подписка продлена!", "", ...(until ? [`📅 Действует до: ${longDate(until)}`, ""] : []), "Удачной торговли! 🚀"].join("\n");
}

export const DEACTIVATED_TEXT = "📴 Подписка деактивирована\n\nВаш доступ к NIHILYST был деактивирован администратором.\n\nПо вопросам обращайтесь напрямую.";
export const PASSWORD_CHANGED_TEXT = "🔑 Пароль изменён\n\nВаш пароль был сброшен администратором. Если это были не вы — обратитесь к администратору.";
export const BLOCKED_TEXT = "🚫 Доступ приостановлен\n\nВаш доступ к NIHILYST был заблокирован администратором. По вопросам обращайтесь напрямую.";

const subDate = (d: Date) => `${d.toLocaleString("ru-RU", {
  timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
})} Дубай`;

function remaining(until: Date, now: number): string {
  const ms = until.getTime() - now;
  if (ms <= 0) return "срок уже истёк";
  const days = Math.floor(ms / 86_400_000), hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return days > 0 ? `${days} дн. ${hours} ч.` : `${hours} ч.`;
}

export function subscriptionStatusText(user: UserRow | null, now = Date.now()): string {
  if (!user) {
    return ["📅 Статус подписки", "", "Подписка для этого Telegram-аккаунта не найдена.", `По вопросам доступа — ${CONTACT}`].join("\n");
  }
  const owner = isOwnerEmail(user.email);
  const active = accessStatus(user, new Date(now)) === "approved" && user.notify;
  const until = owner ? null : user.subscribed_until;
  return [
    `${active ? "✅" : "❌"} Подписка ${active ? "активна" : "неактивна"}`,
    "",
    `🟢 Начало: ${subDate(user.approved_at ?? user.created_at)}`,
    `🏁 Окончание: ${until ? subDate(until) : "не установлена"}`,
    until ? `⏳ Осталось: ${remaining(until, now)}` : "⏳ Срок: не ограничен",
  ].join("\n");
}

// ---------------- keyboards ----------------
export const SUBSCRIPTION_STATUS_KEYBOARD: InlineKeyboard = [[{ text: "📅 Дата окончания подписки", callback_data: "subscription_status" }]];
const UNSUBSCRIBE_KEYBOARD: InlineKeyboard = [[
  { text: "✅ Да, отписаться", callback_data: "unsubscribe_yes" },
  { text: "❌ Нет, остаться", callback_data: "unsubscribe_no" },
]];

export function welcomeKeyboard(): InlineKeyboard {
  const url = dashboardUrl();
  return [
    ...(url ? [[{ text: "📱 Открыть NIHILYST", web_app: { url } }], [{ text: "🌐 Открыть сайт", url }]] : []),
    ...SUBSCRIPTION_STATUS_KEYBOARD,
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
  const head = resubmitted ? "🔐 Повторный запрос доступа к Dashboard" : "🔐 Новый запрос доступа к Dashboard";
  const reason = resubmitted === "blocked"
    ? ["", "Аккаунт был заблокирован — пользователь повторно запросил доступ."]
    : resubmitted === "expired" ? ["", "Подписка истекла — пользователь повторно запросил доступ."] : [];
  await sendMessageKb(owner, [head, "", `👤 ${u.name}`, `📧 ${u.email}`, `💬 ${tg}`, ...reason].join("\n"), [[
    { text: "✅ Одобрить", callback_data: `approve_user:${u.id}` },
    { text: "❌ Заблокировать", callback_data: `block_user:${u.id}` },
  ]]);
}

export function sendQuiet(chatId: string | null, text: string, keyboard?: InlineKeyboard): void {
  if (!chatId) return;
  void sendMessageKb(chatId, text, keyboard).catch((err) => logger.warn({ err }, "nihilist: bot message not delivered"));
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
  const def = findCommand(cmd);
  if (!def) {
    await sendMessageKb(chatId, "❓ Команда не поддерживается. Используй /menu, чтобы увидеть доступные команды.");
    return;
  }
  if (def.privateOnly && !isPrivate) {
    await sendMessageKb(chatId, def.command === "/resetpassword"
      ? "🔒 Используй эту команду только в личном чате с ботом."
      : "🔒 Эта команда изменяет подписку и доступна только в личном чате с ботом.");
    return;
  }

  switch (def.command) {
    case "/myid":
      await sendMessageKb(chatId, [
        `🆔 Твой Telegram Chat ID: ${chatId}`,
        ...(m.from ? [`👤 User ID: ${m.from.id}`] : []),
        "",
        "Укажи этот Chat ID при регистрации в Dashboard.",
      ].join("\n"));
      return;
    case "/start": {
      const user = isPrivate ? await userByChatId(chatId) : null;
      let extra = "";
      if (user && accessStatus(user) === "approved" && !user.notify) {
        await pool.query("UPDATE nh_users SET notify = true, notify_since = now(), bot_blocked_at = NULL WHERE id = $1", [user.id]);
        extra = "\n\n✅ Сигналы снова включены.";
      } else if (user?.bot_blocked_at) {
        await pool.query("UPDATE nh_users SET bot_blocked_at = NULL WHERE id = $1", [user.id]);
      }
      await sendMessageKb(chatId, welcomeText() + extra, welcomeKeyboard());
      return;
    }
    case "/prices":
      await sendMessageKb(chatId, PRICES_TEXT);
      return;
    case "/subscription":
      await sendMessageKb(chatId, subscriptionStatusText(await userByChatId(chatId)), SUBSCRIPTION_STATUS_KEYBOARD);
      return;
    case "/resetpassword": {
      const user = await userByChatId(chatId);
      if (!user) {
        await sendMessageKb(chatId, ["❌ Аккаунт с этим Telegram Chat ID не найден.", "", "Зарегистрируйся в Dashboard и укажи свой Chat ID."].join("\n"));
        return;
      }
      const code = String(randomInt(100000, 1000000));
      await pool.query("DELETE FROM nh_password_resets WHERE user_id = $1", [user.id]);
      await pool.query("INSERT INTO nh_password_resets (user_id, code, expires_at) VALUES ($1, $2, now() + interval '15 minutes')", [user.id, code]);
      await sendMessageKb(chatId, [
        `🔑 Код сброса пароля: ${code}`,
        "",
        "⏱ Действителен 15 минут.",
        "",
        "Открой Dashboard → страница входа → «Забыли пароль?» и введи email, этот код и новый пароль.",
      ].join("\n"));
      return;
    }
  }

  const { ok } = await isSubscriberChat(chatId);
  if (!ok) {
    await sendMessageKb(chatId, welcomeText(), welcomeKeyboard());
    return;
  }
  switch (def.command) {
    case "/menu":
      await sendMessageKb(chatId, MENU_TEXT, SUBSCRIPTION_STATUS_KEYBOARD);
      return;
    case "/unsubscribe":
      await sendMessageKb(chatId, UNSUBSCRIBE_CONFIRM_TEXT, UNSUBSCRIBE_KEYBOARD);
      return;
    case "/daily": case "/weekly": case "/monthly": {
      const kind = def.command.slice(1) as ReportKind;
      await sendMessageKb(chatId, kind === "monthly" ? "📊 Формирую месячный дайджест..." : `📊 Формирую ${kind === "daily" ? "дневной" : "недельный"} отчёт...`);
      try {
        await sendMessageKb(chatId, await buildReport(onDemandSchedule(kind, Date.now())));
      } catch (err) {
        logger.warn({ err }, "nihilist: on-demand report failed");
        await sendMessageKb(chatId, "❌ Ошибка при формировании отчёта. Попробуй позже.");
      }
      return;
    }
  }
}

const monthLater = (from: Date) => { const d = new Date(from); d.setMonth(d.getMonth() + 1); return d; };

async function handleCallback(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const data = cq.data ?? "";
  await telegramCall("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => undefined);
  const msg = cq.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);

  if (data === "subscription_status") {
    await sendMessageKb(chatId, subscriptionStatusText(await userByChatId(String(cq.from.id))), SUBSCRIPTION_STATUS_KEYBOARD);
    return;
  }

  if (data.startsWith("approve_user:") || data.startsWith("block_user:")) {
    if (!await isOwnerChat(cq.from.id)) { await sendMessageKb(chatId, "⛔ Только владелец может выполнять это действие."); return; }
    const id = Number(data.slice(data.indexOf(":") + 1));
    const before = Number.isSafeInteger(id) && id > 0 ? await userById(id) : null;
    if (!before) { await editMessage(chatId, msg.message_id, "❌ Пользователь не найден в базе."); return; }
    if (data.startsWith("approve_user:")) {
      const now = new Date();
      const until = monthLater(now);
      const wasActive = accessStatus(before, now) === "approved";
      await pool.query(
        `UPDATE nh_users SET status = 'approved', approved_at = now(), subscribed_until = $2,
           notify = true, notify_since = COALESCE(CASE WHEN $3 THEN notify_since END, now()) WHERE id = $1`,
        [id, until, wasActive],
      );
      await editMessage(chatId, msg.message_id, `✅ ${before.name} одобрен\n📧 ${before.email}\n📅 до ${longDate(until)}`);
      sendQuiet(before.chat_id, wasActive ? subscriptionRenewedText(until) : subscriptionStartedText(until));
    } else {
      await pool.query("UPDATE nh_users SET status = 'blocked', approved_at = NULL WHERE id = $1", [id]);
      await editMessage(chatId, msg.message_id, `❌ ${before.name} заблокирован\n📧 ${before.email}`);
      if (before.status !== "blocked") sendQuiet(before.chat_id, BLOCKED_TEXT);
    }
    logger.info({ id, data }, "nihilist: user status changed from Telegram");
    return;
  }

  if (msg.chat.type !== "private") {
    await sendMessageKb(chatId, "🔒 Управление подпиской доступно только в личном чате с ботом.");
    return;
  }
  const { user, ok } = await isSubscriberChat(String(cq.from.id));
  if (!ok) { await sendMessageKb(chatId, welcomeText(), welcomeKeyboard()); return; }

  if (data === "unsubscribe_confirm") {
    await editMessage(chatId, msg.message_id, UNSUBSCRIBE_CONFIRM_TEXT, UNSUBSCRIBE_KEYBOARD);
  } else if (data === "unsubscribe_yes") {
    if (user) await pool.query("UPDATE nh_users SET notify = false WHERE id = $1", [user.id]);
    await editMessage(chatId, msg.message_id, [
      "❌ Подписка отменена.", "", "Сигналы больше не будут приходить.", "Напиши /start, чтобы включить их снова.",
    ].join("\n"));
  } else if (data === "unsubscribe_no") {
    await editMessage(chatId, msg.message_id, ALREADY_SUBSCRIBED_TEXT, [[{ text: "❌ Отписаться", callback_data: "unsubscribe_confirm" }]]);
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

export async function setBotMenu(): Promise<void> {
  await telegramCall("setMyCommands", { commands: BOT_MENU }).catch((err) => logger.warn({ err }, "nihilist: setMyCommands failed"));
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
