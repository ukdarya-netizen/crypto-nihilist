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
    const fileId = typeof photo === "string"
      ? photo
      : photo instanceof Blob && (photo as File).name === "stop-loss.png"
        ? "telegram-stop-loss-id"
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
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  }

  assert.equal(forms.length, 4);
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
});
