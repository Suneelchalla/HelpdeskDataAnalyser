/* HD Dashboards — Jira Live Fetch (v3 API, extension-only, CSP-safe) */
(function () {
  var CFG_KEY = "hd-jira-cfg", PAGE_SIZE = 100;

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
      timeToResolution: [/time\s*to\s*resolution/i]
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
    var all = [];
    function page(token) {
      var path = "/rest/api/3/search/jql?jql=" + encodeURIComponent(jql)
        + "&maxResults=" + PAGE_SIZE
        + "&fields=" + fields.join(",")
        + (token ? "&nextPageToken=" + encodeURIComponent(token) : "");
      return bridgeCall(host, path, "GET").then(function (data) {
        all = all.concat(data.issues || []);
        var total = data.total || all.length;
        if (onProgress) onProgress(all.length, total);
        if (data.nextPageToken) return page(data.nextPageToken);
        return all;
      });
    }
    return page(null);
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
      row["Created"] = f.created ? new Date(f.created) : "";
      row["Resolved"] = f.resolutiondate ? new Date(f.resolutiondate) : "";
      row["Updated"] = f.updated ? new Date(f.updated) : "";
      row["Resolution"] = f.resolution ? f.resolution.name : "";
      row["SVM In Charge"] = person(f[fm.svmInCharge]);
      row["Current Worker"] = person(f[fm.currentWorker]);
      row["Next Action"] = choice(f[fm.nextAction]);
      row["Time to first response"] = sla(f[fm.timeToFirstResponse]);
      row["Time to resolution"] = sla(f[fm.timeToResolution]);
      if (f.issuelinks && f.issuelinks.length) {
        var lk = [], ls = [];
        f.issuelinks.forEach(function (l) {
          var o = l.outwardIssue || l.inwardIssue;
          if (o) { lk.push(o.key); if (o.fields && o.fields.status) ls.push(o.fields.status.name); }
        });
        row["Linked Issues"] = lk.join(", "); row["Linked Ticket status"] = ls.join(", ");
      } else { row["Linked Issues"] = ""; row["Linked Ticket status"] = ""; }
      return row;
    });
  }
  function person(v) { if (!v) return ""; if (typeof v === "string") return v; if (Array.isArray(v)) return v.map(function (x) { return x.displayName || x.name || ""; }).join(", "); return v.displayName || v.name || v.value || ""; }
  function choice(v) { if (!v) return ""; if (typeof v === "string") return v; return v.value || v.name || ""; }
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

  function fetchAll(jql, onProgress) {
    var cfg = loadCfg(), host = cfg.jiraHost || "svmhelpdesk.atlassian.net", fm = cfg.fieldMap || {};
    var fields = ["summary","status","priority","project","components","created","resolutiondate","updated","issuetype","resolution","issuelinks"];
    ["svmInCharge","currentWorker","nextAction","timeToFirstResponse","timeToResolution"]
      .forEach(function (k) { if (fm[k]) fields.push(fm[k]); });
    return search(host, jql, fields, onProgress).then(function (issues) {
      var rows = transform(issues, fm), blob = toBlob(rows);
      var name = "Jira Live \u00B7 " + new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) + ".xlsx";
      return window.HDStore.saveFile(blob, name)
        .then(function () { return window.HDStore.clearRows(); })
        .then(function () {
          var cMin = null, cMax = null, rMin = null, rMax = null;
          rows.forEach(function (r) {
            var c = r["Created"], v = r["Resolved"];
            if (c instanceof Date && !isNaN(c)) { if (!cMin || c < cMin) cMin = c; if (!cMax || c > cMax) cMax = c; }
            if (v instanceof Date && !isNaN(v)) { if (!rMin || v < rMin) rMin = v; if (!rMax || v > rMax) rMax = v; }
          });
          return { count: rows.length, cMin: cMin, cMax: cMax, rMin: rMin, rMax: rMax, fileName: name };
        });
    });
  }

  window.HDJira = {
    loadConfig: loadCfg, saveConfig: saveCfg,
    isBridgeAvailable: function () { return _bridgeReady; },
    isConfigured: function () { return _bridgeReady; },
    testConnection: testConnection, discoverFields: discoverFields, autoDetect: autoDetect, fetchAll: fetchAll
  };
})();
