// Owner tools: bring data over from the Claude version, add cell numbers in bulk,
// see the text log, and send a test text.
import { boot, normPhone, PAY_KEYS } from "./common.js";
import { collection, doc, getDocs, query, orderBy, limit, writeBatch, httpsCallable } from "./fbapi.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLS = ["config", "staff", "shifts", "standard", "timeoff", "requests", "messages", "forecast"];

async function commitAll(db, ops, progress) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(([path, data, opts]) => b.set(doc(db, ...path), data, opts || {}));
    await b.commit();
    progress && progress(Math.min(i + 400, ops.length), ops.length);
  }
}

boot({
  title: "Owner tools",
  async onReady({ db, fns, profile }) {
    const app = $("#app");
    if (profile.role !== "owner") { app.innerHTML = `<div class="hero-empty"><h2>Owners only</h2><p><a href="/">Back to the schedule</a></p></div>`; return; }
    app.innerHTML = `
      <p><a href="/">← Back to the schedule</a></p>
      <section class="panel"><div class="phead"><h3>1. Bring over data from the Claude version</h3></div>
        <p class="muted">Choose the <span class="mono">gss-export.json</span> file. Team, shifts, standard weeks, time off, requests, messages and settings are copied in. Records with the same ID are replaced, so running it twice is safe.</p>
        <input type="file" id="imp-file" accept=".json,application/json">
        <div class="acts"><button class="btn primary" id="imp-go" disabled>Import</button></div>
        <p class="gate-msg" id="imp-msg"></p></section>
      <section class="panel"><div class="phead"><h3>2. Add cell numbers</h3></div>
        <p class="muted">One person per line: <span class="mono">Name, cell number</span>. Names must match the Team list. People can sign in once their number is added.</p>
        <textarea id="ph-text" rows="8" style="width:100%" placeholder="Jordan Smith, 816-555-0123"></textarea>
        <div class="acts"><button class="btn primary" id="ph-go">Save numbers</button></div>
        <p class="gate-msg" id="ph-msg"></p></section>
      <section class="panel"><div class="phead"><h3>3. Test texting</h3></div>
        <label class="f">Send a test text to<input type="tel" id="tt-num" placeholder="816-555-0123"></label>
        <div class="acts"><button class="btn" id="tt-go">Send test</button></div>
        <p class="gate-msg" id="tt-msg"></p></section>
      <section class="panel"><div class="phead"><h3>Recent texts</h3><span class="spacer"></span><button class="btn sm" id="ob-go">Refresh</button></div>
        <div id="ob-list" class="muted">Loading…</div></section>`;
    app.style.display = "grid"; app.style.gap = "16px";

    let payload = null;
    $("#imp-file").addEventListener("change", async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        payload = JSON.parse(await f.text());
        const counts = COLS.filter(c => payload[c]).map(c => `${Object.keys(payload[c]).length} ${c}`);
        $("#imp-msg").textContent = `Ready: ${counts.join(", ")}.`; $("#imp-go").disabled = false;
      } catch { payload = null; $("#imp-msg").textContent = "That file isn't a schedule export."; }
    });
    $("#imp-go").addEventListener("click", async () => {
      if (!payload) return;
      const btn = $("#imp-go"); btn.disabled = true;
      const ops = [];
      for (const col of COLS) {
        for (const [id, raw] of Object.entries(payload[col] || {})) {
          const data = { ...raw }; delete data.id;
          if (col === "staff") {
            const priv = {}; for (const k of PAY_KEYS) if (k in data) { priv[k] = data[k]; delete data[k]; }
            delete data.uid; // old Claude sign-ins don't carry over
            if ("phone" in priv) priv.phone = normPhone(priv.phone);
            ops.push([["staff", id], data]);
            ops.push([["private", id], priv, { merge: true }]);
          } else ops.push([[col, id], data]);
        }
      }
      try {
        await commitAll(db, ops, (n, t) => { $("#imp-msg").textContent = `Saving… ${n} of ${t}`; });
        $("#imp-msg").textContent = `Done. ${ops.length} records saved.`;
      } catch (e) { console.warn(e); $("#imp-msg").textContent = "Import stopped partway. Run it again; it picks up safely."; }
      btn.disabled = false;
    });

    $("#ph-go").addEventListener("click", async () => {
      const staff = (await getDocs(collection(db, "staff"))).docs.map(d => ({ id: d.id, ...d.data() }));
      const key = s => s.toLowerCase().replace(/[^a-z]/g, "");
      const byName = new Map(staff.map(s => [key(s.name || ""), s]));
      const ok = [], bad = [];
      for (const line of $("#ph-text").value.split("\n").map(l => l.trim()).filter(Boolean)) {
        const i = line.lastIndexOf(","); const name = i < 0 ? line : line.slice(0, i); const num = i < 0 ? "" : line.slice(i + 1);
        const st = byName.get(key(name)); const p = normPhone(num);
        if (st && p) ok.push([["private", st.id], { phone: p }, { merge: true }]); else bad.push(`${line} (${!st ? "name not on Team" : "number"})`);
      }
      if (ok.length) await commitAll(db, ok);
      $("#ph-msg").textContent = `Saved ${ok.length} number${ok.length === 1 ? "" : "s"}.${bad.length ? ` Not saved: ${bad.join("; ")}` : ""}`;
    });

    $("#tt-go").addEventListener("click", async () => {
      $("#tt-msg").textContent = "Sending…";
      try { await httpsCallable(fns, "testText")({ to: $("#tt-num").value }); $("#tt-msg").textContent = "Sent. Check that phone."; }
      catch (e) { $("#tt-msg").textContent = (e && e.message) || "Didn't send."; }
    });

    async function loadOutbox() {
      const [ob, staff] = await Promise.all([
        getDocs(query(collection(db, "outbox"), orderBy("ts", "desc"), limit(40))),
        getDocs(collection(db, "staff")),
      ]);
      const names = Object.fromEntries(staff.docs.map(d => [d.id, d.data().name]));
      const label = { sent: "Sent", failed: "Failed", "no-phone": "No cell number", "texting-off": "Texting not set up" };
      $("#ob-list").innerHTML = ob.docs.length ? `<table class="team"><tbody>${ob.docs.map(d => { const m = d.data();
        return `<tr><td class="mono" style="white-space:nowrap">${new Date(m.ts).toLocaleString()}</td><td>${esc(names[m.staffId] || "?")}</td><td>${esc(label[m.status] || m.status)}${m.error ? `: ${esc(m.error)}` : ""}</td><td style="white-space:pre-line;font-size:13px">${esc(m.body)}</td></tr>`; }).join("")}</tbody></table>` : "No texts yet.";
    }
    $("#ob-go").addEventListener("click", loadOutbox);
    loadOutbox().catch(e => { console.warn(e); $("#ob-list").textContent = "Couldn't load the text log."; });
  },
});
