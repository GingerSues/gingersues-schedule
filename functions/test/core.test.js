const test = require("node:test");
const assert = require("node:assert");
const c = require("../lib/core");

const config = { locations: [{ id: "liberty", name: "Liberty" }, { id: "olathe", name: "Olathe" }] };
const staff = { a: { name: "Amy Lee" }, b: { name: "Ben Cho" }, z: { name: "Zed Gone", active: false } };

test("normPhone", () => {
  assert.equal(c.normPhone("(816) 555-0123"), "+18165550123");
  assert.equal(c.normPhone("1-816-555-0123"), "+18165550123");
  assert.equal(c.normPhone("+18165550123"), "+18165550123");
  assert.equal(c.normPhone("555-0123"), null);
});

test("publish texts go only to people with newly published shifts, with their whole week", () => {
  const week = [
    { id: "1", date: "2026-11-09", start: "06:15", end: "14:00", pos: "Server", loc: "liberty", staffId: "a", published: true },
    { id: "2", date: "2026-11-11", start: "07:30", end: "14:00", pos: "Server", loc: "liberty", staffId: "a", published: true },
    { id: "3", date: "2026-11-10", start: "08:00", end: "14:30", pos: "Cook", loc: "olathe", staffId: "b", published: true },
    { id: "4", date: "2026-11-10", start: "08:00", end: "14:30", pos: "Cook", loc: "olathe", staffId: "z", published: true },
  ];
  const out = c.publishTexts({ week: "2026-11-09", shiftIds: ["2", "4"] }, week, staff, config);
  assert.equal(out.length, 1);
  assert.equal(out[0].staffId, "a");
  assert.match(out[0].body, /Hi Amy, your schedule for the week of Nov 9 at Liberty is posted\./);
  assert.match(out[0].body, /Mon 11\/9 6:15a–2p Server\nWed 11\/11 7:30a–2p Server/);
  assert.match(out[0].body, /Reply STOP/);
});

test("publish modes: changed / all / none, and updated wording", () => {
  const week = [
    { id: "1", date: "2026-11-09", start: "06:15", end: "14:00", pos: "Server", loc: "liberty", staffId: "a", published: true },
    { id: "3", date: "2026-11-10", start: "08:00", end: "14:30", pos: "Cook", loc: "olathe", staffId: "b", published: true },
  ];
  const ev = { week: "2026-11-09", shiftIds: [], locs: ["liberty"] };
  const changed = c.publishTexts(ev, week, staff, config, ["a"]);
  assert.deepEqual(changed.map(m => m.staffId), ["a"]);
  assert.match(changed[0].body, /was updated\./);
  assert.deepEqual(c.publishTexts({ ...ev, mode: "all" }, week, staff, config, []).map(m => m.staffId), ["a"]);
  assert.deepEqual(c.publishTexts({ ...ev, mode: "all", locs: [] }, week, staff, config, []).map(m => m.staffId).sort(), ["a", "b"]);
  assert.deepEqual(c.publishTexts({ ...ev, mode: "none" }, week, staff, config, ["a"]), []);
  const gone = c.publishTexts(ev, week, { ...staff, e: { name: "Eve X" } }, config, ["e"]);
  assert.match(gone.find(m => m.staffId === "e").body, /no shifts that week/);
});

test("edits to published shifts are noted for the next publish", () => {
  const base = { date: "2026-11-12", start: "07:00", end: "14:00", pos: "Server", loc: "liberty", published: true, staffId: "a" };
  assert.deepEqual(c.changeNotes(base, { ...base, staffId: "b" }, "2026-11-08"),
    [{ staffId: "a", week: "2026-11-09", loc: "liberty" }, { staffId: "b", week: "2026-11-09", loc: "liberty" }]);
  assert.deepEqual(c.changeNotes(base, { ...base, end: "15:00" }, "2026-11-08"), [{ staffId: "a", week: "2026-11-09", loc: "liberty" }]);
  assert.deepEqual(c.changeNotes(base, { ...base, note: "x" }, "2026-11-08"), []);
  assert.deepEqual(c.changeNotes({ ...base, published: false }, base, "2026-11-08"), []);
  assert.deepEqual(c.changeNotes(base, null, "2026-11-08"), [{ staffId: "a", week: "2026-11-09", loc: "liberty" }]);
  assert.equal(c.mondayOf("2026-11-15"), "2026-11-09");
});

test("shift change texts", () => {
  const today = "2026-11-08";
  const base = { date: "2026-11-10", start: "07:00", end: "14:00", pos: "Server", loc: "liberty", published: true };
  assert.deepEqual(c.shiftChangeTexts({ ...base, published: false, staffId: "a" }, { ...base, staffId: "a" }, staff, config, today), []);
  const moved = c.shiftChangeTexts({ ...base, staffId: "a" }, { ...base, staffId: "b" }, staff, config, today);
  assert.deepEqual(moved.map(m => m.staffId), ["a", "b"]);
  assert.match(moved[0].body, /no longer on Tue 11\/10 7a–2p Server \(Liberty\)/);
  assert.match(moved[1].body, /added to/);
  const timeChange = c.shiftChangeTexts({ ...base, staffId: "a" }, { ...base, staffId: "a", end: "15:00" }, staff, config, today);
  assert.match(timeChange[0].body, /Was Tue 11\/10 7a–2p.*Now Tue 11\/10 7a–3p/);
  assert.deepEqual(c.shiftChangeTexts({ ...base, staffId: "a" }, { ...base, staffId: "a", note: "x" }, staff, config, today), []);
  assert.equal(c.shiftChangeTexts({ ...base, staffId: "a" }, null, staff, config, today).length, 1);
  assert.deepEqual(c.shiftChangeTexts({ ...base, date: "2026-11-01", staffId: "a" }, null, staff, config, today), []);
});

test("time off, cover and request texts", () => {
  const t = c.timeoffText({ status: "pending" }, { status: "approved", staffId: "a", from: "2026-11-12", to: "2026-11-13" }, staff);
  assert.match(t[0].body, /Thu 11\/12 – Fri 11\/13 was approved/);
  assert.deepEqual(c.timeoffText({ status: "pending" }, { status: "cancelled", staffId: "a" }, staff), []);
  const req = { type: "cover", status: "coworker", staffId: "a", targetId: "b", date: "2026-11-10", start: "07:00", end: "14:00", pos: "Server", loc: "liberty" };
  assert.equal(c.coverAskText(req, staff, config)[0].staffId, "b");
  assert.match(c.requestUpdateTexts(req, { ...req, status: "pending" }, staff, config)[0].body, /Ben Cho agreed to cover/);
  assert.match(c.requestUpdateTexts({ ...req, status: "pending", type: "pickup" }, { ...req, type: "pickup", status: "denied" }, staff, config)[0].body, /pick up .* wasn't approved/);
});

test("decideRole", () => {
  assert.deepEqual(c.decideRole({ phone: "+18165550123", ownerPhones: ["816-555-0123"], staffMatch: null }), { role: "owner", staffId: null });
  assert.deepEqual(c.decideRole({ phone: "+18165550199", ownerPhones: [], staffMatch: { id: "m", isManager: true } }), { role: "manager", staffId: "m" });
  assert.deepEqual(c.decideRole({ phone: "+18165550199", ownerPhones: [], staffMatch: { id: "e" } }), { role: "employee", staffId: "e" });
  assert.equal(c.decideRole({ phone: "+18165550199", ownerPhones: [], staffMatch: null }), null);
});

test("functions file loads", () => {
  const f = require("../index.js");
  for (const k of ["linkAccount", "syncRole", "phoneChanged", "onPublish", "onShiftUpdate", "onShiftDelete", "onTimeoffUpdate", "onRequestCreate", "onRequestUpdate", "testText"]) assert.ok(f[k], k);
});
