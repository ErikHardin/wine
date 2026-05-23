// Hardin Cellar – Trip View widget for Scriptable (medium size)
// Place this file in Scriptable on iOS, add a medium widget, and optionally
// set the widget Parameter to a trip name to pin that trip.

// ─── Constants ───────────────────────────────────────────────────────────────

const DB_BASE    = "https://wine-5ab2d-default-rtdb.firebaseio.com";
const WINE_COLORS = ["Red", "White", "Rosé", "Sparkling"];

const PALETTE = {
  bg:        new Color("#ede4d0"),
  text:      new Color("#1e1408"),
  muted:     new Color("#8a7a6a"),
  gold:      new Color("#c8602a"),
  barTrack:  new Color("#d0c4ae"),
  Red:       new Color("#9b3040"),
  White:     new Color("#a07820"),
  "Rosé":    new Color("#b05868"),
  Sparkling: new Color("#3a6888"),
};

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchData() {
  const wineReq = new Request(`${DB_BASE}/wines.json`);
  const tripReq = new Request(`${DB_BASE}/trips.json`);
  const winesRaw = await wineReq.loadJSON();
  const tripsRaw = await tripReq.loadJSON();
  return { wines: winesRaw || {}, trips: tripsRaw || {} };
}

// ─── Trip selection ───────────────────────────────────────────────────────────

function selectTrip(trips, param) {
  const list = Object.values(trips);
  if (list.length === 0) return null;

  if (param) {
    const match = list.find(t => t.name.toLowerCase() === param.toLowerCase());
    if (match) return match;
  }

  return list.sort((a, b) => b.createdAt - a.createdAt)[0];
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregateTrip(wines, tripId) {
  const tripWines = Object.values(wines).filter(w => w.tripId === tripId);
  const counts    = { Red: 0, White: 0, "Rosé": 0, Sparkling: 0 };
  let totalBottles = 0;
  let totalCost    = 0;

  for (const w of tripWines) {
    const qty   = parseInt(w.qty)     || 1;
    const price = parseFloat(w.price) || 0;
    if (Object.prototype.hasOwnProperty.call(counts, w.color)) {
      counts[w.color] += qty;
    }
    totalBottles += qty;
    totalCost    += price * qty;
  }

  return { counts, totalBottles, totalCost };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatCost(n) {
  if (n === 0)    return "$0";
  if (n >= 1000)  return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// ─── Widget builders ──────────────────────────────────────────────────────────

// Progress bar: two stacked WidgetStacks inside a fixed outer stack
function addProgressBar(parent, pct) {
  const BAR_W = 268, BAR_H = 8;
  const clamped  = Math.min(100, Math.max(0, pct));
  const filledPt = Math.round(BAR_W * clamped / 100);
  const emptyPt  = BAR_W - filledPt;

  const outer = parent.addStack();
  outer.layoutHorizontally();
  outer.size            = new Size(BAR_W, BAR_H);
  outer.cornerRadius    = 4;
  outer.backgroundColor = PALETTE.barTrack;

  if (filledPt > 0) {
    const filled = outer.addStack();
    filled.size            = new Size(filledPt, BAR_H);
    filled.backgroundColor = PALETTE.gold;
  }

  if (emptyPt > 0) {
    const empty = outer.addStack();
    empty.size = new Size(emptyPt, BAR_H);
  }
}

// One color cell: dot ● + label + spacer + count
function addColorCell(parent, colorName, counts) {
  const cell = parent.addStack();
  cell.layoutHorizontally();
  cell.centerAlignContent();

  const dot = cell.addStack();
  dot.size            = new Size(8, 8);
  dot.cornerRadius    = 4;
  dot.backgroundColor = PALETTE[colorName];

  cell.addSpacer(5);

  const lbl = cell.addText(colorName);
  lbl.font      = Font.systemFont(11);
  lbl.textColor = PALETTE.muted;
  lbl.lineLimit = 1;

  cell.addSpacer(null);

  const cnt = cell.addText(String(counts[colorName]));
  cnt.font      = Font.boldSystemFont(12);
  cnt.textColor = PALETTE.text;
}

function buildWidget(trip, agg) {
  const { counts, totalBottles, totalCost } = agg;
  const pct = trip.capacity > 0
    ? Math.min(100, Math.round(totalBottles / trip.capacity * 100))
    : 0;

  const widget = new ListWidget();
  widget.backgroundColor = PALETTE.bg;
  widget.setPadding(14, 16, 14, 16);

  // ── Header ────────────────────────────────────────────────────────────────
  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();

  const title = header.addText("Hardin Cellar");
  title.font      = Font.boldSystemFont(13);
  title.textColor = PALETTE.text;

  header.addSpacer(null);

  const tripName = header.addText(trip.name);
  tripName.font      = Font.systemFont(12);
  tripName.textColor = PALETTE.gold;
  tripName.lineLimit = 1;

  widget.addSpacer(8);

  // ── Capacity label ────────────────────────────────────────────────────────
  const capRow = widget.addStack();
  capRow.layoutHorizontally();
  capRow.centerAlignContent();

  const bottleLabel = capRow.addText(
    `${totalBottles} of ${trip.capacity} bottles`
  );
  bottleLabel.font      = Font.systemFont(11);
  bottleLabel.textColor = PALETTE.muted;

  capRow.addSpacer(null);

  const pctLabel = capRow.addText(`${pct}%`);
  pctLabel.font      = Font.boldSystemFont(12);
  pctLabel.textColor = PALETTE.gold;

  widget.addSpacer(4);

  // ── Progress bar ──────────────────────────────────────────────────────────
  addProgressBar(widget, pct);

  widget.addSpacer(10);

  // ── Color grid (2 × 2) ────────────────────────────────────────────────────
  const row1 = widget.addStack();
  row1.layoutHorizontally();

  addColorCell(row1, "Red",   counts);
  row1.addSpacer(12);
  addColorCell(row1, "White", counts);

  widget.addSpacer(4);

  const row2 = widget.addStack();
  row2.layoutHorizontally();

  addColorCell(row2, "Rosé",      counts);
  row2.addSpacer(12);
  addColorCell(row2, "Sparkling", counts);

  widget.addSpacer(10);

  // ── Total cost ────────────────────────────────────────────────────────────
  const costRow = widget.addStack();
  costRow.layoutHorizontally();
  costRow.centerAlignContent();

  const costLabel = costRow.addText("TOTAL VALUE");
  costLabel.font      = Font.systemFont(10);
  costLabel.textColor = PALETTE.muted;

  costRow.addSpacer(null);

  const costVal = costRow.addText(formatCost(totalCost));
  costVal.font      = Font.boldSystemFont(13);
  costVal.textColor = PALETTE.gold;

  return widget;
}

function buildErrorWidget(msg) {
  const widget = new ListWidget();
  widget.backgroundColor = PALETTE.bg;
  widget.setPadding(14, 16, 14, 16);

  const t1 = widget.addText("Hardin Cellar");
  t1.font      = Font.boldSystemFont(13);
  t1.textColor = PALETTE.text;

  widget.addSpacer(8);

  const t2 = widget.addText(`⚠ ${msg}`);
  t2.font      = Font.systemFont(12);
  t2.textColor = new Color("#b03030");

  widget.addSpacer(4);

  const t3 = widget.addText("Tap to open app");
  t3.font      = Font.systemFont(10);
  t3.textColor = PALETTE.muted;

  return widget;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run() {
  const param = Script.widgetParameter || null;

  let data;
  try {
    data = await fetchData();
  } catch (e) {
    const w = buildErrorWidget("Network error");
    if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
    Script.complete();
    return;
  }

  const trip = selectTrip(data.trips, param);
  if (!trip) {
    const w = buildErrorWidget("No trips found");
    if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
    Script.complete();
    return;
  }

  const agg    = aggregateTrip(data.wines, trip.id);
  const widget = buildWidget(trip, agg);

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentMedium();
  }

  Script.complete();
}

await run();
