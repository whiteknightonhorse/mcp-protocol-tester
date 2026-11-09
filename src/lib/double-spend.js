// T-0676: classify the 200s of the 18.12 double-spend burst.
// A 200 with X-APIbase-Charged:false AND the receipt of the first charged success is a T-0526
// dedup replay (answered, not charged, one transfer) - not a double-spend.
// Anything else is a charged success. Receipt header: X-APIbase-Receipt (public receipt URL).
function classifyDoubleSpend(oks) {
  // oks: [{ charged: string|null, receipt: string|null }] for every 200, in arrival order
  const list = oks.map((o) => ({ c: String(o.charged ?? '').trim().toLowerCase(), r: o.receipt || null }));
  const firstIdx = list.findIndex((o) => o.c !== 'false');
  const first = firstIdx >= 0 ? list[firstIdx].r : null;
  let charged = 0, replays = 0, foreign = 0;
  list.forEach((o, i) => {
    if (o.c === 'false' && first && o.r === first) replays++;
    else {
      if (o.c !== 'false') charged++;
      if (i !== firstIdx && o.r !== first) foreign++;
    }
  });
  // T-0717: no charged response and every 200 is a charged:false replay sharing one receipt = the
  // payment under test was never settled (an earlier identical call inside the dedup window was).
  const inconclusive = list.length > 0 && firstIdx < 0 && list.every((o) => o.c === 'false' && o.r && o.r === list[0].r);
  if (inconclusive) {
    return { charged: 0, replays: list.length, foreign: 0, inconclusive: true, red: false,
      note: 'all replays of an earlier charge - 8.2 payment unused' };
  }
  return { charged, replays, foreign, inconclusive: false, red: charged > 1 || foreign > 0 };
}
module.exports = { classifyDoubleSpend };
