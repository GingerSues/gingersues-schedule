// Pure helpers for the Cloud Functions: phone numbers, dates and the wording of each text.
// No Firebase imports here, so these are easy to test.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SITE = "https://schedule.gingersues.com";

function normPhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null;
}
function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function addD(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fmtT(t) {
  let [h, m] = String(t || "0:0").split(":").map(Number); const ap = h >= 12 ? "p" : "a"; h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
}
function fmtDay(s) { const d = parse(s); return `${DAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }
function mondayOf(s) { const d = parse(s); const back = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - back); return d.toISOString().slice(0, 10); }
function fmtMonthDay(s) { const d = parse(s); return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`; }
function todayCentral(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function locName(config, id) { return ((config && config.locations) || []).find(l => l.id === id)?.name || id; }
function shiftLine(s, config, withLoc) {
  return `${fmtDay(s.date)} ${fmtT(s.start)}–${fmtT(s.end)} ${s.pos || ""}${withLoc ? ` (${locName(config, s.loc)})` : ""}`.trim();
}
const byTime = (a, b) => a.date.localeCompare(b.date) || String(a.start).localeCompare(String(b.start));

/**
 * Texts for a publish. Each person texted gets their whole week (all stores).
 * @param ev {week, shiftIds, mode: "changed" | "all" | "none", locs}
 * @param weekShifts published shifts in that week (all stores)
 * @param staff map id -> staff doc
 * @param changedIds staff ids whose published shifts were edited since the last publish
 */
function publishTexts(ev, weekShifts, staff, config, changedIds = []) {
  const mode = ev.mode || "changed";
  if (mode === "none") return [];
  const fresh = new Set(ev.shiftIds || []);
  const locs = ev.locs && ev.locs.length ? new Set(ev.locs) : null;
  const updated = new Set(changedIds);
  const people = new Set([...weekShifts.filter(s => fresh.has(s.id) && s.staffId).map(s => s.staffId), ...updated]);
  if (mode === "all") weekShifts.filter(s => s.staffId && (!locs || locs.has(s.loc))).forEach(s => people.add(s.staffId));
  const out = [];
  for (const id of people) {
    const st = staff[id]; if (!st || st.active === false) continue;
    const mine = weekShifts.filter(s => s.staffId === id).sort(byTime);
    const first = (st.name || "").split(" ")[0];
    const verb = updated.has(id) ? "was updated" : "is posted";
    if (!mine.length) {
      out.push({ staffId: id, body: `Ginger Sue's: Hi ${first}, your schedule for the week of ${fmtMonthDay(ev.week)} was updated. You have no shifts that week.\n${SITE}\nReply STOP to opt out.` });
      continue;
    }
    const multi = new Set(mine.map(s => s.loc)).size > 1;
    const lines = mine.map(s => shiftLine(s, config, multi));
    const where = multi ? "" : ` at ${locName(config, mine[0].loc)}`;
    out.push({
      staffId: id,
      body: `Ginger Sue's: Hi ${first}, your schedule for the week of ${fmtMonthDay(ev.week)}${where} ${verb}.\n${lines.join("\n")}\n${SITE}\nReply STOP to opt out.`,
    });
  }
  return out;
}

/** Who to note for the next publish when a published shift is edited (not texted right away). */
function changeNotes(before, after, today) {
  if (!before || !before.published) return [];
  if (after && !after.published) return [];
  if (after && !CHANGE_KEYS.some(k => (before[k] || null) !== (after[k] || null))) return [];
  const notes = [];
  if (before.staffId && before.date >= today) notes.push({ staffId: before.staffId, week: mondayOf(before.date), loc: before.loc });
  if (after && after.staffId && after.date >= today) notes.push({ staffId: after.staffId, week: mondayOf(after.date), loc: after.loc });
  const seen = new Set();
  return notes.filter(n => { const k = `${n.week}_${n.staffId}_${n.loc}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const CHANGE_KEYS = ["staffId", "date", "start", "end", "loc", "pos"];
/** Texts when a published shift is changed, reassigned or deleted. after = null for a delete. */
function shiftChangeTexts(before, after, staff, config, today) {
  if (!before || !before.published) return [];
  if (after && !after.published) return [];
  if (after && !CHANGE_KEYS.some(k => (before[k] || null) !== (after[k] || null))) return [];
  const live = s => s && s.date >= today;
  const out = [];
  const nameOf = id => ((staff[id] || {}).name || "").split(" ")[0];
  const push = (id, body) => { const st = staff[id]; if (st && st.active !== false) out.push({ staffId: id, body: `Ginger Sue's: ${nameOf(id) ? "Hi " + nameOf(id) + ", " : ""}${body}\n${SITE}` }); };
  const oldId = before.staffId || null, newId = after ? after.staffId || null : null;
  if (oldId && oldId !== newId && live(before)) push(oldId, `you're no longer on ${shiftLine(before, config, true)}.`);
  if (newId && newId !== oldId && live(after)) push(newId, `you've been added to ${shiftLine(after, config, true)}.`);
  if (newId && newId === oldId && (live(after) || live(before)))
    push(newId, `your shift changed. Was ${shiftLine(before, config, true)}. Now ${shiftLine(after, config, true)}.`);
  return out;
}

function timeoffText(before, after, staff) {
  if (!after || !after.staffId || before.status === after.status) return [];
  if (!["approved", "denied"].includes(after.status) || before.status !== "pending") return [];
  const st = staff[after.staffId]; if (!st || st.active === false) return [];
  const range = after.from === after.to ? fmtDay(after.from) : `${fmtDay(after.from)} – ${fmtDay(after.to)}`;
  return [{ staffId: after.staffId, body: `Ginger Sue's: your time-off request for ${range} was ${after.status}.\n${SITE}` }];
}

function coverAskText(req, staff, config) {
  if (!req || req.type !== "cover" || req.status !== "coworker" || !req.targetId) return [];
  const from = (staff[req.staffId] || {}).name || "A coworker";
  return [{ staffId: req.targetId, body: `Ginger Sue's: ${from} asked you to cover ${shiftLine(req, config, true)}.${req.note ? ` “${String(req.note).slice(0, 120)}”` : ""} Open the app to say yes or no.\n${SITE}` }];
}

function requestUpdateTexts(before, after, staff, config) {
  if (!after || before.status === after.status) return [];
  const who = (staff[after.targetId] || {}).name || "Your coworker";
  const line = shiftLine(after, config, true);
  if (after.type === "cover" && before.status === "coworker" && after.status === "pending")
    return [{ staffId: after.staffId, body: `Ginger Sue's: ${who} agreed to cover ${line}. A manager still needs to approve it.\n${SITE}` }];
  if (after.type === "cover" && before.status === "coworker" && after.status === "declined")
    return [{ staffId: after.staffId, body: `Ginger Sue's: ${who} can't cover ${line}. You're still on it.\n${SITE}` }];
  if (after.status === "denied" && before.status === "pending") {
    const what = after.type === "pickup" ? "pick up" : after.type === "drop" ? "drop" : "trade";
    return [{ staffId: after.staffId, body: `Ginger Sue's: your request to ${what} ${line} wasn't approved.\n${SITE}` }];
  }
  return [];
}

/** Decide what account a signed-in phone number gets. */
function decideRole({ phone, ownerPhones, staffMatch }) {
  const owner = (ownerPhones || []).map(normPhone).filter(Boolean).includes(phone);
  if (staffMatch && staffMatch.active !== false)
    return { role: owner ? "owner" : staffMatch.isManager ? "manager" : "employee", staffId: staffMatch.id };
  if (owner) return { role: "owner", staffId: null };
  return null;
}

module.exports = {
  SITE, normPhone, addD, fmtT, fmtDay, todayCentral, shiftLine,
  publishTexts, changeNotes, mondayOf, shiftChangeTexts, timeoffText, coverAskText, requestUpdateTexts, decideRole,
};
