// In-memory stand-in for the Firebase SDK, used only by the browser tests.
// It also enforces the main read rules for employees, so a query the real
// security rules would reject fails here too.
const F = (window.__FAKE = window.__FAKE || {});
F.data = F.data || {};
F.log = [];
F.denied = [];
const listeners = new Set();
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const colData = c => (F.data[c] = F.data[c] || {});
const MGR_ONLY = ["standard", "forecast", "emailImports", "diag", "private", "publishEvents", "outbox", "users"];

export async function loadConfig() { return { projectId: "fake" }; }
export function initializeApp(cfg) { return { cfg }; }

/* auth */
let authCb = null;
const auth = { currentUser: F.signedIn ? { uid: "uid-" + F.phone, phoneNumber: F.phone } : null };
export function getAuth() { return auth; }
export function onAuthStateChanged(a, cb) { authCb = cb; setTimeout(() => cb(auth.currentUser), 0); return () => {}; }
export class RecaptchaVerifier { clear() {} }
export async function signInWithPhoneNumber(a, phone) {
  F.lastPhone = phone;
  return { confirm: async code => {
    if (code !== "123456") throw Object.assign(new Error("bad code"), { code: "auth/invalid-verification-code" });
    auth.currentUser = { uid: "uid-" + phone, phoneNumber: phone }; authCb && authCb(auth.currentUser);
  } };
}
export async function signOut() { auth.currentUser = null; authCb && authCb(null); }

/* firestore */
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const deleteField = () => ({ __delete: true });
export function initializeFirestore() { return { fake: true }; }
export function collection(db, name) { return { kind: "col", col: name, cons: [] }; }
export function doc(db, col, id) { return { kind: "doc", col, id }; }
export function query(ref, ...cons) { return { kind: "col", col: ref.col, cons: [...ref.cons, ...cons] }; }
export const where = (f, op, v) => ({ k: "where", f, op, v });
export const orderBy = (f, dir = "asc") => ({ k: "orderBy", f, dir });
export const limit = n => ({ k: "limit", n });

const role = () => F.role;
const isMgr = () => role() === "manager" || role() === "owner";
function deny(what) { F.denied.push(what); return Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" }); }
function checkRead(ref) {
  if (isMgr()) return null;
  if (MGR_ONLY.includes(ref.col)) return deny("read " + ref.col);
  if (ref.kind === "doc") return null;
  const has = (f, v) => ref.cons.some(c => c.k === "where" && c.f === f && c.op === "==" && c.v === v);
  if (ref.col === "shifts" && !has("published", true)) return deny("unfiltered shifts");
  if (ref.col === "timeoff" && !has("staffId", F.staffId)) return deny("unfiltered timeoff");
  if (ref.col === "requests" && !has("staffId", F.staffId) && !has("targetId", F.staffId)) return deny("unfiltered requests");
  return null;
}
function evalRef(ref) {
  if (ref.kind === "doc") {
    const d = colData(ref.col)[ref.id];
    return { id: ref.id, exists: () => d !== undefined, data: () => clone(d) };
  }
  let rows = Object.entries(colData(ref.col)).map(([id, d]) => ({ id, d }));
  for (const c of ref.cons) {
    if (c.k === "where") rows = rows.filter(({ d }) => {
      const x = d[c.f];
      return c.op === "==" ? x === c.v : c.op === ">=" ? x >= c.v : c.op === "<=" ? x <= c.v : true;
    });
    if (c.k === "orderBy") rows.sort((a, b) => ((a.d[c.f] > b.d[c.f]) - (a.d[c.f] < b.d[c.f])) * (c.dir === "desc" ? -1 : 1));
    if (c.k === "limit") rows = rows.slice(0, c.n);
  }
  return { docs: rows.map(({ id, d }) => ({ id, data: () => clone(d) })) };
}
export function onSnapshot(ref, next, err) {
  const e = checkRead(ref);
  if (e) { setTimeout(() => err && err(e), 0); return () => {}; }
  const l = () => next(evalRef(ref));
  listeners.add(l); setTimeout(l, 0);
  return () => listeners.delete(l);
}
const notify = () => setTimeout(() => listeners.forEach(l => l()), 0);
function checkWrite(col, id, data) {
  if (isMgr()) return;
  const ok = (col === "timeoff" && data && data.staffId === F.staffId)
    || (col === "requests")
    || (col === "messages" && data && data.staffId === F.staffId)
    || (col === "staff" && id === F.staffId && data && Object.keys(data).every(k => ["avail", "maxHours"].includes(k)));
  if (!ok) throw deny(`write ${col}/${id}`);
}
function rawSet(col, id, data, merge) {
  const cur = colData(col)[id];
  const next = merge && cur ? { ...cur, ...clone(data) } : clone(data);
  for (const k of Object.keys(next)) if (next[k] && next[k].__delete) delete next[k];
  colData(col)[id] = next;
}
export async function setDoc(ref, data, opts = {}) { checkWrite(ref.col, ref.id, data); rawSet(ref.col, ref.id, data, opts.merge); F.log.push(["set", ref.col, ref.id, clone(data)]); notify(); }
export async function updateDoc(ref, data) {
  checkWrite(ref.col, ref.id, data);
  if (!colData(ref.col)[ref.id]) throw Object.assign(new Error("No document"), { code: "not-found" });
  rawSet(ref.col, ref.id, data, true); F.log.push(["update", ref.col, ref.id, clone(data)]); notify();
}
export async function deleteDoc(ref) { if (!isMgr()) throw deny("delete"); delete colData(ref.col)[ref.id]; F.log.push(["delete", ref.col, ref.id]); notify(); }
export async function getDoc(ref) { const e = checkRead(ref); if (e) throw e; return evalRef(ref); }
export async function getDocs(ref) { const e = checkRead(ref); if (e) throw e; return evalRef(ref); }
export function writeBatch() {
  const ops = [];
  return { set(ref, data, opts = {}) { ops.push([ref, data, opts]); }, async commit() { for (const [r, d, o] of ops) await setDoc(r, d, o); } };
}

/* functions */
export function getFunctions() { return {}; }
export function httpsCallable(fns, name) {
  return async data => {
    F.calls = F.calls || []; F.calls.push([name, data]);
    if (name === "linkAccount") {
      if (!F.role || F.role === "none") throw Object.assign(new Error("not on list"), { code: "functions/permission-denied" });
      if (F.staffId && colData("staff")[F.staffId]) colData("staff")[F.staffId].uid = auth.currentUser.uid;
      return { data: { role: F.role, staffId: F.staffId || null } };
    }
    return { data: { ok: true } };
  };
}
