// Firebase layer for the schedule page. It signs people in, then gives the page the same
// small data API the Claude artifact version used (window.claude.use("db"|"user"|"downloads")),
// so the screens themselves stay the same. It also keeps pay and phone numbers in a
// managers-only collection and limits what employees ask the database for.
import { boot, normPhone, prettyPhone, PAY_KEYS } from "./common.js";
import {
  collection, doc, query, where, orderBy, limit, onSnapshot, setDoc, updateDoc, deleteDoc,
} from "./fbapi.js";

const MGR_ONLY = new Set(["standard", "forecast", "emailImports", "diag", "private", "publishEvents", "outbox", "users", "notify"]);

export function makeShim({ db, user, profile }) {
  const mgr = profile.role === "owner" || profile.role === "manager";
  const myStaff = profile.staffId || null;

  const wrapDocs = s => ({ docs: s.docs.map(d => ({ id: d.id, exists: true, data: () => d.data() })) });
  const empty = next => { setTimeout(() => next({ docs: [] }), 0); return () => {}; };
  const build = (col, cons) => query(collection(db, col), ...cons.map(([k, a, b, c]) =>
    k === "where" ? where(a, b, c) : k === "orderBy" ? orderBy(a, b) : limit(a)));

  function splitStaff(data) {
    const pub = {}, priv = {};
    for (const [k, v] of Object.entries(data || {})) (PAY_KEYS.includes(k) ? priv : pub)[k] = v;
    if ("phone" in priv) {
      const raw = String(priv.phone || "").trim();
      if (!raw) priv.phone = null;
      else {
        const p = normPhone(raw);
        if (!p) { const e = new Error("bad phone"); e.code = "bad-phone"; throw e; }
        priv.phone = p;
      }
    }
    delete pub.id;
    return { pub, priv };
  }

  function subscribe(col, cons, next, err) {
    if (!mgr && MGR_ONLY.has(col)) return empty(next);
    if (!mgr && col === "shifts") return onSnapshot(build(col, [["where", "published", "==", true], ...cons]), s => next(wrapDocs(s)), err);
    if (!mgr && col === "timeoff") {
      if (!myStaff) return empty(next);
      return onSnapshot(build(col, [["where", "staffId", "==", myStaff], ...cons]), s => next(wrapDocs(s)), err);
    }
    if (!mgr && col === "requests") {
      if (!myStaff) return empty(next);
      // Employees see requests they made and cover asks sent to them.
      const parts = { a: null, b: null };
      const emit = () => {
        if (!parts.a || !parts.b) return;
        const seen = new Map(); [...parts.a.docs, ...parts.b.docs].forEach(d => seen.set(d.id, d));
        next({ docs: [...seen.values()] });
      };
      const u1 = onSnapshot(build(col, [["where", "staffId", "==", myStaff], ...cons]), s => { parts.a = wrapDocs(s); emit(); }, err);
      const u2 = onSnapshot(build(col, [["where", "targetId", "==", myStaff], ...cons]), s => { parts.b = wrapDocs(s); emit(); }, err);
      return () => { u1(); u2(); };
    }
    if (mgr && col === "staff") {
      // Managers see pay and phone merged back into each team member.
      let pub = null, priv = null;
      const emit = () => {
        if (!pub || !priv) return;
        next({
          docs: pub.docs.map(d => {
            const p = priv.get(d.id) || {};
            const merged = { ...d.data(), ...p, phone: p.phone ? prettyPhone(p.phone) : "" };
            return { id: d.id, exists: true, data: () => merged };
          }),
        });
      };
      const u1 = onSnapshot(build("staff", cons), s => { pub = wrapDocs(s); emit(); }, err);
      const u2 = onSnapshot(collection(db, "private"), s => { priv = new Map(s.docs.map(d => [d.id, d.data()])); emit(); }, err);
      return () => { u1(); u2(); };
    }
    return onSnapshot(build(col, cons), s => next(wrapDocs(s)), err);
  }

  class Ref {
    constructor(col, id) { this.col = col; this.id = id; }
    onSnapshot(next, err) {
      if (!mgr && MGR_ONLY.has(this.col)) { setTimeout(() => next({ exists: false, data: () => undefined }), 0); return () => {}; }
      return onSnapshot(doc(db, this.col, this.id), s => next({ exists: s.exists(), data: () => s.data() }), err);
    }
    async set(data) {
      if (this.col !== "staff") return setDoc(doc(db, this.col, this.id), data);
      const { pub, priv } = splitStaff(data);
      await setDoc(doc(db, "staff", this.id), pub);
      if (mgr && Object.keys(priv).length) await setDoc(doc(db, "private", this.id), priv, { merge: true });
    }
    async update(data) {
      if (this.col !== "staff") return updateDoc(doc(db, this.col, this.id), data);
      const { pub, priv } = splitStaff(data);
      if (Object.keys(pub).length) await updateDoc(doc(db, "staff", this.id), pub);
      if (mgr && Object.keys(priv).length) await setDoc(doc(db, "private", this.id), priv, { merge: true });
    }
    async delete() {
      await deleteDoc(doc(db, this.col, this.id));
      if (this.col === "staff" && mgr) await deleteDoc(doc(db, "private", this.id)).catch(() => {});
    }
  }

  class Q {
    constructor(col, cons = []) { this.col = col; this.cons = cons; }
    where(f, op, v) { return new Q(this.col, [...this.cons, ["where", f, op, v]]); }
    orderBy(f, dir) { return new Q(this.col, [...this.cons, ["orderBy", f, dir || "asc"]]); }
    limit(n) { return new Q(this.col, [...this.cons, ["limit", n]]); }
    doc(id) { return new Ref(this.col, id); }
    onSnapshot(next, err) { return subscribe(this.col, this.cons, next, err); }
  }

  const dbApi = {
    collection: c => new Q(c),
    doc: path => { const [c, id] = path.split("/"); return new Ref(c, id); },
  };
  const userApi = {
    isOwner: async () => profile.role === "owner",
    canEdit: async () => mgr,
    id: async () => user.uid,
    can: async () => true,
  };
  const downloadsApi = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv" : "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    },
  };
  const unavailable = () => Promise.reject(Object.assign(new Error("Not available"), { code: "not_available" }));
  return {
    use(name) {
      if (name === "db") return Promise.resolve(dbApi);
      if (name === "user") return Promise.resolve(userApi);
      if (name === "downloads") return Promise.resolve(downloadsApi);
      return unavailable();
    },
  };
}

boot({
  title: "Schedule",
  onReady(ctx) {
    window.claude = makeShim(ctx);
    if (window.__gssResolve) window.__gssResolve();
  },
});
