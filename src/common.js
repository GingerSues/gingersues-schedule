// Shared by the schedule page and the owner page: Firebase start-up, sign-in by texted code,
// and the account check that matches a phone number to a team member.
import {
  initializeApp, loadConfig, getAuth, onAuthStateChanged, signInWithPhoneNumber, RecaptchaVerifier,
  signOut, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFunctions, httpsCallable,
} from "./fbapi.js";

export const PAY_KEYS = ["wage", "rates", "phone"];

export function normPhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return null;
}
export function prettyPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || "");
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const GATE_CSS = `
.gate{position:fixed;inset:0;z-index:50;background:var(--bg,#f3f4f1);display:grid;place-items:center;padding:16px;overflow:auto}
.gate-card{width:100%;max-width:380px;background:var(--surface,#fff);border:1px solid var(--line,#dcdfd8);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:14px}
.gate-card h1{font-family:var(--f-display,system-ui);font-size:26px;margin:0}
.gate-card h1 i{font-style:normal;color:var(--ginger,#b86b00)}
.gate-card p{margin:0}
.gate-card form{display:flex;flex-direction:column;gap:12px}
.gate-card input{font-size:20px;letter-spacing:.02em}
.gate-card .btn{justify-content:center;min-height:44px}
.gate-msg{font-size:14px;min-height:1.4em}
.gate-msg.bad{color:var(--bad,#b42318)}
.gate-legal{font-size:12px;line-height:1.5;color:var(--muted,#5b6672);margin:0}
.gate-legal a{color:inherit}
.gss-foot{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;font-size:13px;color:var(--muted,#5b6672);padding-bottom:32px}
.gss-foot a{color:inherit}
.gss-foot .btn{font-size:13px}
`;

export async function boot({ onReady, title = "Schedule" }) {
  const st = document.createElement("style"); st.textContent = GATE_CSS; document.head.appendChild(st);
  const gate = document.createElement("div"); gate.className = "gate"; gate.id = "gate";
  gate.innerHTML = `<div class="gate-card" role="main"><h1>Ginger Sue's <i>${esc(title)}</i></h1><p class="gate-msg" id="g-msg">Loading…</p></div>`;
  document.body.appendChild(gate);
  const msg = (t, bad) => { const el = document.getElementById("g-msg"); if (el) { el.textContent = t; el.className = "gate-msg" + (bad ? " bad" : ""); } };

  let config;
  try { config = await loadConfig(); } catch (e) { msg("The schedule can't load right now. Check your connection and reload.", true); throw e; }
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  const fns = getFunctions(app, "us-central1");
  let started = false;

  function showLogin(note) {
    const card = gate.querySelector(".gate-card");
    card.innerHTML = `<h1>Ginger Sue's <i>${esc(title)}</i></h1>
      <p>Sign in with your cell number. We'll text you a 6-digit code.</p>
      <form id="g-phone" novalidate><label class="f">Cell number<input type="tel" id="g-num" autocomplete="tel" inputmode="tel" placeholder="816-555-0123" required></label>
        <button class="btn primary" id="g-send" type="submit">Text me a code</button></form>
      <form id="g-code" hidden novalidate><label class="f">Code from the text<input id="g-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required></label>
        <button class="btn primary" type="submit" id="g-verify">Sign in</button><button type="button" class="btn" id="g-back">Use a different number</button></form>
      <p class="gate-msg" id="g-msg"></p>
      <p class="gate-legal">By signing in, you agree to receive Ginger Sue's Schedule Alerts texts about your work schedule from Bradley-Fuller, Inc (Ginger Sue's). Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. <a href="/terms">Terms &amp; Conditions</a> · <a href="/privacy">Privacy Policy</a></p>`;
    if (note) msg(note, true);
    let confirmation = null, verifier = null;
    const getVerifier = () => verifier || (verifier = new RecaptchaVerifier(auth, "g-send", { size: "invisible" }));
    card.querySelector("#g-phone").addEventListener("submit", async e => {
      e.preventDefault();
      const p = normPhone(card.querySelector("#g-num").value);
      if (!p) return msg("Enter a 10-digit US cell number.", true);
      const btn = card.querySelector("#g-send"); btn.disabled = true; msg("Sending…");
      try {
        confirmation = await signInWithPhoneNumber(auth, p, getVerifier());
        card.querySelector("#g-phone").hidden = true; card.querySelector("#g-code").hidden = false;
        msg(`Code sent to ${prettyPhone(p)}.`); card.querySelector("#g-otp").focus();
      } catch (err) {
        console.warn(err);
        try { verifier && verifier.clear(); } catch { /* ignore */ } verifier = null;
        msg(err && err.code === "auth/too-many-requests" ? "Too many tries. Wait a few minutes and try again." :
          err && err.code === "auth/invalid-phone-number" ? "That number doesn't look right." : "The code didn't send. Try again.", true);
      } finally { btn.disabled = false; }
    });
    card.querySelector("#g-code").addEventListener("submit", async e => {
      e.preventDefault();
      const code = card.querySelector("#g-otp").value.replace(/\D/g, "");
      if (code.length !== 6) return msg("Enter the 6-digit code.", true);
      const btn = card.querySelector("#g-verify"); btn.disabled = true; msg("Checking…");
      try { await confirmation.confirm(code); }
      catch (err) {
        console.warn(err);
        msg(err && err.code === "auth/code-expired" ? "That code expired. Go back and send a new one." : "That code isn't right. Check the text and try again.", true);
        btn.disabled = false;
      }
    });
    card.querySelector("#g-back").addEventListener("click", () => {
      card.querySelector("#g-code").hidden = true; card.querySelector("#g-phone").hidden = false; msg("");
    });
  }

  function showBlocked(text) {
    const card = gate.querySelector(".gate-card");
    card.innerHTML = `<h1>Ginger Sue's <i>${esc(title)}</i></h1><p>${esc(text)}</p><button class="btn" id="g-out">Sign out</button>`;
    card.querySelector("#g-out").addEventListener("click", () => signOut(auth));
  }

  onAuthStateChanged(auth, async u => {
    if (!u) { if (started) location.reload(); else showLogin(); return; }
    if (started) return;
    msg("Signing in…");
    let profile;
    try { profile = (await httpsCallable(fns, "linkAccount")()).data; }
    catch (err) {
      console.warn(err);
      const code = String(err && err.code || "");
      if (code.includes("permission-denied") || code.includes("not-found"))
        return showBlocked(`${prettyPhone(u.phoneNumber)} isn't on the team list. Ask a manager to add this cell number to your Team profile, then sign in again.`);
      return showBlocked("Sign-in didn't finish. Check your connection and try again.");
    }
    started = true;
    gate.remove();
    const foot = document.createElement("footer"); foot.className = "wrap gss-foot";
    foot.innerHTML = `<span>Signed in as ${esc(prettyPhone(u.phoneNumber))}</span>${profile.role === "owner" ? `<a href="/admin.html">Owner tools</a>` : ""}<a href="/privacy">Privacy</a><a href="/terms">Terms</a><button class="btn sm" type="button" id="gss-out">Sign out</button>`;
    document.body.appendChild(foot);
    foot.querySelector("#gss-out").addEventListener("click", () => signOut(auth));
    onReady({ app, auth, db, fns, user: u, profile });
  });
}
