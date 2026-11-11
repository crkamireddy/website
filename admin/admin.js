// The /admin page: Cat's private numbers for catkamireddy.com.
//
// This file is public, like everything on GitHub Pages, and holds no data. It
// asks the Voice Guide Worker for the numbers, sending the admin key Cat pastes
// in. Without the right key the Worker answers "Not found".
// See voice-guide-skill/web/worker/src/admin.ts.

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const STATS_URL = LOCAL
  ? "http://localhost:8787/admin/stats"
  : "https://voice-guide.catreading.workers.dev/admin/stats";
const KEY_STORAGE = "admin-key";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const form = $("key-form");
const keyInput = $("key");
const keyError = $("key-error");
const report = $("report");
const tooltip = $("tooltip");

// ---------- The key, remembered in this browser only ----------

function savedKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}
function saveKey(key) {
  try { localStorage.setItem(KEY_STORAGE, key); } catch { /* private window: ask each time */ }
}
function forgetKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* nothing saved */ }
}

let currentKey = savedKey();

function askForKey(message) {
  report.hidden = true;
  $("refresh").hidden = true;
  $("forget").hidden = true;
  statusEl.textContent = "";
  form.hidden = false;
  keyError.hidden = !message;
  keyError.textContent = message || "";
  keyInput.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  currentKey = keyInput.value.trim();
  load();
});
$("refresh").addEventListener("click", () => load());
$("forget").addEventListener("click", () => {
  forgetKey();
  currentKey = "";
  keyInput.value = "";
  askForKey();
});

async function load() {
  if (!currentKey) return askForKey();
  statusEl.textContent = "Loading…";
  let response;
  try {
    response = await fetch(STATS_URL, { headers: { Authorization: `Bearer ${currentKey}` }, cache: "no-store" });
  } catch {
    statusEl.textContent = "Couldn't reach the Voice Guide Worker. Check your connection and refresh.";
    return;
  }
  if (response.status === 404) {
    forgetKey();
    return askForKey("That key didn't work.");
  }
  if (!response.ok) {
    statusEl.textContent = `The Worker answered ${response.status}. Try again in a minute.`;
    return;
  }
  saveKey(currentKey);
  form.hidden = true;
  $("refresh").hidden = false;
  $("forget").hidden = false;
  const data = await response.json();
  render(data);
  statusEl.textContent = `Updated ${new Date(data.generatedAt).toLocaleString()}. Days are Pacific time.`;
  report.hidden = false;
}

// ---------- Small helpers ----------

const fmt = (n) => Math.round(n).toLocaleString();
const money = (n) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);
const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : "–");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function tiles(items) {
  return el("div", { class: "tiles" }, ...items.map(([value, label, sub]) =>
    el("div", { class: "tile" },
      el("div", { class: "value" }, value),
      el("div", { class: "label" }, label),
      ...(sub ? [el("div", { class: "sub" }, sub)] : []))));
}

// columns: [heading, key, kind]: kind true = a number to format, "right" = text
// that's already formatted (like money) but lines up with numbers.
function table(columns, rows) {
  const head = el("tr", {}, ...columns.map(([h, , num]) => el("th", num ? { class: "num" } : {}, h)));
  const body = rows.map((row) =>
    el("tr", {}, ...columns.map(([, key, num]) =>
      el("td", { class: num ? "num" : "name" }, num === true ? fmt(row[key]) : String(row[key])))));
  return el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...body)));
}

// Pacific "today" comes from the Worker. Build the last n day strings, oldest first.
function lastDays(today, n) {
  const out = [];
  const base = new Date(`${today}T12:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
  return out;
}
const shortDate = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

// ---------- Bar chart (one measure, so one color and no legend) ----------

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// bars: [{ label, value, tip }]. Labels under every nth bar so they don't collide.
function barChart(title, bars, { height = 160, labelEvery = 1 } = {}) {
  const width = 640, left = 44, bottom = 30, top = 8;
  const plotW = width - left, plotH = height - top - bottom;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const slot = plotW / bars.length;
  const gap = Math.min(4, slot * 0.25);
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title });

  for (let v = 0; v <= yMax; v += step) {
    const y = top + plotH - (v / yMax) * plotH;
    chart.append(svg("line", { class: v === 0 ? "axis" : "grid", x1: left, x2: width, y1: y, y2: y }));
    const t = svg("text", { x: left - 6, y: y + 4, "text-anchor": "end" });
    t.textContent = fmt(v);
    chart.append(t);
  }

  bars.forEach((b, i) => {
    const x = left + i * slot + gap / 2;
    const w = Math.max(1, slot - gap);
    const h = (b.value / yMax) * plotH;
    const y = top + plotH - h;
    // Rounded at the top only: a rect with a square bottom under a rounded one.
    const r = Math.min(4, w / 2, h);
    const path = h > 0
      ? `M${x},${top + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${top + plotH} Z`
      : "";
    // A taller, invisible target so thin or zero bars are still easy to hover.
    const hit = svg("rect", { class: "hit", x: left + i * slot, y: top, width: slot, height: plotH });
    const bar = svg("path", { class: "bar", d: path });
    for (const target of [hit, bar]) {
      target.addEventListener("mousemove", (e) => showTip(e, b.tip));
      target.addEventListener("mouseleave", hideTip);
    }
    chart.append(hit, bar);
    // Count back from the newest bar, so the latest day always has a label.
    if ((bars.length - 1 - i) % labelEvery === 0) {
      const t = svg("text", { x: x + w / 2, y: height - 6, "text-anchor": "middle" });
      t.textContent = b.label;
      chart.append(t);
    }
  });
  return el("div", {}, el("p", { class: "chart-title" }, title), chart);
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) || pow * 10;
}

function showTip(event, text) {
  tooltip.textContent = text;
  tooltip.hidden = false;
  const x = Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth - 8);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${event.clientY - tooltip.offsetHeight - 10}px`;
}
function hideTip() { tooltip.hidden = true; }

// ---------- The report ----------

function render(data) {
  const vg = data.voiceGuide;
  const today = vg.today.day;
  const days30 = lastDays(today, 30);
  const byDay = Object.fromEntries(vg.days.map((d) => [d.day, d]));
  const sum = (rows, key) => rows.reduce((t, r) => t + (r?.[key] || 0), 0);
  const recent = days30.map((d) => byDay[d]).filter(Boolean);
  const month = today.slice(0, 7);
  const thisMonth = vg.days.filter((d) => d.day.startsWith(month));

  renderNotes(data, recent, thisMonth);
  renderVisitors(data, days30, recent);
  renderVoiceGuide(data, days30, byDay, sum, thisMonth);
}

function renderNotes(data, recent, thisMonth) {
  const vg = data.voiceGuide;
  const sum = (rows, key) => rows.reduce((t, r) => t + (r[key] || 0), 0);
  const notes = [];
  const siteFull = recent.filter((d) => d.site_limit_hits > 0).length;
  const todayLeft = data.limits.sitePerDay - vg.today.conversationsStarted;

  notes.push(`Voice Guide today: ${vg.today.conversationsStarted} of ${data.limits.sitePerDay} conversations used (${todayLeft} left), from ${vg.today.distinctVisitors} ${vg.today.distinctVisitors === 1 ? "visitor" : "visitors"}.`);
  notes.push(`Estimated Anthropic spend this month: ${money(sum(thisMonth, "cost_usd"))}. Your Console billing page has the real number.`);
  if (siteFull) notes.push(`The site-wide daily limit (${data.limits.sitePerDay}) turned people away on ${siteFull} of the last 30 days (${fmt(sum(recent, "site_limit_hits"))} times). Worth raising if it keeps happening.`);
  const cap = sum(recent, "spending_cap_hits");
  if (cap) notes.push(`The Console spending cap stopped Voice Guide ${fmt(cap)} ${cap === 1 ? "time" : "times"} in the last 30 days.`);
  const errors = sum(recent, "errors") - cap;
  if (errors) notes.push(`Claude's API failed ${fmt(errors)} ${cap ? "other " : ""}${errors === 1 ? "time" : "times"} in the last 30 days (outages, overload). People saw a "try again" message.`);
  const fallbacks = sum(recent, "fallbacks");
  if (fallbacks) notes.push(`Opus declined ${fmt(fallbacks)} ${fallbacks === 1 ? "reply" : "replies"} in the last 30 days and another model answered instead.`);
  const turnstile = sum(recent, "turnstile_failures");
  if (turnstile) notes.push(`The "are you a person" check failed ${fmt(turnstile)} ${turnstile === 1 ? "time" : "times"} in the last 30 days. A few is normal; a lot means bots are trying.`);
  if (data.visitors.status === "not_connected") notes.push("Visitor numbers aren't connected yet. Steps are under Visitors.");
  if (data.visitors.status === "error") notes.push(`Cloudflare Web Analytics returned an error: ${data.visitors.message}`);

  $("notes").replaceChildren(...notes.map((n) => el("li", {}, n)));
}

function renderVisitors(data, days30, recentVG) {
  const v = data.visitors;
  const box = $("visitors");
  $("visitors-range").textContent = v.status === "ok" ? "Last 30 days, from Cloudflare Web Analytics. A visit is someone arriving from another site or typing the address." : "";

  if (v.status !== "ok") {
    const message = v.status === "not_connected"
      ? "Not connected yet. The Worker needs your Cloudflare account ID, the Web Analytics site tag and a read-only analytics token."
      : `Cloudflare returned an error: ${v.message}`;
    box.replaceChildren(el("div", { class: "note-box" }, message));
    return;
  }

  const visitsByDay = Object.fromEntries(v.byDay.map((d) => [d.date, d]));
  const totalViews = v.byDay.reduce((t, d) => t + d.pageViews, 0);
  const totalVisits = v.byDay.reduce((t, d) => t + d.visits, 0);
  const vgPage = v.pages.filter((p) => p.name.startsWith("/voice-guide")).reduce((t, p) => t + p.pageViews, 0);
  const started = recentVG.reduce((t, d) => t + (d.conversations || 0), 0);
  const guides = recentVG.reduce((t, d) => t + (d.guides || 0), 0);

  box.replaceChildren(
    tiles([
      [fmt(totalVisits), "visits"],
      [fmt(totalViews), "page views"],
      [fmt(vgPage), "Voice Guide page views"],
      [pct(started, vgPage), "of Voice Guide views started a conversation", `${fmt(started)} started, ${fmt(guides)} guides`],
    ]),
    barChart("Visits per day", days30.map((d) => {
      const row = visitsByDay[d] || { visits: 0, pageViews: 0 };
      return { label: shortDate(d), value: row.visits, tip: `${shortDate(d)}: ${fmt(row.visits)} visits, ${fmt(row.pageViews)} page views` };
    }), { labelEvery: 7 }),
    el("div", { class: "tables" },
      el("div", {}, el("h3", {}, "Top pages"), table([["Page", "name"], ["Views", "pageViews", true], ["Visits", "visits", true]], v.pages)),
      el("div", {}, el("h3", {}, "Where visits came from"), table([["Site", "name"], ["Views", "pageViews", true], ["Visits", "visits", true]], v.referrers)),
      el("div", {}, el("h3", {}, "Countries"), table([["Country", "name"], ["Views", "pageViews", true]], v.countries)),
      el("div", {}, el("h3", {}, "Devices"), table([["Device", "name"], ["Views", "pageViews", true]], v.devices)),
    ),
  );
}

function renderVoiceGuide(data, days30, byDay, sum, thisMonth) {
  const vg = data.voiceGuide;
  const all = vg.days;
  const convos = vg.conversations;
  const totalConvos = convos.length;
  const withGuide = convos.filter((c) => c.guide).length;
  const allCost = sum(all, "cost_usd");
  const box = $("voice-guide");

  if (!all.length) {
    box.replaceChildren(el("div", { class: "note-box" }, "No conversations recorded yet. Counting started when this version of the Worker was deployed."));
    return;
  }

  // How far conversations get, in turns (one turn = one message from the visitor).
  const buckets = [["1", 1, 1], ["2–5", 2, 5], ["6–10", 6, 10], ["11–20", 11, 20], ["21–40", 21, 40], ["41–60", 41, 60]];
  const lengthBars = buckets.map(([label, lo, hi]) => {
    const inBucket = convos.filter((c) => c.turns >= lo && c.turns <= hi);
    const guides = inBucket.filter((c) => c.guide).length;
    return { label, value: inBucket.length, tip: `${label} messages: ${fmt(inBucket.length)} conversations, ${fmt(guides)} with a guide` };
  });

  // Month by month.
  const months = {};
  for (const d of all) {
    const m = (months[d.day.slice(0, 7)] ||= { month: d.day.slice(0, 7), conversations: 0, guides: 0, turns: 0, cost: 0 });
    m.conversations += d.conversations; m.guides += d.guides; m.turns += d.turns; m.cost += d.cost_usd;
  }
  const monthRows = Object.values(months).reverse().map((m) => ({
    ...m,
    monthName: new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }),
    costText: money(m.cost),
  }));

  // What stopped people, last 30 days and all time.
  const recent = days30.map((d) => byDay[d]).filter(Boolean);
  const stops = [
    [`Hit their own daily limit (${data.limits.visitorPerDay})`, "visitor_limit_hits"],
    [`Site daily limit reached (${data.limits.sitePerDay})`, "site_limit_hits"],
    ["Failed the person check", "turnstile_failures"],
    ["Conversation too long (60 turns)", "conversation_limit_hits"],
    ["Conversation over a day old", "expired"],
    ["Sending too fast", "rate_limited"],
    ["Claude API error", "errors"],
    ["...of which the spending cap", "spending_cap_hits"],
  ].map(([name, key]) => ({ name, recent: sum(recent, key), all: sum(all, key) }));

  box.replaceChildren(
    tiles([
      [fmt(totalConvos), "conversations, all time"],
      [fmt(withGuide), "ended with a guide", `${pct(withGuide, totalConvos)} of conversations`],
      [money(allCost), "estimated spend, all time", `${money(sum(thisMonth, "cost_usd"))} this month`],
      [totalConvos ? money(allCost / totalConvos) : "–", "average per conversation"],
    ]),
    barChart("Conversations per day, last 30 days", days30.map((d) => {
      const row = byDay[d] || { conversations: 0, guides: 0, cost_usd: 0 };
      return { label: shortDate(d), value: row.conversations, tip: `${shortDate(d)}: ${fmt(row.conversations)} conversations, ${fmt(row.guides)} guides, ${money(row.cost_usd)}` };
    }), { labelEvery: 7 }),
    barChart("How far conversations get (messages from the visitor)", lengthBars, { height: 140 }),
    el("div", { class: "tables" },
      el("div", {}, el("h3", {}, "By month"), table([["Month", "monthName"], ["Conversations", "conversations", true], ["Guides", "guides", true], ["Est. cost", "costText", "right"]], monthRows)),
      el("div", {}, el("h3", {}, "What stopped people"), table([["", "name"], ["30 days", "recent", true], ["All time", "all", true]], stops)),
    ),
  );
}

load();
