// Browser tests: the real page with the Firebase SDK swapped for test/fake-fbapi.js.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = path.resolve("test/site");
fs.mkdirSync(root, { recursive: true });
for (const f of ["index.html", "admin.html", "icon.svg", "manifest.webmanifest"]) if (fs.existsSync("public/" + f)) fs.copyFileSync("public/" + f, path.join(root, f));
const shots = path.resolve("test/shots"); fs.mkdirSync(shots, { recursive: true });

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".svg") ? "image/svg+xml" : "text/html" });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
test.after(async () => { await browser.close(); server.close(); });

const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mon = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d; })();
const day = n => { const d = new Date(mon); d.setDate(d.getDate() + n); return iso(d); };

function seed() {
  return {
    config: { main: {
      locations: [{ id: "lees-summit", name: "Lee's Summit", code: "LS" }, { id: "liberty", name: "Liberty", code: "LB" }, { id: "olathe", name: "Olathe", code: "OL" }],
      positions: [{ name: "Supervisor", color: "#7c3aed" }, { name: "Server", color: "#0e7490" }, { name: "Host", color: "#be185d" }, { name: "Cook", color: "#c2410c" }, { name: "Dish", color: "#475569" }],
      templates: [{ name: "Open", start: "06:15", end: "14:00" }], defaultMax: 40 } },
    staff: {
      m1: { name: "Mia Manager", positions: ["Supervisor"], locations: ["liberty"], active: true, isManager: true, avail: [] },
      e1: { name: "Evan Server", positions: ["Server"], locations: ["liberty"], active: true, avail: [] },
      e2: { name: "Cora Cook", positions: ["Cook"], locations: ["liberty"], active: true, avail: [] },
    },
    private: { m1: { wage: 18, phone: "+18165550100" }, e1: { wage: 7.5, phone: "+18165550101" }, e2: { wage: 16 } },
    shifts: {
      s1: { date: day(0), start: "07:30", end: "14:00", pos: "Server", loc: "liberty", staffId: "e1", published: true, breakMin: 0, note: "" },
      s2: { date: day(1), start: "06:15", end: "14:00", pos: "Cook", loc: "liberty", staffId: "e2", published: true, breakMin: 0, note: "" },
      s3: { date: day(2), start: "08:00", end: "14:30", pos: "Server", loc: "liberty", staffId: "e1", published: false, breakMin: 0, note: "" },
    },
    timeoff: { t1: { staffId: "e2", from: day(9), to: day(9), status: "pending", note: "private reason", ts: 1 } },
    requests: {}, messages: {}, standard: {}, forecast: {},
    notify: { [`${day(0)}_e2_liberty`]: { week: day(0), staffId: "e2", loc: "liberty", ts: 1 } },
  };
}

async function open(fake, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/ERR_TUNNEL|ERR_NAME|net::/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(f => { window.__FAKE = f; try { localStorage.clear(); } catch {} }, { data: seed(), ...fake });
  await page.goto(base + "/");
  return { page, ctx, errors };
}
const fake = page => page.evaluate(() => ({ data: window.__FAKE.data, log: window.__FAKE.log, denied: window.__FAKE.denied, calls: window.__FAKE.calls }));

test("sign in by texted code, manager sees the full app", async () => {
  const { page, ctx, errors } = await open({ role: "manager", staffId: "m1" });
  await page.getByLabel("Cell number").fill("816 555 0100");
  await page.getByRole("button", { name: "Text me a code" }).click();
  await page.getByLabel("Code from the text").fill("111111");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("That code isn't right").waitFor();
  await page.getByLabel("Code from the text").fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("nav.tabs").waitFor();
  const tabs = await page.locator("nav.tabs button").allTextContents();
  assert.ok(tabs.some(t => t.startsWith("Team")) && tabs.some(t => t.startsWith("Settings")), tabs.join());
  assert.equal(await page.evaluate(() => window.__FAKE.lastPhone), "+18165550100");
  await page.getByText("Signed in as (816) 555-0100").waitFor();
  await page.screenshot({ path: path.join(shots, "manager-schedule.png") });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("manager: pay and cell stay in /private, publish creates a text event, no Drive button", async () => {
  const { page, ctx, errors } = await open({ role: "manager", staffId: "m1", signedIn: true, phone: "+18165550100" });
  await page.locator("nav.tabs").waitFor();
  await page.locator('nav.tabs button[data-tab="team"]').click();
  await page.getByText("$7.50").waitFor();
  await page.locator('tr:has-text("Cora Cook") button[data-act="editStaff"]').click();
  await page.locator("#st-phone").fill("(913) 555-0102");
  await page.locator("#st-wage").fill("16.5");
  await page.locator('#staffForm button[data-act="saveStaff"]').click();
  await page.waitForTimeout(300);
  let f = await fake(page);
  assert.equal(f.data.private.e2.phone, "+19135550102");
  assert.equal(f.data.private.e2.wage, 16.5);
  assert.ok(!("wage" in f.data.staff.e2) && !("phone" in f.data.staff.e2) && !("rates" in f.data.staff.e2));

  await page.locator('tr:has-text("Evan Server") button[data-act="editStaff"]').click();
  await page.locator("#st-phone").fill("555-01");
  await page.locator('#staffForm button[data-act="saveStaff"]').click();
  await page.getByText("doesn't look right").waitFor();

  await page.locator('nav.tabs button[data-tab="schedule"]').click();
  await page.locator('[data-act="printMenu"]').click();
  assert.equal(await page.locator('[data-act="doDrive"]').count(), 0);
  assert.equal(await page.locator("#pr-auto").count(), 0);
  await page.locator('#modal [data-act="closeModal"]').first().click();

  // e2's published shift was edited earlier: it counts as a change to text on the next publish.
  await page.locator('[data-act="publish"]', { hasText: "changes (1)" }).first().waitFor();
  await page.locator('[data-act="publish"]').first().click();
  await page.locator("#modal").getByText("Who gets a text?").waitFor();
  await page.locator("#modal").getByText("Only people whose shifts changed").waitFor();
  assert.match(await page.locator("#modal").innerText(), /changed\s*\(2 people\)/);
  await page.locator('#modal input[value="changed"]').check();
  await page.screenshot({ path: path.join(shots, "publish-choice.png") });
  await page.locator('#modal [data-act="doPublish"]').click();
  await page.waitForTimeout(400);
  f = await fake(page);
  const ev = Object.values(f.data.publishEvents || {});
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].shiftIds, ["s3"]);
  assert.equal(ev[0].mode, "changed");
  assert.equal(f.data.shifts.s3.published, true);

  // Editing a published shift marks it as an edit (texted at the next publish, not right away).
  await page.locator('.chip[data-id="s1"]').first().click();
  await page.locator('#sf-end').fill("15:00");
  await page.locator('#modal [data-act="saveShift"]').click();
  await page.waitForTimeout(300);
  f = await fake(page);
  assert.equal(f.data.shifts.s1.lastChange, "edit");
  assert.equal(f.data.shifts.s1.published, true);
  assert.deepEqual(f.denied, []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("employee on a phone: published shifts only, no pay, can ask for time off", async () => {
  const { page, ctx, errors } = await open({ role: "employee", staffId: "e1", signedIn: true, phone: "+18165550101" }, { width: 390, height: 844 });
  await page.locator("nav.tabs").waitFor();
  const tabs = await page.locator("nav.tabs button").allTextContents();
  assert.ok(!tabs.some(t => /Team|Settings|Requests/.test(t)), tabs.join());
  await page.waitForTimeout(300);
  const seen = await page.evaluate(() => document.body.innerText);
  assert.ok(!seen.includes("$"), "no pay shown");
  assert.ok(!seen.includes("private reason"), "no one else's time-off note");
  await page.screenshot({ path: path.join(shots, "employee-schedule-phone.png"), fullPage: true });
  await page.locator('nav.tabs button[data-tab="mine"]').click();
  await page.screenshot({ path: path.join(shots, "employee-mine-phone.png"), fullPage: true });
  await page.locator('[data-act="newOff"]').first().click();
  await page.locator('#offForm [name="from"]').fill(day(14));
  await page.locator('#offForm [name="to"]').fill(day(15));
  await page.locator('#modal button.primary').click();
  await page.getByText("Time-off request sent").waitFor();
  const f = await fake(page);
  const mine = Object.values(f.data.timeoff).find(t => t.from === day(14));
  assert.equal(mine.staffId, "e1"); assert.equal(mine.status, "pending");
  assert.deepEqual(f.denied, []);
  assert.deepEqual(errors.filter(e => !/permission/i.test(e)), []);
  await ctx.close();
});

test("a number that isn't on the team list is turned away", async () => {
  const { page, ctx } = await open({ role: "none", signedIn: true, phone: "+18165550999" });
  await page.getByText("isn't on the team list").waitFor();
  assert.equal(await page.locator("nav.tabs").count(), 0);
  await page.screenshot({ path: path.join(shots, "not-on-list.png") });
  await ctx.close();
});

test("owner tools: import and bulk phone numbers", async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.addInitScript(f => { window.__FAKE = f; }, { data: { staff: {}, private: {}, outbox: {} }, role: "owner", signedIn: true, phone: "+18165550001" });
  await page.goto(base + "/admin.html");
  await page.getByText("Bring over data").waitFor();
  const exp = { config: seed().config, staff: { x1: { name: "Pat Host", positions: ["Host"], locations: ["olathe"], wage: 13, rates: { Host: 13 }, uid: "claude-uid", active: true } }, shifts: seed().shifts };
  await page.setInputFiles("#imp-file", { name: "gss-export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exp)) });
  await page.getByText("Ready:").waitFor();
  await page.locator("#imp-go").click();
  await page.getByText("records saved").waitFor();
  await page.locator("#ph-text").fill("Pat Host, 913-555-0177\nNobody Here, 816-555-0000");
  await page.locator("#ph-go").click();
  await page.getByText("Saved 1 number").waitFor();
  const f = await fake(page);
  assert.equal(f.data.staff.x1.wage, undefined); assert.equal(f.data.staff.x1.uid, undefined);
  assert.equal(f.data.private.x1.wage, 13); assert.equal(f.data.private.x1.phone, "+19135550177");
  assert.equal(Object.keys(f.data.shifts).length, 3);
  await page.screenshot({ path: path.join(shots, "owner-tools.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});
