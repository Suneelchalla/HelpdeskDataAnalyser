/* HD Jira Bridge — content script (injected into dashboard pages) */
(function () {
  if (!document.querySelector('meta[name="hd-dashboard"]')) return;

  /* Tell the page the bridge is available (inject into PAGE world) */
  var s = document.createElement("script");
  s.textContent = 'window.__hdBridge=true;window.dispatchEvent(new Event("hd-bridge-ready"));';
  (document.head || document.documentElement).appendChild(s);
  s.remove();

  /* Relay: page → extension background → page */
  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.type !== "HD_BRIDGE_CALL") return;
    var id = e.data.id;
    chrome.runtime.sendMessage(
      { type: "HD_JIRA_API", host: e.data.host, path: e.data.path },
      function (resp) {
        window.postMessage({
          type: "HD_BRIDGE_RESULT", id: id,
          ok: resp ? resp.ok : false, data: resp ? resp.data : null,
          error: resp ? resp.error : "Extension not responding."
        }, "*");
      }
    );
  });
})();
