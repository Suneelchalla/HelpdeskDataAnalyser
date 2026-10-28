/* HD Dashboards — Jira Live Fetch (v3 API, extension-only, CSP-safe) */
(function () {
  var CFG_KEY = "hd-jira-cfg", PAGE_SIZE = 250;

  /* ══════ Bridge detection via postMessage ══════ */
  var _bridgeReady = false, _seq = 0, _pending = {};
  window.addEventListener("message", function (e) {
    if (!e.data) return;
    if (e.data.type === "HD_BRIDGE_READY") { _bridgeReady = true; return; }
    if (e.data.type !== "HD_BRIDGE_RESULT") return;
    var cb = _pending[e.data.id]; if (!cb) return;
    delete _pending[e.data.id];
    if (e.data.ok) cb.resolve(e.data.data);
    else cb.reject(new Error(e.data.error || "Bridge error"));
  });
  window.postMessage({ type: "HD_BRIDGE_PING" }, "*");
  setTimeout(function(){ window.postMessage({ type: "HD_BRIDGE_PING" }, "*"); }, 500);

  function bridgeCall(host, path, method, body) {
    if (!_bridgeReady) return Promise.reject(new Error("EXTENSION_NOT_FOUND"));
    return new Promise(function (resolve, reject) {
      var id = ++_seq;
      _pending[id] = { resolve: resolve, reject: reject };
      window.postMessage({ type: "HD_BRIDGE_CALL", id: id, host: host, path: path, method: method || "GET", body: body || null }, "*");
      setTimeout(function () { if (_pending[id]) { delete _pending[id]; reject(new Error("Request timed out.")); } }, 60000);
    });
  }

  /* ══════ Config ══════ */
  function loadCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) { return {}; } }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }

  function testConnection(cfg) {
    return bridgeCall(cfg.jiraHost || "svmhelpdesk.atlassian.net", "/rest/api/3/myself");
  }
  function discoverFields(cfg) {
    return bridgeCall(cfg.jiraHost || "svmhelpdesk.atlassian.net", "/rest/api/3/field")
      .then(function (fields) {
        return fields.filter(function (f) { return f.custom; })
          .sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
      });
  }
  function autoDetect(customFields) {
    var map = {}, patterns = {
      svmInCharge: [/svm\s*in\s*charge/i], currentWorker: [/current\s*worker/i],
      nextAction: [/next\s*action/i], timeToFirstResponse: [/time\s*to\s*first\s*resp/i, /first\s*response/i],
      timeToResolution: [/time\s*to\s*resolution/i],
      rootCause: [/^root\s*cause$/i, /root\s*cause\s*category/i],
      typeOfFix: [/type\s*of\s*fix/i],
      screenName: [/screen\s*name/i],
      menuHead: [/menu\s*head/i],
      releaseDataFix: [/release\s*number\s*\(?\s*data\s*fix/i, /data\s*fix\s*release/i],
      releaseNumber: [/^\s*release\s*number\s*$/i, /^\s*release\s*no\.?\s*$/i],
      parentRelease: [/parent\s*release/i],
      tshirtSizing: [/t.?shirt\s*siz/i, /^\s*t.?shirt\s*$/i, /^\s*sizing\s*$/i],
      severity: [/^\s*severity\s*$/i, /severity/i],
      assignedDate: [/assigned\s*date/i, /^\s*assigned\s*on\s*$/i],
      deliveredDate: [/delivered\s*date/i, /^\s*delivered\s*on\s*$/i],
      clientReference: [/client\s*reference/i, /client\s*ref\b/i],
      analysis: [/^\s*analysis\s*$/i],
      solutionSummary: [/solution\s*summary/i, /^\s*solution\s*$/i],
      /* Root Cause tab: the written cause, the cause category and how it was fixed */
      reasonText: [/reason\s*for\s*occ?urr?ence\s*[-\u2013:]?\s*text/i, /reason\s*for\s*occ?urr?ence.*(desc|detail|text)/i],
      reasonOccurrence: [/^\s*reason\s*for\s*occ?urr?ence\s*$/i],
      resolutionDetails: [/^\s*resolution\s*details?\s*$/i, /resolution\s*details?/i, /^\s*fix\s*details?\s*$/i],
      /* FPA Details (change tickets) */
      chargeable: [/^\s*chargeable\s*$/i, /^\s*charge\s*type\s*$/i, /chargeab/i],
      fpaManDays: [/^\s*fpa\s*man.?days\s*$/i, /fpa\s*man.?days(?!\s*split)/i],
      approvedManDays: [/^\s*approved\s*man.?days\s*$/i, /approved\s*man.?days/i],
      fpaPreparedBy: [/fpa\s*prepared\s*by/i],
      fpaApprovedBy: [/fpa\s*approved\s*by/i],
      impactModule: [/^\s*impact\s*module\s*$/i, /impact\s*module/i],
      manpowerType: [/man\s*power\s*type/i]
    };
    Object.keys(patterns).forEach(function (key) {
      /* patterns are tried in order across ALL fields, so an exact name ("Chargeable") wins over a loose one ("Chargeable Amount") */
      for (var j = 0; j < patterns[key].length; j++) {
        for (var i = 0; i < customFields.length; i++) {
          if (patterns[key][j].test(customFields[i].name || "")) { map[key] = customFields[i].id; return; }
        }
      }
    });
    return map;
  }

  /* Jira often has several custom fields with the SAME name (company-managed + team-managed projects, old copies).
     Mapping only the first one silently gives empty values for every ticket that uses another copy — that is how
     Root Cause came back blank for all tickets. This returns, per key, every field matching its best pattern. */
  function autoDetectAll(customFields) {
    var single = autoDetect(customFields), out = {};
    Object.keys(single).forEach(function (key) {
      var first = null; customFields.forEach(function (f) { if (f.id === single[key]) first = f; });
      var name = String(first && first.name || "").trim().toLowerCase();
      out[key] = customFields.filter(function (f) { return String(f.name || "").trim().toLowerCase() === name; }).map(function (f) { return f.id; });
    });
    return out;
  }

  /* ══════ Paginated search (v3 GET with cursor pagination) ══════ */
  /* A background Jira tab can be reloaded/slept mid-request ("Frame with ID 0 was removed").
     Reads are safe to repeat, so retry the SAME page instead of failing the whole fetch. */
  var RETRY_RE = /Frame with ID|No tab with id|Cannot access contents|Receiving end does not exist|The frame was removed|Jira tab timed out|Request timed out/i;
  function callRetry(host, path, method, body, n) {
    n = n || 0;
    return bridgeCall(host, path, method, body).catch(function (e) {
      if (n < 3 && RETRY_RE.test(String((e && e.message) || e))) {
        return new Promise(function (r) { setTimeout(r, 2000 * (n + 1)); })
          .then(function () { return callRetry(host, path, method, body, n + 1); });
      }
      throw e;
    });
  }

  function search(host, jql, fields, onProgress) {
    var all = [], total = 0;

    /* /search/jql no longer returns a total, so ask the approximate-count endpoint.
       It is only used for the progress bar — if it fails the fetch carries on without it. */
    return callRetry(host, "/rest/api/3/search/approximate-count", "POST", { jql: jql })
      .then(function (c) { total = (c && c.count) || 0; }, function () { total = 0; })
      .then(function () {
        if (onProgress) onProgress(0, total);
        return nextPage(null);
      });

    function nextPage(token) {
      var path = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql)
        + "&maxResults=" + PAGE_SIZE
        + "&fields=" + fields.join(",")
        + (token ? "&nextPageToken=" + encodeURIComponent(token) : "");
      return callRetry(host, path, "GET", null).then(function (data) {
        all = all.concat(data.issues || []);
        /* unknown total → estimate "one more page to go" so the bar stays below 100% until done */
        var shownTotal = total > all.length ? total : (data.nextPageToken ? all.length + PAGE_SIZE : all.length);
        if (onProgress) onProgress(all.length, shownTotal);
        if (data.nextPageToken) return nextPage(data.nextPageToken);
        return all;
      });
    }
  }

  /* ══════ Transform ══════ */
  function transform(issues, fm) {
    return issues.map(function (issue) {
      var f = issue.fields || {}, row = {};
      row["Issue Type"] = f.issuetype ? f.issuetype.name : "";
      row["Key"] = issue.key || ""; row["Summary"] = f.summary || "";
      row["Status"] = f.status ? f.status.name : "";
      row["Priority"] = f.priority ? f.priority.name : "";
      row["Project"] = f.project ? f.project.name : "";
      row["Components"] = (f.components || []).map(function (c) { return c.name; }).join("; ");
      row["Created"] = f.created || "";
      row["Resolved"] = f.resolutiondate || "";
      row["Updated"] = f.updated || "";
      row["Resolution"] = f.resolution ? f.resolution.name : "";
      row["SVM In Charge"] = person(pf(f, fm.svmInCharge));
      row["Current Worker"] = person(pf(f, fm.currentWorker));
      row["Next Action"] = choice(pf(f, fm.nextAction));
      row["Time to first response"] = sla(pf(f, fm.timeToFirstResponse));
      row["Time to resolution"] = sla(pf(f, fm.timeToResolution));
      row["Root Cause"] = choice(pf(f, fm.rootCause));
      row["Type of Fix"] = choice(pf(f, fm.typeOfFix));
      row["Screen Name"] = choice(pf(f, fm.screenName));
      row["Menu Head"] = choice(pf(f, fm.menuHead));
      row["Release Number"] = txt(pf(f, fm.releaseNumber));
      row["Release Number (Data Fix)"] = txt(pf(f, fm.releaseDataFix));
      row["Parent Release No"] = txt(pf(f, fm.parentRelease));
      row["Assignee"] = person(f.assignee);
      row["Reporter"] = person(f.reporter);
      row["T-Shirt Sizing"] = choice(pf(f, fm.tshirtSizing));
      row["Severity"] = choice(pf(f, fm.severity));
      row["Assigned Date"] = txt(pf(f, fm.assignedDate));
      row["Delivered Date"] = txt(pf(f, fm.deliveredDate));
      row["Client Reference"] = txt(pf(f, fm.clientReference));
      row["Analysis"] = rich(pf(f, fm.analysis));
      row["Solution Summary"] = rich(pf(f, fm.solutionSummary));
      row["Reason for Occurrence - Text"] = rich(pf(f, fm.reasonText));
      row["Reason for Occurrence"] = anyVal(pf(f, fm.reasonOccurrence));
      row["Resolution Details"] = rich(pf(f, fm.resolutionDetails));
      row["Chargeable"] = anyVal(pf(f, fm.chargeable));
      row["FPA Man-days"] = num(pf(f, fm.fpaManDays));
      row["Approved Man-days"] = num(pf(f, fm.approvedManDays));
      row["SVM FPA Prepared By"] = person(pf(f, fm.fpaPreparedBy));
      row["SVM FPA Approved By"] = person(pf(f, fm.fpaApprovedBy));
      row["Impact Module"] = anyVal(pf(f, fm.impactModule));
      row["Manpower Type"] = anyVal(pf(f, fm.manpowerType));
      row["Labels"] = (f.labels || []).join("; ");
      row["Description"] = rich(f.description);
      row["Environment"] = txt(f.environment);
      row["Fix Versions"] = (f.fixVersions || []).map(function (v) { return v.name || ""; }).join("; ");
      row["Parent Key"] = f.parent ? (f.parent.key || "") : "";
      row["Parent Summary"] = f.parent && f.parent.fields ? (f.parent.fields.summary || "") : "";
      row["Comment Count"] = f.comment ? (f.comment.total || 0) : 0;
      row["Last Comment"] = "";
      if (f.comment && f.comment.comments && f.comment.comments.length) {
        var lastC = f.comment.comments[f.comment.comments.length - 1];
        row["Last Comment"] = lastC.updated || lastC.created || "";
      }
      if (f.issuelinks && f.issuelinks.length) {
        var lk = [], ls = [], lt = [];
        f.issuelinks.forEach(function (l) {
          var o = l.outwardIssue || l.inwardIssue;
          var ltype = l.outwardIssue ? (l.type ? l.type.outward || "" : "") : (l.type ? l.type.inward || "" : "");
          if (o) {
            lk.push(o.key);
            if (o.fields && o.fields.status) ls.push(o.fields.status.name);
            lt.push(o.key + ":" + ltype + (o.fields && o.fields.issuetype ? ":" + o.fields.issuetype.name : ""));
          }
        });
        row["Linked Issues"] = lk.join(", "); row["Linked Ticket status"] = ls.join(", ");
        row["Link Details"] = lt.join(", ");
      } else { row["Linked Issues"] = ""; row["Linked Ticket status"] = ""; row["Link Details"] = ""; }
      return row;
    });
  }
  function pf(f, spec) {
    if (!spec) return undefined;
    var ids = String(spec).split(","), v;
    for (var i = 0; i < ids.length; i++) { v = f[ids[i].trim()]; if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) return v; }
    return v;
  }
  function person(v) { if (!v) return ""; if (typeof v === "string") return v; if (Array.isArray(v)) return v.map(function (x) { return x.displayName || x.name || ""; }).join(", "); return v.displayName || v.name || v.value || ""; }
  /* single select, multi-select (array) and cascading select ("Parent - Child") all read as text */
  function choice(v) {
    if (!v) return ""; if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(choice).filter(Boolean).join("; ");
    var s = v.value || v.name || "";
    if (v.child) { var c = choice(v.child); if (c) s = s ? s + " - " + c : c; }
    return s;
  }
  function txt(v) { if (v == null) return ""; if (typeof v === "object") return v.value || v.name || v.displayName || (Array.isArray(v) ? v.map(function (x) { return x.value || x.name || x; }).join(", ") : ""); return String(v); }
  /* Jira rich text (ADF) → readable plain text. Keeps what the old version dropped: line breaks, list bullets,
     links (as "text (url)"), @mentions, ticket smart-links / cards (their URL, so referenced tickets survive),
     status lozenges, dates, table cells and code blocks. */
  function rich(v) { if (v == null) return ""; if (typeof v === "string") return v;
    if (typeof v === "object") { if (Array.isArray(v.content)) return adfText(v).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); return v.value || v.name || ""; }
    return String(v); }
  var ADF_BLOCK = { paragraph: 1, heading: 1, codeBlock: 1, blockquote: 1, panel: 1, listItem: 1, decisionItem: 1, taskItem: 1 };
  function adfText(root) {
    var out = "";
    function nl() { if (out && !/\n$/.test(out)) out += "\n"; }
    function walk(n, list) {
      if (!n) return;
      var a = n.attrs || {};
      switch (n.type) {
        case "text":
          var t = n.text || "", lk = (n.marks || []).filter(function (m) { return m.type === "link" && m.attrs && m.attrs.href; })[0];
          out += t; if (lk && lk.attrs.href !== t) out += " (" + lk.attrs.href + ")"; return;
        case "hardBreak": out += "\n"; return;
        case "mention": out += a.text || (a.id ? "@user" : ""); return;
        case "emoji": out += a.text || a.shortName || ""; return;
        case "inlineCard": out += a.url || (a.data && a.data.url) || ""; return;
        case "blockCard": case "embedCard": nl(); out += a.url || (a.data && a.data.url) || ""; out += "\n"; return;
        case "status": out += "[" + (a.text || "") + "]"; return;
        case "date": out += a.timestamp ? new Date(+a.timestamp).toISOString().slice(0, 10) : ""; return;
        case "rule": nl(); out += "———\n"; return;
        case "mediaSingle": case "mediaGroup": case "mediaInline": nl(); out += "[attachment]\n"; return;
      }
      var kids = n.content || [], sub = list;
      if (n.type === "bulletList") sub = { ordered: false };
      else if (n.type === "orderedList") sub = { ordered: true, i: a.order || 1 };
      if (n.type === "listItem") { nl(); out += list && list.ordered ? (list.i++) + ". " : "• "; }
      if (n.type === "tableRow") { nl(); kids.forEach(function (c, ix) { if (ix) out += " | "; walk(c, sub); out = out.replace(/\n+$/, ""); }); out += "\n"; return; }
      kids.forEach(function (c) { walk(c, sub); });
      if (ADF_BLOCK[n.type]) nl();
    }
    walk(root, null);
    return out;
  }
  /* select / multi-select / cascading / text / number → plain text */
  function anyVal(v) { if (v == null || v === "") return ""; if (Array.isArray(v)) return v.map(anyVal).filter(Boolean).join("; ");
    if (typeof v === "object") { var b = v.value || v.name || v.displayName || ""; return v.child && v.child.value ? b + " - " + v.child.value : b; } return String(v); }
  function num(v) { if (v == null || v === "") return ""; var n = typeof v === "number" ? v : parseFloat(anyVal(v)); return isNaN(n) ? anyVal(v) : n; }
  function sla(s) { if (!s) return ""; if (typeof s === "string") return s;
    if (s.completedCycles && s.completedCycles.length) { var l = s.completedCycles[s.completedCycles.length - 1]; if (l.elapsedTime) return (l.breached ? "-" : "") + (l.elapsedTime.friendly || ""); }
    if (s.ongoingCycle) { var o = s.ongoingCycle; if (o.breached && o.elapsedTime) return "-" + (o.elapsedTime.friendly || ""); if (o.remainingTime) return o.remainingTime.friendly || ""; }
    return ""; }

  /* Excel allows at most 32,767 characters in one cell, and XLSX.write throws on anything longer
     ("Text length must not exceed 32767 characters"). A few tickets have huge descriptions / analysis
     (pasted logs, stack traces), so long text is cut here, with a note, before the workbook is written. */
  var CELL_MAX = 32767, CUT_NOTE = "\n\n[…truncated — full text is in Jira]";
  function capCell(v) { return (typeof v === "string" && v.length > CELL_MAX) ? v.slice(0, CELL_MAX - CUT_NOTE.length) + CUT_NOTE : v; }
  function toBlob(rows) {
    rows = rows.map(function (r) { var o = {}; for (var k in r) o[k] = capCell(r[k]); return o; });
    var ws = XLSX.utils.json_to_sheet(rows), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Jira Issues");
    return new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })],
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function summarize(rows) {
    var cMin = null, cMax = null, rMin = null, rMax = null;
    rows.forEach(function (r) {
      var c = r["Created"] ? new Date(r["Created"]) : null;
      var v = r["Resolved"] ? new Date(r["Resolved"]) : null;
      if (c && !isNaN(c)) { if (!cMin || c < cMin) cMin = c; if (!cMax || c > cMax) cMax = c; }
      if (v && !isNaN(v)) { if (!rMin || v < rMin) rMin = v; if (!rMax || v > rMax) rMax = v; }
    });
    return { cMin: cMin, cMax: cMax, rMin: rMin, rMax: rMax };
  }

  /* opts.full === true forces a full re-pull. Otherwise, if a cached fetch exists
     for the same JQL + host, only tickets updated since the last fetch are pulled
     and merged by Key (incremental). Returns {..., mode, changed}. */
  /* Fields added in a later version (e.g. Chargeable) are mapped automatically on the next fetch, so nobody has to
     re-open the setup: missing keys are auto-detected from the saved field list, or from Jira if there is none. */
  /* Version of the Jira rich-text → plain-text conversion. It is recorded with the cache for information only and does
     NOT force a full fetch: tickets pick up the new text as they are updated in Jira, and the launcher's "Full" button
     re-reads everything when wanted. (Forcing a full fetch made every Refresh restart a long full download until one
     finally completed.) */
  var TEXT_VER = 2;
  var NEW_KEYS = ["chargeable", "fpaManDays", "approvedManDays", "fpaPreparedBy", "fpaApprovedBy", "impactModule", "manpowerType", "reasonText", "reasonOccurrence", "resolutionDetails"];
  /* Every custom field the fetch knows. Any of them that is unmapped ("" or missing) is auto-detected again.
     Before, only NEW_KEYS were checked, so a mapping that got blanked (e.g. Settings saved before "Test connection &
     discover fields" had filled the dropdowns) stayed blank for good — Root Cause came back empty for every ticket
     and the Trend Tracker's Clarification view showed nothing. Detection only fills blanks, never overwrites a
     mapping someone chose, and uses the saved field list when there is one (no extra Jira call). */
  var ALL_KEYS = ["svmInCharge","currentWorker","nextAction","timeToFirstResponse","timeToResolution","rootCause","typeOfFix","screenName","menuHead","releaseNumber","releaseDataFix","parentRelease","tshirtSizing","severity","assignedDate","deliveredDate","clientReference","analysis","solutionSummary"].concat(NEW_KEYS);
  var _discoveredThisSession = false;
  var FM_VER = 2;                              // 2 = duplicate-named fields have been merged into the mapping
  function ensureFieldMap(cfg) {
    var fm = cfg.fieldMap || {}, need = ALL_KEYS.filter(function (k) { return !fm[k]; }), upgrade = cfg._fmVer !== FM_VER;
    if (!need.length && !upgrade) return Promise.resolve(cfg);
    function fills(list) { var auto = autoDetect(list || []); return need.some(function (k) { return auto[k]; }); }
    var src, fresh = false;
    if (!upgrade && cfg._fields && cfg._fields.length && fills(cfg._fields)) src = Promise.resolve(cfg._fields);   // saved list is enough
    else if (!_discoveredThisSession) { fresh = true; src = discoverFields(cfg).then(function (l) { _discoveredThisSession = true; return l; },
                                                                                   function () { _discoveredThisSession = true; return null; }); }
    else return Promise.resolve(cfg);                                                                                 // already looked this session
    return src.then(function (list) {
      if (!list || !list.length) return cfg;
      var auto = autoDetect(list);
      need.forEach(function (k) { if (auto[k]) fm[k] = auto[k]; else if (!(k in fm)) fm[k] = ""; });
      if (fresh) {
        var all = autoDetectAll(list), known = {}; list.forEach(function (f) { known[f.id] = 1; });
        ALL_KEYS.forEach(function (k) {
          var cur = String(fm[k] || "").split(",").map(function (x) { return x.trim(); }).filter(function (x) { return x && known[x]; });   // drop deleted fields
          (all[k] || []).forEach(function (id) { if (cur.indexOf(id) < 0) cur.push(id); });
          if (cur.length || fm[k]) fm[k] = cur.join(",");
        });
        cfg._fmVer = FM_VER;
      }
      cfg.fieldMap = fm; cfg._fields = list;
      saveCfg(cfg); return cfg;
    });
  }

  function fetchAll(jql, onProgress, opts) {
    opts = opts || {};
    return ensureFieldMap(loadCfg()).then(function (cfg) { return fetchWith(cfg, jql, onProgress, opts); });
  }
  function fetchWith(cfg, jql, onProgress, opts) {
    var host = cfg.jiraHost || "svmhelpdesk.atlassian.net", fm = cfg.fieldMap || {};
    var fields = ["summary","status","priority","project","components","created","resolutiondate","updated","issuetype","resolution","issuelinks","assignee","reporter","labels","description","environment","fixVersions","parent","comment"];
    ["svmInCharge","currentWorker","nextAction","timeToFirstResponse","timeToResolution","rootCause","typeOfFix","screenName","menuHead","releaseNumber","releaseDataFix","parentRelease","tshirtSizing","severity","assignedDate","deliveredDate","clientReference","analysis","solutionSummary","chargeable","fpaManDays","approvedManDays","fpaPreparedBy","fpaApprovedBy","impactModule","manpowerType","reasonText","reasonOccurrence","resolutionDetails"]
      .forEach(function (k) { String(fm[k] || "").split(",").forEach(function (id) { id = id.trim(); if (id && fields.indexOf(id) < 0) fields.push(id); }); });

    var loadCache = (window.HDStore && window.HDStore.loadFetchCache) ? window.HDStore.loadFetchCache() : Promise.resolve(null);
    var prevTextVer = 1;
    return loadCache.then(function (cache) {
      var fetchStart = Date.now();
      prevTextVer = (cache && cache.textVer) || 1;
      /* the cached rows only hold the fields that were fetched then — if the field set changed (a field was added or
         re-mapped), unchanged tickets would never get the new columns, so do one full fetch instead of a delta */
      var fieldSig = fields.join(",");
      var cachedSig = String((cache && cache.fieldSig) || "").replace(/\|text-v\d+$/, "");   // accept caches saved by the short-lived "|text-v2" build
      var canDelta = !opts.full && cache && cache.rows && cache.rows.length && cache.jql === jql && cache.host === host && cache.lastFetch && cachedSig === fieldSig;
      if (canDelta) {
        /* relative minutes are evaluated against Jira's own clock, so this is safe
           regardless of the browser's timezone; +5 min guards against clock skew. */
        var mins = Math.ceil((fetchStart - cache.lastFetch) / 60000) + 5;
        var deltaJql = "(" + jql + ") AND updated >= \"-" + mins + "m\"";
        return search(host, deltaJql, fields, onProgress).then(function (issues) {
          var deltaRows = transform(issues, fm), map = {};
          cache.rows.forEach(function (r) { if (r["Key"]) map[r["Key"]] = r; });
          deltaRows.forEach(function (r) { if (r["Key"]) map[r["Key"]] = r; });
          var rows = Object.keys(map).map(function (k) { return map[k]; });
          return finalize(rows, fetchStart, deltaRows.length, "incremental");
        });
      }
      return search(host, jql, fields, onProgress).then(function (issues) {
        var rows = transform(issues, fm);
        return finalize(rows, fetchStart, rows.length, "full");
      });
    });

    function finalize(rows, fetchStart, changed, mode) {
      var blob = toBlob(rows);
      var name = "Jira Live \u00B7 " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + ".xlsx";
      var saveCache = (window.HDStore && window.HDStore.saveFetchCache)
        ? window.HDStore.saveFetchCache({ rows: rows, jql: jql, host: host, lastFetch: fetchStart, fieldSig: fields.join(","), textVer: mode === "full" ? TEXT_VER : prevTextVer })
        : Promise.resolve();
      return saveCache
        .then(function () { return window.HDStore.saveFile(blob, name); })
        .then(function () { return window.HDStore.clearRows(); })
        .then(function () {
          var r = summarize(rows);
          return { count: rows.length, changed: changed, mode: mode, cMin: r.cMin, cMax: r.cMax, rMin: r.rMin, rMax: r.rMax, fileName: name };
        });
    }
  }

  window.HDJira = {
    loadConfig: loadCfg, saveConfig: saveCfg,
    isBridgeAvailable: function () { return _bridgeReady; },
    isConfigured: function () { return _bridgeReady; },
    testConnection: testConnection, discoverFields: discoverFields, autoDetect: autoDetect, autoDetectAll: autoDetectAll, fetchAll: fetchAll
  };
})();
