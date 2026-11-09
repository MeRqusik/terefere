// Shared by the server cache and the browser chart: extends the last candle with a price,
// or opens a new one on the series' own time grid (daily forex bars start at 21:04, not midnight).
export function addTick(bars, step, t, p) {
  let last = bars.at(-1);
  if (!last || t < last.time) return null;
  if (t >= last.time + step) {
    last = { time: last.time + Math.floor((t - last.time) / step) * step, open: p, high: p, low: p, close: p, trades: 0 };
    bars.push(last);
  }
  last.high = Math.max(last.high, p);
  last.low = Math.min(last.low, p);
  last.close = p;
  last.trades++;
  return last;
}
