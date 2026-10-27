import assert from "node:assert/strict";
import test from "node:test";
import { sendPhoto } from "./transport";

test("sendPhoto sends the signal image with its caption and reuses Telegram's file id", async () => {
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
    return new Response(JSON.stringify({
      ok: true,
      result: { photo: [{ file_id: "telegram-photo-id" }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    await sendPhoto("@signals", "First signal");
    await sendPhoto("@signals", "Second signal");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  }

  assert.equal(forms.length, 2);
  assert.equal(forms[0].get("chat_id"), "@signals");
  assert.equal(forms[0].get("caption"), "First signal");
  const uploaded = forms[0].get("photo");
  assert.ok(uploaded instanceof Blob);
  assert.equal((uploaded as File).name, "new-signal.png");
  assert.ok(uploaded.size > 1_000_000);
  assert.equal(forms[1].get("caption"), "Second signal");
  assert.equal(forms[1].get("photo"), "telegram-photo-id");
});
