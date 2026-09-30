/* HD Dashboards — SLA status-history fetcher.
   Pulls STATUS transitions for a list of ticket keys through the HD Jira Bridge.
   The bridge call is injected (call(host, path, method, body) -> Promise<json>) so
   this file has no DOM dependency and can be tested against a mock Jira.

   Strategy — fast first, but never trust an empty answer:
     1. BATCH: one search per batch of tickets with expand=changelog. This uses the same
        /search/jql endpoint the launcher already uses, so it is known to work here.
     2. CHECK every ticket: a history is only believed if it agrees with the ticket's
        current status (last transition lands on it; or, with no transitions, the ticket
        is still in its first status). Jira caps expand=changelog at 40 entries, so a
        long history is also treated as unproven.
     3. VERIFY anything unproven with the per-ticket changelog endpoint, which is
        complete and paged. If that also finds nothing, the ticket is kept but flagged
        `suspect` so the UI can say the history is unverified rather than show a
        confident-looking wrong number.
   If the search ignores expand=changelog entirely, the whole run switches to
   per-ticket automatically.
   The first call of a run is always sequential so the extension can open its Jira
   tab once before any parallel work starts. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HDSlaHistory = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CAP = 40;                       // Jira returns at most this many changelog entries with expand=changelog

  function parseTs(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isNaN(v) ? null : (v < 1e11 ? v * 1000 : v);   // epoch seconds or ms
    var s = String(v).trim();
    if (/^\d{10,13}$/.test(s)) return parseTs(+s);
    s = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    var t = new Date(s).getTime();
    return isNaN(t) ? null : t;
  }
  function q(s) { return encodeURIComponent(s); }
  function chunk(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function errText(e) { return String((e && e.message) || e || ""); }
  function isTransient(e) { return /timed out|EXTENSION_NOT_FOUND|Failed to fetch|network/i.test(errText(e)); }

  /* Status transitions out of a list of Jira changelog histories. */
  function statusTransitions(histories) {
    var out = [];
    (histories || []).forEach(function (h) {
      var t = parseTs(h.created);
      if (t == null) return;
      (h.items || []).forEach(function (it) {
        if (it.fieldId === "status" || String(it.field || "").toLowerCase() === "status")
          out.push({ t: t, from: it.fromString || "", to: it.toString || "", _n: Number(h.id) || 0 });
      });
    });
    out.sort(function (a, b) { return a.t - b.t || a._n - b._n; });
    out.forEach(function (x) { delete x._n; });
    return out;
  }
  /* Does this history disagree with where the ticket is now? */
  function looksWrong(tr, status, initial) {
    if (!status) return false;
    if (tr.length) return tr[tr.length - 1].to !== status;
    return (initial || ["Open"]).indexOf(status) < 0;
  }

  /* One search for a set of keys. withChangelog=true adds expand=changelog.
     Resolves { KEY: {id, status, histories|null, total|null} }. */
  function searchKeys(call, host, keys, withChangelog) {
    var map = {}, jql = "key in (" + keys.map(function (k) { return '"' + k + '"'; }).join(",") + ")";
    function page(token) {
      var path = "/rest/api/3/search/jql?jql=" + q(jql) + "&maxResults=" + Math.max(keys.length, 1) + "&fields=status" + (withChangelog ? "&expand=changelog" : "") + (token ? "&nextPageToken=" + q(token) : "");
      return call(host, path, "GET").then(function (d) {
        (d.issues || []).forEach(function (i) {
          var cl = i.changelog;
          map[i.key] = { id: String(i.id), status: i.fields && i.fields.status ? i.fields.status.name : "",
            histories: cl ? (cl.histories || []) : null, total: cl && cl.total != null ? cl.total : null };
        });
        return d.nextPageToken ? page(d.nextPageToken) : map;
      });
    }
    return page(null);
  }

  /* One ticket via the classic per-issue changelog endpoint (complete, paged). */
  function perIssue(call, host, key) {
    var all = [];
    function page(startAt) {
      return call(host, "/rest/api/3/issue/" + q(key) + "/changelog?startAt=" + startAt + "&maxResults=100", "GET").then(function (d) {
        var vals = d.values || d.histories || [];
        all = all.concat(vals);
        var total = d.total != null ? d.total : null;
        if (vals.length && (d.isLast === false || (total != null && startAt + vals.length < total))) return page(startAt + vals.length);
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
     opts: { call, host, batch=50, concurrency=4, mode="auto"|"per-issue", initialStatuses=["Open"],
             onProgress(done,total,mode), shouldCancel(), onBatch(batchResults) }
     resolves: { results:{KEY:{transitions,src,status,suspect,verified}}, failed:[{key,reason}], mode, cancelled, verifiedCount, suspectCount } */
  function fetchHistory(keys, opts) {
    var call = opts.call, host = opts.host, batchSize = opts.batch || 50, conc = opts.concurrency || 4;
    var initial = opts.initialStatuses || ["Open"];
    var mode = opts.mode === "per-issue" ? "per-issue" : "batch";
    var results = {}, failed = [], done = 0, total = keys.length, cancelled = false, verified = 0, suspects = 0;
    function progress() { if (opts.onProgress) opts.onProgress(done, total, mode); }
    function cancel() { if (opts.shouldCancel && opts.shouldCancel()) { cancelled = true; return true; } return false; }

    function doBatch(batchKeys) {
      var batchRes = {};
      var step = mode === "batch"
        ? searchKeys(call, host, batchKeys, true).catch(function (e) {
            if (isTransient(e)) throw e;
            mode = "per-issue"; return searchKeys(call, host, batchKeys, false);       // expand refused → per-ticket for the rest of the run
          })
        : searchKeys(call, host, batchKeys, false);
      return step.then(function (idMap) {
        var found = batchKeys.filter(function (k) { return idMap[k]; });
        batchKeys.forEach(function (k) { if (!idMap[k]) failed.push({ key: k, reason: "not found in Jira (moved/deleted or no access)" }); });
        if (!found.length) return;
        if (mode === "batch" && found.every(function (k) { return idMap[k].histories === null; })) mode = "per-issue";   // expand silently ignored
        var toVerify = [];
        found.forEach(function (k) {
          var e = idMap[k];
          if (mode === "batch" && e.histories !== null) {
            var tr = statusTransitions(e.histories);
            var capped = (e.total != null && e.total > e.histories.length) || (e.total == null && e.histories.length >= CAP);
            batchRes[k] = { transitions: tr, src: "search", status: e.status, suspect: false, verified: false };
            if (capped || looksWrong(tr, e.status, initial)) toVerify.push(k);
          } else toVerify.push(k);
        });
        if (!toVerify.length) return;
        return runPool(toVerify, conc, function (k) {
          return perIssue(call, host, k).then(function (tr) {
            var st = idMap[k].status, wrong = looksWrong(tr, st, initial);
            batchRes[k] = { transitions: tr, src: "issue", status: st, suspect: wrong, verified: true };
            verified++; if (wrong) suspects++;
          }, function (e) {
            if (batchRes[k]) { batchRes[k].suspect = true; suspects++; return; }         // keep the batch answer, flagged
            failed.push({ key: k, reason: errText(e) });
          });
        }, opts.shouldCancel);
      }).then(function () {
        Object.keys(batchRes).forEach(function (k) { results[k] = batchRes[k]; });
        done += batchKeys.length; progress();
        if (opts.onBatch) return opts.onBatch(batchRes);
      });
    }

    var batches = chunk(keys, batchSize);
    function loop(i) {
      if (i >= batches.length || cancel()) return Promise.resolve();
      return doBatch(batches[i]).catch(function () {
        return doBatch(batches[i]).catch(function (e2) {                                // one retry, then mark the batch failed and carry on
          batches[i].forEach(function (k) { if (!results[k]) failed.push({ key: k, reason: errText(e2) }); });
          done += batches[i].length; progress();
        });
      }).then(function () { return loop(i + 1); });
    }
    progress();
    return loop(0).then(function () {
      return { results: results, failed: failed, mode: mode, cancelled: cancelled, verifiedCount: verified, suspectCount: suspects };
    });
  }

  /* "Test history access": for a few tickets, compare what the fast path and the
     per-ticket path each find, in plain terms. */
  function probe(call, host, keys, opts) {
    var initial = (opts && opts.initialStatuses) || ["Open"], report = { steps: [], rows: [], mode: null };
    return searchKeys(call, host, keys, true).then(function (idMap) {
      var found = keys.filter(function (k) { return idMap[k]; });
      report.steps.push({ name: "Find tickets", ok: found.length > 0, detail: found.length + " of " + keys.length + " found" });
      if (!found.length) throw new Error("None of the sample tickets could be found in Jira.");
      var expandSeen = found.some(function (k) { return idMap[k].histories !== null; });
      report.steps.push({ name: "Search returns changelog", ok: expandSeen, detail: expandSeen ? "yes" : "no — Jira ignored expand=changelog" });
      return runPool(found, 3, function (k) {
        var e = idMap[k], fast = e.histories === null ? null : statusTransitions(e.histories);
        return perIssue(call, host, k).then(function (full) {
          report.rows.push({ key: k, status: e.status, fast: fast ? fast.length : null, full: full.length, agree: fast ? fast.length === full.length : false,
            first: full[0] ? full[0].from + " → " + full[0].to : "—", last: full.length ? full[full.length - 1].to : "—", consistent: !looksWrong(full, e.status, initial) });
        });
      });
    }).then(function () {
      var anyChanges = report.rows.some(function (r) { return r.full > 0; });
      var perOk = report.rows.length > 0 && report.rows.every(function (r) { return r.consistent; });
      var fastOk = report.rows.length > 0 && report.rows.every(function (r) { return r.fast != null && r.agree && r.consistent; });
      report.steps.push({ name: "Per-ticket history", ok: anyChanges && perOk, detail: anyChanges ? (perOk ? "found and consistent with each ticket’s current status" : "found, but does not match the current status of every ticket") : "no status changes found for any sample ticket" });
      report.mode = !anyChanges ? null : (fastOk ? "batch" : "per-issue");
      return report;
    }).catch(function (e) { report.steps.push({ name: "Error", ok: false, detail: errText(e) }); return report; });
  }

  return { fetchHistory: fetchHistory, probe: probe, statusTransitions: statusTransitions, searchKeys: searchKeys, perIssue: perIssue, looksWrong: looksWrong, parseTs: parseTs };
});
