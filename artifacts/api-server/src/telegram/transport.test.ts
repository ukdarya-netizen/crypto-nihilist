import assert from "node:assert/strict";
import test from "node:test";
import { sendPhoto } from "./transport";

test("sendPhoto sends each image with its caption and keeps separate Telegram file ids", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const forms: FormData[] = [];
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://api.telegram.org/bottest-token/sendPhoto");
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    const form = init.body;
    forms.push(form);
    const photo = form.get("photo");
    const photoName = photo instanceof Blob ? (photo as File).name : "";
    const fileId = typeof photo === "string"
      ? photo
      : photoName === "stop-loss.png"
        ? "telegram-stop-loss-id"
        : photoName === "take-profit.png"
          ? "telegram-take-profit-id"
          : photoName === "position-update.png"
            ? "telegram-position-update-id"
          : "telegram-signal-id";
    return new Response(JSON.stringify({
      ok: true,
      result: { photo: [{ file_id: fileId }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    await sendPhoto("@signals", "First signal");
    await sendPhoto("@signals", "Second signal");
    await sendPhoto("@signals", "Stopped signal", "stopLoss");
    await sendPhoto("@signals", "Another stopped signal", "stopLoss");
    await sendPhoto("@signals", "Take profit reached", "takeProfit");
    await sendPhoto("@signals", "Trailing profit closed", "takeProfit");
    await sendPhoto("@signals", "Position update", "positionUpdate");
    await sendPhoto("@signals", "Another position update", "positionUpdate");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  }

  assert.equal(forms.length, 8);
  assert.equal(forms[0].get("chat_id"), "@signals");
  assert.equal(forms[0].get("caption"), "First signal");
  const uploaded = forms[0].get("photo");
  assert.ok(uploaded instanceof Blob);
  assert.equal((uploaded as File).name, "new-signal.png");
  assert.ok(uploaded.size > 1_000_000);
  assert.equal(forms[1].get("caption"), "Second signal");
  assert.equal(forms[1].get("photo"), "telegram-signal-id");
  assert.equal(forms[2].get("caption"), "Stopped signal");
  const stopLossUploaded = forms[2].get("photo");
  assert.ok(stopLossUploaded instanceof Blob);
  assert.equal((stopLossUploaded as File).name, "stop-loss.png");
  assert.ok(stopLossUploaded.size > 1_000_000);
  assert.equal(forms[3].get("caption"), "Another stopped signal");
  assert.equal(forms[3].get("photo"), "telegram-stop-loss-id");
  assert.equal(forms[4].get("caption"), "Take profit reached");
  const takeProfitUploaded = forms[4].get("photo");
  assert.ok(takeProfitUploaded instanceof Blob);
  assert.equal((takeProfitUploaded as File).name, "take-profit.png");
  assert.ok(takeProfitUploaded.size > 1_000_000);
  assert.equal(forms[5].get("caption"), "Trailing profit closed");
  assert.equal(forms[5].get("photo"), "telegram-take-profit-id");
  assert.equal(forms[6].get("caption"), "Position update");
  const positionUpdateUploaded = forms[6].get("photo");
  assert.ok(positionUpdateUploaded instanceof Blob);
  assert.equal((positionUpdateUploaded as File).name, "position-update.png");
  assert.ok(positionUpdateUploaded.size > 1_000_000);
  assert.equal(forms[7].get("caption"), "Another position update");
  assert.equal(forms[7].get("photo"), "telegram-position-update-id");
});
