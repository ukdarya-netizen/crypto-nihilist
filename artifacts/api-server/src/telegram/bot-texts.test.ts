import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, MENU_DESCRIPTIONS, langOf, myIdText, pricesText, subscriptionStatusText, welcomeText,
} from "./bot-texts";
import { COMMANDS, welcomeKeyboard } from "./bot";
import { formatPeriodReport } from "./report-format";

test("the bot is English for everyone, also for Russian-language Telegram apps", () => {
  for (const c of ["ru", "ru-RU", "uk", "en", "de", undefined, null, ""]) assert.equal(langOf(c), "en");
});

test("bot profile fits Telegram limits in both languages; every menu command has both texts", () => {
  for (const l of ["ru", "en"] as const) {
    assert.ok(BOT_DESCRIPTION[l].length <= 512, `description ${l} ${BOT_DESCRIPTION[l].length}`);
    assert.ok(BOT_SHORT_DESCRIPTION[l].length <= 120, `short ${l} ${BOT_SHORT_DESCRIPTION[l].length}`);
  }
  for (const c of COMMANDS.filter((x) => x.menu)) {
    assert.ok(MENU_DESCRIPTIONS[c.command]?.ru && MENU_DESCRIPTIONS[c.command]?.en, c.command);
  }
});

test("English texts carry no Russian; buttons as CAB (app, site, subscription end)", () => {
  const cyr = /[А-Яа-яЁё]/;
  assert.ok(!cyr.test(welcomeText("en")) && !cyr.test(pricesText("en")) && !cyr.test(BOT_DESCRIPTION.en));
  assert.ok(!cyr.test(subscriptionStatusText("en", { found: true, active: true, start: new Date(0), until: new Date(864e5 * 3) }, 0)));
  assert.ok(!cyr.test(formatPeriodReport("weekly", [], 0, 864e5 * 7, "en")));
  const kb = welcomeKeyboard("en");
  assert.equal(kb.length, 3);
  assert.ok(kb.flat().every((b) => !cyr.test(b.text)));
});

test("/myid: the Chat ID is found in the text (copy span offset)", () => {
  const t = myIdText("ru", "123456789", 42);
  assert.equal(t.slice(t.indexOf("123456789"), t.indexOf("123456789") + 9), "123456789");
});
