/* HD Dashboards — Jira Live Fetch (v3 API, extension-only, CSP-safe) */
(function () {
  var CFG_KEY = "hd-jira-cfg", PAGE_SIZE = 1000;

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
      solutionSummary: [/solution\s*summary/i, /^\s*solution\s*$/i]
    };
    Object.keys(patterns).forEach(function (key) {
      for (var i = 0; i < customFields.length; i++) {
        for (var j = 0; j < patterns[key].length; j++) {
          if (patterns[key][j].test(customFields[i].name || "")) { map[key] = customFields[i].id; return; }
        }
      }
    });
    return map;
  }

  /* ══════ Paginated search (v3 GET with cursor pagination) ══════ */
  function search(host, jql, fields, onProgress) {
    var all = [], total = 0;

    /* First: one lightweight call to get the real total count */
    var countPath = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql) + "&maxResults=1&fields=key";
    return bridgeCall(host, countPath, "GET").then(function (countData) {
      total = countData.total || 0;
      if (onProgress) onProgress(0, total);
      return nextPage(null);
    });

    function nextPage(token) {
      var path = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql)
        + "&maxResults=" + PAGE_SIZE
        + "&fields=" + fields.join(",")
        + (token ? "&nextPageToken=" + encodeURIComponent(token) : "");
      return bridgeCall(host, path, "GET").then(function (data) {
        all = all.concat(data.issues || []);
        if (onProgress) onProgress(all.length, total || data.total || all.length);
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
      row["SVM In Charge"] = person(f[fm.svmInCharge]);
      row["Current Worker"] = person(f[fm.currentWorker]);
      row["Next Action"] = choice(f[fm.nextAction]);
      row["Time to first response"] = sla(f[fm.timeToFirstResponse]);
      row["Time to resolution"] = sla(f[fm.timeToResolution]);
      row["Root Cause"] = choice(f[fm.rootCause]);
      row["Type of Fix"] = choice(f[fm.typeOfFix]);
      row["Screen Name"] = choice(f[fm.screenName]);
      row["Menu Head"] = choice(f[fm.menuHead]);
      row["Release Number"] = txt(f[fm.releaseNumber]);
      row["Release Number (Data Fix)"] = txt(f[fm.releaseDataFix]);
      row["Parent Release No"] = txt(f[fm.parentRelease]);
      row["Assignee"] = person(f.assignee);
      row["Reporter"] = person(f.reporter);
      row["T-Shirt Sizing"] = choice(f[fm.tshirtSizing]);
      row["Severity"] = choice(f[fm.severity]);
      row["Assigned Date"] = txt(f[fm.assignedDate]);
      row["Delivered Date"] = txt(f[fm.deliveredDate]);
      row["Client Reference"] = txt(f[fm.clientReference]);
      row["Analysis"] = rich(f[fm.analysis]);
      row["Solution Summary"] = rich(f[fm.solutionSummary]);
      row["Labels"] = (f.labels || []).join("; ");
      row["Description"] = rich(f.description);
      row["Environment"] = txt(f.environment);
      row["Fix Versions"] = (f.fixVersions || []).map(function (v) { return v.name || ""; }).join("; ");
      row["Parent Key"] = f.parent ? (f.parent.key || "") : "";
      row["Parent Summary"] = f.parent && f.parent.fields ? (f.parent.fields.summary || "") : "";
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
  function person(v) { if (!v) return ""; if (typeof v === "string") return v; if (Array.isArray(v)) return v.map(function (x) { return x.displayName || x.name || ""; }).join(", "); return v.displayName || v.name || v.value || ""; }
  function choice(v) { if (!v) return ""; if (typeof v === "string") return v; return v.value || v.name || ""; }
  function txt(v) { if (v == null) return ""; if (typeof v === "object") return v.value || v.name || v.displayName || (Array.isArray(v) ? v.map(function (x) { return x.value || x.name || x; }).join(", ") : ""); return String(v); }
  function rich(v) { if (v == null) return ""; if (typeof v === "string") return v;
    if (typeof v === "object") { if (Array.isArray(v.content)) { var out = ""; (function walk(n) { if (!n) return; if (n.text) out += n.text; if (Array.isArray(n.content)) n.content.forEach(walk); if (n.type === "paragraph") out += "\n"; })(v); return out.trim(); } return v.value || v.name || ""; }
    return String(v); }
  function sla(s) { if (!s) return ""; if (typeof s === "string") return s;
    if (s.completedCycles && s.completedCycles.length) { var l = s.completedCycles[s.completedCycles.length - 1]; if (l.elapsedTime) return (l.breached ? "-" : "") + (l.elapsedTime.friendly || ""); }
    if (s.ongoingCycle) { var o = s.ongoingCycle; if (o.breached && o.elapsedTime) return "-" + (o.elapsedTime.friendly || ""); if (o.remainingTime) return o.remainingTime.friendly || ""; }
    return ""; }

  function toBlob(rows) {
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
  function fetchAll(jql, onProgress, opts) {
    opts = opts || {};
    var cfg = loadCfg(), host = cfg.jiraHost || "svmhelpdesk.atlassian.net", fm = cfg.fieldMap || {};
    var fields = ["summary","status","priority","project","components","created","resolutiondate","updated","issuetype","resolution","issuelinks","assignee","reporter","labels","description","environment","fixVersions","parent"];
    ["svmInCharge","currentWorker","nextAction","timeToFirstResponse","timeToResolution","rootCause","typeOfFix","screenName","menuHead","releaseNumber","releaseDataFix","parentRelease","tshirtSizing","severity","assignedDate","deliveredDate","clientReference","analysis","solutionSummary"]
      .forEach(function (k) { if (fm[k]) fields.push(fm[k]); });

    var loadCache = (window.HDStore && window.HDStore.loadFetchCache) ? window.HDStore.loadFetchCache() : Promise.resolve(null);
    return loadCache.then(function (cache) {
      var fetchStart = Date.now();
      var canDelta = !opts.full && cache && cache.rows && cache.rows.length && cache.jql === jql && cache.host === host && cache.lastFetch;
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
        ? window.HDStore.saveFetchCache({ rows: rows, jql: jql, host: host, lastFetch: fetchStart })
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
    testConnection: testConnection, discoverFields: discoverFields, autoDetect: autoDetect, fetchAll: fetchAll
  };
})();
