import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Telegram runs only in the published deployment: the dev workspace and the
 * deployment share one bot token, and two getUpdates pollers kill each other
 * (409) and would send every signal twice. NIHILIST_TELEGRAM_IN_DEV=1 forces it on.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
type PhotoKind = "signal" | "stopLoss" | "takeProfit";
type PhotoAsset = { filename: string; bytes: Promise<Buffer> | null; fileId: string | null };
const photoAssets: Record<PhotoKind, PhotoAsset> = {
  signal: { filename: "new-signal.png", bytes: null, fileId: null },
  stopLoss: { filename: "stop-loss.png", bytes: null, fileId: null },
  takeProfit: { filename: "take-profit.png", bytes: null, fileId: null },
};

export function telegramEnabled(): boolean {
  if (!process.env.TELEGRAM_BOT_TOKEN) return false;
  return process.env.REPLIT_DEPLOYMENT === "1" || process.env.NIHILIST_TELEGRAM_IN_DEV === "1";
}

/** Channel for live signals, e.g. @nihilyst_trading (unset = subscribers only). */
export function signalChannel(): string | null {
  const value = process.env.NIHILIST_TELEGRAM_CHANNEL?.trim();
  return value ? value : null;
}

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0) {
    super(`Telegram API error ${code}`);
  }
}

async function telegramRequest<T>(method: string, payload: object | FormData): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      ...(payload instanceof FormData
        ? { body: payload }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 10_000),
    });
  } catch {
    // Native fetch errors may contain the credential-bearing URL.
    throw new Error("Telegram network request failed");
  }
  const body = await response.json() as {
    ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number };
  };
  if (!response.ok || !body.ok) {
    throw new TelegramError(body.error_code ?? response.status, body.parameters?.retry_after);
  }
  return body.result;
}

export async function telegramCall<T>(method: string, payload: object): Promise<T> {
  return telegramRequest(method, payload);
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  await telegramCall("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

async function getPhotoBytes(kind: PhotoKind): Promise<Buffer> {
  const asset = photoAssets[kind];
  asset.bytes ??= (async () => {
    for (const filePath of [
      path.resolve(moduleDir, "assets", asset.filename),
      path.resolve(moduleDir, "../../assets", asset.filename),
    ]) {
      try {
        return await readFile(filePath);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Telegram image is missing from the API build: ${asset.filename}`);
  })();
  return asset.bytes;
}

export async function sendPhoto(chatId: string, caption: string, kind: PhotoKind = "signal"): Promise<void> {
  const asset = photoAssets[kind];
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", caption);
  if (asset.fileId) {
    form.set("photo", asset.fileId);
  } else {
    const bytes = await getPhotoBytes(kind);
    form.set("photo", new Blob([new Uint8Array(bytes)], { type: "image/png" }), asset.filename);
  }
  const result = await telegramRequest<{ photo?: Array<{ file_id: string }> }>("sendPhoto", form);
  const photo = result.photo?.[result.photo.length - 1];
  if (photo?.file_id) asset.fileId = photo.file_id;
}

export type TelegramUpdate = {
  update_id: number;
  message?: { chat: { id: number; type: string }; text?: string };
};

export function subscriptionCommand(update: TelegramUpdate): "start" | "stop" | null {
  if (update.message?.chat.type !== "private") return null;
  const command = update.message.text?.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return command === "/start" ? "start" : command === "/stop" ? "stop" : null;
}
