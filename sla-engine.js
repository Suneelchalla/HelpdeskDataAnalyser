/* HD Dashboards — SLA engine (pure logic, no DOM, no storage).
   Loaded by sla.html as window.HDSla; also require()-able in Node for tests.

   THE RULE
   A ticket's resolution clock starts at Created and counts business time while the
   ticket is on OUR side (Help Desk or Engineering). It is PAUSED while the ticket sits
   in a status that Master Data classifies as CLIENT (waiting on the client, awaiting
   confirmation, client approvals, resolved/delivered awaiting client…). When the
   ticket comes back, the clock RESUMES with the time already used kept — the days
   spent with the client are never counted. "Closed" stops the clock; if the ticket is
   reopened the clock resumes and the time spent Closed is not counted.

   Time is measured on a business calendar (work days, hours, holidays) evaluated in
   IST so results never depend on the viewer's browser timezone. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HDSla = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAY = 86400000, MIN = 60000;

  /* ─────────── defaults (from the old SLA Manager file) ─────────── */
  var SEVERITIES = [
    { id: "showstopper", name: "Show Stopper", color: "#BE1D42" },
    { id: "critical",    name: "Critical",     color: "#EA580C" },
    { id: "high",        name: "High",         color: "#B45309" },
    { id: "medium",      name: "Medium",       color: "#2563EB" },
    { id: "low",         name: "Low",          color: "#6B7A90" }
  ];
  var DEFAULT_CONFIG = {
    businessStart: "00:00",
    businessEnd: "24:00",
    workDays: [1, 2, 3, 4, 5],
    holidays: [],                       // [{date:"2026-01-26", name:"Republic Day"}]
    targets: {
      defaults: { showstopper: 4, critical: 48, high: 32, medium: 48, low: 90 },   // business hours
      clients: {}                       // { "SWIPHX": { high: 24 } }  — only the exceptions
    },
    warnPct: 75,
    dangerPct: 90,
    goalPct: 90,                        // SLA % the team aims for (colours only)
    issueTypes: ["Incident", "Service Request"]
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  /* Merge a saved config over the defaults so new keys always exist. */
  function mergeConfig(saved) {
    var c = clone(DEFAULT_CONFIG); saved = saved || {};
    ["businessStart", "businessEnd", "warnPct", "dangerPct", "goalPct"].forEach(function (k) { if (saved[k] != null) c[k] = saved[k]; });
    if (Array.isArray(saved.workDays)) c.workDays = saved.workDays.slice();
    if (Array.isArray(saved.holidays)) c.holidays = saved.holidays.slice();
    if (Array.isArray(saved.issueTypes) && saved.issueTypes.length) c.issueTypes = saved.issueTypes.slice();
    if (saved.targets) {
      if (saved.targets.defaults) Object.keys(saved.targets.defaults).forEach(function (k) { c.targets.defaults[k] = saved.targets.defaults[k]; });
      if (saved.targets.clients) c.targets.clients = clone(saved.targets.clients);
    }
    return c;
  }

  /* ─────────── timestamps ─────────── */
  /* Jira sends "2026-09-30T10:15:30.123+0530" (no colon in the offset). Not every
     JS engine parses that, so normalise before parsing. */
  function parseTs(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) { var t0 = v.getTime(); return isNaN(t0) ? null : t0; }
    if (typeof v === "number") return isNaN(v) ? null : v;
    var s = String(v).trim();
    if (!s || s.toLowerCase() === "nan") return null;
    s = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    var t = new Date(s).getTime();
    return isNaN(t) ? null : t;
  }

  /* ─────────── business calendar ─────────── */
  function hmToMin(s, dflt) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
    if (!m) return dflt;
    return +m[1] * 60 + +m[2];
  }
  function makeCalendar(cfg) {
    var start = hmToMin(cfg.businessStart, 0), end = hmToMin(cfg.businessEnd, 1440);
    if (end >= 1439) end = 1440;                       // "23:59" means "to midnight" (fixes the old 1-min/day loss)
    if (end <= start) end = 1440;
    var hol = {};
    (cfg.holidays || []).forEach(function (h) { var d = typeof h === "string" ? h : h && h.date; if (d) hol[String(d).slice(0, 10)] = 1; });
    var wd = {}; (cfg.workDays || [1, 2, 3, 4, 5]).forEach(function (d) { wd[d] = 1; });
    return { tz: 330, startMin: start, endMin: end, dayMin: end - start, workDays: wd, holidays: hol };
  }
  /* Business minutes between two instants (ms). */
  function bizMinutes(a, b, cal) {
    if (a == null || b == null || b <= a) return 0;
    var off = cal.tz * MIN, la = a + off, lb = b + off;
    var d0 = Math.floor(la / DAY), d1 = Math.floor(lb / DAY), total = 0;
    for (var d = d0; d <= d1; d++) {
      var ds = d * DAY, dt = new Date(ds);
      if (!cal.workDays[dt.getUTCDay()]) continue;
      if (cal.holidays[dt.toISOString().slice(0, 10)]) continue;
      var s = Math.max(la, ds + cal.startMin * MIN), e = Math.min(lb, ds + cal.endMin * MIN);
      if (e > s) total += (e - s) / MIN;
    }
    return total;
  }

  /* The instant at which `minutes` of business time have passed, counting from `start`.
     Skips non-working days, holidays and hours outside the working window.
     Returns ms, or null if the calendar has no working time at all. */
  function advanceBiz(start, minutes, cal) {
    if (!(minutes > 0)) return start;
    var off = cal.tz * MIN, l = start + off, need = minutes, d = Math.floor(l / DAY);
    for (var i = 0; i < 4000; i++, d++) {
      var ds = d * DAY, dt = new Date(ds);
      if (!cal.workDays[dt.getUTCDay()] || cal.holidays[dt.toISOString().slice(0, 10)]) continue;
      var ws = Math.max(l, ds + cal.startMin * MIN), we = ds + cal.endMin * MIN;
      if (we <= ws) continue;
      var avail = (we - ws) / MIN;
      if (need <= avail) return ws + need * MIN - off;
      need -= avail;
    }
    return null;
  }

  /* ─────────── severity / client / target ─────────── */
  function normSev(priority) {
    var s = String(priority == null ? "" : priority).toLowerCase().replace(/[^a-z]/g, "");
    if (s === "showstopper" || s === "blocker") return "showstopper";
    if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
    return null;
  }
  function sevName(id) { for (var i = 0; i < SEVERITIES.length; i++) if (SEVERITIES[i].id === id) return SEVERITIES[i].name; return "Unrated"; }
  function sevColor(id) { for (var i = 0; i < SEVERITIES.length; i++) if (SEVERITIES[i].id === id) return SEVERITIES[i].color; return "#9AA7B8"; }
  function prefixOf(key) { var i = String(key || "").indexOf("-"); return i > 0 ? String(key).slice(0, i).toUpperCase() : ""; }
  /* Target in business MINUTES, or null when no target applies. */
  function targetMin(cfg, sev, prefix) {
    if (!sev) return null;
    var ex = cfg.targets.clients && cfg.targets.clients[prefix];
    var h = ex && ex[sev] > 0 ? ex[sev] : cfg.targets.defaults[sev];
    return h > 0 ? h * 60 : null;
  }
  function levelOf(elapsed, target, warn, danger) {
    if (!target) return "none";
    var p = elapsed / target * 100;
    if (p >= 100) return "breached";
    if (p >= danger) return "danger";
    if (p >= warn) return "warning";
    return "safe";
  }

  /* ─────────── the timeline + clock ─────────── */
  /* transitions: [{t:ms, from:"Open", to:"Waiting for customer"}] oldest first.
     ticket:      {created:ms, status:"<current status>", severity, prefix}
     opts:        {cfg, cal, classify(status)->{kind,mapped}, now:ms}
       kind ∈ "hd" | "engg" (clock runs) | "client" (paused) | "closed" (stopped) */
  function compute(ticket, transitions, opts) {
    var cfg = opts.cfg, cal = opts.cal, now = opts.now, classify = opts.classify;
    transitions = (transitions || []).slice().sort(function (a, b) { return a.t - b.t; });
    var created = ticket.created;
    var cur = transitions.length && transitions[0].from ? transitions[0].from : (ticket.status || "Open");
    var curStart = created, raw = [], i;
    for (i = 0; i < transitions.length; i++) {
      var t = Math.max(transitions[i].t, curStart);
      raw.push({ status: cur, start: curStart, end: t });
      cur = transitions[i].to || cur; curStart = t;
    }
    raw.push({ status: cur, start: curStart, end: Math.max(now, curStart), open: true });

    var elapsed = 0, paused = 0, hd = 0, engg = 0, unmappedMin = 0, clientRounds = 0, reopens = 0;
    var byKind = { hd: { biz: 0, cal: 0 }, engg: { biz: 0, cal: 0 }, client: { biz: 0, cal: 0 }, closed: { biz: 0, cal: 0 } };
    var unmapped = {}, segs = [], prevKind = null, prevStatus = null;
    for (i = 0; i < raw.length; i++) {
      var s = raw[i], c = classify(s.status), mins = bizMinutes(s.start, s.end, cal);
      var counted = c.kind === "hd" || c.kind === "engg";
      byKind[c.kind].biz += mins; byKind[c.kind].cal += (s.end - s.start) / MIN;
      if (counted) { elapsed += mins; if (c.kind === "engg") engg += mins; else hd += mins; }
      else if (c.kind === "client") paused += mins;
      if (!c.mapped && c.kind !== "closed") { unmapped[s.status] = 1; unmappedMin += mins; }
      if (c.kind === "client" && prevKind !== "client" && i > 0) clientRounds++;
      if (prevKind === "closed" && c.kind !== "closed") reopens++;
      segs.push({ status: s.status, kind: c.kind, mapped: c.mapped, start: s.start, end: s.end, open: !!s.open,
                  calMin: (s.end - s.start) / MIN, bizMin: mins, counted: counted, elapsedAfter: elapsed });
      prevKind = c.kind; prevStatus = s.status;
    }
    var last = segs[segs.length - 1];
    var isClosed = last.kind === "closed";
    var target = targetMin(cfg, ticket.severity, ticket.prefix);
    var level = levelOf(elapsed, target, cfg.warnPct, cfg.dangerPct);
    var closedAt = null;
    if (isClosed) closedAt = last.start;
    return {
      segs: segs, byKind: byKind, ageCalMin: (Math.max(now, created) - created) / MIN, elapsedMin: elapsed, pausedMin: paused, hdMin: hd, enggMin: engg,
      unmappedMin: unmappedMin, unmapped: Object.keys(unmapped),
      clientRounds: clientRounds, reopens: reopens,
      isClosed: isClosed, closedAt: closedAt,
      isPaused: !isClosed && last.kind === "client",
      currentKind: last.kind, currentStatus: last.status,
      targetMin: target, remainingMin: target == null ? null : target - elapsed,
      pct: target ? elapsed / target * 100 : null,
      level: level,
      met: isClosed && target != null ? elapsed <= target : null
    };
  }

  /* When does (or did) this ticket breach?
       running  → breachAt: the clock is running, this is when the remaining working time runs out
       paused   → with the client: the clock is stopped. remainingMin is what is left; ifResumedAt is the
                  earliest it could breach if it came back to us right now
       breached → breachedAt: the instant the counted time crossed the target (open or closed)
       met / none → nothing to warn about */
  function breachInfo(r, cal, now) {
    if (r.targetMin == null) return { state: "none" };
    var target = r.targetMin;
    if (r.elapsedMin >= target) {
      var before = 0, at = null;
      for (var i = 0; i < r.segs.length; i++) {
        var sg = r.segs[i]; if (!sg.counted) continue;
        if (before + sg.bizMin >= target) { at = advanceBiz(sg.start, target - before, cal); break; }
        before += sg.bizMin;
      }
      return { state: r.isClosed ? "missed" : "breached", breachedAt: at, overByMin: r.elapsedMin - target };
    }
    if (r.isClosed) return { state: "met" };
    var rem = target - r.elapsedMin;
    if (r.isPaused) return { state: "paused", remainingMin: rem, ifResumedAt: advanceBiz(now, rem, cal) };
    return { state: "running", remainingMin: rem, breachAt: advanceBiz(now, rem, cal) };
  }

  /* Result bucket used by filters/KPIs:
       open tickets  → safe | warning | danger | breached | none
       closed tickets→ met | missed | none */
  function bucket(r) {
    if (r.level === "none") return "none";
    if (r.isClosed) return r.met ? "met" : "missed";
    return r.level;
  }

  /* ─────────── formatting ─────────── */
  /* dayMin = length of one "day" in minutes. Working-time figures pass the calendar's
     working-day length (e.g. 480 for a 9–17 day) so "1d" always means one working day;
     calendar figures use the default 1440. */
  function fmtDur(m, dayMin) {
    if (m == null || isNaN(m)) return "—";
    var D = dayMin > 0 && dayMin < 1440 ? dayMin : 1440;
    var neg = m < 0, a = Math.abs(Math.round(m)), d = Math.floor(a / D), h = Math.floor((a % D) / 60), mn = a % 60, s = neg ? "-" : "";
    if (d > 0) s += d + "d ";
    if (h > 0 || d > 0) s += h + "h ";
    s += mn + "m";
    return s.trim();
  }

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG, SEVERITIES: SEVERITIES, mergeConfig: mergeConfig,
    parseTs: parseTs, makeCalendar: makeCalendar, bizMinutes: bizMinutes,
    normSev: normSev, sevName: sevName, sevColor: sevColor, prefixOf: prefixOf,
    targetMin: targetMin, levelOf: levelOf, compute: compute, bucket: bucket, fmtDur: fmtDur,
    advanceBiz: advanceBiz, breachInfo: breachInfo
  };
});
