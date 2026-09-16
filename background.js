/* HD Jira Bridge — background service worker
   Finds an open Jira tab (or opens one), runs fetch() inside that tab's
   page context via chrome.scripting.executeScript so session cookies are
   sent automatically. No API token needed. */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type !== "HD_JIRA_API") return false;
  var host = msg.host || "svmhelpdesk.atlassian.net";
  getJiraTab(host)
    .then(function (tabId) { return execFetch(tabId, msg.path); })
    .then(function (data)  { sendResponse({ ok: true, data: data }); })
    .catch(function (err)  { sendResponse({ ok: false, error: err.message }); });
  return true;
});

function getJiraTab(host) {
  return chrome.tabs.query({ url: "https://" + host + "/*" }).then(function (tabs) {
    if (tabs.length) return tabs[0].id;
    return chrome.tabs.create({ url: "https://" + host + "/jira/your-work", active: false })
      .then(function (tab) { return waitForTab(tab.id).then(function () { return tab.id; }); });
  });
}

function waitForTab(tabId) {
  return new Promise(function (resolve, reject) {
    var timeout = setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(fn);
      reject(new Error("Jira tab timed out — are you logged in?"));
    }, 25000);
    function fn(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

function execFetch(tabId, url) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function (u) {
      return fetch(u, { headers: { "Accept": "application/json" } })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) {
            return { __err: "Jira " + r.status + (r.status === 401 ? " — open Jira in a tab and log in first." : ": " + t.slice(0, 300)) };
          });
          return r.json();
        })
        .catch(function (e) { return { __err: e.message }; });
    },
    args: [url]
  }).then(function (results) {
    var d = results && results[0] && results[0].result;
    if (!d) throw new Error("No response — try refreshing the Jira page.");
    if (d.__err) throw new Error(d.__err);
    return d;
  });
}
