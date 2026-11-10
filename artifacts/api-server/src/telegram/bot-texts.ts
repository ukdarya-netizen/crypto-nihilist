/**
 * Bot texts (owner 2026-11-10: the bot and the channel are fully English). The Russian variants stay in the
 * code but are not used: langOf() always answers English. Plain text only (no HTML).
 */
export type Lang = "ru" | "en";

/** Always English (owner 2026-11-10), whatever the language of the user's Telegram app. */
export const langOf = (_code?: string | null): Lang => "en";

export const CONTACT = "@The_Lucy_x";
const TZ = "Asia/Dubai";
const L = (lang: Lang, ru: string, en: string) => (lang === "ru" ? ru : en);

// ---------------- bot profile (shown before /start) ----------------
/** «What can this bot do?» — up to 512 characters. */
export const BOT_DESCRIPTION: Record<Lang, string> = {
  ru: [
    "NIHILYST — сигналы по методу Smart Money: вход от ордер-блока старшего ТФ (4h / 1D) после слома структуры на младшем (30m / 1h). Лонги и шорты, фьючерсы BingX.",
    "",
    "Вход, стоп и сопровождение каждой сделки до закрытия, отчёты за день, неделю и месяц, Dashboard со статистикой.",
    "",
    "Закрытый доступ: регистрация в Dashboard и одобрение. Нажми /start.",
  ].join("\n"),
  en: [
    "NIHILYST — Smart Money signals: entry from a higher-TF order block (4h / 1D) after a change of character on the lower TF (30m / 1h). Longs and shorts, BingX futures.",
    "",
    "Entry, stop and follow-up of every trade until it closes, daily, weekly and monthly reports, a Dashboard with statistics.",
    "",
    "Private access: sign up in the Dashboard and get approved. Tap /start.",
  ].join("\n"),
};
/** Bot profile line — up to 120 characters. */
export const BOT_SHORT_DESCRIPTION: Record<Lang, string> = {
  ru: "Сигналы Smart Money: ордер-блоки и слом структуры. Лонги и шорты, сопровождение сделок.",
  en: "Smart Money signals: order blocks and change of character. Longs and shorts, full trade follow-up.",
};

export const MENU_DESCRIPTIONS: Record<string, Record<Lang, string>> = {
  "/start": { ru: "Начать работу с ботом", en: "Start the bot" },
  "/myid": { ru: "Показать Chat ID", en: "Show Chat ID" },
  "/daily": { ru: "Дневной отчёт", en: "Daily report" },
  "/weekly": { ru: "Недельный отчёт", en: "Weekly report" },
  "/monthly": { ru: "Месячный дайджест", en: "Monthly digest" },
  "/prices": { ru: "Тарифы", en: "Pricing" },
  "/subscription": { ru: "Статус и даты подписки", en: "Subscription status and dates" },
  "/unsubscribe": { ru: "Отписаться от сигналов", en: "Unsubscribe from signals" },
  "/resetpassword": { ru: "Сбросить пароль Dashboard", en: "Reset Dashboard password" },
};

// ---------------- replies ----------------
export function welcomeText(lang: Lang): string {
  return lang === "ru" ? [
    "🚀 NIHILYST — сигналы Smart Money",
    "",
    "Находим, где крупный игрок оставил ордер-блок на старшем ТФ (4h / 1D), и входим, когда на младшем (30m / 1h) цена в этом блоке ломает структуру. Лонги и шорты, фьючерсы BingX.",
    "",
    "Что ты получаешь внутри:",
    "",
    "✅ Сигналы со входом и стопом.",
    "✅ Сопровождение каждой сделки: безубыток на +5%, тейк: шорты +8%, лонги +10%, закрытие.",
    "✅ Отчёты за день, неделю и месяц.",
    "✅ Dashboard — открытые позиции, история сигналов, статистика.",
    "",
    "📱 Доступ через Mini App прямо в Telegram",
    "Регистрация, позиции и история — всё открывается внутри Telegram. Нажми кнопку «📱 Открыть NIHILYST» ниже.",
    "",
    "💎 Доступ ограничен",
    "Бот работает в закрытом режиме: сигналы приходят только после регистрации в Dashboard и одобрения доступа.",
    "",
    "🆔 Как узнать Chat ID",
    "Нажми /myid в меню бота — бот отправит твой Chat ID. Его нужно указать при регистрации.",
    "",
    "💰 Подключение — 100 USDT / месяц",
    `По вопросам оплаты и доступа — ${CONTACT}`,
  ].join("\n") : [
    "🚀 NIHILYST — Smart Money signals",
    "",
    "We find where a large player left an order block on the higher timeframe (4h / 1D) and enter when price breaks structure inside that block on the lower one (30m / 1h). Longs and shorts, BingX futures.",
    "",
    "What you get:",
    "",
    "✅ Signals with entry and stop.",
    "✅ Follow-up of every trade: break-even at +5%, take: shorts +8%, longs +10%, close.",
    "✅ Daily, weekly and monthly reports.",
    "✅ Dashboard — open positions, signal history, statistics.",
    "",
    "📱 Mini App right inside Telegram",
    "Sign-up, positions and history all open inside Telegram. Tap «📱 Open NIHILYST» below.",
    "",
    "💎 Limited access",
    "The bot is private: signals arrive only after you sign up in the Dashboard and your access is approved.",
    "",
    "🆔 How to find your Chat ID",
    "Tap /myid in the bot menu — the bot sends your Chat ID. You need it to sign up.",
    "",
    "💰 Access — 100 USDT / month",
    `Payment and access — ${CONTACT}`,
  ].join("\n");
}

export const pricesText = (lang: Lang) => (lang === "ru" ? [
  "💎 NIHILYST — Тарифы",
  "",
  "💰 1 месяц — 100 USDT",
  "",
  "Что входит:",
  "• Сигналы 24/7 по фьючерсам BingX — лонги и шорты",
  "• Сопровождение каждой сделки до закрытия",
  "• Отчёты: день, неделя, месяц",
  "• Dashboard с позициями и статистикой",
  "",
  `Для оплаты или вопросов — ${CONTACT}`,
] : [
  "💎 NIHILYST — Pricing",
  "",
  "💰 1 month — 100 USDT",
  "",
  "Included:",
  "• Signals 24/7 on BingX futures — longs and shorts",
  "• Follow-up of every trade until it closes",
  "• Reports: daily, weekly, monthly",
  "• Dashboard with positions and statistics",
  "",
  `Payment or questions — ${CONTACT}`,
]).join("\n");

export const alreadySubscribedText = (lang: Lang) => L(lang,
  "✅ У тебя уже есть доступ!\n\nСигналы приходят автоматически. Используй /menu для отчётов.",
  "✅ You already have access!\n\nSignals arrive automatically. Use /menu for reports.");

export const menuText = (lang: Lang) => (lang === "ru" ? [
  "📋 Доступные команды",
  "",
  "/daily — Дневной отчёт",
  "/weekly — Недельный отчёт",
  "/monthly — Месячный дайджест",
  "/subscription — Начало и окончание подписки",
  "/prices — Тарифы",
  "/unsubscribe — Отписаться",
] : [
  "📋 Available commands",
  "",
  "/daily — Daily report",
  "/weekly — Weekly report",
  "/monthly — Monthly digest",
  "/subscription — Subscription start and end",
  "/prices — Pricing",
  "/unsubscribe — Unsubscribe",
]).join("\n");

export const unsubscribeConfirmText = (lang: Lang) => L(lang,
  "❓ Точно хочешь отписаться?\n\nСигналы перестанут приходить. Снова подключиться — через /start.",
  "❓ Are you sure you want to unsubscribe?\n\nSignals will stop. To come back — /start.");
export const unsubscribedText = (lang: Lang) => L(lang,
  "❌ Подписка отменена.\n\nСигналы больше не будут приходить.\nНапиши /start, чтобы включить их снова.",
  "❌ Unsubscribed.\n\nSignals will no longer arrive.\nSend /start to turn them back on.");
export const signalsBackOnText = (lang: Lang) => L(lang, "\n\n✅ Сигналы снова включены.", "\n\n✅ Signals are back on.");

export const myIdText = (lang: Lang, chatId: string, userId: number | null) => {
  const lines = lang === "ru"
    ? [`🆔 Твой Telegram Chat ID: ${chatId}`, ...(userId !== null ? [`👤 User ID: ${userId}`] : []), "", "Нажми на Chat ID, чтобы скопировать, и укажи его при регистрации в Dashboard."]
    : [`🆔 Your Telegram Chat ID: ${chatId}`, ...(userId !== null ? [`👤 User ID: ${userId}`] : []), "", "Tap the Chat ID to copy it and enter it when you sign up in the Dashboard."];
  return lines.join("\n");
};

export const resetNoAccountText = (lang: Lang) => L(lang,
  "❌ Аккаунт с этим Telegram Chat ID не найден.\n\nЗарегистрируйся в Dashboard и укажи свой Chat ID.",
  "❌ No account with this Telegram Chat ID.\n\nSign up in the Dashboard with your Chat ID.");
export const resetCodeText = (lang: Lang, code: string) => (lang === "ru" ? [
  `🔑 Код сброса пароля: ${code}`, "", "⏱ Действителен 15 минут.", "",
  "Открой Dashboard → страница входа → «Забыли пароль?» и введи email, этот код и новый пароль.",
] : [
  `🔑 Password reset code: ${code}`, "", "⏱ Valid for 15 minutes.", "",
  "Open the Dashboard → sign-in page → «Forgot password?» and enter your email, this code and a new password.",
]).join("\n");

export const unknownCommandText = (lang: Lang) => L(lang,
  "❓ Команда не поддерживается. Используй /menu, чтобы увидеть доступные команды.",
  "❓ Unknown command. Use /menu to see the available commands.");
export const privateOnlyText = (lang: Lang, reset: boolean) => reset
  ? L(lang, "🔒 Используй эту команду только в личном чате с ботом.", "🔒 Use this command only in a private chat with the bot.")
  : L(lang, "🔒 Эта команда изменяет подписку и доступна только в личном чате с ботом.", "🔒 This command changes your subscription and works only in a private chat with the bot.");
export const privateManageText = (lang: Lang) => L(lang,
  "🔒 Управление подпиской доступно только в личном чате с ботом.",
  "🔒 Subscription settings are available only in a private chat with the bot.");
export const reportBuildingText = (lang: Lang, kind: "daily" | "weekly" | "monthly") => lang === "ru"
  ? (kind === "monthly" ? "📊 Формирую месячный дайджест..." : `📊 Формирую ${kind === "daily" ? "дневной" : "недельный"} отчёт...`)
  : `📊 Building the ${kind === "daily" ? "daily report" : kind === "weekly" ? "weekly report" : "monthly digest"}...`;
export const reportFailedText = (lang: Lang) => L(lang, "❌ Ошибка при формировании отчёта. Попробуй позже.", "❌ Could not build the report. Try again later.");

const longDate = (lang: Lang, d: Date) =>
  d.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-GB", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
const subDate = (lang: Lang, d: Date) => `${d.toLocaleString(lang === "ru" ? "ru-RU" : "en-GB", {
  timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
})} ${L(lang, "Дубай", "Dubai")}`;

function remaining(lang: Lang, until: Date, now: number): string {
  const ms = until.getTime() - now;
  if (ms <= 0) return L(lang, "срок уже истёк", "already expired");
  const days = Math.floor(ms / 86_400_000), hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return lang === "ru" ? (days > 0 ? `${days} дн. ${hours} ч.` : `${hours} ч.`) : (days > 0 ? `${days} d ${hours} h` : `${hours} h`);
}

export function subscriptionStatusText(lang: Lang, s: { found: false } | { found: true; active: boolean; start: Date; until: Date | null }, now = Date.now()): string {
  if (!s.found) {
    return lang === "ru"
      ? ["📅 Статус подписки", "", "Подписка для этого Telegram-аккаунта не найдена.", `По вопросам доступа — ${CONTACT}`].join("\n")
      : ["📅 Subscription status", "", "No subscription found for this Telegram account.", `Access questions — ${CONTACT}`].join("\n");
  }
  return [
    lang === "ru" ? `${s.active ? "✅" : "❌"} Подписка ${s.active ? "активна" : "неактивна"}` : `${s.active ? "✅" : "❌"} Subscription ${s.active ? "active" : "inactive"}`,
    "",
    `🟢 ${L(lang, "Начало", "Start")}: ${subDate(lang, s.start)}`,
    `🏁 ${L(lang, "Окончание", "End")}: ${s.until ? subDate(lang, s.until) : L(lang, "не установлена", "not set")}`,
    s.until ? `⏳ ${L(lang, "Осталось", "Left")}: ${remaining(lang, s.until, now)}` : L(lang, "⏳ Срок: не ограничен", "⏳ Term: unlimited"),
  ].join("\n");
}

// ---------------- notifications from the owner's actions ----------------
export const subscriptionStartedText = (until: Date | null) => (lang: Lang) => (lang === "ru" ? [
  "🎉 Ваша подписка активирована!", "", "Доступ к сигналам, аналитике и Dashboard открыт.", "Добро пожаловать в NIHILYST.",
  ...(until ? ["", `📅 Подписка активна до: ${longDate(lang, until)}`] : []),
  "", "Открой меню бота и нажми /start, чтобы увидеть все возможности.",
  "", "🔑 Забыли пароль от Dashboard?", "Нажми /resetpassword в меню бота — придёт одноразовый код для сброса.",
] : [
  "🎉 Your subscription is active!", "", "Signals, analytics and the Dashboard are open to you.", "Welcome to NIHILYST.",
  ...(until ? ["", `📅 Active until: ${longDate(lang, until)}`] : []),
  "", "Open the bot menu and tap /start to see everything it can do.",
  "", "🔑 Forgot your Dashboard password?", "Tap /resetpassword in the bot menu to get a one-time reset code.",
]).join("\n");
export const subscriptionRenewedText = (until: Date | null) => (lang: Lang) => (lang === "ru"
  ? ["🔄 Ваша подписка продлена!", "", ...(until ? [`📅 Действует до: ${longDate(lang, until)}`, ""] : []), "Удачной торговли! 🚀"]
  : ["🔄 Your subscription has been renewed!", "", ...(until ? [`📅 Valid until: ${longDate(lang, until)}`, ""] : []), "Good trading! 🚀"]).join("\n");
export const DEACTIVATED_TEXT = (lang: Lang) => L(lang,
  "📴 Подписка деактивирована\n\nВаш доступ к NIHILYST был деактивирован администратором.\n\nПо вопросам обращайтесь напрямую.",
  `📴 Subscription deactivated\n\nYour access to NIHILYST was deactivated by the administrator.\n\nQuestions — ${CONTACT}`);
export const PASSWORD_CHANGED_TEXT = (lang: Lang) => L(lang,
  "🔑 Пароль изменён\n\nВаш пароль был сброшен администратором. Если это были не вы — обратитесь к администратору.",
  "🔑 Password changed\n\nYour password was reset by the administrator. If you did not ask for it, contact the administrator.");
export const BLOCKED_TEXT = (lang: Lang) => L(lang,
  "🚫 Доступ приостановлен\n\nВаш доступ к NIHILYST был заблокирован администратором. По вопросам обращайтесь напрямую.",
  `🚫 Access suspended\n\nYour access to NIHILYST was blocked by the administrator. Questions — ${CONTACT}`);

// ---------------- buttons (as CAB) ----------------
export const BUTTONS = {
  openApp: (lang: Lang) => L(lang, "📱 Открыть NIHILYST", "📱 Open NIHILYST"),
  openSite: (lang: Lang) => L(lang, "🌐 Открыть сайт", "🌐 Open website"),
  subscriptionEnd: (lang: Lang) => L(lang, "📅 Дата окончания подписки", "📅 Subscription end date"),
  unsubscribe: (lang: Lang) => L(lang, "❌ Отписаться", "❌ Unsubscribe"),
  unsubscribeYes: (lang: Lang) => L(lang, "✅ Да, отписаться", "✅ Yes, unsubscribe"),
  unsubscribeNo: (lang: Lang) => L(lang, "❌ Нет, остаться", "❌ No, stay"),
};
