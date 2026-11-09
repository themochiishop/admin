// 测试用的记忆体假资料库（不用模拟器）：doc get/create/set/update（含 a.b.c 路径）、where == + limit、transaction、increment
"use strict";
const { FieldValue } = require("firebase-admin/firestore");
const INC = FieldValue.increment(1).constructor;
const isInc = v => v && v.constructor === INC;
const incOf = v => v.operand ?? v._operand ?? 0;
function setPath(obj, path, v) {
  const ks = path.split("."); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] = { ...(o[ks[i]] || {}) }; o = o[ks[i]]; }
  const k = ks[ks.length - 1];
  o[k] = isInc(v) ? (Number(o[k]) || 0) + incOf(v) : v;
}
function applyPatch(old, patch, merge) {
  if (!merge && !old) return { ...patch };
  const out = JSON.parse(JSON.stringify(old || {}, (k, v) => v));
  // 保留 Timestamp 等物件
  for (const [k, v] of Object.entries(old || {})) if (v && typeof v === "object" && typeof v.toMillis === "function") out[k] = v;
  for (const [k, v] of Object.entries(patch)) setPath(out, k, v);
  return out;
}
let autoId = 0;
function fakeDb(seed = {}) {
  const data = new Map(Object.entries(seed));
  const snapOf = r => { const d = data.get(r.path); return { exists: d !== undefined, data: () => d, id: r.id, ref: r }; };
  const runQuery = q => {
    const docs = [...data.entries()]
      .filter(([k, d]) => k.split("/").length === 2 && k.startsWith(q.col + "/") && q.ws.every(([f, , v]) => d[f] === v))
      .slice(0, q.n).map(([k]) => snapOf(ref(q.col, k.split("/")[1])));
    return { empty: docs.length === 0, docs, size: docs.length };
  };
  const ref = (col, id) => ({ kind: "doc", col, id, path: col + "/" + id });
  const mkQuery = (col, ws = [], n = Infinity) => ({
    kind: "query", col, ws, n,
    where: (f, op, v) => mkQuery(col, [...ws, [f, op, v]], n),
    limit: m => mkQuery(col, ws, m),
    get: async () => runQuery({ col, ws, n }),
  });
  return {
    data,
    collection(col) {
      return { doc: id => ref(col, id || "auto" + (++autoId)), where: (f, op, v) => mkQuery(col, [[f, op, v]]) };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(r) { return r.kind === "doc" ? snapOf(r) : runQuery(r); },
        create(r, d) { writes.push(["create", r, d]); },
        set(r, d, o) { writes.push(["set", r, d, o]); },
        update(r, d) { writes.push(["update", r, d]); },
      };
      const out = await fn(tx);
      for (const [op, r] of writes) {
        if (op === "create" && data.has(r.path)) throw new Error("ALREADY_EXISTS " + r.path);
        if (op === "update" && !data.has(r.path)) throw new Error("NOT_FOUND " + r.path);
      }
      for (const [op, r, d, o] of writes) data.set(r.path, op === "create" ? { ...d } : applyPatch(data.get(r.path), d, op === "update" || (o && o.merge)));
      return out;
    },
  };
}
module.exports = { fakeDb };
