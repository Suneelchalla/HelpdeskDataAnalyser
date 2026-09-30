/* HD Dashboards — SLA status-history fetcher.
   Pulls STATUS transitions for a list of ticket keys through the HD Jira Bridge.
   The bridge call is injected (call(host, path, method, body) -> Promise<json>) so
   this file has no dependency on the DOM and can be tested against a mock Jira.

   Strategy (fastest first, automatic fallback):
     1. Resolve keys -> issue ids with one cheap JQL search per batch.
     2. POST /rest/api/3/changelog/bulkfetch  (status field only, many issues per call).
     3. If that endpoint is unavailable on this Jira (404 / not found / not allowed),
        fall back to GET /rest/api/3/issue/{key}/changelog per ticket (slower, always works).
   The first call of a run is always sequential so the extension can open its Jira tab
   once before any parallel work starts. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HDSlaHistory = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function parseTs(v) {
    if (!v) return null;
    var s = String(v).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"), t = new Date(s).getTime();
    return isNaN(t) ? null : t;
  }
  function q(s) { return encodeURIComponent(s); }
  function chunk(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function errText(e) { return String((e && e.message) || e || ""); }
  function isUnavailable(e) { return /\b404\b|not found|not allowed|\b405\b|\b501\b/i.test(errText(e)); }

  /* Status transitions out of a list of Jira changelog "histories". */
  function statusTransitions(histories) {
    var out = [];
    (histories || []).forEach(function (h) {
      var t = parseTs(h.created);
      if (t == null) return;
      (h.items || []).forEach(function (it) {
        if (it.fieldId === "status" || String(it.field || "").toLowerCase() === "status")
          out.push({ t: t, from: it.fromString || "", to: it.toString || "" });
      });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  /* keys -> { KEY: {id, status} } using one JQL search (pages followed). */
  function resolveIds(call, host, keys) {
    var map = {}, jql = "key in (" + keys.map(function (k) { return '"' + k + '"'; }).join(",") + ")";
    function page(token) {
      var path = "/rest/api/3/search/jql?jql=" + q(jql) + "&maxResults=" + Math.max(keys.length, 1) + "&fields=status" + (token ? "&nextPageToken=" + q(token) : "");
      return call(host, path, "GET").then(function (d) {
        (d.issues || []).forEach(function (i) { map[i.key] = { id: String(i.id), status: i.fields && i.fields.status ? i.fields.status.name : "" }; });
        return d.nextPageToken ? page(d.nextPageToken) : map;
      });
    }
    return page(null);
  }

  /* ids -> { id: [transitions] } via the bulk endpoint (pages followed). */
  function bulk(call, host, ids) {
    var byId = {}; ids.forEach(function (id) { byId[id] = []; });
    function page(token) {
      var body = { issueIdsOrKeys: ids, fieldIds: ["status"], maxResults: 1000 };
      if (token) body.nextPageToken = token;
      return call(host, "/rest/api/3/changelog/bulkfetch", "POST", body).then(function (d) {
        if (!d || (!d.issueChangeLogs && d.errorMessages)) throw new Error("bulkfetch: " + JSON.stringify(d).slice(0, 200));
        (d.issueChangeLogs || []).forEach(function (ic) {
          var id = String(ic.issueId);
          if (!byId[id]) byId[id] = [];
          byId[id] = byId[id].concat(statusTransitions(ic.changeHistories));
        });
        return d.nextPageToken ? page(d.nextPageToken) : byId;
      });
    }
    return page(null).then(function (m) { Object.keys(m).forEach(function (k) { m[k].sort(function (a, b) { return a.t - b.t; }); }); return m; });
  }

  /* one ticket via the classic per-issue changelog endpoint. */
  function perIssue(call, host, key) {
    var all = [];
    function page(startAt) {
      return call(host, "/rest/api/3/issue/" + q(key) + "/changelog?startAt=" + startAt + "&maxResults=100", "GET").then(function (d) {
        var vals = d.values || d.histories || [];
        all = all.concat(vals);
        var total = d.total != null ? d.total : null;
        if (d.isLast === false || (total != null && startAt + vals.length < total)) {
          if (!vals.length) return all;
          return page(startAt + vals.length);
        }
        return all;
      });
    }
    return page(0).then(statusTransitions);
  }

  function runPool(items, n, worker, shouldCancel) {
    var i = 0, out = [];
    function next() {
      if (i >= items.length || (shouldCancel && shouldCancel())) return Promise.resolve();
      var idx = i++;
      return Promise.resolve(worker(items[idx], idx)).then(function (r) { out[idx] = r; return next(); });
    }
    var runners = []; for (var k = 0; k < Math.min(n, items.length); k++) runners.push(next());
    return Promise.all(runners).then(function () { return out; });
  }

  /* Main entry.
     opts: { call, host, batch=100, concurrency=4, mode="auto"|"per-issue", onProgress(done,total,mode), shouldCancel(), onBatch(results) }
     resolves: { results:{KEY:{transitions,src}}, failed:[{key,reason}], mode, cancelled } */
  function fetchHistory(keys, opts) {
    var call = opts.call, host = opts.host, batchSize = opts.batch || 100, conc = opts.concurrency || 4;
    var mode = opts.mode === "per-issue" ? "per-issue" : "bulk";
    var results = {}, failed = [], done = 0, total = keys.length, cancelled = false;
    function progress() { if (opts.onProgress) opts.onProgress(done, total, mode); }
    function cancel() { if (opts.shouldCancel && opts.shouldCancel()) { cancelled = true; return true; } return false; }

    function doBatch(batchKeys) {
      var batchRes = {};
      return resolveIds(call, host, batchKeys).then(function (idMap) {
        var found = batchKeys.filter(function (k) { return idMap[k]; });
        batchKeys.forEach(function (k) { if (!idMap[k]) failed.push({ key: k, reason: "not found in Jira (moved/deleted or no access)" }); });
        if (!found.length) return;
        var viaBulk = mode === "bulk"
          ? bulk(call, host, found.map(function (k) { return idMap[k].id; })).then(function (byId) {
              found.forEach(function (k) { batchRes[k] = { transitions: byId[idMap[k].id] || [], src: "bulk", status: idMap[k].status }; });
            }, function (e) {
              if (isUnavailable(e)) { mode = "per-issue"; return null; }   // switch for the rest of the run
              throw e;
            })
          : Promise.resolve(null);
        return viaBulk.then(function () {
          var todo = found.filter(function (k) { return !batchRes[k]; });
          if (!todo.length) return;
          return runPool(todo, conc, function (k) {
            return perIssue(call, host, k).then(function (tr) { batchRes[k] = { transitions: tr, src: "issue", status: idMap[k].status }; },
              function (e) { failed.push({ key: k, reason: errText(e) }); });
          }, opts.shouldCancel);
        });
      }).then(function () {
        Object.keys(batchRes).forEach(function (k) { results[k] = batchRes[k]; });
        done += batchKeys.length; progress();
        if (opts.onBatch) return opts.onBatch(batchRes);
      });
    }

    var batches = chunk(keys, batchSize);
    function loop(i) {
      if (i >= batches.length || cancel()) return Promise.resolve();
      return doBatch(batches[i]).catch(function (e) {
        // one retry for transient failures, then mark the whole batch failed and carry on
        return doBatch(batches[i]).catch(function (e2) {
          batches[i].forEach(function (k) { if (!results[k]) failed.push({ key: k, reason: errText(e2) }); });
          done += batches[i].length; progress();
        });
      }).then(function () { return loop(i + 1); });
    }
    progress();
    return loop(0).then(function () { return { results: results, failed: failed, mode: mode, cancelled: cancelled }; });
  }

  /* Small probe used by the "Test history access" button. */
  function probe(call, host, keys) {
    var report = { steps: [] };
    return resolveIds(call, host, keys).then(function (idMap) {
      report.steps.push({ name: "Resolve ticket ids", ok: true, detail: Object.keys(idMap).length + " of " + keys.length + " found" });
      var ids = keys.filter(function (k) { return idMap[k]; }).map(function (k) { return idMap[k].id; });
      if (!ids.length) throw new Error("None of the sample tickets could be found in Jira.");
      return bulk(call, host, ids).then(function (byId) {
        var n = 0; Object.keys(byId).forEach(function (k) { n += byId[k].length; });
        report.steps.push({ name: "Bulk changelog endpoint", ok: true, detail: n + " status transitions for " + ids.length + " tickets" });
        report.mode = "bulk"; return report;
      }, function (e) {
        report.steps.push({ name: "Bulk changelog endpoint", ok: false, detail: errText(e) });
        return perIssue(call, host, keys.filter(function (k) { return idMap[k]; })[0]).then(function (tr) {
          report.steps.push({ name: "Per-ticket changelog (fallback)", ok: true, detail: tr.length + " status transitions" });
          report.mode = "per-issue"; return report;
        });
      });
    }).catch(function (e) {
      report.steps.push({ name: "Error", ok: false, detail: errText(e) }); report.mode = null; return report;
    });
  }

  return { fetchHistory: fetchHistory, probe: probe, statusTransitions: statusTransitions, resolveIds: resolveIds, bulk: bulk, perIssue: perIssue };
});
