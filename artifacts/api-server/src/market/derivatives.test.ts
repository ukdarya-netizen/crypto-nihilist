import assert from "node:assert/strict";
import test from "node:test";
import { cgBase, derivativeMetrics } from "./derivatives";

const H = 3_600_000;
const asOf = Date.UTC(2026, 9, 26, 12, 0);
const bars = (n: number, f: (i: number) => Record<string, number>) =>
  Array.from({ length: n }, (_, i) => ({ time: asOf - (n - i) * H, ...f(i) }));

test("CoinGlass flow metrics at a moment: OI, taker, CVD, liquidations, long/short, funding", async () => {
  process.env.NIHILIST_COINGLASS_API_KEY = "test";
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}?end_time=${url.searchParams.get("end_time")}&symbol=${url.searchParams.get("symbol")}`);
    const path = url.pathname;
    const data =
      path.endsWith("open-interest/aggregated-history") ? bars(30, (i) => ({ close: 1000 + i * 10 })) :
      path.endsWith("aggregated-taker-buy-sell-volume/history") ? bars(30, () => ({ aggregated_buy_volume_usd: 60, aggregated_sell_volume_usd: 40 })) :
      path.endsWith("aggregated-cvd/history") ? bars(30, (i) => ({ agg_taker_buy_vol: 5, agg_taker_sell_vol: 5, cum_vol_delta: i * 2 })) :
      path.endsWith("liquidation/aggregated-history") ? bars(30, () => ({ aggregated_long_liquidation_usd: 10, aggregated_short_liquidation_usd: 1 })) :
      path.endsWith("global-long-short-account-ratio/history") ? bars(6, (i) => ({ global_account_long_percent: 60 + i })) :
      bars(4, () => ({ close: 0.01 }));
    return new Response(JSON.stringify({ code: "0", data }), { status: 200 });
  }) as typeof fetch;
  try {
    const m = await derivativeMetrics("JCT-USDT", asOf);
    assert.ok(seen.every((s) => s.includes(`end_time=${asOf}`) && s.includes("symbol=JCT")), seen.join("\n"));
    assert.equal(m.d_oi_usd, 1290);
    assert.equal(m.d_oi_chg1h, Math.round((10 / 1280) * 10000) / 100);
    assert.equal(m.d_fut_taker_net_4h, 20);
    assert.equal(m.d_spot_cvd_chg4h, 8);
    assert.equal(m.d_spot_taker_net_1h, 0);
    assert.equal(m.d_liq_long_24h, 240);
    assert.equal(m.d_ls_long_pct, 65);
    assert.equal(m.d_ls_long_pct_chg, 5);
    assert.equal(m.d_funding_pct, 0.01);
  } finally {
    globalThis.fetch = original;
  }
});

test("BingX tickers map to CoinGlass bases", () => {
  assert.equal(cgBase("BTC-USDT"), "BTC");
  assert.equal(cgBase("USELES-USDT"), "USELESS");
});
