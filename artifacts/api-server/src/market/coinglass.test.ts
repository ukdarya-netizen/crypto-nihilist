import assert from "node:assert/strict";
import test from "node:test";
import { parsePriceRows, parseSupportedPairs, setScanBusy, waitForScanIdle } from "./coinglass";

test("BingX USDT pairs from supported-exchange-pairs; USDC excluded", () => {
  const data = {
    BingX: [
      { instrument_id: "JCT-USDT", base_asset: "JCT", quote_asset: "USDT" },
      { instrument_id: "BTC-USDC", base_asset: "BTC", quote_asset: "USDC" },
      { instrument_id: "ETH-USDT", base_asset: "ETH", quote_asset: "USDT" },
    ],
    Binance: [{ instrument_id: "XRPUSDT", base_asset: "XRP", quote_asset: "USDT" }],
  };
  assert.deepEqual(parseSupportedPairs(data).map((p) => p.instrumentId), ["ETH-USDT", "JCT-USDT"]);
  assert.deepEqual(parseSupportedPairs(data.BingX).map((p) => p.base), ["ETH", "JCT"]);
});

test("price history rows: seconds or ms, strings or numbers, sorted, invalid dropped", () => {
  const rows = [
    { time: 1761350400, open: "0.0068", high: "0.0073", low: "0.0058", close: "0.0068", volume_usd: "1" },
    { time: 1761336000000, open: 0.006, high: 0.0069, low: 0.0059, close: 0.0068 },
    { time: 1761364800, open: "x", high: 1, low: 1, close: 1 },
  ];
  const candles = parsePriceRows(rows);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].t, 1761336000000);
  assert.equal(candles[1].t, 1761350400000);
  assert.equal(candles[1].h, 0.0073);
});

test("CoinGlass scan keeps priority over derivative history lookups", async () => {
  setScanBusy(true);
  let finished = false;
  try {
    const waiting = waitForScanIdle(5_000, 5).then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(finished, false, "history lookups must remain queued while candle scanning is active");
    setScanBusy(false);
    await waiting;
    assert.equal(finished, true);
  } finally {
    setScanBusy(false);
  }
});
