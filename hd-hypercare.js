/* HD Dashboards — Swire Hypercare rules (pure logic, no DOM, no storage).
   Implements the "Phoenix Hypercare Runbook and Rulebook" v1.0 (28 Oct 2026) for the Swire Shipping module
   (swire.html). Also require()-able in Node for tests.

   What it decides, per the runbook:
     • who is on duty at any moment (Section 1.3)          → duty()
     • the Product Owner for a ticket (Section 15.3)        → poFor()   component → PO; several components → SVM In Charge
     • first response, progress and resolution clocks      → evaluate() (Section 10.1 targets; every day is a working day)
     • rule and runbook checks                              → checks()  (Section 3 Step 3, R2, R4, R19, Step 4 …)
     • escalation triggers and who must be told             → escalations() (Section 10.2)
     • analytics for a date range                           → analytics() (Section 11 measures)
   First response = the first time the ticket moves to a CLIENT-side status (Master Data), same as every other module;
   Jira's automated "Time to first response" is not used. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HDHypercare = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR, IST = 330 * MIN;

  /* ── runbook defaults (editable in the module's Setup) ── */
  var DEFAULTS = {
    prefix: "SWIPHX",
    start: "2026-10-29",                  // counting starts today (agreed); the runbook's effective date is below
    officialStart: "2026-11-01",
    openBox: ["Open", "Acknowledged", "Analysis and Study"],
    /* delivered, now with finance for invoicing / payment: no technical work left, so never escalated and our clock stops */
    billing: ["Invoice Issued", "Invoice Yet to Raise"],
    /* Section 10.1 — minutes, measured round the clock (Hypercare: every day counts, holidays too) */
    targets: {
      showstopper: { fr: 30, upd: 60, res: 4 * 60 },
      critical:    { fr: 60, upd: 120, res: 24 * 60 },
      high:        { fr: 60, upd: 240, res: 2 * 24 * 60 },
      medium:      { fr: 240, upd: 480, res: 5 * 24 * 60 },
      low:         { fr: 240, upd: 480, res: 5 * 24 * 60 }
    },
    triageMin: 30,                        // Step 4 "immediately after logging": flag tickets in the open box longer than this
    /* Section 10.2 — "no progress" = no status change for this long */
    escalate: { critical: 4 * 60, high: 2 * 24 * 60 },
    night: { from: "21:00", to: "06:00" }, callWindow: { from: "06:00", to: "09:00" },
    /* team shifts (IST), as in the Hypercare shift roster: Day shift 1 06:00–15:00, Day shift 2 12:00–21:00, Night 21:00–06:00.
       Day shifts 1 and 2 overlap 12:00–15:00: a ticket created then is in both handovers, and Movement shows it as its
       own "overlap" block. Edit them in Master data if the rota changes. */
    shifts: [
      { id: "1st", name: "1st shift", from: "06:00", to: "15:00" },
      { id: "2nd", name: "2nd shift", from: "12:00", to: "21:00" },
      { id: "night", name: "Night shift", from: "21:00", to: "06:00" }
    ],
    /* Section 15.3 — component (as written in Jira) → module. Several spellings per module. */
    modules: [
      { module: "NFR",     po: "Thennarasu",                 email: "thennarasu.sundharapandiyan@solverminds.com", phone: "+91 99520 85384", match: ["nfr"] },
      { module: "VSS",     po: "Alauudeen.M",                email: "alaudeen.m@solverminds.com",                  phone: "+91 73587 77152", match: ["vss"] },
      { module: "PNC",     po: "Ram Kumar Mourouguessin",    email: "ramkumar@solverminds.com",                    phone: "+91 99406 39985", match: ["pnc"] },
      { module: "Export",  po: "Muthuraj V",                 email: "muthuraj.v@solverminds.com",                  phone: "+91 73053 33644", match: ["export", "exports"] },
      { module: "Import",  po: "Manikandan.V",               email: "mani@solverminds.com",                        phone: "+91 98406 00471", match: ["import", "imports"] },
      { module: "OPS",     po: "Naveen.N",                   email: "naveen.n@solverminds.com",                    phone: "+91 96775 23386", match: ["ops", "operations", "operation"] },
      { module: "EMS",     po: "Balamurugan.R",              email: "balamurugan.r@solverminds.com",               phone: "+91 75500 07656", match: ["ems"] },
      { module: "CMR",     po: "Sentamil Selvan",            email: "sentamil.selvan@solverminds.com",             phone: "+91 90801 19523", match: ["cmr"] },
      { module: "EDI",     po: "Vignesh R",                  email: "vignesh.ravi@solverminds.com",                phone: "+91 63830 78917", match: ["edi"] },
      { module: "CVP",     po: "Raghul Sekar",               email: "raghul.sekar@solverminds.com",                phone: "+91 82480 92223", match: ["cvp"] },
      { module: "Release", po: "Vinothkumar Viswanathan",    email: "vinothkumar.v@solverminds.com",               phone: "+91 97907 13820", match: ["release", "releases"] },
      { module: "DB",      po: "Naveen Enaganti",            email: "naveen.e@solverminds.com",                    phone: "+91 83744 89900", match: ["db", "database"] }
    ],
    /* Section 15.2 */
    contacts: [
      { role: "Engineering head", name: "Venkatasamy", email: "venkats@solverminds.com", phone: "+91 96000 75068" },
      { role: "Engineering head", name: "Premalatha", email: "prema@solverminds.com", phone: "+91 80560 02541" },
      { role: "Customer relationship head", name: "Saji Francis Varghese", email: "sajifrancis.varghese@solverminds.com", phone: "+91 95783 30035" },
      { role: "Account manager", name: "Deepak Matta", email: "Deepakmatta.kamakshaiah@solverminds.com", phone: "+91 97907 88594" }
    ]
  };
  var SEVS = [
    { id: "showstopper", name: "Showstopper", color: "#C8102E" },
    { id: "critical", name: "Critical", color: "#C2680A" },
    { id: "high", name: "High", color: "#A16207" },
    { id: "medium", name: "Medium", color: "#2563EB" },
    { id: "low", name: "Low", color: "#64748B" }
  ];

  function merge(saved) {
    var c = JSON.parse(JSON.stringify(DEFAULTS));
    if (!saved) return c;
    Object.keys(saved).forEach(function (k) {
      if (k === "targets" && saved.targets) Object.keys(saved.targets).forEach(function (s) { c.targets[s] = Object.assign({}, c.targets[s] || {}, saved.targets[s]); });
      else if (k === "escalate" && saved.escalate) c.escalate = Object.assign({}, c.escalate, saved.escalate);
      else c[k] = saved[k];
    });
    /* shift times saved by earlier versions (2nd 12:30–21:30, or 15:00–21:00) are replaced by the roster times */
    var old = c.shifts && c.shifts.map(function (x) { return x.id + x.from + x.to; }).join("|");
    if (old === "1st06:0015:00|2nd12:3021:30|night21:0006:00" || old === "1st06:0015:00|2nd15:0021:00|night21:0006:00") c.shifts = JSON.parse(JSON.stringify(DEFAULTS.shifts));
    return c;
  }

  /* ── time helpers (IST, independent of the viewer's timezone) ── */
  function parseTs(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return isNaN(v) ? null : v.getTime();
    if (typeof v === "number") return isNaN(v) ? null : (v < 1e11 ? v * 1000 : v);
    var s = String(v).trim(); if (!s) return null;
    if (/^\d{10,13}$/.test(s)) return parseTs(+s);
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);   // dd/mm/yyyy [hh:mm]
    if (m) {
      var y = +m[3]; if (y < 100) y += 2000; var h = +(m[4] || 0); if (m[7]) { if (/pm/i.test(m[7]) && h < 12) h += 12; if (/am/i.test(m[7]) && h === 12) h = 0; }
      return Date.UTC(y, +m[2] - 1, +m[1], h, +(m[5] || 0), +(m[6] || 0)) - IST;          // a sheet date with no zone = IST
    }
    s = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    var t = new Date(s).getTime(); return isNaN(t) ? null : t;
  }
  function ist(ms) { var d = new Date(ms + IST); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
  function hm(s) { var m = String(s || "").match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : 0; }
  function istMidnight(ms) { var p = ist(ms); return Date.UTC(p.y, p.mo, p.d) - IST; }
  function dayKey(ms) { return new Date(ms + IST).toISOString().slice(0, 10); }
  function dateMs(s) { var m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - IST : null; }

  /* ── Section 1.3: who is on duty at moment ms ──
     weekday nights 21:00–06:00 → Shadow team logs, Hypercare team owns and runs the Showstopper playbook
     weekday 06:00–09:00        → Shadow team logs, PO owns; Critical/Showstopper: call and inform the PO
     weekday daytime            → Shadow team logs, PO owns
     weekends                   → General Support logs, PO owns; Critical/Showstopper: call and inform the PO */
  function duty(ms, cfg) {
    cfg = cfg || DEFAULTS;
    var p = ist(ms), nf = hm(cfg.night.from), nt = hm(cfg.night.to), cf = hm(cfg.callWindow.from), ct = hm(cfg.callWindow.to);
    var weekend = p.dow === 0 || p.dow === 6;                    // Saturday and Sunday: General Support all day (Section 1.3)
    if (!weekend && (p.min >= nf || p.min < nt)) {
      return { id: "night", label: "Weekday night", logs: "Shadow team", owns: "Hypercare team", critical: "Hypercare team runs the Showstopper playbook (phone the Engineering head)",
        from: nf, to: nt };
    }
    if (weekend) return { id: "weekend", label: p.dow === 6 ? "Saturday" : "Sunday", logs: "General Support", owns: "PO for the module", critical: "Call and inform the PO, who handles further action", from: 0, to: 1440 };
    if (p.min >= cf && p.min < ct) return { id: "call", label: "Weekday morning", logs: "Shadow team", owns: "PO for the module", critical: "Call and inform the PO, who handles further action", from: cf, to: ct };
    return { id: "day", label: "Weekday daytime", logs: "Shadow team", owns: "PO for the module", critical: "Tag the PO for the module", from: ct, to: nf };
  }
  /* the next change of duty after ms (for "until 21:00") */
  function nextDutyChange(ms, cfg) {
    var cur = duty(ms, cfg).id, t = Math.ceil(ms / (15 * MIN)) * 15 * MIN;
    for (var i = 0; i < 4 * 24 * 8; i++, t += 15 * MIN) if (duty(t, cfg).id !== cur) return t;
    return null;
  }

  function sevOf(priority) {
    var s = String(priority == null ? "" : priority).toLowerCase().replace(/[^a-z]/g, "");
    if (s === "showstopper" || s === "blocker") return "showstopper";
    if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
    if (s === "mediumlow") return "medium";
    return null;
  }
  function sevName(id) { for (var i = 0; i < SEVS.length; i++) if (SEVS[i].id === id) return SEVS[i].name; return "Unrated"; }
  function sevRank(id) { for (var i = 0; i < SEVS.length; i++) if (SEVS[i].id === id) return i; return 9; }

  /* ── an export / Jira row → ticket ── */
  function getter(rows) {
    /* column names from many rows, not just the first (a row can lack a column another has) */
    var km = {};
    (rows || []).slice(0, 400).forEach(function (r) { Object.keys(r).forEach(function (k) {
      var n = k.trim().toLowerCase(), m = n.match(/^custom field \((.+)\)$/);
      if (km[n] === undefined) km[n] = k; if (m && km[m[1]] === undefined) km[m[1]] = k;
    }); });
    return function (row, name) { var k = km[name]; if (k === undefined) { k = name; } var v = row[k]; return v == null ? "" : v; };
  }
  function txt(v) { if (v == null) return ""; if (v instanceof Date) return v.toISOString(); return String(v).trim(); }
  /* "-", "N/A", "nil", "none", "TBD"… typed into a Jira field mean nothing was written */
  function real(v) { var x = txt(v); return /^[\s\-–—_.:;,\/\\*#?]*$/.test(x) || /^(n\/?a|nil|none|null|na|tbd|tba|no|nothing|not applicable|not available|pending|-+\s*na)$/i.test(x) ? "" : x; }
  function list(v) { return txt(v).split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function normTicket(row, get) {
    var g = function (n) { return txt(get(row, n)); };
    var key = g("key"), links = list(get(row, "linked issues")), lst = list(get(row, "linked ticket status"));
    var lrps = [], lrpsStatus = {};
    links.forEach(function (k, i) { if (/^LRPS-\d+$/i.test(k)) { lrps.push(k.toUpperCase()); if (lst[i]) lrpsStatus[k.toUpperCase()] = lst[i]; } });
    return {
      _row: row, key: key, prefix: key.split("-")[0].toUpperCase(), summary: g("summary"), status: g("status"), priority: g("priority"), sev: sevOf(g("priority")),
      type: g("issue type"), created: parseTs(get(row, "created")), updated: parseTs(get(row, "updated")), resolved: parseTs(get(row, "resolved")),
      components: list(get(row, "components")), svm: g("svm in charge"), cw: g("current worker"), assignee: g("assignee"), reporter: g("reporter"),
      meId: g("client reference"), env: g("environment"), impact: g("incident - impact") || g("incident impact"), severity: g("incident - severity") || g("severity"),
      businessUser: g("business user"), orgs: g("organizations"), menu: g("menu head"), screen: g("screen name"), description: g("description"),
      reasonText: real(get(row, "reason for occurrence - text")), reasonOcc: real(get(row, "reason for occurrence")), resolutionDetails: real(get(row, "resolution details")), solution: real(get(row, "solution summary")),
      rootCause: g("root cause"), labels: g("labels"), releaseNo: g("release number") || g("release number (data fix)"), lrps: lrps, lrpsStatus: lrpsStatus
    };
  }

  /* ── Section 15.3: the Product Owner. One mapped component → its PO; several (or none mapped) → SVM In Charge. ── */
  function moduleOf(comp, cfg) {
    var c = String(comp || "").toLowerCase().trim();
    for (var i = 0; i < cfg.modules.length; i++) { var m = cfg.modules[i]; if (m.match.some(function (x) { return x === c; })) return m; }
    return null;
  }
  function poFor(t, cfg) {
    var mods = [], seen = {};
    t.components.forEach(function (c) { var m = moduleOf(c, cfg); if (m && !seen[m.module]) { seen[m.module] = 1; mods.push(m); } });
    if (mods.length === 1 && t.components.length === 1) return { po: mods[0].po, module: mods[0].module, phone: mods[0].phone, email: mods[0].email, via: "component" };
    var why = t.components.length > 1 ? "several components" : t.components.length ? "component not in the PO list" : "no component";
    var byName = null; if (t.svm) cfg.modules.forEach(function (m) { if (!byName && m.po.toLowerCase().replace(/[^a-z]/g, "") === t.svm.toLowerCase().replace(/[^a-z]/g, "")) byName = m; });
    return { po: t.svm || "", module: mods.length === 1 ? mods[0].module : (mods.map(function (m) { return m.module; }).join(" + ") || (t.components.join(", ") || "")),
             phone: byName ? byName.phone : "", email: byName ? byName.email : "", via: t.svm ? "svm" : "none", why: why };
  }

  /* ── where the ticket stands now ── */
  /* "Analysis & Study" and "Analysis and Study" are the same status for matching */
  function normSt(s) { return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/\s+/g, " ").trim(); }
  function stageOf(t, cfg, cls) {
    var st = normSt(t.status);
    if (cls && cls.isTerminal(t.status)) return "closed";
    if ((cfg.billing || []).some(function (s) { return normSt(s) === st; })) return "billing";
    if (cfg.openBox.some(function (s) { return normSt(s) === st; })) return "openbox";
    if (cls && cls.owner(t.status) === "client") return "client";
    return "working";
  }

  /* ── Section 10.1 clocks for one ticket ──
     transitions: [{t, from, to, by}] or null (no valid status history yet).
     cls: { isTerminal(status), owner(status) → "client" | "svm" | null }
     FR   = created → first move to a client-side status (or straight to Closed). Bots (FR_BOT) are skipped via firstResponse.
     res  = time on OUR side (not with the client, not closed), round the clock.
     prog = time since the last status change (the "no progress" test of Section 10.2). */
  function evaluate(t, transitions, now, cfg, cls, firstResponse) {
    var tg = cfg.targets[t.sev] || null, stage = stageOf(t, cfg, cls), out = { stage: stage, sev: t.sev, target: tg, hist: !!transitions };
    if (t.created == null) return out;
    var isBilling = function (s) { var n = normSt(s); return (cfg.billing || []).some(function (b) { return normSt(b) === n; }); };
    var isClient = function (s) { return cls && !cls.isTerminal(s) && (cls.owner(s) === "client" || isBilling(s)); };   // delivered for billing = answered, off our clock
    var isClosed = function (s) { return cls ? cls.isTerminal(s) : /^closed$/i.test(String(s || "")); };
    if (transitions) {
      var tr = transitions.slice().sort(function (a, b) { return a.t - b.t; });
      var fr = firstResponse ? firstResponse(t.created, tr, { isClient: isClient, isClosed: isClosed }) : null;
      if (!fr) { fr = { pending: true }; for (var i = 0; i < tr.length; i++) if (isClient(tr[i].to) || isClosed(tr[i].to)) { fr = { min: Math.max(0, (tr[i].t - t.created) / MIN), at: tr[i].t, to: tr[i].to }; break; } }
      out.fr = { at: fr.at || null, min: fr.min != null ? fr.min : null, to: fr.to || "" };
      /* segments → time on our side, reopens */
      var cur = tr.length && tr[0].from ? tr[0].from : t.status, start = t.created, ours = 0, client = 0, reopens = 0, wasClosed = false, firstClosedAt = null;
      function add(status, a, b) { var d = Math.max(0, b - a); if (isClosed(status)) return; if (isClient(status)) client += d; else ours += d; }
      for (var j = 0; j < tr.length; j++) {
        var at = Math.max(tr[j].t, start); add(cur, start, at);
        if (isClosed(cur) && !isClosed(tr[j].to)) reopens++;
        cur = tr[j].to || cur; start = at;
        if (isClosed(cur) && firstClosedAt == null) firstClosedAt = at;
      }
      if (t.status && cur !== t.status) cur = t.status;              // Jira's current status is the authority (same as the SLA engine)
      add(cur, start, Math.max(now, start));
      out.oursMin = ours / MIN; out.clientMin = client / MIN; out.reopens = reopens;
      out.lastMove = tr.length ? tr[tr.length - 1].t : t.created;
    } else {
      out.lastMove = null;
    }
    out.closedAt = stage === "closed" ? (t.resolved || (transitions && out.lastMove) || t.updated) : null;
    if (tg) {
      /* first response */
      if (out.fr && out.fr.min != null) out.frState = out.fr.min <= tg.fr ? "met" : "missed";
      else if (out.fr) out.frState = (now - t.created) / MIN > tg.fr ? "breached" : "waiting";
      else out.frState = "nohist";
      out.frDueAt = t.created + tg.fr * MIN;
      /* resolution benchmark (a guide, not a commitment) */
      if (out.oursMin != null) {
        out.resPct = out.oursMin / tg.res * 100;
        out.resState = stage === "closed" ? (out.oursMin <= tg.res ? "met" : "missed") : out.oursMin > tg.res ? "over" : out.resPct >= 75 ? "risk" : "ok";
      }
      /* update interval: no status change for longer than the Analysis & ETR interval while on our side */
      if (out.lastMove != null && (stage === "working" || stage === "openbox")) {
        out.sinceMoveMin = (now - out.lastMove) / MIN;
        out.updateDue = out.sinceMoveMin > tg.upd;
      }
    }
    return out;
  }

  /* ── runbook checks ── each: { id, ref, title, who, why, keys:[…] } */
  var MANDATORY = [
    ["description", "Description"], ["meId", "Client Reference (ME ID)"], ["env", "Environment"], ["impact", "Incident - Impact"],
    ["severity", "Incident - Severity"], ["priority", "Priority"], ["menu", "Menu Head"], ["screen", "Screen Name"],
    ["businessUser", "Business User"], ["orgs", "Organizations"]
  ];
  function checks(T, E, now, cfg) {
    var open = T.filter(function (t, i) { return E[i].stage !== "closed"; });
    var out = [];
    function push(id, ref, title, who, why, keys, extra) { out.push(Object.assign({ id: id, ref: ref, title: title, who: who, why: why, keys: keys }, extra || {})); }
    /* which mandatory fields does the data carry at all? (a column that is empty for every ticket was not fetched) */
    var carried = MANDATORY.filter(function (m) { return T.some(function (t) { return t[m[0]]; }); });
    var notCarried = MANDATORY.filter(function (m) { return carried.indexOf(m) < 0; }).map(function (m) { return m[1]; });
    var miss = [], missBy = {};
    open.forEach(function (t) {
      var m = carried.filter(function (f) { return !t[f[0]]; }).map(function (f) { return f[1]; });
      if (m.length) { miss.push(t.key); missBy[t.key] = m; }
    });
    push("mandatory", "Step 3", "Mandatory fields missing", "Shadow team / General Support",
      "Every field in Step 3 must be filled when the ticket is logged.", miss, { detail: missBy, notCarried: notCarried });
    push("meid", "R2", "No ME ID", "Shadow team / General Support", "The ME ID must be recorded in Client Reference.",
      open.filter(function (t) { return !t.meId; }).map(function (t) { return t.key; }));
    var byMe = {}; T.forEach(function (t, i) { var id = t.meId.replace(/\s+/g, "").toUpperCase(); if (id) (byMe[id] = byMe[id] || []).push(i); });
    var dups = [], dupOf = {};
    Object.keys(byMe).forEach(function (id) { var l = byMe[id]; if (l.length > 1 && l.some(function (i) { return E[i].stage !== "closed"; })) l.forEach(function (i) { dups.push(T[i].key); dupOf[T[i].key] = { me: id, with: l.filter(function (x) { return x !== i; }).map(function (x) { return T[x].key; }) }; }); });
    push("dup", "R4", "Same ME ID on more than one ticket", "Shadow team / General Support", "One issue, one Jira ticket.", dups, { detail: dupOf });
    push("triage", "Step 4", "Still in the open box after " + cfg.triageMin + " minutes", "Shadow team / General Support",
      "Triage immediately after logging: owner in an internal note, status Technical Analysis.",
      T.filter(function (t, i) { return E[i].stage === "openbox" && t.created != null && (now - t.created) / MIN > cfg.triageMin; }).map(function (t) { return t.key; }));
    push("lrps", "Step 4", "Past the open box, but no linked LRPS ticket", "Shadow team / General Support",
      "Setting Technical Analysis creates the linked LRPS ticket for the engineering owner.",
      T.filter(function (t, i) { return E[i].stage !== "openbox" && E[i].stage !== "closed" && E[i].stage !== "billing" && !t.lrps.length && /incident/i.test(t.type); }).map(function (t) { return t.key; }));
    push("nosvm", "R6", "No SVM In Charge", "Product Owners", "Every ticket needs one named owner. With several components the SVM In Charge is the PO.",
      open.filter(function (t) { return !t.svm; }).map(function (t) { return t.key; }));
    var hcStart = dateMs(cfg.start) || 0;
    push("fr", "10.1", "First response overdue", "Hypercare team / PO", "No move to the client yet and the first-response target has passed. Tickets created since counting started; older backlog shows its clock on the ticket.",
      T.filter(function (t, i) { return E[i].frState === "breached" && E[i].stage !== "closed" && (t.created || 0) >= hcStart; }).map(function (t) { return t.key; }));
    push("upd", "10.1", "ETR update overdue", "Hypercare team / PO", "With us and no status change for longer than the Section 10.1 Analysis and ETR update interval (Showstopper 1h, Critical 2h, High 4h, Medium/Low 8h). Send the progress update with an ETR.",
      T.filter(function (t, i) { return E[i].updateDue; }).map(function (t) { return t.key; }));
    /* closure rules apply to tickets closed during Hypercare, not to the years before it */
    var hcFrom = dateMs(cfg.start) || 0, closedInHc = function (i) { return E[i].stage === "closed" && (E[i].closedAt || 0) >= hcFrom; };
    push("notes", "R19", "Closed without closure notes", "Hypercare team / PO", "Closure needs root cause (Reason for Occurrence) and fix applied (Resolution Details). Tickets closed since counting started.",
      T.filter(function (t, i) { return closedInHc(i) && (!t.reasonText || !t.resolutionDetails); }).map(function (t) { return t.key; }),
      { detail: (function () { var d = {}; T.forEach(function (t, i) { if (closedInHc(i)) { var m = []; if (!t.reasonText) m.push("Reason for Occurrence"); if (!t.resolutionDetails) m.push("Resolution Details"); if (m.length) d[t.key] = m; } }); return d; })() });
    push("reopen", "11", "Reopened tickets", "Product Owners", "A closed ticket came back. Check the closure and the fix.",
      T.filter(function (t, i) { return E[i].reopens > 0 && (E[i].stage !== "closed" || closedInHc(i)); }).map(function (t) { return t.key; }));
    return out;
  }

  /* ── Section 10.2 escalations (open tickets only) ── */
  function escalations(T, E, now, cfg) {
    var out = [];
    T.forEach(function (t, i) {
      var e = E[i]; if (e.stage === "closed") return;
      if (e.stage === "billing") return;                              // delivered, with finance: nothing technical to escalate
      if (t.sev === "showstopper") out.push({ i: i, key: t.key, sev: t.sev, trigger: "Showstopper open", inform: ["Engineering head", "Customer relationship head", "Account manager", "Swire IT"], since: t.created, when: "at once" });
      else if (t.sev === "critical" && e.stage !== "client" && e.sinceMoveMin != null && e.sinceMoveMin > cfg.escalate.critical)
        out.push({ i: i, key: t.key, sev: t.sev, trigger: "Critical, no progress for " + Math.round(cfg.escalate.critical / 60) + " hours", inform: ["Engineering head"], since: e.lastMove });
      else if (t.sev === "high" && e.stage !== "client" && e.sinceMoveMin != null && e.sinceMoveMin > cfg.escalate.high)
        out.push({ i: i, key: t.key, sev: t.sev, trigger: "High, no progress for " + Math.round(cfg.escalate.high / 1440) + " days", inform: ["PO for the module (Hypercare lead)"], since: e.lastMove });
      else if ((t.sev === "medium" || t.sev === "low") && e.resState === "over")
        out.push({ i: i, key: t.key, sev: t.sev, trigger: "Past its resolution benchmark", inform: ["PO for the module, at the weekly ageing review"], since: t.created });
    });
    out.sort(function (a, b) { return sevRank(a.sev) - sevRank(b.sev) || (a.since || 0) - (b.since || 0); });
    return out;
  }

  /* ── analytics for tickets created in [from, to) (ms; null = open-ended) ── */
  function analytics(T, E, from, to, now) {
    var inR = function (ms) { return ms != null && (from == null || ms >= from) && (to == null || ms < to); };
    var created = [], closed = [];
    T.forEach(function (t, i) { if (inR(t.created)) created.push(i); if (E[i].stage === "closed" && inR(E[i].closedAt)) closed.push(i); });
    var bySev = {}; SEVS.forEach(function (s) { bySev[s.id] = { n: 0, frMet: 0, frDecided: 0, frNoHist: 0, resMet: 0, resDecided: 0, frSum: 0, frCnt: 0 }; });
    var days = {}, comp = {}, env = {}, type = {}, users = {}, mand = 0, meid = 0, notes = 0, closedN = 0, reopened = 0;
    created.forEach(function (i) {
      var t = T[i], e = E[i], b = bySev[t.sev];
      var dk = dayKey(t.created); (days[dk] = days[dk] || { c: 0, x: 0 }).c++;
      (t.components.length ? t.components : ["(none)"]).forEach(function (c) { comp[c] = (comp[c] || 0) + 1; });
      env[t.env || "(blank)"] = (env[t.env || "(blank)"] || 0) + 1; type[t.type || "(blank)"] = (type[t.type || "(blank)"] || 0) + 1;
      if (t.businessUser) users[t.businessUser] = (users[t.businessUser] || 0) + 1;
      if (t.meId) meid++;
      if (e.reopens > 0) reopened++;
      if (!b) return;
      b.n++;
      if (e.frState === "met" || e.frState === "missed") { b.frDecided++; if (e.frState === "met") b.frMet++; b.frSum += e.fr.min; b.frCnt++; }
      else if (e.frState === "breached") b.frDecided++;
      else if (e.frState === "nohist") b.frNoHist++;
      if (e.resState === "met" || e.resState === "missed") { b.resDecided++; if (e.resState === "met") b.resMet++; }
    });
    closed.forEach(function (i) { var dk = dayKey(E[i].closedAt); (days[dk] = days[dk] || { c: 0, x: 0 }).x++; closedN++; if (T[i].reasonText && T[i].resolutionDetails) notes++; });
    function top(o, n) { return Object.keys(o).map(function (k) { return { k: k, n: o[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, n || 12); }
    return { created: created, closed: closed, bySev: bySev, days: days, comp: top(comp, 14), env: top(env, 8), type: top(type, 6), users: top(users, 10),
             meidPct: created.length ? Math.round(meid / created.length * 100) : null, notesPct: closedN ? Math.round(notes / closedN * 100) : null,
             reopened: reopened };
  }

  /* every shift that starts between fromMs and toMs → [{ id, name, from, to, start, end, day }] sorted by start.
     A shift whose end is not after its start (Night 21:00–06:00) ends the next day. */
  function shiftInstances(cfg, fromMs, toMs) {
    var out = [], d0 = istMidnight(fromMs) - DAY;
    for (var d = d0; d <= toMs; d += DAY) (cfg.shifts || DEFAULTS.shifts).forEach(function (s) {
      var a = d + hm(s.from) * MIN, bm = hm(s.to), b = d + bm * MIN; if (bm <= hm(s.from)) b += DAY;
      if (a >= fromMs - DAY && a <= toMs) out.push({ id: s.id, name: s.name, from: s.from, to: s.to, start: a, end: b, day: dayKey(d) });
    });
    out.sort(function (x, y) { return x.start - y.start; });
    return out;
  }

  /* Hypercare phase (Section 10.7) from the start date */
  function phase(now, cfg) {
    var s = dateMs(cfg.start); if (s == null || now < s) return { month: 0, name: "Not started" };
    var a = ist(s), b = ist(now), m = (b.y - a.y) * 12 + (b.mo - a.mo) + (b.d >= a.d ? 1 : 0); if (m < 1) m = 1;
    var name = m === 1 ? "Stabilise" : m <= 3 ? "Settle" : m <= 5 ? "Reduce" : "Hand over";
    return { month: m, name: name };
  }

  function fmtMin(m) {
    if (m == null || isNaN(m)) return "—";
    m = Math.max(0, Math.round(m));
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return h + "h" + (r ? " " + r + "m" : "");
    var d = Math.floor(h / 24), hh = h % 24; return d + "d" + (hh ? " " + hh + "h" : "");
  }

  return { DEFAULTS: DEFAULTS, SEVS: SEVS, MANDATORY: MANDATORY, merge: merge, parseTs: parseTs, ist: ist, istMidnight: istMidnight, dayKey: dayKey, dateMs: dateMs,
           duty: duty, nextDutyChange: nextDutyChange, sevOf: sevOf, sevName: sevName, sevRank: sevRank, getter: getter, normTicket: normTicket,
           moduleOf: moduleOf, poFor: poFor, stageOf: stageOf, evaluate: evaluate, checks: checks, escalations: escalations, analytics: analytics,
           phase: phase, fmtMin: fmtMin, shiftInstances: shiftInstances };
});
