/* HD Dashboards — SLA link.
   Lets any dashboard show the SAME SLA numbers as the SLA Tracker (sla.html), without
   re-implementing the rules. It reads what the SLA Tracker saved in this browser:
     • SLA settings      (HDStore.loadSlaConfig  → targets, working calendars, warn %)
     • status histories  (HDStore.loadSlaHistory → every status change per ticket)
   and runs them through the shared engine (sla-engine.js), classifying statuses with
   Master Data (HDClass) exactly like sla.html does.

   A ticket only gets numbers when its cached history is still valid for the row in
   hand (same rule as sla.html: the ticket has not changed in Jira since it was fetched).
   Otherwise it is reported as "nohist" — never guessed.

   Needs: hd-store.js, sla-engine.js (and sla-history.js for fetchMissing).

   API (window.HDSlaLink):
     load()                → Promise; reads settings + history. Safe to call again to refresh.
     ready()               → true once loaded
     version()             → bumps on every load/refresh/fetch (use as a re-render key)
     subscribe(fn)         → fn() after every change; returns an unsubscribe function
     get(row)              → SLA info for an Excel/Jira row (Key, Created, Status, Priority, Updated, Issue Type)
     summarize(rows)       → counts by state for a list of rows
     missing(rows)         → rows that are SLA tickets but have no valid history yet
     bridgeReady()         → is the HD Jira Bridge extension connected?
     fetchMissing(rows, {onProgress(done,total), shouldCancel()}) → fetch history for those rows,
                             save it into the SLA Tracker's cache, refresh. Resolves {fetched, failed}. */
(function (root) {
  "use strict";
  var HIST_VER = 2;                                    // must match sla.html
  var L = { loaded: false, ver: 0, cfg: null, cals: null, hist: { v: HIST_VER, tickets: {} }, now: Date.now(), types: {}, cache: {}, subs: [], fetching: false };

  function Sla() { return root.HDSla; }
  function notify() { L.ver++; L.cache = {}; L.subs.slice().forEach(function (f) { try { f(); } catch (e) {} }); }

  /* ── status → clock behaviour (identical to sla.html classify) ── */
  function classify(status) {
    var C = root.HDClass;
    if (C.isTerminal(status)) return { kind: "closed", mapped: true };
    var o = C.owner(status);
    if (o === "client") return { kind: "client", mapped: true };
    return { kind: C.classify3(status) === "engg" ? "engg" : "hd", mapped: o !== null };
  }

  /* ── an Excel/Jira row → the ticket shape the engine uses (same as sla.html normalize) ── */
  function pick(row, names) {
    for (var i = 0; i < names.length; i++) if (row[names[i]] != null && row[names[i]] !== "") return row[names[i]];
    var km = {}; Object.keys(row).forEach(function (k) { km[k.trim().toLowerCase()] = k; });
    for (var j = 0; j < names.length; j++) { var k = km[names[j].toLowerCase()]; if (k !== undefined && row[k] !== "") return row[k]; }
    return "";
  }
  function norm(row) {
    var S = Sla(), key = String(pick(row, ["Key"]) || "").trim(), pr = String(pick(row, ["Priority"]) || "").trim();
    return { key: key, status: String(pick(row, ["Status"]) || "").trim(), priority: pr, sev: S.normSev(pr),
      type: String(pick(row, ["Issue Type"]) || "").trim(), created: S.parseTs(pick(row, ["Created"])),
      updated: S.parseTs(pick(row, ["Updated"])), prefix: S.prefixOf(key) };
  }

  /* ── cached history is valid while the ticket hasn't changed since it was fetched (same as sla.html histFor) ── */
  function histFor(t) {
    var e = L.hist.tickets[t.key]; if (!e) return null;
    if (e.updated != null && t.updated != null && e.updated === t.updated) return e;
    var last = e.transitions.length ? e.transitions[e.transitions.length - 1].to : e.status;
    if (t.updated != null && e.fetchedAt && t.updated <= e.fetchedAt - 300000 && last === t.status) return e;
    if (t.updated == null && last === t.status) return e;
    return null;
  }

  var IST = "Asia/Kolkata";
  function fdt(ms) { return ms == null ? "—" : new Date(ms).toLocaleString("en-GB", { timeZone: IST, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }); }

  /* SLA info for one row.
     state: loading | na (not an SLA ticket type) | none (no target for this severity) | nohist (history not fetched / out of date)
            | running | paused | breached (open, over target) | met | missed (closed over target)
     level: safe | warning | danger | breached (open tickets) */
  function get(row) {
    if (!row) return { state: "na", label: "", tip: "" };
    if (!L.loaded || !Sla()) return { state: "loading", label: "", tip: "SLA data is loading…" };
    var S = Sla(), t = norm(row);
    if (!t.key || t.created == null) return { state: "na", label: "", tip: "" };
    var ck = t.key + "|" + t.updated + "|" + t.status + "|" + t.priority;
    if (L.cache[ck]) return L.cache[ck];
    var out;
    if (!L.types[t.type.toLowerCase()]) out = { state: "na", label: "", tip: t.type + " tickets are not tracked for SLA (see SLA Tracker → Settings)." };
    else {
      var cal = L.cals.get(t.prefix), target = S.targetMin(L.cfg, t.sev, t.prefix);
      if (target == null) out = { state: "none", label: "No target", tip: "No SLA target for " + (t.priority || "this severity") + "." };
      else {
        var e = histFor(t);
        if (!e) out = { state: "nohist", label: "No SLA data", tip: "Status history not fetched yet, or the ticket changed in Jira since. Use “Calculate SLA” or open the SLA Tracker." };
        else out = describe(S.compute({ created: t.created, status: t.status, severity: t.sev, prefix: t.prefix }, e.transitions, { cfg: L.cfg, cal: cal, now: L.now, classify: classify }), cal, e);
      }
    }
    L.cache[ck] = out; return out;
  }

  function describe(r, cal, e) {
    var S = Sla(), bi = S.breachInfo(r, cal, L.now), D = function (m) { return S.fmtDur(m, cal.dayMin); };
    var KN = { hd: "Help Desk", engg: "Engineering", client: "Client", closed: "Closed" };
    var used = "Working time used " + D(r.elapsedMin) + " of " + D(r.targetMin) + " (" + Math.round(r.pct) + "%)";
    var paused = r.pausedMin > 0 ? " · " + D(r.pausedMin) + " paused with client" : "";
    var o = { state: bi.state, level: r.level, pct: r.pct, elapsedMin: r.elapsedMin, targetMin: r.targetMin, remainingMin: r.remainingMin,
      pausedMin: r.pausedMin, isClosed: r.isClosed, isPaused: r.isPaused, heldBy: KN[r.currentKind] || r.currentKind, suspect: !!e.suspect,
      breachAt: bi.breachAt || null, breachedAt: bi.breachedAt || null, overByMin: bi.overByMin || 0, fmt: D };
    o.breached = bi.state === "breached" || bi.state === "missed";
    o.atRisk = !r.isClosed && !o.breached && (r.level === "warning" || r.level === "danger");
    switch (bi.state) {
      case "breached":
        o.label = "Breached · " + D(bi.overByMin) + " over"; o.short = D(bi.overByMin) + " over"; o.tone = "red";
        o.tip = "SLA breached on " + fdt(bi.breachedAt) + " IST, now " + D(bi.overByMin) + " over target. " + used + paused + ". Held by " + o.heldBy + "."; break;
      case "missed":
        o.label = "Missed · " + D(bi.overByMin) + " over"; o.short = "Missed"; o.tone = "red";
        o.tip = "Closed, but over target by " + D(bi.overByMin) + ". " + used + paused + "."; break;
      case "met":
        o.label = "Met"; o.short = "Met"; o.tone = "green"; o.tip = "Closed within target. " + used + paused + "."; break;
      case "paused":
        o.label = "Paused · " + D(bi.remainingMin) + " left"; o.short = "Paused"; o.tone = "grey";
        o.tip = "Clock paused — ticket is with the client. " + D(bi.remainingMin) + " of working time left when it comes back. " + used + paused + "."; break;
      default:
        var crit = r.level === "danger", warn = r.level === "warning";
        o.label = (crit ? "Critical" : warn ? "At risk" : "On track") + " · " + D(bi.remainingMin) + " left"; o.short = D(bi.remainingMin) + " left";
        o.tone = crit ? "orange" : warn ? "amber" : "green";
        o.tip = "Breaches " + fdt(bi.breachAt) + " IST if still with us. " + used + paused + ". Held by " + o.heldBy + ".";
    }
    if (o.suspect) o.tip += " ⚠ History unverified — Jira showed no status changes for this ticket.";
    return o;
  }

  function summarize(rows) {
    var s = { total: 0, breached: 0, missed: 0, met: 0, atRisk: 0, onTrack: 0, paused: 0, nohist: 0, none: 0, na: 0, lists: { breached: [], atRisk: [], paused: [], onTrack: [], nohist: [], met: [], missed: [] } };
    (rows || []).forEach(function (row) {
      var x = get(row);
      if (x.state === "na" || x.state === "loading") { s.na++; return; }
      s.total++;
      if (x.state === "breached") { s.breached++; s.lists.breached.push(row); }
      else if (x.state === "missed") { s.missed++; s.lists.missed.push(row); }
      else if (x.state === "met") { s.met++; s.lists.met.push(row); }
      else if (x.state === "paused") { s.paused++; s.lists.paused.push(row); }
      else if (x.state === "nohist") { s.nohist++; s.lists.nohist.push(row); }
      else if (x.state === "none") s.none++;
      else if (x.atRisk) { s.atRisk++; s.lists.atRisk.push(row); }
      else { s.onTrack++; s.lists.onTrack.push(row); }
    });
    var decided = s.met + s.missed; s.metPct = decided ? Math.round(s.met / decided * 100) : null; s.decided = decided;
    return s;
  }
  function missing(rows) { return (rows || []).filter(function (r) { return get(r).state === "nohist"; }); }

  function load() {
    if (!root.HDStore || !Sla()) { L.loaded = true; notify(); return Promise.resolve(); }
    return Promise.all([root.HDStore.loadSlaConfig(), root.HDStore.loadSlaHistory()]).then(function (a) {
      L.cfg = Sla().mergeConfig(a[0]); L.cals = Sla().makeCalendarSet(L.cfg);
      L.types = {}; L.cfg.issueTypes.forEach(function (t) { L.types[String(t).toLowerCase()] = 1; });
      var h = a[1] || { tickets: {} };
      L.hist = h.v === HIST_VER ? h : { v: HIST_VER, tickets: {} };      // older caches are untrusted (sla.html discards them too)
      L.now = Date.now(); L.loaded = true; notify();
    }).catch(function () { L.loaded = true; notify(); });
  }
  /* keep the clocks moving and pick up fetches done in the SLA Tracker tab */
  setInterval(function () { if (L.loaded && !L.fetching) load(); }, 5 * 60000);
  if (root.addEventListener) root.addEventListener("focus", function () { if (L.loaded && !L.fetching && Date.now() - L.now > 60000) load(); });

  /* ── extension bridge (same protocol as sla.html; own id range so replies never collide) ── */
  var BR = { ready: false, seq: 7000000, pend: {} };
  if (root.addEventListener) {
    root.addEventListener("message", function (e) {
      if (!e.data) return;
      if (e.data.type === "HD_BRIDGE_READY") { if (!BR.ready) { BR.ready = true; notify(); } return; }
      if (e.data.type !== "HD_BRIDGE_RESULT") return;
      var p = BR.pend[e.data.id]; if (!p) return; delete BR.pend[e.data.id];
      if (e.data.ok) p.res(e.data.data); else p.rej(new Error(e.data.error || "Bridge error"));
    });
    [0, 300, 1000, 3000].forEach(function (ms) { setTimeout(function () { root.postMessage({ type: "HD_BRIDGE_PING" }, "*"); }, ms); });
  }
  function bridgeReady() { return BR.ready || !!root._rmBridge; }
  function jiraHost() { try { var c = JSON.parse(localStorage.getItem("hd-jira-cfg") || "{}"); if (c.jiraHost) return c.jiraHost; } catch (e) {} return "svmhelpdesk.atlassian.net"; }
  function bridgeCall(host, path, method, body) {
    if (!bridgeReady()) return Promise.reject(new Error("EXTENSION_NOT_FOUND"));
    return new Promise(function (res, rej) {
      var id = ++BR.seq; BR.pend[id] = { res: res, rej: rej };
      root.postMessage({ type: "HD_BRIDGE_CALL", id: id, host: host, path: path, method: method || "GET", body: body || null }, "*");
      setTimeout(function () { if (BR.pend[id]) { delete BR.pend[id]; rej(new Error("Request timed out.")); } }, 90000);
    });
  }

  /* Fetch status history for rows that have none, and save it into the SLA Tracker's cache
     (merged with whatever is there now, so a fetch running in the SLA Tracker tab is not overwritten). */
  function fetchMissing(rows, opts) {
    opts = opts || {};
    var H = root.HDSlaHistory, list = missing(rows), byKey = {};
    list.forEach(function (r) { var t = norm(r); byKey[t.key] = t; });
    var keys = Object.keys(byKey);
    if (!keys.length) return Promise.resolve({ fetched: 0, failed: [] });
    if (!H) return Promise.reject(new Error("sla-history.js did not load."));
    if (!bridgeReady()) return Promise.reject(new Error("HD Jira Bridge extension not detected. Enable it and reload the page."));
    var got = {};
    L.fetching = true;
    function persist() {
      return root.HDStore.loadSlaHistory().then(function (cur) {
        var h = cur && cur.v === HIST_VER ? cur : { v: HIST_VER, tickets: {} };
        Object.keys(got).forEach(function (k) { h.tickets[k] = got[k]; });
        L.hist = h; return root.HDStore.saveSlaHistory(h);
      });
    }
    return H.fetchHistory(keys, {
      call: bridgeCall, host: jiraHost(), batch: 50, concurrency: 4, mode: "auto",
      onProgress: function (d, t) { if (opts.onProgress) opts.onProgress(d, t); },
      shouldCancel: opts.shouldCancel,
      onBatch: function (res) {
        Object.keys(res).forEach(function (k) { var t = byKey[k]; got[k] = { updated: t ? t.updated : null, fetchedAt: Date.now(), src: res[k].src, status: res[k].status, suspect: !!res[k].suspect, transitions: res[k].transitions }; });
      }
    }).then(function (r) {
      return persist().then(function () { L.fetching = false; L.now = Date.now(); notify(); return { fetched: Object.keys(r.results).length, failed: r.failed, cancelled: r.cancelled }; });
    }, function (err) {
      return persist().catch(function () {}).then(function () { L.fetching = false; notify(); throw err; });
    });
  }

  root.HDSlaLink = {
    load: load, ready: function () { return L.loaded; }, version: function () { return L.ver; },
    subscribe: function (fn) { L.subs.push(fn); return function () { L.subs = L.subs.filter(function (f) { return f !== fn; }); }; },
    get: get, summarize: summarize, missing: missing, bridgeReady: bridgeReady, fetchMissing: fetchMissing,
    isFetching: function () { return L.fetching; }, config: function () { return L.cfg; }
  };
})(typeof self !== "undefined" ? self : this);
