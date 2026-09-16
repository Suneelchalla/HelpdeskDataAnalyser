/* hd-store.js
   Shared storage for the HD dashboards.
   The launcher (index.html) saves the uploaded Excel here once; each dashboard
   (followup.html, trend.html) reads it back — including when opened in a new
   browser tab, which starts with empty memory. Uses IndexedDB because a large
   Jira export can exceed localStorage's ~5MB limit. The raw file (Blob) is
   stored as-is, so each dashboard parses it with its own existing XLSX code. */
(function () {
  var DB = "hd-tracker", STORE = "files", KEY = "current", ROWS_KEY = "edited-rows", SNAP_KEY = "weekly-snapshots", CFG_KEY = "master-config";

  function open() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  window.HDStore = {
    // Save the uploaded file. `file` is a File/Blob; `name` is its display name.
    saveFile: function (file, name) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).put({ blob: file, name: name, savedAt: Date.now() }, KEY);
          t.oncomplete = function () { res(true); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },
    // Returns { blob, name, savedAt } or null if nothing has been uploaded yet.
    loadFile: function () {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var g = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
          g.onsuccess = function () { res(g.result || null); };
          g.onerror = function () { rej(g.error); };
        });
      }).catch(function () { return null; });
    },
    // Forget the current file (used by "Change file").
    clearFile: function () {
      return open().then(function (db) {
        return new Promise(function (res) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).delete(KEY);
          t.oncomplete = function () { res(true); };
        });
      }).catch(function () { return false; });
    },

    /* ── Edited rows ──
       The dashboards let you correct the parsed data in-app (an "Edit Data"
       tab) and recalculate without re-uploading the Excel. The corrected rows
       are stored here as an array of plain objects using the ORIGINAL Excel
       column names — the same shape XLSX.sheet_to_json produces — so both
       followup.html and trend.html can consume them directly. IndexedDB uses
       structured clone, so Date cells survive as real Dates. Whichever
       dashboard you edit in, the other picks the changes up when it next opens.
       Uploading a new file (or "Change file") clears these edits. */
    saveRows: function (rows) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).put({ rows: rows, savedAt: Date.now() }, ROWS_KEY);
          t.oncomplete = function () { res(true); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },
    // Returns the edited rows array, or null if no edits have been saved yet.
    loadRows: function () {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var g = db.transaction(STORE, "readonly").objectStore(STORE).get(ROWS_KEY);
          g.onsuccess = function () { res(g.result ? g.result.rows : null); };
          g.onerror = function () { rej(g.error); };
        });
      }).catch(function () { return null; });
    },
    // Discard edits (used by "Revert to original upload" and on new upload).
    clearRows: function () {
      return open().then(function (db) {
        return new Promise(function (res) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).delete(ROWS_KEY);
          t.oncomplete = function () { res(true); };
        });
      }).catch(function () { return false; });
    },

    /* ── Weekly snapshots (for the Weekly Report) ──
       A single Jira export only knows today's open state, so the Weekly Report
       accumulates a small per-week summary each time a fresh export is opened.
       Stored as ONE object { "2026-34": {...week summary...}, ... } keyed by
       ISO week. Deliberately NOT cleared by "Change file" / new upload — the
       whole point is that history survives across weekly uploads. Reset only
       happens through the Weekly Report's own controls. */
    saveSnapshots: function (obj) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).put({ snaps: obj, savedAt: Date.now() }, SNAP_KEY);
          t.oncomplete = function () { res(true); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },
    // Returns the snapshots object (possibly {}), never null.
    loadSnapshots: function () {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var g = db.transaction(STORE, "readonly").objectStore(STORE).get(SNAP_KEY);
          g.onsuccess = function () { res(g.result ? g.result.snaps || {} : {}); };
          g.onerror = function () { rej(g.error); };
        });
      }).catch(function () { return {}; });
    },
    // Wipe all captured weekly history (explicit user action only).
    clearSnapshots: function () {
      return open().then(function (db) {
        return new Promise(function (res) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).delete(SNAP_KEY);
          t.oncomplete = function () { res(true); };
        });
      }).catch(function () { return false; });
    },

    /* ── Master Data config (Status / Group / Stage overrides) ──
       Written by the Master Data module on the launcher; read by every dashboard
       on load, which feeds it into HDClass/HDGroups/HDStages before rendering.
       Shape: { statusOverrides:{}, groupOverrides:{}, stageOverrides:{}, savedAt }.
       Like weekly snapshots, this is intentionally NOT cleared by "Change file" /
       a new upload — corrections should persist across weekly exports. Reset only
       via the module's own "Reset to defaults". loadConfig never returns null. */
    saveConfig: function (cfg) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).put({ cfg: cfg, savedAt: Date.now() }, CFG_KEY);
          t.oncomplete = function () { res(true); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },
    loadConfig: function () {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var g = db.transaction(STORE, "readonly").objectStore(STORE).get(CFG_KEY);
          g.onsuccess = function () {
            var v = g.result && g.result.cfg ? g.result.cfg : {};
            res({ statusOverrides: v.statusOverrides || {}, groupOverrides: v.groupOverrides || {}, stageOverrides: v.stageOverrides || {} });
          };
          g.onerror = function () { rej(g.error); };
        });
      }).catch(function () { return { statusOverrides: {}, groupOverrides: {}, stageOverrides: {} }; });
    },
    clearConfig: function () {
      return open().then(function (db) {
        return new Promise(function (res) {
          var t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).delete(CFG_KEY);
          t.oncomplete = function () { res(true); };
        });
      }).catch(function () { return false; });
    }
  };
})();

/* ═══════════════════ HD Dashboards — shared status classification ═══════════════════
   ONE canonical Status→owner map for all three dashboards, so they can never
   drift apart. Two axes are derived from the same lists:

     • owner  (svm | client) — used by the Trend Tracker & Weekly Report.
                                "svm" = anything on our side (Help Desk OR
                                Engineering); "client" = waiting on the client.
     • classify3 (hd | engg | client) — used by the Follow-up Tracker, which
                                additionally splits the svm side into desk-level
                                (HD) vs escalated-to-Engineering (ENGG).

   Because CLIENT is the single source of truth for the svm/client boundary,
   the two-way and three-way views are guaranteed consistent. Unknown statuses:
   owner() returns null so the Trend/Weekly callers can fall back to the (less
   reliable) "Next Action" column; classify3() defaults to "hd", matching the
   Follow-up Tracker's original behaviour. Edit the lists here ONLY. */
(function () {
  var HD = ["Acknowledged","Assign HD (WFC)","Clarify","On-Hold","Open","Re-open Review","Analysis & Study","Sys/user configuration","Invoice Yet to Raise"];
  var ENGG = ["Technical Analysis","Development In Progress","Approval DB Admin","DB Admin Approval","DB Script Request","Impact Study","POC Release Approval","Project Lead Approval","Release Plan (Production)","Release Plan (UAT or Hot Fix)","Review","Script Release","SVM Hotfix Testing","Team Lead Review & Approval","Testing In Progress","Assign to SVM Deployment Team","Release In Progress","Release Kit Prep.","User Request"];
  var CLIENT = ["Waiting for customer","Resolved With Clarification","Resolved","Confirmation","Get Confirmation","Completed","DB Script Delivered","Delivered","Release Move to Production","Doubt Clarification","Clarification (Dev)","Published","CLIENT Approval (DB Script)","CLIENT RELEASE APPROVAL","Client Release Approval (PROD)","Client Hotfix Testing","Client Deployment (PROD)","Client Rejected (DB Script)"];

  /* User overrides from the Master Data module: { "<Status>": "hd"|"engg"|"client" }.
     A dashboard calls setOverrides(cfg.statusOverrides) once on load (after reading
     config from IndexedDB) BEFORE it renders, so every KPI/chart reflects the
     corrected mapping. Empty overrides ⇒ identical behaviour to the built-in lists. */
  var OV = {};
  /* Terminal statuses need no SVM/Client classification — the ticket is done, and
     the dashboards exclude them from open-work anyway. They're recognised here so
     the Master Data module doesn't flag them as "needs review" (no action needed). */
  var TERMINAL = ["Closed"];
  function has(arr, s) { return arr.indexOf(s) > -1; }
  // Built-in bucket for a status, or null if it's in none of the lists (i.e. brand-new/unknown).
  function def3(s) { return has(CLIENT, s) ? "client" : has(ENGG, s) ? "engg" : has(HD, s) ? "hd" : null; }

  window.HDClass = {
    HD: HD, ENGG: ENGG, CLIENT: CLIENT, TERMINAL: TERMINAL,
    setOverrides: function (m) { OV = m || {}; },
    getOverrides: function () { return OV; },
    // Built-in (pre-override) bucket; unknown statuses default to "hd" (SVM side).
    defaultClassify3: function (status) { return def3(status) || "hd"; },
    // Is this status present in any built-in list? (false ⇒ "needs review" in the UI)
    isKnown: function (status) { return def3(status) !== null; },
    // A finished status that needs no owner classification (no action in the module).
    isTerminal: function (status) { return has(TERMINAL, status); },
    isOverridden: function (status) { return Object.prototype.hasOwnProperty.call(OV, status); },
    // Follow-up Tracker: three-way desk view (override wins, then built-in, then "hd").
    classify3: function (status) { return OV[status] || def3(status) || "hd"; },
    // Trend / Weekly: two-way owner view. Unknown & un-overridden → null so callers
    // can fall back to the (less reliable) "Next Action" column.
    owner: function (status) { var c = OV[status] || def3(status); return c ? (c === "client" ? "client" : "svm") : null; }
  };
})();

/* ═══════════════════ HD Dashboards — shared GROUP directory (person → group) ═══════════════════
   Was hard-coded in trend.html as GROUP_MAP; centralised here so the Master Data
   module can edit it and every dashboard shares one directory. Keyed on the
   NORMALISED person name so it matches whether the name arrives via "SVM In
   Charge" or "Current Worker" (the two fields the module scans). Overrides:
   { "<normalised name>": "<Group>" }. */
(function () {
  var MAP = {
    "muthuraj v":"Group 1","manikandan v":"Group 1","naveen n":"Group 1","vijay j":"Group 1","ramkumar m":"Group 1","lenin b premnath":"Group 1",
    "sentamil selvan":"Group 2","thennarasu s":"Group 2","jayasree b":"Group 2","balamurugan r":"Group 2","alaudeen m":"Group 2","vignesh r":"Group 2"
  };
  var MEMBERS = {
    "Group 1":"Exports (Muthuraj) · Imports (Manikandan) · Operations (Naveen N) · Ecom (Vijay) · PNC (Ramkumar/Lenin)",
    "Group 2":"CMR (Sentamil) · NFR (Thennarasu) · Cost (Jayasree) · EMS (Balamurugan) · VSS (Alaudeen) · EDI (Vignesh)",
    "Others":"All remaining people (and unassigned)"
  };
  var ORDER = ["Group 1","Group 2","Others"];
  var OV = {};
  function norm(s) { return String(s || "").toLowerCase().replace(/[.]/g, " ").replace(/\s+/g, " ").trim(); }

  window.HDGroups = {
    ORDER: ORDER, MEMBERS: MEMBERS, normName: norm, defaults: MAP,
    setOverrides: function (m) { OV = m || {}; },
    getOverrides: function () { return OV; },
    defaultGroupOf: function (name) { if (!name) return "Others"; return MAP[norm(name)] || "Others"; },
    isOverridden: function (name) { return Object.prototype.hasOwnProperty.call(OV, norm(name)); },
    // Override wins, then built-in, then "Others".
    groupOf: function (name) { if (!name) return "Others"; var n = norm(name); return OV[n] || MAP[n] || "Others"; }
  };
})();

/* ═══════════════════ HD Dashboards — shared STAGE map (status → activity stage) ═══════════════════
   Was hard-coded in weekly.html as STAGE_MAP; centralised so the Master Data
   module can edit it. Overrides: { "<Status>": "<Stage>" }. Unknown → "Other". */
(function () {
  var MAP = {
    "Analysis & Study":"Stage 1 - Analysis & Study",
    "Testing In Progress":"Stage 2 - Fix in Progress","Technical Analysis":"Stage 2 - Fix in Progress","Team Lead Review & Approval":"Stage 2 - Fix in Progress","SVM Hotfix Testing":"Stage 2 - Fix in Progress","Release Plan (UAT or Hot Fix)":"Stage 2 - Fix in Progress","Release Kit Prep.":"Stage 2 - Fix in Progress","Impact Study":"Stage 2 - Fix in Progress","Doubt Clarification":"Stage 2 - Fix in Progress","Development In Progress":"Stage 2 - Fix in Progress","DB Script Request":"Stage 2 - Fix in Progress","Clarification (Dev)":"Stage 2 - Fix in Progress",
    "POC Release Approval":"Stage 3 - Under Delivery","DB Script Delivered":"Stage 3 - Under Delivery","DB Admin Approval":"Stage 3 - Under Delivery","Client Release Approval (PROD)":"Stage 3 - Under Delivery","Client Hotfix Testing":"Stage 3 - Under Delivery","Client Deployment (PROD)":"Stage 3 - Under Delivery","CLIENT RELEASE APPROVAL":"Stage 3 - Under Delivery","CLIENT Approval (DB Script)":"Stage 3 - Under Delivery",
    "Waiting for customer":"Stage 4 - Awaiting Confirmation","Resolved With Clarification":"Stage 4 - Awaiting Confirmation","Resolved":"Stage 4 - Awaiting Confirmation","Release Move to Production":"Stage 4 - Awaiting Confirmation","Release In Progress":"Stage 4 - Awaiting Confirmation","Delivered":"Stage 4 - Awaiting Confirmation",
    "Script Release":"Script Release",
    "Closed":"Stage 5 - Ticket Closure","Confirmation":"Stage 4 - Awaiting Confirmation","Completed":"Stage 5 - Ticket Closure","Invoice Yet to Raise":"Stage 5 - Ticket Closure","User Request":"Stage 1 - Analysis & Study","Sys/user configuration":"Stage 2 - Fix in Progress","Approval DB Admin":"Stage 3 - Under Delivery","Assign to SVM Deployment Team":"Stage 3 - Under Delivery","Published":"Stage 3 - Under Delivery"
  };
  var ORDER = ["Stage 1 - Analysis & Study","Stage 2 - Fix in Progress","Stage 3 - Under Delivery","Stage 4 - Awaiting Confirmation","Script Release","Other"];
  var ALL = ORDER.concat(["Stage 5 - Ticket Closure"]);
  var OV = {};

  window.HDStages = {
    ORDER: ORDER, ALL: ALL, defaults: MAP,
    setOverrides: function (m) { OV = m || {}; },
    getOverrides: function () { return OV; },
    defaultStageOf: function (status) { return MAP[status] || "Other"; },
    isOverridden: function (status) { return Object.prototype.hasOwnProperty.call(OV, status); },
    stageOf: function (status) { return OV[status] || MAP[status] || "Other"; },
    // Every stage name that can appear in a dropdown (built-in stages, minus the "Other" catch-all).
    allStages: function () { return ORDER.filter(function (s) { return s !== "Other"; }).concat(["Stage 5 - Ticket Closure"]); }
  };
})();

/* ══════════════════════ HD Dashboards — soft app lock ══════════════════════
   A light deterrent for the public GitHub Pages build. This is NOT real
   security: the source is open, so anyone who reads it can find or bypass the
   password — and that's an accepted trade-off. Config is stored per-browser in
   localStorage. Everything is wrapped so a failure never blocks the app
   (fail-open). Loaded on every page via hd-store.js.
   - Hidden hotspot: bottom-left corner → Admin panel.
   - Admin: set/change password, enable/disable, auto-lock interval (min).
   - When enabled, the app locks every N minutes (default 60). */
(function(){
  var KEY="hd-applock";
  function cfg(){ try{ return JSON.parse(localStorage.getItem(KEY))||{}; }catch(e){ return {}; } }
  function save(c){ try{ localStorage.setItem(KEY, JSON.stringify(c)); }catch(e){} }
  function hash(s){ var h=5381,i=s.length; while(i){ h=(h*33)^s.charCodeAt(--i); } return (h>>>0).toString(36); }
  function mins(){ var c=cfg(); return (c.mins&&c.mins>0)? c.mins : 60; }
  function isLocked(){ var c=cfg(); if(!c.enabled||!c.hash) return false; return (Date.now()-(c.unlockAt||0)) >= mins()*60000; }
  function markUnlocked(){ var c=cfg(); c.unlockAt=Date.now(); save(c); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(m){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]; }); }

  var STY=""
    +".hdlk-ov{position:fixed;inset:0;z-index:2147483000;background:linear-gradient(135deg,#0f172a,#1f2937);display:flex;align-items:center;justify-content:center;font-family:'Inter',system-ui,-apple-system,sans-serif}"
    +".hdlk-card{background:#fff;border-radius:16px;padding:26px 28px;width:min(380px,92vw);box-shadow:0 24px 70px rgba(0,0,0,.45);text-align:center;box-sizing:border-box}"
    +".hdlk-ico{font-size:34px}"
    +".hdlk-card h3{font-size:18px;margin:8px 0 4px;color:#111827;font-weight:800}"
    +".hdlk-card p{font-size:12px;color:#6b7280;margin:0 0 14px;line-height:1.5}"
    +".hdlk-card input[type=password],.hdlk-card input[type=number]{width:100%;padding:11px 13px;border:1px solid #d1d5db;border-radius:9px;font-size:14px;margin-bottom:10px;box-sizing:border-box;font-family:inherit}"
    +".hdlk-card button{width:100%;padding:11px;border:none;border-radius:9px;background:#0f766e;color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}"
    +".hdlk-card button:hover{filter:brightness(1.06)}"
    +".hdlk-err{color:#dc2626;font-size:12px;min-height:16px;margin-bottom:4px;font-weight:600}"
    +".hdlk-lab{display:flex;align-items:center;gap:9px;font-size:14px;color:#111827;font-weight:600;margin-bottom:12px;cursor:pointer;text-align:left}"
    +".hdlk-lab input{width:16px;height:16px;margin:0}"
    +".hdlk-fl{font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;text-align:left}"
    +".hdlk-btns{display:flex;gap:8px;margin-top:6px}.hdlk-btns button{width:auto;flex:1}"
    +".hdlk-note{font-size:10.5px;color:#9ca3af;margin-top:12px;line-height:1.5;text-align:left}"
    +".hdlk-hot{position:fixed;left:0;bottom:0;width:48px;height:48px;z-index:2147482000;cursor:pointer;background:transparent}"
    +".hdlk-hot span{position:absolute;left:9px;bottom:9px;font-size:15px;line-height:1;opacity:0;transition:opacity .18s;color:#94a3b8;pointer-events:none}"
    +".hdlk-hot:hover span{opacity:.55}";
  function ensureStyle(){ if(document.getElementById("hdlk-style"))return; var s=document.createElement("style"); s.id="hdlk-style"; s.textContent=STY; (document.head||document.documentElement).appendChild(s); }
  function host(){ return document.body||document.documentElement; }
  function removeOverlay(){ var o=document.getElementById("hdlk-ov"); if(o)o.remove(); }
  function overlay(html){ removeOverlay(); ensureStyle(); var d=document.createElement("div"); d.id="hdlk-ov"; d.className="hdlk-ov"; d.innerHTML=html; host().appendChild(d); return d; }

  /* password prompt — used to unlock the app AND to gate the admin panel */
  function promptPw(opts){
    var d=overlay('<div class="hdlk-card"><div class="hdlk-ico">🔒</div><h3>'+esc(opts.title)+'</h3><p>'+esc(opts.sub||"")+'</p>'
      +'<div class="hdlk-err" id="hdlk-e"></div>'
      +'<input type="password" id="hdlk-pw" placeholder="Password" autocomplete="off">'
      +'<button id="hdlk-go">'+esc(opts.btn||"Unlock")+'</button>'
      +(opts.allowClose?'<button id="hdlk-x" style="background:#6b7280;margin-top:8px">Cancel</button>':'')+'</div>');
    var pw=d.querySelector("#hdlk-pw"), err=d.querySelector("#hdlk-e");
    function go(){ var c=cfg(); if(!c.hash || hash(pw.value)===c.hash){ removeOverlay(); opts.onok&&opts.onok(); } else { err.textContent="Incorrect password"; pw.value=""; pw.focus(); } }
    d.querySelector("#hdlk-go").onclick=go;
    pw.addEventListener("keydown",function(e){ if(e.key==="Enter") go(); });
    var x=d.querySelector("#hdlk-x"); if(x)x.onclick=removeOverlay;
    setTimeout(function(){ try{pw.focus();}catch(e){} },50);
  }

  function showAdmin(){
    var c=cfg();
    var d=overlay('<div class="hdlk-card" style="text-align:left;width:min(430px,94vw)">'
      +'<h3 style="text-align:center">🔧 App Lock — Admin</h3>'
      +'<p style="text-align:center">Soft deterrent only — the source is public, so treat this as a light lock, not real security.</p>'
      +'<label class="hdlk-lab"><input type="checkbox" id="hdlk-en" '+(c.enabled?"checked":"")+'> Enable lock</label>'
      +'<div class="hdlk-fl">Password '+(c.hash?"(set — leave blank to keep)":"(not set yet)")+'</div>'
      +'<input type="password" id="hdlk-npw" placeholder="'+(c.hash?"New password (optional)":"Set a password")+'" autocomplete="new-password">'
      +'<div class="hdlk-fl">Auto-lock after (minutes)</div>'
      +'<input type="number" id="hdlk-min" min="1" value="'+(c.mins||60)+'">'
      +'<div class="hdlk-err" id="hdlk-e"></div>'
      +'<div class="hdlk-btns"><button id="hdlk-save">Save</button><button id="hdlk-now" style="background:#b45309">Lock now</button><button id="hdlk-x" style="background:#6b7280">Close</button></div>'
      +'<div class="hdlk-note">Status: <b>'+(c.enabled?"ON":"OFF")+'</b> · locks every '+(c.mins||60)+' min. Forgot the password? Clear this site\u2019s data in your browser to reset.</div>'
    +'</div>');
    function collect(){ var cc=cfg(); var np=d.querySelector("#hdlk-npw").value; var en=d.querySelector("#hdlk-en").checked; var mn=parseInt(d.querySelector("#hdlk-min").value)||60; if(np)cc.hash=hash(np); cc.mins=mn; cc.enabled=en; if(en&&!cc.hash){ d.querySelector("#hdlk-e").textContent="Set a password before enabling."; return null; } return cc; }
    d.querySelector("#hdlk-save").onclick=function(){ var cc=collect(); if(!cc)return; if(cc.enabled)cc.unlockAt=Date.now(); save(cc); removeOverlay(); };
    d.querySelector("#hdlk-now").onclick=function(){ var np=d.querySelector("#hdlk-npw").value; var cc=cfg(); if(np)cc.hash=hash(np); if(!cc.hash){ d.querySelector("#hdlk-e").textContent="Set a password first."; return; } cc.enabled=true; cc.mins=parseInt(d.querySelector("#hdlk-min").value)||60; cc.unlockAt=0; save(cc); removeOverlay(); guard(); };
    d.querySelector("#hdlk-x").onclick=removeOverlay;
  }

  function openAdmin(){ if(isLocked()){ guard(); return; } var c=cfg(); if(c.hash){ promptPw({title:"Admin access", sub:"Enter the app password to open settings", btn:"Continue", allowClose:true, onok:showAdmin}); } else { showAdmin(); } }
  function guard(){ if(isLocked()){ promptPw({title:"HD Dashboards is locked", sub:"Enter the password to continue", btn:"Unlock", allowClose:false, onok:markUnlocked}); } }
  function hotspot(){ if(document.getElementById("hdlk-hot"))return; ensureStyle(); var b=document.createElement("div"); b.id="hdlk-hot"; b.className="hdlk-hot"; b.title="App lock (Ctrl+Shift+L)"; b.innerHTML="<span>\uD83D\uDD12</span>"; b.addEventListener("click",openAdmin); host().appendChild(b); }

  function boot(){ try{ ensureStyle(); hotspot(); guard(); setInterval(guard,30000);
    document.addEventListener("keydown",function(e){ if((e.ctrlKey||e.metaKey)&&e.shiftKey&&(e.key==="L"||e.key==="l")){ e.preventDefault(); openAdmin(); } });
  }catch(e){} }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
  window.HDLock={ openAdmin:openAdmin, isLocked:isLocked };
})();
