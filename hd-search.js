/* HD Dashboards — ticket search engine (pure logic, no DOM, no storage).
   Used by the Similar Ticket Finder (clarify.html) for both the search box and "similar tickets".
   Also require()-able in Node for tests.

   HOW IT RANKS
   Every ticket is indexed over five fields, each with its own weight:
     summary      ×4.0   the subject line
     meta         ×2.5   screen, menu, components, labels, root-cause category, type of fix
     cause        ×2.0   "Reason for Occurrence" (text + category)
     resolution   ×1.6   "Resolution Details", solution summary, analysis
     description  ×1.0   the client's description
   Scoring is BM25F: a word counts more when it is rare across all tickets (IDF), when it sits in a heavier
   field, and with diminishing returns when it repeats. Long descriptions don't win just by being long.
   On top of that:
     • light stemming  — "mapping / mapped / maps" are one word; "payloads" = "payload"
     • typo tolerance  — a query word that appears nowhere is matched to close spellings ("paylod" → payload)
     • typing ahead    — the last word of the query also matches longer words it starts ("valid" → validation)
     • codes are kept  — "ESB-701", "ORA-01403", usp_createBI stay searchable (a known Jira key is handled apart)
     • phrases count   — words next to each other in the query score more when they are next to each other
                         in the ticket (summary phrase > phrase anywhere else); "quoted phrases" are required
     • feedback pass   — for short queries, words the best matches share are added at low weight, so a
                         ticket that describes the same problem in other words is still found
   Scores come back as 0–1 "how much of the query this ticket explains", so the caller can turn them into
   a percentage and add its own structural signals (same screen, same release, linked in Jira…). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HDSearch = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* words that carry no meaning in ticket text (greetings, sign-offs, filler) */
  var STOP = {};
  ("a an the is was are were be been being am have has had do does did done will would could should shall may might must can " +
   "and or but if then else so than too very just also only even still yet not no nor of in on at to for from by with as into onto " +
   "about up down out off over under again further once here there when where why how all any both each few more most other some such " +
   "own same that this these those it its i we they he she my our your their you me us him her them what which who whom whose " +
   "hi hello hey dear sir madam team kindly please pls plz thank thanks regards regard best warm greetings good morning afternoon evening " +
   "let know find attached attachment below above mentioned following via etc ie eg re fw fwd cc " +
   "svm helpdesk desk see ref check").split(" ").forEach(function (w) { if (w) STOP[w] = 1; });

  /* ── stemming: a light, conservative English suffix stripper (cached) ── */
  var SC = Object.create(null);
  function stem(w) {
    var c = SC[w]; if (c !== undefined) return c;
    var s = w;
    if (s.length > 3 && !/\d/.test(s)) {
      var strip = s.length;
      if (/ies$/.test(s) && s.length > 5) s = s.slice(0, -3) + "y";
      else if (/sses$/.test(s)) s = s.slice(0, -2);
      else if (/(ches|shes|xes|zes)$/.test(s)) s = s.slice(0, -2);
      else if (/[^suic]s$/.test(s)) s = s.slice(0, -1);
      if (/elled$/.test(s)) s = s.slice(0, -3);                                                 // cancelled, labelled → cancel, label
      if (/ingly$/.test(s) && s.length > 7) s = s.slice(0, -5);
      else if (/ing$/.test(s) && s.length > 5) s = s.slice(0, -3);
      else if (/edly$/.test(s) && s.length > 6) s = s.slice(0, -4);
      else if (/ied$/.test(s) && s.length > 5) s = s.slice(0, -3) + "y";
      else if (/[^e]ed$/.test(s) && s.length > 5) s = s.slice(0, -2);
      else if (/eed$/.test(s)) { /* keep: "need", "proceed" */ }
      else if (/ed$/.test(s) && s.length > 5) s = s.slice(0, -1);
      if (s.length < strip && /([bcdfgkmnprtvz])\1$/.test(s)) s = s.slice(0, -1);           // mapp → map, stopp → stop (only after a suffix came off)
      if (/ation$/.test(s) && s.length > 7) s = s.slice(0, -5) + "ate";                     // validation → validate
      if (/e$/.test(s) && s.length > 4) s = s.slice(0, -1);                                   // validate → validat, update → updat
    }
    SC[w] = s; return s;
  }

  var URL_RX = /https?:\/\/[^\s<>"')]+/g;
  var KEY_RX = /\b([A-Za-z][A-Za-z0-9]{1,11})-(\d{1,7})\b/g;

  /* one raw word (original case) → null | term | [terms]. Cached: ticket text repeats the same words endlessly. */
  var TC = Object.create(null), TCn = 0;
  function termsOf(w) {
    var out = [];
    if (w.indexOf("_") > -1) {
      w = w.replace(/^_+|_+$/g, "").toLowerCase(); if (!w) return null;
      if (w.length <= 40 && w.indexOf("_") > -1) out.push(w);
      w.split("_").forEach(function (x) { if (x.length > 2 && !STOP[x] && !/^\d+$/.test(x)) out.push(stem(x)); });
    } else {
      var sub = /[a-z][A-Z][a-z]/.test(w) ? w.replace(/([a-z])([A-Z][a-z])/g, "$1 $2").split(" ") : [w];   // camelCase → camel case
      for (var u = 0; u < sub.length; u++) {
        var x = sub[u].toLowerCase();
        if (/^\d+$/.test(x)) { if (x.length >= 3 && x.length <= 4 && !/^(19|20)\d\d$/.test(x)) out.push(x); continue; }   // 404, 1403 yes; years, dates, ids no
        if (/\d/.test(x)) { if (x.replace(/\D/g, "").length <= 6 && /[a-z]{2}/.test(x) && x.length <= 16) out.push(x); continue; }
        if (x.length < 2 || STOP[x]) continue;
        out.push(stem(x));
      }
    }
    return !out.length ? null : out.length === 1 ? out[0] : out;
  }

  /* text → list of index terms (in order). knownPrefix: {"GWFC":1,…} — "GWFC-8599" is a ticket reference
     (collected into refs, not indexed as words); "ESB-701" with an unknown prefix becomes the code "esb701". */
  function tokenize(text, knownPrefix, refs, cap) {
    var out = [];
    if (!text) return out;
    var s = String(text).replace(URL_RX, function (u) { var m = u.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/); if (m && refs) refs.push(m[1]); return " "; });
    s = s.replace(KEY_RX, function (all, p, n) {
      var P = p.toUpperCase();
      if (knownPrefix && knownPrefix[P]) { if (refs) refs.push(P + "-" + n); return " "; }
      return " " + p + n + " ";
    });
    var parts = s.split(/[^A-Za-z0-9_]+/), max = cap || 1e9;
    for (var i = 0; i < parts.length && out.length < max; i++) {
      var w = parts[i]; if (!w) continue;
      var r = TC[w];
      if (r === undefined) { r = termsOf(w); if (++TCn > 300000) { TC = Object.create(null); TCn = 0; } TC[w] = r; }
      if (r === null) continue;
      if (typeof r === "string") out.push(r); else for (var u = 0; u < r.length; u++) out.push(r[u]);
    }
    return out;
  }

  var FIELDS = ["s", "m", "c", "r", "d"];
  var FW = { s: 4.0, m: 2.5, c: 2.0, r: 1.6, d: 1.0 };     // field weights
  var FB = { s: 0.5, m: 0.3, c: 0.5, r: 0.7, d: 0.75 };    // length normalisation per field
  var CAP = { s: 60, m: 60, c: 250, r: 450, d: 380 };      // terms indexed per field
  var K1 = 1.2;

  /* docs: [{ s, m, c, r, d }] — plain text per field. opts.keyPrefixes: known Jira project prefixes.
     builder() does the work in slices (step(ms) → true when finished) so a page can index without freezing. */
  function builder(docs, opts) {
    opts = opts || {};
    var N = docs.length, known = opts.keyPrefixes || {}, t0 = Date.now();
    var avg = {}, stepN = Math.max(1, Math.floor(N / 600)), cnt = 0;
    FIELDS.forEach(function (f) { avg[f] = 0; });
    for (var i = 0; i < N; i += stepN) { cnt++; FIELDS.forEach(function (f) { avg[f] += tokenize(docs[i][f], known, null, CAP[f]).length; }); }
    FIELDS.forEach(function (f) { avg[f] = Math.max(1, avg[f] / Math.max(1, cnt)); });
    var post = Object.create(null), sumBig = new Array(N), sumSet = new Array(N), refsOf = new Array(N), byRef = Object.create(null), d = 0, E = null;

    function one(d) {
      var doc = docs[d], acc = Object.create(null), refs = [];
      for (var fi = 0; fi < FIELDS.length; fi++) {
        var f = FIELDS[fi], toks = tokenize(doc[f], known, refs, CAP[f]);
        if (!toks.length) continue;
        var norm = FW[f] / (1 - FB[f] + FB[f] * toks.length / avg[f]), k;
        for (k = 0; k < toks.length; k++) acc[toks[k]] = (acc[toks[k]] || 0) + norm;
        if (f === "s") {
          var bg = Object.create(null), ss = Object.create(null);
          for (k = 0; k < toks.length; k++) { ss[toks[k]] = 1; if (k + 1 < toks.length) bg[toks[k] + " " + toks[k + 1]] = 1; }
          sumBig[d] = bg; sumSet[d] = ss;
        }
      }
      for (var term in acc) { var p = post[term]; if (!p) p = post[term] = []; p.push(d, acc[term]); }
      var ur = {}; refs.forEach(function (r) { ur[r] = 1; }); refsOf[d] = Object.keys(ur);
      refsOf[d].forEach(function (r) { (byRef[r] = byRef[r] || []).push(d); });
    }
    function finish() {
      var P = Object.create(null), DF = Object.create(null), vocab = [];
      for (var t in post) {                                   // freeze postings into typed arrays (far less memory)
        var arr = post[t], n = arr.length / 2, ds = new Int32Array(n), ws = new Float32Array(n);
        for (var j = 0; j < n; j++) { ds[j] = arr[2 * j]; ws[j] = arr[2 * j + 1]; }
        P[t] = { d: ds, w: ws }; DF[t] = n; vocab.push(t);
      }
      post = null;
      E = { N: N, P: P, DF: DF, vocab: vocab, sumBig: sumBig, sumSet: sumSet, refsOf: refsOf, byRef: byRef, known: known, docs: docs,
            buildMs: Date.now() - t0, _tri: null, _lazy: {}, _lazyKeys: [] };
      E.acc = new Float64Array(N); E.grp = new Float64Array(N); E.mask = new Uint32Array(N); E.mask2 = new Uint32Array(N);
    }
    return {
      step: function (ms) { var t = Date.now(); while (d < N) { one(d++); if ((d & 63) === 0 && Date.now() - t > ms) return false; } if (!E) finish(); return true; },
      progress: function () { return N ? d / N : 1; },
      result: function () { return E; }
    };
  }
  function build(docs, opts) { var b = builder(docs, opts); b.step(Infinity); return b.result(); }
  /* same index, built in ~25 ms slices; onProgress(0..1). Resolves the engine. */
  function buildAsync(docs, opts, onProgress) {
    var b = builder(docs, opts);
    return new Promise(function (res) {
      (function go() { if (b.step(25)) { if (onProgress) onProgress(1); res(b.result()); } else { if (onProgress) onProgress(b.progress()); setTimeout(go, 0); } })();
    });
  }

  function idf(E, t) { var df = E.DF[t] || 0; return Math.log(1 + (E.N - df + 0.5) / (df + 0.5)); }

  /* ── typo tolerance: trigram index over the vocabulary (built on first use) ── */
  function tri(w) { var s = "^" + w + "$", o = []; for (var i = 0; i + 3 <= s.length; i++) o.push(s.substr(i, 3)); return o; }
  function triIndex(E) {
    if (E._tri) return E._tri;
    var T = Object.create(null);
    E.vocab.forEach(function (w, i) { if (w.length < 4 || /\d|_/.test(w)) return; tri(w).forEach(function (g) { (T[g] = T[g] || []).push(i); }); });
    return (E._tri = T);
  }
  /* Damerau-Levenshtein distance with an early exit once it exceeds max */
  function edit(a, b, max) {
    var la = a.length, lb = b.length; if (Math.abs(la - lb) > max) return max + 1;
    var p2 = null, p1 = [], cur, i, j;
    for (j = 0; j <= lb; j++) p1[j] = j;
    for (i = 1; i <= la; i++) {
      cur = [i]; var mn = i;
      for (j = 1; j <= lb; j++) {
        var v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
        if (p2 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, p2[j - 2] + 1);
        cur[j] = v; if (v < mn) mn = v;
      }
      if (mn > max) return max + 1; p2 = p1; p1 = cur;
    }
    return p1[lb];
  }
  function fuzzy(E, w) {
    if (w.length < 4 || /\d|_/.test(w)) return [];
    var max = w.length >= 8 ? 2 : 1, T = triIndex(E), hits = Object.create(null), grams = tri(w);
    grams.forEach(function (g) { (T[g] || []).forEach(function (i) { hits[i] = (hits[i] || 0) + 1; }); });
    var need = Math.max(1, grams.length - 3 * max), out = [];
    for (var i in hits) {
      if (hits[i] < need) continue;
      var v = E.vocab[i]; if (v === w) continue;
      var dist = edit(w, v, max); if (dist <= max) out.push({ t: v, dist: dist, df: E.DF[v] });
    }
    out.sort(function (a, b) { return a.dist - b.dist || b.df - a.df; });
    return out.slice(0, 3);
  }
  function prefixes(E, w) {
    if (w.length < 3 || /\d|_/.test(w)) return [];
    var out = [];
    for (var i = 0; i < E.vocab.length; i++) { var v = E.vocab[i]; if (v.length > w.length && v.lastIndexOf(w, 0) === 0) out.push({ t: v, df: E.DF[v] }); }
    out.sort(function (a, b) { return b.df - a.df; });
    return out.slice(0, 4);
  }

  /* per-doc term sets per field, made on demand for the few tickets being explained / phrase-checked */
  function lazy(E, i) {
    var c = E._lazy[i]; if (c) return c;
    var doc = E.docs[i]; c = { f: {}, bg: {} };
    FIELDS.forEach(function (f) {
      var toks = tokenize(doc[f], E.known, null, CAP[f]), set = Object.create(null);
      for (var k = 0; k < toks.length; k++) { set[toks[k]] = (set[toks[k]] || 0) + 1; if (k + 1 < toks.length) c.bg[toks[k] + " " + toks[k + 1]] = f === "s" ? 2 : Math.max(1, c.bg[toks[k] + " " + toks[k + 1]] || 0); }
      c.f[f] = set;
    });
    E._lazy[i] = c; E._lazyKeys.push(i);
    if (E._lazyKeys.length > 1500) { var drop = E._lazyKeys.splice(0, 500); drop.forEach(function (x) { delete E._lazy[x]; }); }
    return c;
  }

  /* ── core scorer. groups: [{ w, terms:[{t, rel}], orig }] — a doc scores the best member of each group. ── */
  function score(E, groups, opts) {
    var acc = E.acc, grp = E.grp, mask = E.mask, mask2 = E.mask2, touched = [], seen = new Uint8Array(E.N), excl = opts.exclude, filter = opts.filter;
    groups.forEach(function (g, gi) {
      var gt = [];
      g.terms.forEach(function (m) {
        var p = E.P[m.t]; if (!p) return;
        var w = idf(E, m.t) * m.rel, ds = p.d, ws = p.w;
        for (var j = 0; j < ds.length; j++) {
          var d = ds[j], tf = ws[j], v = w * tf / (K1 + tf);
          if (v > grp[d]) { if (grp[d] === 0) gt.push(d); grp[d] = v; }
        }
      });
      for (var k = 0; k < gt.length; k++) {
        var d2 = gt[k];
        if (!seen[d2]) { seen[d2] = 1; touched.push(d2); acc[d2] = 0; mask[d2] = 0; mask2[d2] = 0; }
        acc[d2] += g.w * grp[d2];
        if (g.orig) { if (gi < 32) mask[d2] |= (1 << gi); else if (gi < 64) mask2[d2] |= (1 << (gi - 32)); }
        grp[d2] = 0;
      }
    });
    var res = [];
    for (var i = 0; i < touched.length; i++) {
      var d3 = touched[i];
      if (excl != null && d3 === excl) continue;
      if (filter && !filter(d3)) continue;
      res.push({ i: d3, raw: acc[d3], mask: mask[d3], mask2: mask2[d3] });
    }
    return res;
  }
  function hasBit(r, b) { return b < 32 ? (r.mask & (1 << b)) !== 0 : b < 64 ? (r.mask2 & (1 << (b - 32))) !== 0 : false; }
  function ideal(E, groups) {
    var s = 0; groups.forEach(function (g) { if (g.orig) s += g.w * g.idf; }); return s || 1;
  }
  function groupFor(E, t, w, opts) {
    var g = { w: w, terms: [], orig: true, word: t, idf: 0 };
    if (E.DF[t]) { g.terms.push({ t: t, rel: 1 }); g.idf = idf(E, t); }
    if (opts && opts.typo && (!E.DF[t] || E.DF[t] <= 1)) {
      fuzzy(E, t).forEach(function (f) { g.terms.push({ t: f.t, rel: f.dist === 1 ? 0.75 : 0.55 }); g.idf = Math.max(g.idf, idf(E, f.t) * 0.8); g.fuzzy = (g.fuzzy || []).concat(f.t); });
    }
    if (opts && opts.prefix && (!E.DF[t] || E.DF[t] < 3)) {
      prefixes(E, t).forEach(function (f) { if (!g.terms.some(function (x) { return x.t === f.t; })) { g.terms.push({ t: f.t, rel: 0.6 }); g.idf = Math.max(g.idf, idf(E, f.t) * 0.7); g.fuzzy = (g.fuzzy || []).concat(f.t); } });
    }
    if (!g.terms.length) return null;                     // the word appears nowhere and has no close spelling
    return g;
  }

  /* phrase signals for one doc: query bigrams found in the summary / anywhere else */
  function phraseInfo(E, i, qbig) {
    if (!qbig.length) return { s: 0, o: 0 };
    var sb = E.sumBig[i] || {}, s = 0, o = 0, lz = null;
    qbig.forEach(function (b) { if (sb[b]) s++; else { lz = lz || lazy(E, i); if (lz.bg[b]) o++; } });
    return { s: s, o: o };
  }

  /* which query words matched, and where (for the "why it matched" view and highlighting) */
  function explain(E, i, words) {
    var lz = lazy(E, i), where = { s: [], m: [], c: [], r: [], d: [] }, all = [];
    words.forEach(function (w) {
      var hit = false;
      FIELDS.forEach(function (f) { if (lz.f[f][w]) { where[f].push(w); hit = true; } });
      if (hit) all.push(w);
    });
    return { words: all, where: where };
  }

  /* ── free-text search ──
     returns [{ i, text (0–1), cover (0–1 share of query words matched), phrase:{s,o}, words:[matched terms],
                exactTitle, refHit }] best first */
  function query(E, q, opts) {
    opts = opts || {};
    var topN = opts.topN || 50, raw = String(q || "");
    var quoted = []; raw.replace(/"([^"]{3,})"/g, function (a, p) { quoted.push(p); return " "; });
    var refs = [], toks = tokenize(raw, E.known, refs);
    var typingLast = !/\s$/.test(raw) && toks.length ? toks[toks.length - 1] : null;
    var uniq = [], cnt = {}; toks.forEach(function (t) { if (!cnt[t]) uniq.push(t); cnt[t] = (cnt[t] || 0) + 1; });
    var groups = [];
    uniq.forEach(function (t) {
      var g = groupFor(E, t, 1 + 0.25 * Math.min(2, cnt[t] - 1), { typo: true, prefix: t === typingLast });
      if (g) groups.push(g);
    });
    var qbig = []; for (var k = 0; k + 1 < toks.length; k++) qbig.push(toks[k] + " " + toks[k + 1]);
    var qPhr = quoted.map(function (p) { var tt = tokenize(p, E.known); var b = []; for (var j = 0; j + 1 < tt.length; j++) b.push(tt[j] + " " + tt[j + 1]); return b; });
    if (!groups.length && !refs.length) return { results: [], terms: [], refs: refs };
    var idl = ideal(E, groups), nOrig = groups.length;
    var res = groups.length ? score(E, groups, opts) : [];

    /* feedback pass: short query → borrow the shared vocabulary of the clearest matches */
    if (opts.feedback !== false && nOrig && nOrig <= 6 && res.length > 3) {
      var top = res.slice().sort(function (a, b) { return b.raw - a.raw; }).slice(0, 6).filter(function (r) { return r.raw / idl >= 0.5; });
      if (top.length >= 2) {
        var tally = Object.create(null), have = {}; groups.forEach(function (g) { g.terms.forEach(function (m) { have[m.t] = 1; }); });
        top.forEach(function (r) { var lz = lazy(E, r.i), seenT = {}; ["s", "c", "m"].forEach(function (f) { for (var w in lz.f[f]) if (!have[w] && !seenT[w]) { seenT[w] = 1; tally[w] = (tally[w] || 0) + 1; } }); });
        var extra = Object.keys(tally).filter(function (w) { return tally[w] >= 2 && E.DF[w] >= 2 && E.DF[w] < E.N * 0.05; })
          .sort(function (a, b) { return tally[b] * idf(E, b) - tally[a] * idf(E, a); }).slice(0, 6);
        if (extra.length) {
          extra.forEach(function (w) { groups.push({ w: 0.22, terms: [{ t: w, rel: 1 }], orig: false, word: w, idf: idf(E, w) }); });
          res = score(E, groups, opts);
        }
      }
    }

    var origWords = groups.filter(function (g) { return g.orig; });
    var rawL = raw.toLowerCase().replace(/\s+/g, " ").trim();
    res.forEach(function (r) {
      r.text = Math.min(1, r.raw / (idl * 0.62));        // ≈1 when every query word is in the summary of a typical ticket
      var m = 0, mw = 0; origWords.forEach(function (g, gi) { if (hasBit(r, gi)) { m++; mw += g.w * g.idf; } });
      r.cover = nOrig ? m / nOrig : 0; r.coverW = mw / idl;
    });
    res.sort(function (a, b) { return b.raw - a.raw; });
    var pool = res.slice(0, Math.max(topN * 4, 200));
    pool.forEach(function (r) {
      r.phrase = phraseInfo(E, r.i, qbig);
      if (qPhr.length) r.quoted = qPhr.filter(function (bs) { return bs.length && bs.every(function (b) { return (E.sumBig[r.i] || {})[b] || lazy(E, r.i).bg[b]; }); }).length;
      var sum = String(E.docs[r.i].s || "").toLowerCase().replace(/\s+/g, " ").trim();
      r.exactTitle = rawL.length >= 6 && sum ? (sum === rawL ? 2 : sum.indexOf(rawL) > -1 || (rawL.indexOf(sum) > -1 && sum.length > 12) ? 1 : 0) : 0;
      /* rank: text first, then coverage of the query, then phrases */
      r.rank = r.text * 0.7 + r.coverW * 0.18 + Math.min(1, (r.phrase.s * 0.6 + r.phrase.o * 0.3) / Math.max(1, qbig.length)) * 0.12 + r.exactTitle * 0.15 + (r.quoted || 0) * 0.2
        - (qPhr.length && !r.quoted ? 0.25 : 0);
    });
    pool.sort(function (a, b) { return b.rank - a.rank; });
    var words = origWords.map(function (g) { return g.word; }).concat([].concat.apply([], origWords.map(function (g) { return g.fuzzy || []; })));
    pool.slice(0, topN).forEach(function (r) { r.words = explain(E, r.i, words.concat(groups.filter(function (g) { return !g.orig; }).map(function (g) { return g.word; }))).words; });
    return { results: pool.slice(0, topN), terms: words, refs: refs, bigrams: qbig, quoted: quoted };
  }

  /* ── "more like this": tickets similar to ticket i ──
     The ticket becomes a weighted query: its summary words count most, then screen/menu/component words,
     its written cause/resolution, and the most telling words of its description (rare ones, not every word). */
  function similar(E, i, opts) {
    opts = opts || {};
    var lz = lazy(E, i), weights = Object.create(null), from = Object.create(null);
    function add(set, w, tag, limit) {
      var list = Object.keys(set).filter(function (t) { return E.DF[t] && E.DF[t] < E.N * 0.2; });
      list.sort(function (a, b) { return set[b] * idf(E, b) - set[a] * idf(E, a); });
      list.slice(0, limit || 999).forEach(function (t) { var v = w * Math.min(1.5, 1 + 0.15 * (set[t] - 1)); if (!weights[t] || weights[t] < v) { weights[t] = v; from[t] = tag; } });
    }
    add(lz.f.s, 1.0, "s", 40); add(lz.f.m, 0.6, "m", 20); add(lz.f.c, 0.45, "c", 18); add(lz.f.r, 0.35, "r", 18); add(lz.f.d, 0.4, "d", 30);
    var groups = Object.keys(weights).map(function (t) { return { w: weights[t], terms: [{ t: t, rel: 1 }], orig: true, word: t, idf: idf(E, t), from: from[t] }; });
    groups.sort(function (a, b) { return b.w * b.idf - a.w * a.idf; });
    groups = groups.slice(0, 64);
    if (!groups.length) return { results: [], terms: [] };
    var sGroups = groups.filter(function (g) { return g.from === "s"; }), cGroups = groups.filter(function (g) { return g.from === "c"; }), rGroups = groups.filter(function (g) { return g.from === "r"; });
    var idl = ideal(E, groups), idlS = sGroups.reduce(function (s, g) { return s + g.w * g.idf; }, 0), idlC = cGroups.reduce(function (s, g) { return s + g.w * g.idf; }, 0), idlR = rGroups.reduce(function (s, g) { return s + g.w * g.idf; }, 0);
    var bitOf = {}; groups.forEach(function (g, gi) { bitOf[g.word] = gi; });
    function cov(list, idlX, r) { if (!idlX) return 0; var x = 0; list.forEach(function (g) { if (hasBit(r, bitOf[g.word])) x += g.w * g.idf; }); return x / idlX; }
    var res = score(E, groups, { exclude: i, filter: opts.filter });
    res.sort(function (a, b) { return b.raw - a.raw; });
    var pool = res.slice(0, opts.pool || 250);
    var qbig = Object.keys(E.sumBig[i] || {});
    pool.forEach(function (r) {
      /* summary-to-anything overlap is what people judge "same problem" by; the long tail of the
         description only helps. Two views, the larger wins. */
      var covS = cov(sGroups, idlS, r);
      /* the same written cause / resolution on both tickets is strong evidence on its own (needs some substance) */
      var covC = Math.max(cGroups.length >= 4 ? cov(cGroups, idlC, r) : 0, rGroups.length >= 4 ? cov(rGroups, idlR, r) : 0);
      r.text = Math.min(1, Math.max(r.raw / (idl * 0.30), covS * 0.9, covC * 0.85));
      r.covS = covS; r.covC = covC;
      r.phrase = phraseInfo(E, r.i, qbig);
      r.rank = r.text * 0.85 + Math.min(1, (r.phrase.s * 0.7 + r.phrase.o * 0.3) / Math.max(1, qbig.length)) * 0.15;
    });
    pool.sort(function (a, b) { return b.rank - a.rank; });
    var top = pool.slice(0, opts.topN || 40), words = groups.map(function (g) { return g.word; });
    top.forEach(function (r) { r.words = explain(E, r.i, words).words; });
    return { results: top, terms: words };
  }

  return {
    build: build, buildAsync: buildAsync, query: query, similar: similar, explain: explain, tokenize: tokenize, stem: stem,
    fuzzy: fuzzy, idf: idf, FIELDS: FIELDS, FW: FW
  };
});
