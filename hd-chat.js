/* ══════════ HD Dashboards — "Ask" engine (no AI) ══════════
   Turns a typed question into a plan (what to measure · which tickets · for whom · when · how to show it),
   runs the plan over the loaded tickets and returns an answer card description. Pure logic: no DOM, no storage.
   The same SLA numbers as the dashboards come in through opts.slaGet (HDSlaLink.get). */
(function (root) {
  "use strict";
  var DAY = 864e5, MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  var MONFULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  var MONNAME = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var STOP = {};
  ("a an the of for in on at to from by with and or is are was were be been it its this that these those me my our us we you your i do does did " +
    "have has had show list give display find get fetch see view pull tell what which who whom whose how many much any all every each there " +
    "tickets ticket issues issue incidents incident requests request please can could would should will also only just now then than too very " +
    "number count total average avg mean median top bottom most least highest lowest fewest more less over under above below about around " +
    "than as if so not no without per wise vs versus compare comparison between across against still yet already currently today want wants need needs wanna like where owned").split(" ").forEach(function (w) { STOP[w] = 1; });

  /* Damerau-Levenshtein with an early exit (typo tolerance) */
  function lev(a, b, max) {
    var la = a.length, lb = b.length; if (Math.abs(la - lb) > max) return max + 1;
    var prev2 = null, prev = [], cur, i, j, min;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur = [i]; min = i;
      for (j = 1; j <= lb; j++) {
        var c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1, v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v; if (v < min) min = v;
      }
      if (min > max) return max + 1; prev2 = prev; prev = cur;
    }
    return prev[lb];
  }
  /* words the question parser relies on — a misspelling close to one of these is corrected */
  var VOCAB = ("tickets ticket breached breach breaches breaching critical priority priorities medium high closed open client clients customer customers worker workers status statuses " +
    "month months week weeks year years today yesterday created compare comparison average median overview summary waiting awaiting engineering pending oldest newest latest urgent overdue " +
    "unassigned stale silent assigned weekly monthly versus incident incidents request requests service resolved delivered completed workload backlog trend trends breakdown severity " +
    "engineer engineers people between since before after during quarter total count number show list display find performance percentage percent fires danger invoice " +
    "january february march april june july august september october november december anything urgent important busiest busy overloaded handling working responsible escalated " +
    "average compliance incidents screens screen type types cause causes lowest highest least most fewest bottom between").split(/\s+/).filter(Boolean);
  var VOCABSET = {}; VOCAB.forEach(function (w) { VOCABSET[w] = 1; });
  /* words that appear in many client names but also in ordinary questions — never enough on their own to mean "that client" */
  var GENERICTOK = {}; ("service services desk help helpdesk support space request requests incident incidents change changes team teams group limited ltd private pvt company corp inc project projects " +
    "management systems system solutions technologies technology global international india data digital online shipping logistics marine maritime ocean lines line sea freight cargo trading").split(/\s+/).forEach(function (w) { GENERICTOK[w] = 1; });
  /* very short words are only fixed from this explicit list (guessing on 4 letters mangles ordinary words) */
  var TYPO4 = { mnth: "month", mont: "month", wek: "week", tody: "today", toda: "today", opne: "open", oepn: "open", hgih: "high", tpye: "type", shwo: "show", lsit: "list", cleint: "client", clint: "client" };
  /* ordinary words that sit one letter away from a keyword and must never be "corrected" */
  var PROTECT = {}; ("older newer close closer closing closes opened opens assignee assignees owner owners member members group groups stage stages person persons service services staff " +
    "recent report reports status stats where which there their other about after again being could would should while those these every first never order right since still under until whose " +
    "slowest slower worst worse laziest lagging behind stuck issue issues cases tasks items queue plate latest lately later early earlier weeks weekend monthly daily yearly quarterly " +
    "totals counts number numbers people person person's tickets' client's clients' priority priorities").split(/\s+/).forEach(function (w) { PROTECT[w] = 1; });
  /* normalise casual writing before parsing: contractions, possessives, Hinglish basics, filler words */
  function prepText(s) {
    s = String(s || "").replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"');
    s = s.replace(/\b(what|who|how)'?s\b/gi, "$1 is").replace(/\b(that|there|here|where|when)'s\b/gi, "$1 is");
    s = s.replace(/n't\b/gi, " not").replace(/'re\b/gi, " are").replace(/'ll\b/gi, " will").replace(/'ve\b/gi, " have").replace(/'d\b/gi, " would").replace(/'m\b/gi, " am");
    return s.replace(/([A-Za-z0-9])'s\b/g, "$1");
  }
  function loosen(lc) {
    var orig = lc;
    lc = lc.replace(/\b(wat|wats|whts|wht)\b/g, "what is").replace(/\bhw\b/g, "how").replace(/\br\b/g, "are").replace(/\bu\b/g, "you").replace(/\bur\b/g, "your").replace(/\babt\b/g, "about")
      .replace(/\bw\/o\b/g, "without").replace(/\bw\//g, "with ").replace(/\bb4\b/g, "before").replace(/\btmrw\b/g, "tomorrow").replace(/\bpndg\b/g, "pending")
      .replace(/\b([a-z]{3,})wise\b/g, "$1 wise")
      .replace(/\bkitn[eai]\b/g, "how many").replace(/\b(bata ?do|batao|bataiye|batana|dikha ?do|dikhao|dikhaiye|dikhana)\b/g, "show")
      .replace(/\b(pichh?l[ea])\s+(mahine|mahina|month)\b/g, "last month").replace(/\b(iss?)\s+(mahine|mahina)\b/g, "this month")
      .replace(/\b(pichh?l[ea])\s+(hafte|haft[ae]|week)\b/g, "last week").replace(/\b(iss?)\s+(hafte|haft[ae])\b/g, "this week")
      .replace(/\b(pichh?l[ea])\s+(saal|sal|year)\b/g, "last year").replace(/\b(iss?)\s+(saal|sal)\b/g, "this year")
      .replace(/\baaj\b/g, "today").replace(/\bkal\b/g, "yesterday").replace(/\b(sabhi|sab)\b/g, "all");
    var stripped = lc.replace(/\b(give|get|fetch|display|bring|send|pull|show) me\b/g, "show")
      .replace(/\b(please|pls|plz|kindly|could you|can you|would you|will you|may i|i would like to know|i would like to see|i would like|i want to know|i want to see|i want|i need to know|i need to see|i need|tell me|let me know|let me see|need to know|want to know|just|quickly|actually|basically|hey|hi|hello|dear|sir|madam|thanks|thank you|bot|ka|ke|ki|ko|mein|hai|hain|wale|wali|wala|aur|bhi|kya|abhi)\b/g, " ")
      .replace(/\s+/g, " ").trim();
    if (stripped) lc = stripped; else lc = orig;
    lc = lc.replace(/\b(?:(?:avg|average|mean)\s+)?(?:time|days|duration) (?:taken )?to (?:close|resolve|solve|fix|finish|complete)\b|\bresolution time\b|\bturn ?around(?: time)?\b|\bhow long (?:does it take|do we take|did it take|it takes|do tickets take|are tickets taking) to (?:close|resolve|solve|fix)\b/g, "average age of closed tickets")
      .replace(/\bhow much (work|load|stuff|backlog)\b/g, "how many tickets")
      .replace(/\bhow many (did|have|has) (we|the team|team) (close|finish|solve|resolve|complete)d?\b/g, "how many tickets closed")
      .replace(/\bwhat (did|have|has) (we|the team|team) (close|finish|solve|resolve|complete)d?\b/g, "tickets closed")
      .replace(/\b(did|have|has) (we|the team|team|you) (close|finish|solve|resolve|complete)d?\b/g, "closed")
      .replace(/\b(we|team) (closed|solved|resolved|completed|finished)\b/g, "closed")
      .replace(/\bmnths?\b/g, "month").replace(/\bwks?\b/g, "week").replace(/\byrs?\b/g, "year");
    lc = lc.replace(/\b(new|fresh|newly (?:created|raised|logged|opened))\s+(tickets?|issues?|cases?|incidents?|requests?|problems?)\b/g, function (m, a, b) { return /\b(today|yesterday|week|month|year|last|since|between|ago|\d)/.test(lc) ? b : "created last 7 days " + b; })
      .replace(/\b(recently|lately|these days|past few days|last few days|couple of days|past couple of days)\b/g, "last 7 days")
      .replace(/\bpast (week|7 days)\b/g, "last 7 days").replace(/\bpast month\b/g, "last 30 days").replace(/\bpast year\b/g, "last 12 months");
    return lc;
  }
  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function nz(s) { return " " + String(s == null ? "" : s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim() + " "; }
  function clean(v) { var s = String(v == null ? "" : v).trim(); return /^(nan|null|undefined|none)$/i.test(s) ? "" : s; }
  function ts(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return isNaN(v) ? null : v.getTime();
    if (typeof v === "number") return isNaN(v) ? null : (v < 1e11 ? v * 1000 : v);
    var s = String(v).trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"), t = new Date(s).getTime();
    return isNaN(t) ? null : t;
  }
  function has(w, term) { return w.indexOf(" " + term + " ") > -1 || w.indexOf(" " + term + "s ") > -1 || w.indexOf(" " + term + "es ") > -1; }
  function erase(w, term) { return w.replace(new RegExp(" " + esc(term) + "(?:e?s)? ", "g"), " "); }
  function rx(w, re) { return re.test(w); }
  function uniq(a) { var o = {}, r = []; a.forEach(function (x) { if (!o[x]) { o[x] = 1; r.push(x); } }); return r; }
  function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
  function fmtN(n) { return Number(n).toLocaleString("en-US"); }
  function fmtD(ms) { return ms == null ? "—" : new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }); }
  function median(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function sod(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function eod(d) { var x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

  /* ───────── date phrases ───────── */
  function mIndex(s) { s = s.toLowerCase(); for (var i = 0; i < 12; i++) if (s === MON[i] || s === MONFULL[i] || (i === 8 && s === "sept")) return i; return -1; }
  var MRE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  function parseDateStr(s, now) {
    var m;
    if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/.exec(s))) return new Date(+m[3], +m[2] - 1, +m[1]);
    if ((m = new RegExp("(\\d{1,2})(?:st|nd|rd|th)?\\s+" + MRE + "[a-z]*\\.?,?\\s*(\\d{4})?").exec(s))) return new Date(m[3] ? +m[3] : now.getFullYear(), mIndex(m[2]), +m[1]);
    if ((m = new RegExp(MRE + "[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?").exec(s))) return new Date(m[3] ? +m[3] : now.getFullYear(), mIndex(m[1]), +m[2]);
    return null;
  }
  var DATE_ANY = "(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+" + MRE + "[a-z]*\\.?,?\\s*(?:\\d{4})?|" + MRE + "[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*(?:\\d{4})?)";
  function lbl(a, b) { return fmtD(a) + " → " + fmtD(b); }
  /* → { range:{from,to,label}|null, rest } ; `rest` is the text with the date phrase removed */
  function extractRange(lc, now) {
    var m, rest = lc, from, to, y = now.getFullYear(), mo = now.getMonth();
    function cut(re) { rest = rest.replace(re, " "); }
    function mk(a, b, l) { return { range: { from: +a, to: +b, label: l }, rest: rest }; }
    var allD = lc.match(new RegExp(DATE_ANY, "g"));
    if (allD && allD.length >= 2 && /\b(between|from)\b/.test(lc)) {
      var d1 = parseDateStr(allD[0], now), d2 = parseDateStr(allD[1], now);
      if (d1 && d2) {
        rest = rest.replace(new RegExp("(?:between|from)\\s+" + esc(allD[0]) + "\\s+(?:and|to|till|until|-)\\s+" + esc(allD[1])), " ").replace(allD[0], " ").replace(allD[1], " ");
        if (+d2 < +d1) { var sw = d1; d1 = d2; d2 = sw; }
        return mk(sod(d1), eod(d2), lbl(d1, d2));
      }
    }
    if ((m = new RegExp("\\b(since|after|from)\\s+" + DATE_ANY).exec(lc))) { var ds = parseDateStr(m[2], now); if (ds) { cut(new RegExp(esc(m[0]))); return mk(sod(ds), eod(now), "since " + fmtD(ds)); } }
    if ((m = new RegExp("\\b(before|until|till|up to)\\s+" + DATE_ANY).exec(lc))) { var de = parseDateStr(m[2], now); if (de) { cut(new RegExp(esc(m[0]))); return mk(0, sod(de) - 1, "before " + fmtD(de)); } }
    if ((m = new RegExp("\\b(?:on\\s+)?" + DATE_ANY).exec(lc))) { var d0 = /\d/.test(m[0]) ? parseDateStr(m[0], now) : null; if (d0 && /\d{4}|\b\d{1,2}(st|nd|rd|th)?\s+[a-z]|[a-z]+\s+\d{1,2}/.test(m[0])) { cut(new RegExp(esc(m[0]))); return mk(sod(d0), eod(d0), fmtD(d0)); } }
    if ((m = /\b(last|past|previous|prior)\s+(\d+)\s*(day|week|month|year)s?\b/.exec(lc))) {
      var n = +m[2], f = new Date(now); cut(new RegExp(esc(m[0])));
      if (m[3] === "day") f.setDate(f.getDate() - n); else if (m[3] === "week") f.setDate(f.getDate() - 7 * n); else if (m[3] === "month") f.setMonth(f.getMonth() - n); else f.setFullYear(f.getFullYear() - n);
      return mk(sod(f), eod(now), "last " + n + " " + m[3] + (n > 1 ? "s" : ""));
    }
    if ((m = /\blast\s+(3|6|12)\s*m\b/.exec(lc))) { var f2 = new Date(now); f2.setMonth(f2.getMonth() - +m[1]); cut(new RegExp(esc(m[0]))); return mk(sod(f2), eod(now), "last " + m[1] + " months"); }
    if (/\byesterday\b/.test(lc)) { var yd = new Date(now); yd.setDate(yd.getDate() - 1); cut(/\byesterday\b/); return mk(sod(yd), eod(yd), "yesterday"); }
    if (/\btoday\b/.test(lc)) { cut(/\btoday\b/); return mk(sod(now), eod(now), "today"); }
    if (/\b(this|current)\s+week\b/.test(lc)) { var ws = sod(now); ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7)); cut(/\b(this|current)\s+week\b/); return mk(ws, eod(now), "this week"); }
    if (/\b(last|previous)\s+week\b/.test(lc)) { var w1 = sod(now); w1.setDate(w1.getDate() - ((w1.getDay() + 6) % 7) - 7); var w2 = new Date(w1); w2.setDate(w2.getDate() + 6); cut(/\b(last|previous)\s+week\b/); return mk(w1, eod(w2), "last week"); }
    if (/\b(this|current)\s+month\b/.test(lc)) { cut(/\b(this|current)\s+month\b/); return mk(new Date(y, mo, 1), eod(now), "this month"); }
    if (/\b(last|previous)\s+month\b/.test(lc)) { cut(/\b(last|previous)\s+month\b/); return mk(new Date(y, mo - 1, 1), eod(new Date(y, mo, 0)), "last month"); }
    if (/\b(this|current)\s+quarter\b/.test(lc)) { var q0 = Math.floor(mo / 3) * 3; cut(/\b(this|current)\s+quarter\b/); return mk(new Date(y, q0, 1), eod(now), "this quarter"); }
    if (/\b(last|previous)\s+quarter\b/.test(lc)) { var q1 = Math.floor(mo / 3) * 3 - 3; cut(/\b(last|previous)\s+quarter\b/); return mk(new Date(y, q1, 1), eod(new Date(y, q1 + 3, 0)), "last quarter"); }
    if (/\b(this|current)\s+year\b|\bytd\b|\byear to date\b/.test(lc)) { cut(/\b(this|current)\s+year\b|\bytd\b|\byear to date\b/); return mk(new Date(y, 0, 1), eod(now), "this year"); }
    if (/\b(last|previous)\s+year\b/.test(lc)) { cut(/\b(last|previous)\s+year\b/); return mk(new Date(y - 1, 0, 1), eod(new Date(y - 1, 11, 31)), "last year"); }
    if ((m = new RegExp("\\b" + MRE + "\\s+(20\\d\\d)\\b").exec(lc))) { var my = +m[2], mm = mIndex(m[1]); cut(new RegExp(esc(m[0]))); return mk(new Date(my, mm, 1), eod(new Date(my, mm + 1, 0)), MONNAME[mm] + " " + my); }
    if ((m = new RegExp("\\b(?:in|during|for|of)\\s+(?:the\\s+month\\s+of\\s+)?" + MRE + "\\b").exec(lc)) || (m = new RegExp("\\b" + MRE + "\\b").exec(lc.replace(/\bmay\b/g, "mAy"))) && m[1] !== "mAy" && !/^may$/i.test(m[1])) {
      var mi2 = mIndex(m[1]); if (mi2 > -1) { var yy = mi2 > mo ? y - 1 : y; cut(new RegExp(esc(m[0]), "i")); return mk(new Date(yy, mi2, 1), eod(new Date(yy, mi2 + 1, 0)), MONNAME[mi2] + " " + yy); }
    }
    if ((m = /\b(?:in|during|for|of)\s+(20\d\d)\b/.exec(lc))) { cut(new RegExp(esc(m[0]))); return mk(new Date(+m[1], 0, 1), eod(new Date(+m[1], 11, 31)), m[1]); }
    return { range: null, rest: rest };
  }

  /* ───────── status words, priorities ───────── */
  var PRIO = [["Show Stopper", / (show stopper|showstopper|blocker)(s)? /], ["Critical", / critical(s)? /], ["High", / high /], ["Medium", / medium /], ["Low", / low /]];
  var STATUS_ALIAS = { "waiting for customer": ["wfc", "waiting on customer", "awaiting customer"] };
  var DIMS = [
    ["svm", /\b(svm|in charge|incharge|in-charge)\b/, "SVM in charge"],
    ["project", /\b(clients?|projects?|customers?|accounts?)\b/, "client"],
    ["worker", /\b(workers?|persons?|people|agents?|assignees?|engineers?|members?|owners?|staff|team members?)\b/, "worker"],
    ["priority", /\b(priority|priorities|severity|severities)\b/, "priority"],
    ["status", /\b(status|statuses|stage|stages)\b/, "status"],
    ["root", /\b(root causes?|causes?)\b/, "root cause"],
    ["fix", /\b(type of fix|fix type|types of fix|fixes)\b/, "type of fix"],
    ["screen", /\b(screens?|screen names?)\b/, "screen"],
    ["menu", /\b(menu heads?|menus?)\b/, "menu head"],
    ["type", /\b(issue types?|types?)\b/, "issue type"],
    ["age", /\b(age|ageing|aging|age bucket|age group|age band)s?\b/, "age"]
  ];
  var DIMLBL = { project: "Client", worker: "Worker", svm: "SVM in charge", priority: "Priority", status: "Status", type: "Issue type", root: "Root cause", screen: "Screen", fix: "Type of fix", menu: "Menu head", age: "Age" };
  var FKEY = { project: "client", worker: "worker", svm: "svm", priority: "priority", status: "status", type: "type", root: "root", screen: "screen", fix: "fix", menu: "menu" };
  var AGE_B = [["< 7 days", 0, 7], ["7–30 days", 8, 30], ["31–60 days", 31, 60], ["61–90 days", 61, 90], ["90+ days", 91, 1e9]];

  var ANY = "(?:any |some |a |an )?";
  function LAYMAN(plan, ctx) {
    var N = plan.notes;
    function note(s) { if (N.indexOf(s) < 0) N.push(s); return ""; }
    return [
      // people questions
      [/ who (?:is |are )?(?:handling|working on|working with|looking after|looking at|taking care of|managing|owning|owns|responsible for|dealing with|assigned to|covering|supporting)(?= )/g, " who has the most open tickets for"],
      [/ (?:who (?:is|are) (?:the )?(?:busiest|most busy|most loaded|most overloaded|overloaded|overburdened|swamped|stretched)|busiest|most overloaded|most loaded|who has (?:the )?(?:most|more|maximum|highest|max) (?:work|workload|load)|who (?:is )?(?:got|has) (?:the )?(?:most|more) (?:work|load))(?= )/g, " who has the most open tickets"],
      [/ (?:who (?:is|are) (?:free|available|idle|the least busy|least busy|less busy|least loaded|underloaded)|least busy|least loaded|who has (?:the )?(?:least|less|minimum|lowest) (?:work|workload|load)|who has (?:free )?(?:bandwidth|capacity|time)|who has (?:no|zero|nothing|not much)(?: work| tickets| load)?|who can take (?:more|this|new|extra)(?: work| tickets)?)(?= )/g, " who has the least open tickets"],
      [/ (?:who (?:is|are) (?:the )?(?:slowest|slow|lagging|behind|laziest|worst|performing (?:worst|badly|poorly)|not performing)|slowest|laziest|worst performers?|worst performing|lagging behind)(?= )/g, function () { note("Ranked by tickets with no status change for 14+ days — that measures backlog, not a verdict on anyone’s performance."); return " who has the most stale tickets"; }],
      [/ (?:who (?:is|are) (?:the )?(?:best|fastest|top|most productive|performing best|doing (?:best|well))|best performers?|top performers?|most productive|fastest)(?= )/g, function () { note("Ranked by closed tickets — it does not account for ticket difficulty."); return " who has the most closed tickets"; }],
      [/ which (client|project|customer|account)s? (?:is|has) (?:the )?(?:worst|most problematic|most troublesome|biggest headache|giving (?:us )?(?:the )?(?:most )?trouble|most unhappy|most affected|most critical)(?= )/g, function (m, d) { return " which " + d + " has the most breached tickets"; }],
      // "what should I do today"
      [/ (?:what (?:should|do|shall) (?:i|we) (?:do|focus on|focus|work on|chase|look at|tackle|handle|start with)(?: today| now| first| next)?|what (?:needs|need) (?:my |our |immediate |urgent )?(?:attention|action|follow ?up|chasing)|where (?:do|should|shall) (?:i|we) (?:start|begin)|what (?:to|should i) (?:chase|focus on|follow up|work on)|what (?:is|are) (?:hot|urgent|burning|important|pressing|on fire|critical|most urgent|the priorities|the priority)|anything (?:urgent|critical|burning|serious|important|pressing|to worry about|to chase)|priorities|priority list|action items?|todays? focus|focus (?:for )?today|focus areas?|what to follow ?up)(?= )/g, " todays focus"],
      // "how are we doing"
      [/ (?:how (?:are|is) (?:we|things|it|everything|the (?:team|desk|helpdesk|queue|work|situation))(?: doing| going| looking)?|how things (?:stand|look)|state of (?:things|play|affairs)|where (?:do )?we stand|what is (?:going on|happening|the situation|the status|the position|the picture|up)|big picture|health(?: check)?|any (?:issues|problems|trouble|concerns)|anything (?:wrong|bad|alarming)|situation|quick (?:summary|look|update|status|view)|snapshot|report card|scorecard|status report|status update|give (?:an )?update)(?= )/g, " overview"],
      // "is there / are there / do we have ..."
      [/ (?:are there|is there|do we have|do i have|have we got|have i got|are we having)(?: any| some| a| an)?(?= )/g, " how many"],
      // SLA wording
      [/ (?:overdue|over due|late|delayed|delays?|behind schedule|behind sla|crossed (?:the )?(?:sla|deadline|target|limit)|missed (?:the )?(?:deadline|target|sla)|past (?:the )?(?:deadline|due date|due|sla|target)|beyond (?:the )?(?:sla|deadline|target)|out of sla|sla crossed|sla over|sla exceeded|exceeded (?:the )?sla|violated|violating|violations?|not met sla|failed sla|sla failed|sla fail|red tickets?)(?= )/g, " breached"],
      [/ (?:about to (?:breach|breached|miss|cross)|going to (?:breach|miss|cross)|will (?:breach|miss|cross)|likely to (?:breach|miss)|nearing (?:the )?(?:deadline|sla|breach)|close to (?:deadline|sla|the deadline)|almost (?:due|late|breached|overdue)|running out of time|time running out|breaching soon|breach soon)(?= )/g, " will breach soon"],
      // open / closed
      [/ (?:pending|outstanding|unresolved|not closed|not yet closed|yet to (?:be )?(?:close|closed|resolve|resolved|finish)|not done|not completed|not finished|still open|still pending|unclosed|in progress|ongoing|running|being worked on|being handled|active|live)(?= )/g, " open"],
      [/ (?:completed|done|finished|solved|fixed|wrapped up|dealt with|sorted)(?= )/g, " closed"],
      // who holds the ticket
      [/ (?:waiting for (?:a |the )?(?:reply|response|answer|feedback|confirmation|input|approval)(?: from)?(?: the)?(?: client| customer)?|awaiting (?:a |the )?(?:reply|response|feedback|confirmation|input)(?: from)?(?: the)?(?: client| customer)?|(?:client|customer) (?:reply|response|feedback) pending|no (?:reply|response) from (?:the )?(?:client|customer)|(?:client|customer) (?:not responding|not replying|has not replied|silent|yet to (?:reply|respond))|pending (?:with|from|at|on) (?:the )?(?:client|customer)s?|ball is in (?:the )?(?:client|customer) court|client court|at client side)(?= )/g, " with client"],
      [/ (?:(?:with|at|in) (?:the )?(?:developers?|dev team|development team|tech team|technical team|engineering team|devs|programmers?|coders?)|(?:dev|tech|technical) team)(?= )/g, " with engineering"],
      [/ (?:(?:with|at) (?:the )?(?:help ?desk|support team|our team|hd team|service desk)|(?:from|at|on|with) (?:our|my) end|(?:our|hd) (?:court|side)|on us|on our side|ball is with us|waiting for us|pending (?:with|on|from) us|needs? (?:us|our action)|yet to (?:be )?(?:act|action)ed)(?= )/g, " hd action"],
      // stuck / old / urgent
      [/ (?:stuck|not moving|no (?:progress|movement|updates?|activity|response)|nobody (?:touched|looked|is looking|is working)|untouched|ignored|forgotten|neglected|dormant|sitting idle|lying idle|lying around|gathering dust|going nowhere|inactive|have not moved|not touched|no one (?:touched|looked))(?= )/g, " stale"],
      [/ (?:urgent|emergency|asap|p1|top priority|very important|most important|severe|serious)(?= )/g, " show stopper critical"],
      [/ (?:old|ancient|aged|aging|ageing|very old|long pending|long standing|long running)(?= (?:tickets|ones|cases))/g, function () { return /\d+\s*(day|week|month)/.test(ctx.w()) ? " " : " older than 90 days"; }],
      // arrived / created
      [/ (?:came in|come in|coming in|got raised|were raised|was raised|were logged|got logged|were reported|got reported|were received|got created|were created|got opened|raised|logged|reported|received|arrived|incoming|inflow)(?= )/g, " created"],
      // workload of a person / client
      [/ (?:what is )?(?:on |in )?(?:his |her |their |the )?(?:plate|queue|backlog|pipeline|workload|work load|todo|to do list|bandwidth)(?= )/g, function () { if (ctx.hasEntity()) return " open tickets"; ctx.group("worker"); return " open tickets by worker"; }],
      [/ what is (?:working on|doing|handling|busy with)(?= )/g, " open tickets"],
      // ranking words
      [/ (?:max|maximum|biggest|largest|heaviest|highest number of)(?= )/g, " most"],
      [/ (?:min|minimum|smallest|lowest number of)(?= )/g, " least"],
      // what a "ticket" is called
      [/ (?:tkts?|tix|tickts|ticktes|tikets?|tickes|cases?|issues?(?! types?)|problems?|complaints?|queries|query|work items?)(?= )/g, " tickets"],
      [/^ any(?= )/, " how many"]
    ];
  }
  function blankF() {
    return { closed: null, status: [], owner: [], priority: [], client: [], worker: [], svm: [], type: [], root: [], screen: [], fix: [], menu: [], missing: [],
      ageMin: null, ageMax: null, idleMin: null, sla: null, text: null, range: null, dateField: "created", typeAll: false, allStatuses: false };
  }
  function clonePlan(p) { return JSON.parse(JSON.stringify(p)); }
  function applyPatch(plan, patch) {
    var p = clonePlan(plan); p.notes = [];
    Object.keys(patch || {}).forEach(function (k) {
      if (k === "f") Object.keys(patch.f).forEach(function (fk) { p.f[fk] = patch.f[fk]; });
      else p[k] = patch[k];
    });
    return p;
  }

  /* ═════════════════ engine ═════════════════ */
  function createEngine(opts) {
    var now = opts.now ? new Date(opts.now) : new Date(), nowMs = now.getTime();
    var base = opts.jiraBase || "https://svmhelpdesk.atlassian.net/browse/";
    var classify3 = opts.classify3 || function (s) { return /customer|client|resolved|confirm|deliver|approval \(client|published/i.test(s) ? "client" : "hd"; };
    var isSupportType = function (t) { var it = String(t || "").toLowerCase(); return it.indexOf("incident") > -1 || it.indexOf("service req") > -1; };

    /* ── normalise the rows once ── */
    var T = [];
    (opts.rows || []).forEach(function (r) {
      var key = clean(r.Key); if (!key) return;
      var status = clean(r.Status), svmRaw = clean(r["SVM In Charge"]);
      T.push({ raw: r, key: key, summary: clean(r.Summary), status: status, project: clean(r.Project), prefix: key.split("-")[0].toLowerCase(),
        priority: clean(r.Priority), type: clean(r["Issue Type"]), created: ts(r.Created), updated: ts(r.Updated), resolved: ts(r.Resolved),
        worker: clean(r["Current Worker"]), svmRaw: svmRaw, svm: svmRaw ? svmRaw.split(/\s*[,;]\s*/).filter(Boolean) : [],
        root: clean(r["Root Cause"]), screen: clean(r["Screen Name"]), fix: clean(r["Type of Fix"]), menu: clean(r["Menu Head"]),
        linked: clean(r["Linked Issues"]), closed: status === "Closed", support: isSupportType(r["Issue Type"]) });
    });
    var byKey = {}; T.forEach(function (t) { byKey[t.key.toLowerCase()] = t; });

    function ownerOf(t) { if (t._own) return t._own; return (t._own = t.status === "On-Hold" ? "hold" : t.status === "Invoice Yet to Raise" ? "inv" : classify3(t.status)); }
    function age(t) { return t.created == null ? null : Math.max(0, Math.floor((nowMs - t.created) / DAY)); }
    function idle(t) {
      if (t._idle !== undefined) return t._idle;
      var ms = opts.lastMove ? opts.lastMove(t.raw) : null; if (ms == null) ms = t.updated != null ? t.updated : t.created;
      return (t._idle = ms == null ? null : Math.max(0, Math.floor((nowMs - ms) / DAY)));
    }
    function sla(t) { if (t._sla === undefined) t._sla = opts.slaGet ? (opts.slaGet(t.raw) || null) : null; return t._sla; }
    function slaOk() { return !!opts.slaGet; }
    function closeDate(t) { return t.resolved != null ? t.resolved : (t.closed ? t.updated : null); }
    function resDays(t) { var c = closeDate(t); return c == null || t.created == null ? null : Math.max(0, (c - t.created) / DAY); }
    function dateOf(t, field) { return field === "resolved" ? closeDate(t) : field === "updated" ? t.updated : t.created; }

    /* ── entity index (what names the question can mention) ── */
    var E = { project: [], person: [], status: [], type: [], root: [], screen: [], fix: [], menu: [] };
    (function build() {
      function counts(fn) { var m = {}; T.forEach(function (t) { var v = fn(t); (Array.isArray(v) ? v : [v]).forEach(function (x) { if (x) m[x] = (m[x] || 0) + 1; }); }); return m; }
      // clients: full name, ticket-key prefix, and words that belong to only one client
      var pc = counts(function (t) { return t.project; }), prefByProj = {}, prefCount = {};
      T.forEach(function (t) { if (!t.project) return; var k = t.prefix + "|" + t.project; prefCount[k] = (prefCount[k] || 0) + 1; });
      var bestProj = {}; Object.keys(prefCount).forEach(function (k) { var a = k.split("|"), p = a[0]; if (!bestProj[p] || prefCount[k] > bestProj[p][1]) bestProj[p] = [a[1], prefCount[k]]; });
      Object.keys(bestProj).forEach(function (p) { var pr = bestProj[p][0]; (prefByProj[pr] = prefByProj[pr] || []).push(p); });
      var tokOwner = {}; Object.keys(pc).forEach(function (p) { nz(p).trim().split(" ").forEach(function (tk) { if (tk.length >= 4 && !STOP[tk] && !VOCABSET[tk] && !GENERICTOK[tk]) { tokOwner[tk] = tokOwner[tk] === undefined ? p : null; } }); });
      Object.keys(pc).forEach(function (p) {
        var terms = [nz(p).trim()].concat(prefByProj[p] || []), pt = nz(p).trim().split(" ");
        if (pt.length >= 3) for (var i = 0; i < pt.length; i++) for (var j = i + 2; j <= pt.length; j++) if (j - i < pt.length) terms.push(pt.slice(i, j).join(" "));   // "service desk", "desk space" for "FCSL Service Desk Space"
        Object.keys(tokOwner).forEach(function (tk) { if (tokOwner[tk] === p) terms.push(tk); });
        E.project.push({ value: p, n: pc[p], terms: uniq(terms.filter(function (x) { return x && x.length >= 2; })) });
      });
      // people (worker and SVM in charge share one name list)
      var wc = counts(function (t) { return t.worker; }), sc = counts(function (t) { return t.svm; }), names = uniq(Object.keys(wc).concat(Object.keys(sc))), first = {};
      names.forEach(function (n) { var f = nz(n).trim().split(" ")[0]; if (f.length >= 3 && !STOP[f]) first[f] = first[f] === undefined ? n : null; });
      names.forEach(function (n) {
        var terms = [nz(n).trim()]; Object.keys(first).forEach(function (f) { if (first[f] === n) terms.push(f); });
        E.person.push({ value: n, w: wc[n] || 0, s: sc[n] || 0, n: (wc[n] || 0) + (sc[n] || 0), terms: uniq(terms) });
      });
      ["status", "type", "root", "screen", "fix", "menu"].forEach(function (d) {
        var c = counts(function (t) { return t[d]; });
        Object.keys(c).forEach(function (v) {
          if (d === "status" && (v === "Open" || v === "Closed")) return;            // "open"/"closed" are handled as flags
          var terms = [nz(v).trim()].concat((d === "status" && STATUS_ALIAS[v.toLowerCase()]) || []);
          if (d === "type") { if (/change/i.test(v)) terms.push("change", "changes"); if (/service req/i.test(v)) terms.push("sr", "srs"); if (/incident/i.test(v)) terms.push("incident"); }
          E[d].push({ value: v, n: c[v], terms: uniq(terms.filter(function (x) { return x && x.length >= 2; })) });
        });
      });
    })();
    /* every word that appears in a client / person / status / field name — these are never "corrected" */
    var ENT_TOK = {};
    (function () {
      function add(s) { nz(s).trim().split(" ").forEach(function (x) { if (x) ENT_TOK[x] = 1; }); }
      [E.project, E.person, E.status, E.type, E.root, E.screen, E.fix, E.menu].forEach(function (list) { list.forEach(function (e) { add(e.value); e.terms.forEach(add); }); });
    })();
    function fixTypos(s, plan) {
      return s.replace(/[a-z]{4,}/g, function (wd) {
        if (wd.length === 4) return TYPO4[wd] && !ENT_TOK[wd] ? TYPO4[wd] : wd;
        if (TYPO4[wd] && !ENT_TOK[wd]) return TYPO4[wd];
        if (VOCABSET[wd] || STOP[wd] || ENT_TOK[wd] || PROTECT[wd]) return wd;
        var L = wd.length, max = L >= 8 ? 2 : 1, best = null, bd = 9, tie = false;
        for (var i = 0; i < VOCAB.length; i++) {
          var v = VOCAB[i]; if (v.charAt(0) !== wd.charAt(0) || Math.abs(v.length - L) > max) continue;
          var d = lev(wd, v, max); if (d < bd) { bd = d; best = v; tie = false; } else if (d === bd && v !== best) tie = true;
        }
        if (best && bd > 0 && bd <= max && !tie) { if (plan && !/^tickets?$/.test(best) && plan.notes.indexOf("I read “" + wd + "” as “" + best + "”") < 0) plan.notes.push("I read “" + wd + "” as “" + best + "”"); return best; }
        return wd;
      });
    }
    /* a misspelt client / person name → the one real name it is closest to (never guesses between two) */
    function fuzzyEntities(w, list) {
      var out = [], seen = {};
      w.trim().split(/\s+/).forEach(function (tk) {
        if (tk.length < 5 || seen[tk] || VOCABSET[tk] || STOP[tk] || ENT_TOK[tk] || /\d/.test(tk)) return; seen[tk] = 1;
        var best = null, bd = 9, tie = false;
        list.forEach(function (e) { e.terms.forEach(function (term) {
          if (term.indexOf(" ") > -1 || term.length < 5 || term.charAt(0) !== tk.charAt(0)) return;
          var max = tk.length >= 9 || term.substr(0, 3) === tk.substr(0, 3) ? 2 : 1; if (Math.abs(term.length - tk.length) > max) return;
          var d = lev(tk, term, max); if (d > max) return; if (d < bd) { bd = d; best = e; tie = false; } else if (d === bd && e !== best) tie = true;
        }); });
        if (best && bd > 0 && bd <= 2 && !tie) out.push([tk, best]);
      });
      return out;
    }
    function matchEntities(w, list, minLen) {
      var pairs = []; list.forEach(function (e) { e.terms.forEach(function (t) { pairs.push([t, e]); }); });
      pairs.sort(function (a, b) { return b[0].length - a[0].length; });
      var found = [];
      pairs.forEach(function (p) { if (p[0].length >= (minLen || 2) && has(w, p[0])) { if (found.indexOf(p[1]) < 0) found.push(p[1]); w = erase(w, p[0]); } });
      return { found: found, w: w };
    }

    /* ═════════ question → plan ═════════ */
    function parse(text, prev) {
      var raw = prepText(text).trim(), lc = raw.toLowerCase(), lc0 = lc, plan = { metric: null, f: blankF(), group: null, top: null, sort: null, limit: null, series: "created", measure: "count", keys: [], asc: false, explicit: false, ignored: [], recognised: 0, notes: [] };
      var f = plan.f;
      var keys = raw.match(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g); if (keys) plan.keys = uniq(keys.map(function (k) { return k.toUpperCase(); }));
      var m, quoted = /"([^"]{2,60})"/.exec(raw) || /(?:^|\s)'([^']{2,60})'(?=\s|$|[.,?!])/.exec(raw);
      if (quoted) { f.text = quoted[1].toLowerCase(); lc = lc.replace(quoted[0].toLowerCase(), " "); }
      lc = lc.replace(/\b[a-z][a-z0-9]*-\d+\b/g, " ").replace(/[?!]+/g, " ");
      lc = fixTypos(loosen(lc), plan); lc0 = lc;                         // casual wording → plain wording; misspellings → real words

      plan.slaFocus = /\bsla\b|breach|overdue|over due|deadline|time left|time remaining|how long (is )?left|due (date|soon|in)|crossed|late\b|delay/.test(lc);
      var follow = /^\s*(and|now|also|what about|how about|only|same|instead|but|then|plus|just|those|these|them|filter|narrow)\b/.test(lc) || (!!prev && /\b(they|them|those|these|same ones|of these|of those)\b/.test(lc));
      if (/\b(reset|clear (all|filters?)|start over|new question)\b/.test(lc)) { prev = null; plan.reset = true; }

      // dates
      var er = extractRange(lc, now); lc = er.rest; if (er.range) { f.range = er.range; plan.recognised++; }
      var vsEarly = /\b(created|raised|opened|logged|inflow|incoming|new)\b.*\b(vs|versus|against|and|v s)\b.*\b(closed|resolved|solved|delivered|outflow)\b/.test(lc0);
      if (!vsEarly && /\b(closed|resolved|delivered|completed|finished|solved)\b/.test(lc0) && !/\b(created|raised|logged|opened|incoming)\b/.test(lc0) && f.range) { f.dateField = "resolved"; f.closed = true; lc = lc.replace(/\b(closed|resolved|delivered|completed|finished|solved)\b/, " "); }
      else if (/\b(updated|changed|modified|touched|moved)\b/.test(lc) && f.range) f.dateField = "updated";

      var w = nz(lc);

      // statuses ("open"/"closed" are flags, not statuses)
      if (/\b(in|with)\s+open\s+status|\bopen status\b|status\s+(is\s+)?open\b/.test(lc)) { f.status.push("Open"); plan.recognised++; w = w.replace(/ open status | status open | status is open /g, " "); }
      var ms = matchEntities(w, E.status, 3); w = ms.w; ms.found.forEach(function (e) { f.status.push(e.value); plan.recognised++; });
      // clients, people, other fields
      /* "no status change", "any change", "not changed" are about movement, not about Change tickets */
      var wP = w.replace(/ (status|no|any|without|not|never|since|a|the) changes? /g, " $1 \u0001 ").replace(/ changes? (in|for|since|of|from|to) /g, " \u0001 $1 ");
      var mty = matchEntities(wP, E.type, 2); w = mty.w.replace(/\u0001/g, "change"); mty.found.forEach(function (e) { f.type.push(e.value); plan.recognised++; });
      var mc = matchEntities(w, E.project, 2); w = mc.w; mc.found.forEach(function (e) { f.client.push(e.value); plan.recognised++; });
      var mp = matchEntities(w, E.person, 3); w = mp.w;
      function addPerson(e) {
        var svmCue = /\b(svm|in charge|incharge|in-charge)\b/.test(lc), wkCue = /\b(worker|assigned|assignee|current worker|owner)\b/.test(lc);
        /* the wording picks the field, but never a field where this person has no tickets at all */
        var field = svmCue && !wkCue ? (e.s > 0 ? "svm" : "worker") : wkCue && !svmCue ? (e.w > 0 ? "worker" : "svm") : (e.w > 0 ? "worker" : "svm");
        if (f[field].indexOf(e.value) < 0) f[field].push(e.value); plan.recognised++; plan.personBoth = (e.w > 0 && e.s > 0);
      }
      mp.found.forEach(addPerson);
      ["root", "screen", "fix", "menu"].forEach(function (d) {
        var r = matchEntities(w, E[d], 3); w = r.w; r.found.forEach(function (e) { f[d].push(e.value); plan.recognised++; });
      });
      // names with typos ("milha", "vijai") — only when exactly one name is clearly the closest
      fuzzyEntities(w, E.project).forEach(function (x) { f.client.push(x[1].value); plan.recognised++; w = erase(w, x[0]); plan.notes.push("I read “" + x[0] + "” as “" + x[1].value + "”"); });
      fuzzyEntities(w, E.person).forEach(function (x) { addPerson(x[1]); w = erase(w, x[0]); plan.notes.push("I read “" + x[0] + "” as “" + x[1].value + "”"); });
      if (/ all (issue )?types | every type | including (changes|all types) | all issue types /.test(w)) { f.typeAll = true; w = w.replace(/ all (issue )?types | every type | including (changes|all types) | all issue types /g, " "); }

      // everyday wording → the words the rules below understand ("overdue" → breached, "pending with client" → with client …)
      var lctx = { w: function () { return w; }, hasEntity: function () { return f.client.length || f.worker.length || f.svm.length; }, group: function (d) { plan.forceGroup = d; } };
      LAYMAN(plan, lctx).forEach(function (r) { w = w.replace(r[0], r[1]); });
      // owner side
      if (/ (awaiting|waiting (on|for)|pending (with|on|from)|with|on) (the )?(client|customer)s? | client side | client follow ?ups? | client followup | waiting client | client action /.test(w)) { f.owner.push("client"); w = w.replace(/ (awaiting|waiting on|waiting for|pending with|pending on|pending from|with|on) (the )?(client|customer)s? | client side | client follow ?ups? | client followup | waiting client | client action /g, " "); plan.recognised++; }
      if (/ (with|in|at) (the )?(engineering|engg|dev|development|developers?) | engg follow ?ups? | engineering follow ?ups? | escalated | with dev /.test(w)) { f.owner.push("engg"); w = w.replace(/ (with|in|at) (the )?(engineering|engg|dev|development|developers?) | engg follow ?ups? | engineering follow ?ups? | escalated | with dev /g, " "); plan.recognised++; }
      if (/ hd action | needs? action | needs? hd action | action needed | help ?desk action | help ?desk side | our side | with us /.test(w)) { f.owner.push("hd"); w = w.replace(/ hd action | needs? action | needs? hd action | action needed | help ?desk action | help ?desk side | our side | with us /g, " "); plan.recognised++; }

      // special phrases
      var fires = / fires? | on fire /.test(w), danger = / danger zone | danger 90 | 90 days? plus /.test(w);
      if (fires) { f.priority = ["Show Stopper", "Critical"]; f.idleMin = f.idleMin == null ? 14 : f.idleMin; f.closed = false; w = w.replace(/ fires? | on fire /g, " "); plan.recognised++; }
      if (danger) { f.idleMin = 90; f.closed = false; w = w.replace(/ danger zone | danger 90 | 90 days? plus /g, " "); plan.recognised++; }

      // priority
      PRIO.forEach(function (p) { if (p[1].test(w)) { f.priority.push(p[0]); w = w.replace(new RegExp(p[1].source, "g"), " "); plan.recognised++; } });
      f.priority = uniq(f.priority);
      if (/ (no|without|missing|blank|empty|unrated) (priority|severity) /.test(w)) { f.missing.push("priority"); w = w.replace(/ (no|without|missing|blank|empty|unrated) (priority|severity) /g, " "); plan.recognised++; }
      var MISS = [[/ (no|without|missing|blank|empty|unassigned|not assigned) (root cause|cause) /, "root"], [/ (no|without|missing|blank|empty) (svm|in charge|incharge|svm in charge) /, "svm"],
        [/ (no|without|missing|blank|empty) (worker|assignee|owner|current worker) | unassigned | not assigned /, "worker"], [/ (no|without|missing|blank|empty) (screen|screen name) /, "screen"],
        [/ (no|without|missing|blank|empty) (type of fix|fix type) /, "fix"], [/ (no|without|missing|blank|empty) (linked|link|linked issues?) | not linked /, "linked"]];
      MISS.forEach(function (x) { if (x[0].test(w)) { f.missing.push(x[1]); w = w.replace(new RegExp(x[0].source, "g"), " "); plan.recognised++; } });

      // SLA wording
      var slaMetW = /sla\s*%|%\s*sla/.test(lc) || / sla (met|compliance|percent|percentage|performance|achievement|score|rate|adherence) | (met|meeting|hit|within) sla | sla % | sla met /.test(w);
      if (!slaMetW) {
        if (/ (will breach|going to breach|likely to breach|breach soon|breaching soon|soon to breach|to breach) /.test(w)) { f.sla = "atrisk"; plan.recognised++; w = w.replace(/ (will breach|going to breach|likely to breach|breach soon|breaching soon|soon to breach|to breach) /g, " "); }
        else if (/ (breach|breaches|breached|breaching|over sla|missed sla|sla breach(es|ed)?|violat(ed|ion|ions)) /.test(w)) { f.sla = "breached"; plan.recognised++; }
        else if (/ (at risk|due soon|about to breach|near(ly)? breach(ing)?|close to breach|critical sla) /.test(w)) { f.sla = / due soon | about to breach | close to breach /.test(w) ? "duesoon" : "atrisk"; plan.recognised++; }
        else if (/ (paused|clock paused|sla paused) /.test(w)) { f.sla = "paused"; plan.recognised++; }
        else if (/ (no sla data|no history|without history|sla data missing|history missing) /.test(w)) { f.sla = "nohist"; plan.recognised++; }
        else if (/ (on track|within sla|sla ok|safe) /.test(w)) { f.sla = "ontrack"; plan.recognised++; }
        else if (/ no (sla )?target /.test(w)) { f.sla = "none"; plan.recognised++; }
      }
      w = w.replace(/ (breach|breaches|breached|breaching|over sla|missed sla|sla breach(es|ed)?|violat(ed|ion|ions)|at risk|due soon|about to breach|nearly breach(ing)?|near breach(ing)?|close to breach|critical sla|paused|clock paused|sla paused|no sla data|no history|without history|on track|within sla|sla ok|no target|no sla target) /g, " ");

      // durations: age (since created) vs idle (since last status change)
      var idleCue = / stale | silent | idle | untouched | stuck | no (status )?(change|update|movement|activity|progress) | not (moved|changed|updated) | hasn t (moved|changed) | without (any )?(change|update) | inactive /.test(w);
      var dm = /(?: (older than|over|more than|above|greater than|at least|atleast|beyond|exceeding|for|since|aged|> ?|>= ?)\s*)?(\d+)\s*\+?\s*(day|days|d|week|weeks|w|month|months)( old| plus)? /.exec(w);
      var staleWord = / stale | silent | idle | untouched | stuck | inactive /.test(w);
      if (dm) {
        var n = +dm[2] * (/^w/.test(dm[3]) ? 7 : /^m/.test(dm[3]) ? 30 : 1), cueAge = /older|over|more than|above|greater|aged|old|beyond|exceeding|at least|atleast|>/.test(dm[0] + (dm[4] || "")) && !idleCue;
        var waitCue = /\b(waiting|awaiting|pending|stuck|no response|not responded)\b/.test(lc) && !/\b(older|old|created|aged|ageing|aging)\b/.test(lc);
        if (idleCue || waitCue || (!cueAge && / for /.test(" " + dm[0]))) f.idleMin = n; else f.ageMin = n;
        w = w.replace(dm[0], " "); plan.recognised++;
      } else if (staleWord) { f.idleMin = f.idleMin == null ? 14 : f.idleMin; plan.recognised++; }
      if (staleWord || idleCue) { w = w.replace(/ stale | silent | idle | untouched | stuck | inactive | no (status )?(change|update|movement|activity|progress) | not (moved|changed|updated) | hasn t (moved|changed) | without (any )?(change|update) /g, " "); if (f.idleMin == null) f.idleMin = 14; }
      if (/ (old|aged|ageing|aging) /.test(w) && f.ageMin == null && /\b(old|aged|ageing|aging)\b/.test(lc) && !/\bage\b/.test(lc) && !/ by (age|ageing|aging) /.test(w)) { /* "old tickets" without a number is ignored */ }

      // open / closed flags
      if (/ (all tickets|every ticket|all statuses|including closed|open and closed|open or closed|ever) /.test(w)) { f.allStatuses = true; w = w.replace(/ (all tickets|every ticket|all statuses|including closed|open and closed|open or closed|ever) /g, " "); }
      if (f.closed === null && / (open|opened|pending|active|outstanding|unresolved|live|ongoing|not closed) /.test(w) && !/ (created|raised|logged) (and|vs|versus) (closed|resolved) /.test(w)) { f.closed = false; plan.recognised++; }
      if (/ (closed|completed|finished|solved|done) /.test(w) && f.status.indexOf("Closed") < 0) { f.closed = true; plan.recognised++; }
      if (f.sla === "met" || f.sla === "missed") f.closed = true;

      // metric words
      var countW = / (how many|count|number of|no of|total|tally) /.test(w), listW = / (show|list|give|display|find|get|fetch|see|view|pull|which tickets|what tickets|oldest|newest|latest|recent) /.test(w) || /\b(show|list|give|display|find|get|fetch|see|view|pull|oldest|newest|latest|recent)\b/.test(lc);
      var trendW = / (trend|trends|month by month|monthly|per month|by month|each month|every month|weekly|week by week|per week|by week|each week|over time|timeline|month wise|week wise|month on month) /.test(w);
      var vsW = / (created|raised|opened|logged|inflow|incoming|new) .*(vs|versus|against|and|v s) .*(closed|resolved|solved|delivered|outflow) /.test(w) || / created vs closed | raised vs closed | opened vs closed | inflow vs outflow /.test(w);
      var cmpW = / (compare|comparison|versus|vs|v s|difference between|against) /.test(w);
      var avgW = / (average|avg|mean|median|typical) /.test(w), overviewW = / (overview|summary|snapshot|profile|dashboard|status report|how is|how are|performance of|scorecard) /.test(w);
      var which = / (which|what|who|whom) /.test(w), superl = / (most|highest|least|fewest|lowest|maximum|minimum|biggest|largest|worst|best) /.test(w), topW = / (top|bottom) /.test(w);
      var topN = /\b(?:top|first|bottom|lowest|last)\s+(\d+)\b/.exec(lc); if (topN) { plan.top = +topN[1]; if (/\b(bottom|lowest)\b/.test(lc)) plan.asc = true; }
      if (/ (least|fewest|lowest|minimum|bottom) /.test(w)) plan.asc = true;
      var nOld = /\b(\d+)\s+(oldest|newest|latest|recent)\b/.exec(lc) || /\b(oldest|newest|latest|recent)\s+(\d+)\b/.exec(lc);
      if (nOld) plan.limit = +(nOld[1].match(/\d/) ? nOld[1] : nOld[2]);
      if (/\b(oldest)\b/.test(lc)) plan.sort = "oldest"; else if (/\b(newest|latest|recent|most recent)\b/.test(lc)) plan.sort = "newest";
      if (!plan.limit && /\b(?:the )?(?:oldest|newest|latest|most recent)\s+(?:open\s+)?ticket\b/.test(lc)) plan.limit = 1;

      // grouping dimension
      var dimHit = null;
      var byM = /\b(?:by|per|for each|each|breakdown(?: of)?|break down(?: by)?|split(?: by)?|grouped by|group by|across|among)\s+(?:the\s+)?([a-z\- ]{2,24})/.exec(lc), wiseM = /\b([a-z][a-z ]{1,18}?)\s+(?:wise|breakdown|distribution|split|summary by)\b/.exec(lc), phrase = byM ? byM[1] : wiseM ? wiseM[1] : "";
      if (phrase) DIMS.forEach(function (d) { if (!dimHit && d[1].test(phrase)) dimHit = d[0]; });
      if (!dimHit && (superl || topN || topW)) DIMS.forEach(function (d) { if (!dimHit && d[0] !== "age" && d[1].test(lc)) dimHit = d[0]; });
      if ((/\bwho\b/.test(lc) || / who /.test(w)) && !dimHit && !plan.keys.length) dimHit = "worker";
      if (!dimHit && plan.forceGroup) dimHit = plan.forceGroup;
      plan.superl = superl;
      if (dimHit && plan.keys.length) dimHit = null;
      if (dimHit && f[FKEY[dimHit]] && f[FKEY[dimHit]].length === 1 && !(which || superl)) { /* "for MILAHA by client" is pointless — keep grouping anyway */ }
      if (!dimHit && /\b(what|which)\s+(issue\s+)?types?\b|\btypes? of tickets\b/.test(lc)) dimHit = "type";
      var isMonthWeek = /\b(?:by|per|each|every)\s+(month|week)\b|\b(month|week)\s*wise\b/.test(lc);

      // decide the metric
      if (plan.keys.length) plan.metric = "ticket";
      else if (/ todays focus /.test(w)) plan.metric = "focus";
      else if (/^\s*(help|\?|hi|hello|hey|what can you do|how (do|to) (i )?use|examples?|commands?)\b/.test(lc) || / (what can you do|how to use|show examples|example questions) /.test(w)) plan.metric = "help";
      else if (cmpW && (f.client.length > 1 || f.worker.length + f.svm.length > 1 || f.priority.length > 1 || f.type.length > 1 || (f.worker.length && f.svm.length))) plan.metric = "compare";
      else if (cmpW && !vsW) plan.metric = "compare";
      else if (vsW || trendW || isMonthWeek) { plan.metric = "trend"; plan.series = vsW ? "both" : "single"; plan.bucket = /week/.test(lc) ? "week" : "month"; }
      else if (dimHit) { plan.metric = "group"; plan.group = dimHit; }
      else if (overviewW && / sla /.test(w) && !f.sla) plan.metric = "slaSummary";
      else if (slaMetW) plan.metric = "slaMet";
      else if (avgW) plan.metric = "avg";
      else if (countW) plan.metric = "count";
      else if (overviewW) plan.metric = "overview";
      else if (/ (about|status of|everything about|info on|information on|details of|details on|update on) /.test(" " + lc.replace(/[^a-z]+/g, " ") + " ") && (f.client.length || f.worker.length || f.svm.length) && !/ tickets /.test(w)) plan.metric = "overview";
      else if (/ sla /.test(w) && !f.sla) plan.metric = "slaSummary";
      else if (listW || / (tickets|ticket|issues|incidents|requests) /.test(" " + lc.replace(/[^a-z]+/g, " ") + " ") || plan.recognised > 0) { plan.metric = "list"; plan.inferred = !listW && !/ (tickets|ticket|issues|incidents|requests) /.test(" " + lc.replace(/[^a-z]+/g, " ") + " "); }
      if (plan.metric === "slaMet" && f.range && f.dateField === "created" && !/\b(created|raised|logged|opened)\b/.test(lc0)) f.dateField = "resolved";
      if (plan.metric === "count" && (f.type.length > 1 || f.priority.length > 1)) { plan.metric = "group"; plan.group = f.type.length > 1 ? "type" : "priority"; }
      if (plan.metric === "group" || plan.metric === "slaMet") { if (slaMetW) plan.measure = "slaMet"; else if (avgW) plan.measure = "avg"; }
      if (plan.metric === "group" && plan.measure === "count" && slaMetW) plan.measure = "slaMet";
      if (/\b(are|is|were|was)\s+(they|these|those|it|all)\b/.test(lc) && f.type.length >= 1 && !plan.keys.length) { plan.metric = "group"; plan.group = "type"; f.type = []; f.typeAll = true; plan.inferred = false; }
      if (plan.metric === "group" && plan.group === "type" && !f.type.length) f.typeAll = true;
      plan.explicit = !!plan.metric && !plan.inferred;

      if (plan.metric === "focus" && f.range && /^(today|yesterday)$/.test(f.range.label)) { f.range = null; plan.recognised--; }

      // search words
      var trig = /\b(?:about|containing|contains|mentioning|mention|regarding|related to|involving|with the word|search for|searching for|search)\s+([a-z0-9][a-z0-9 ]{1,40})/.exec(lc);
      if (trig && !f.text) {
        var toks = trig[1].split(/\s+/).filter(function (t) { return t && !STOP[t]; }).slice(0, 3), good = [];
        for (var i = 0; i < toks.length; i++) { if (has(w, toks[i])) good.push(toks[i]); else break; }
        if (good.length) { f.text = good.join(" "); plan.recognised++; good.forEach(function (g) { w = erase(w, g); }); }
      }
      if (f.text) plan.recognised++;

      // anything left over that we did not understand
      var left = w.trim().split(/\s+/).filter(function (t) { return t.length >= 3 && !STOP[t] && !/^\d+$/.test(t); });
      var GEN = { tickets: 1, ticket: 1, issues: 1, issue: 1, open: 1, closed: 1, client: 1, clients: 1, worker: 1, workers: 1, priority: 1, status: 1, month: 1, week: 1, wise: 1, breakdown: 1, analysis: 1, report: 1, data: 1, info: 1, sla: 1, svm: 1, charge: 1, assigned: 1, assignee: 1, percentage: 1, percent: 1, rate: 1, compliance: 1, performance: 1, met: 1, score: 1, achievement: 1, adherence: 1 };
      plan.ignored = left.filter(function (t) { return !GEN[t]; }).slice(0, 5);

      // follow-up: a short message that only adds filters refines the previous question
      if (prev && !plan.reset) {
        var addsFilters = plan.recognised > 0 && !plan.keys.length;
        var shortRefine = plan.recognised === 0 && (plan.metric === "group" || plan.metric === "trend") && raw.split(/\s+/).length <= 4 && !plan.keys.length;
        var wc = raw.split(/\s+/).length;
        if (follow || shortRefine || (!plan.explicit && addsFilters && plan.metric !== "help" && wc <= 3)) {
          var merged = clonePlan(prev); merged.ignored = plan.ignored; merged.notes = plan.notes;
          Object.keys(f).forEach(function (k) {
            var v = f[k], b = blankF()[k];
            if (JSON.stringify(v) !== JSON.stringify(b)) merged.f[k] = v;
          });
          if (plan.explicit && plan.metric) { merged.metric = plan.metric; merged.group = plan.group; merged.series = plan.series; merged.measure = plan.measure; merged.bucket = plan.bucket; }
          else if (!merged.metric || merged.metric === "ticket" || merged.metric === "help" || merged.metric === "focus") merged.metric = "list";
          if (plan.top) merged.top = plan.top; if (plan.sort) merged.sort = plan.sort; if (plan.limit) merged.limit = plan.limit;
          merged.followed = true; return merged;
        }
      }
      if (plan.metric === "list" && plan.recognised === 0 && !plan.keys.length && !listW) plan.metric = null;
      return plan;
    }

    /* ═════════ run a plan ═════════ */
    function effective(plan) {
      var f = plan.f, m = plan.metric, ef = { closed: f.closed, dateField: f.dateField };
      var openDefault = ["count", "list", "group", "avg", "compare", "overview", "slaSummary"].indexOf(m) > -1;
      if (ef.closed === null && !f.allStatuses) {
        if (m === "slaMet" || (m === "group" && plan.measure === "slaMet")) ef.closed = true;
        else if (f.sla === "met" || f.sla === "missed") ef.closed = true;
        else if (f.dateField === "resolved" && f.range) ef.closed = true;
        else if (f.status.indexOf("Closed") > -1) ef.closed = true;
        else if (openDefault && !f.range && !f.status.length) ef.closed = false;
        else if (openDefault && !f.range && f.status.length) ef.closed = null;
      }
      return ef;
    }
    function slaPass(info, want) {
      if (!info) return false; var s = info.state;
      switch (want) {
        case "breached": return s === "breached"; case "atrisk": return s === "running" && !!info.atRisk; case "duesoon": return s === "running" && info.level === "danger";
        case "ontrack": return s === "running" && !info.atRisk; case "paused": return s === "paused"; case "nohist": return s === "nohist"; case "none": return s === "none";
        case "met": return s === "met"; case "missed": return s === "missed";
      } return true;
    }
    function select(plan, over) {
      var f = Object.assign({}, plan.f, over || {}), ef = effective(plan); if (over && over.closed !== undefined) ef.closed = over.closed;
      var txt = f.text ? f.text.toLowerCase() : null;
      var out = T.filter(function (t) {
        if (ef.closed === true && !t.closed) return false; if (ef.closed === false && t.closed) return false;
        if (!f.type.length && !f.typeAll && !t.support) return false;
        if (f.type.length && f.type.indexOf(t.type) < 0) return false;
        if (f.status.length && f.status.indexOf(t.status) < 0) return false;
        if (f.priority.length && f.priority.indexOf(t.priority) < 0) return false;
        if (f.client.length && f.client.indexOf(t.project) < 0) return false;
        if (f.worker.length && f.worker.indexOf(t.worker) < 0) return false;
        if (f.svm.length && !t.svm.some(function (s) { return f.svm.indexOf(s) > -1; })) return false;
        if (f.root.length && f.root.indexOf(t.root) < 0) return false; if (f.screen.length && f.screen.indexOf(t.screen) < 0) return false;
        if (f.fix.length && f.fix.indexOf(t.fix) < 0) return false; if (f.menu.length && f.menu.indexOf(t.menu) < 0) return false;
        if (f.owner.length && f.owner.indexOf(ownerOf(t)) < 0) return false;
        for (var i = 0; i < f.missing.length; i++) { var k = f.missing[i]; if (k === "priority" ? t.priority : k === "svm" ? t.svmRaw : k === "linked" ? t.linked : t[k]) return false; }
        if (f.range) { var d = dateOf(t, ef.dateField); if (d == null || d < f.range.from || d > f.range.to) return false; }
        if (f.ageMin != null || f.ageMax != null) { var a = age(t); if (a == null) return false; if (f.ageMin != null && a < f.ageMin) return false; if (f.ageMax != null && a > f.ageMax) return false; }
        if (txt && (t.summary + " " + t.key + " " + t.root + " " + t.screen).toLowerCase().indexOf(txt) < 0) return false;
        return true;
      });
      if (f.idleMin != null) out = out.filter(function (t) { if (t.closed) return false; var d = idle(t); return d != null && d >= f.idleMin; });
      if (f.sla) { if (!slaOk()) return out.slice(0, 0); out = out.filter(function (t) { return slaPass(sla(t), f.sla); }); }
      return out;
    }

    /* ── labels ── */
    function parts(plan) {
      var f = plan.f, ef = effective(plan), c = [], B0 = blankF();
      function P(label, reset) { c.push({ t: label, reset: reset || null }); }
      P(ef.closed === true ? "closed tickets" : ef.closed === false ? "open tickets" : "all statuses", ef.closed === false ? { closed: null, allStatuses: true, _l: "Include closed tickets" } : null);
      if (!f.type.length && !f.typeAll) P("incidents & service requests", { typeAll: true, _l: "Include all issue types" }); else if (f.type.length) P(f.type.join(" / "), { type: [] }); else P("all issue types");
      if (f.priority.length) P(f.priority.join(" + "), { priority: [] }); if (f.client.length) P("client: " + f.client.join(", "), { client: [] });
      if (f.worker.length) P("worker: " + f.worker.join(", "), { worker: [] }); if (f.svm.length) P("SVM in charge: " + f.svm.join(", "), { svm: [] });
      if (f.status.length) P("status: " + f.status.join(", "), { status: [] }); if (f.owner.length) P({ client: "with client", engg: "with engineering", hd: "HD action", hold: "on hold", inv: "invoice pending" }[f.owner[0]] + (f.owner.length > 1 ? " +" : ""), { owner: [] });
      ["root", "screen", "fix", "menu"].forEach(function (d) { if (f[d].length) { var r = {}; r[d] = []; P(DIMLBL[d].toLowerCase() + ": " + f[d].join(", "), r); } });
      f.missing.forEach(function (k) { P("no " + (k === "svm" ? "SVM in charge" : k === "linked" ? "linked issue" : k === "root" ? "root cause" : k), { missing: f.missing.filter(function (x) { return x !== k; }) }); });
      if (f.sla) P({ breached: "SLA breached", atrisk: "SLA at risk", duesoon: "SLA due soon", ontrack: "SLA on track", paused: "SLA paused (with client)", nohist: "no SLA data", none: "no SLA target", met: "SLA met", missed: "SLA missed" }[f.sla], { sla: null });
      if (f.idleMin != null) P("no status change " + f.idleMin + "+ days", { idleMin: null }); if (f.ageMin != null) P("older than " + f.ageMin + " days", { ageMin: null }); if (f.ageMax != null) P("younger than " + (f.ageMax + 1) + " days", { ageMax: null });
      if (f.range) P((ef.dateField === "resolved" ? "closed " : ef.dateField === "updated" ? "updated " : "created ") + f.range.label, { range: null });
      if (f.text) P("text contains “" + f.text + "”", { text: null });
      return c;
    }
    function describe(plan) { return parts(plan).map(function (x) { return x.t; }); }
    /* "no tickets match" → one-click ways to loosen the question */
    function relaxChips(plan) {
      var out = [];
      parts(plan).forEach(function (x) {
        if (!x.reset) return; var r = Object.assign({}, x.reset), lab = r._l; delete r._l;
        out.push({ label: lab || ("Remove “" + (x.t.length > 28 ? x.t.slice(0, 27) + "…" : x.t) + "”"), patch: { f: r } });
      });
      return out.slice(0, 5);
    }
    function followChips(plan, skip) {
      var all = [["List them", { metric: "list" }], ["By client", { metric: "group", group: "project" }], ["By priority", { metric: "group", group: "priority" }], ["By status", { metric: "group", group: "status" }], ["By worker", { metric: "group", group: "worker" }], ["Trend by month", { metric: "trend", series: "single", bucket: "month" }]];
      return all.filter(function (x) { return !(x[1].metric === plan.metric && (x[1].group || "") === (plan.group || "")) && x[1].group !== skip && !(x[1].metric === "group" && plan.f[FKEY[x[1].group]] && plan.f[FKEY[x[1].group]].length === 1); }).slice(0, 5).map(function (x) { return { label: x[0], patch: x[1] }; });
    }

    /* ── ticket row for lists ── */
    function row(t) {
      var s = sla(t), a = age(t);
      return { raw: t.raw, key: t.key, url: base + t.key, summary: t.summary, status: t.status, project: t.project, priority: t.priority, type: t.type, worker: t.worker, svm: t.svmRaw,
        age: a, idle: t.closed ? null : idle(t), created: t.created, sla: s && (s.state === "na" || s.state === "loading") ? null : s ? { label: s.label || "", state: s.state, tone: s.tone || "" } : null, closed: t.closed };
    }
    function csvTickets(list, name) {
      return { name: name, header: ["Key", "Summary", "Status", "Project", "Priority", "Issue Type", "Current Worker", "SVM In Charge", "Created", "Age (days)", "Days in status", "SLA"],
        rows: list.map(function (t) { var r = row(t); return [r.key, r.summary, r.status, r.project, r.priority, r.type, r.worker, r.svm, fmtD(r.created), r.age == null ? "" : r.age, r.idle == null ? "" : r.idle, r.sla ? r.sla.label : ""]; }) };
    }
    function scopeLabel(plan) { var ef = effective(plan); return (ef.closed === false ? "open " : ef.closed === true ? "closed " : "") + (plan.f.type.length || plan.f.typeAll ? "" : "support ") + "tickets"; }

    /* ── profile of a set of open tickets (compare / overview) ── */
    function profile(list) {
      var p = { open: list.length, hd: 0, client: 0, engg: 0, fires: 0, stale: 0, danger: 0, breached: 0, atrisk: 0, ages: [] };
      list.forEach(function (t) {
        var o = ownerOf(t); if (o === "hd") p.hd++; else if (o === "client") p.client++; else if (o === "engg") p.engg++;
        var a = age(t); if (a != null) p.ages.push(a);
        if (!t.closed) { var d = idle(t); if (d != null) { if (d >= 14) p.stale++; if (d >= 90) p.danger++; if ((t.priority === "Show Stopper" || t.priority === "Critical") && d > 14) p.fires++; } }
        if (slaOk()) { var s = sla(t); if (s && s.state === "breached") p.breached++; else if (s && s.state === "running" && s.atRisk) p.atrisk++; }
      });
      p.avgAge = p.ages.length ? Math.round(p.ages.reduce(function (x, y) { return x + y; }, 0) / p.ages.length) : 0;
      return p;
    }

    /* ── group a list by a dimension ── */
    function groupKeys(t, dim) {
      if (dim === "svm") return t.svm.length ? t.svm : ["(none)"];
      if (dim === "age") { var a = age(t); if (a == null) return ["(unknown)"]; for (var i = 0; i < AGE_B.length; i++) if (a <= AGE_B[i][2]) return [AGE_B[i][0]]; return ["90+ days"]; }
      var v = dim === "project" ? t.project : dim === "worker" ? t.worker : dim === "priority" ? t.priority : dim === "status" ? t.status : dim === "type" ? t.type : t[dim];
      return [v || "(none)"];
    }

    /* ═════════ answer builders ═════════ */
    var B = {};
    B.help = function () {
      var c = E.project[0] ? E.project.slice().sort(function (a, b) { return b.n - a.n; })[0].value : "MILAHA", p = E.person[0] ? E.person.slice().sort(function (a, b) { return b.n - a.n; })[0].value : "Vijay";
      return { type: "help", examples: [
        ["Just ask the way you talk", ["What needs attention today?", "What's overdue?", "Who has the most work?", "What's pending with the client?", "How are we doing?"]],
        ["Counts", ["How many open tickets?", "How many tickets are late for " + c + "?", "Open tickets by client"]],
        ["Lists", ["Which tickets are stuck for more than 30 days?", "Oldest 10 tickets for " + p, "Anything urgent for " + c + "?"]],
        ["Rankings", ["Top 5 clients by breaches", "Who is free?", "Which root cause is most common?"]],
        ["SLA", ["Are we meeting SLA?", "What is about to breach?", "SLA met % last month"]],
        ["Trends & compare", ["How many tickets were raised each month?", "Compare " + p + " and " + (E.person[1] ? E.person[1].value : "Naveen"), "What did we close last week?"]],
        ["One ticket or one client", [(T[0] ? T[0].key : "MILAHA-1058"), "Tell me about " + c]] ], note: "Spelling mistakes are fine. After an answer, type what to change — “only critical”, “last month”, “for " + p + "”. Hinglish works too: “kitne open tickets hai”." };
    };
    B.count = function (plan) {
      var list = select(plan), n = list.length, baseN = select(plan, { client: [], worker: [], svm: [], priority: [], status: [], owner: [], sla: null, idleMin: null, ageMin: null, ageMax: null, missing: [], root: [], screen: [], fix: [], menu: [], text: null, range: null }).length;
      var rel = n === 0 ? relaxChips(plan) : null;
      var a = { type: "number", title: scopeLabel(plan).replace(/^./, function (c) { return c.toUpperCase(); }), value: n, unit: n === 1 ? "ticket" : "tickets", sub: n === 0 ? "Nothing matches all of those conditions together. Try loosening one:" : baseN && n !== baseN ? pct(n, baseN) + "% of " + fmtN(baseN) + " " + scopeLabel(plan) : "", chips: describe(plan), follow: rel || followChips(plan) };
      if (f_hasSla(plan) && !slaOk()) a.warn = "SLA data isn’t available on this page — open the Follow-up Tracker for SLA questions.";
      return a;
    };
    function f_hasSla(plan) { return !!plan.f.sla || plan.metric === "slaMet" || plan.metric === "slaSummary"; }
    B.list = function (plan) {
      var list = select(plan), f = plan.f, sort = plan.sort;
      if (sort === "oldest" || (!sort && f.ageMin != null)) list.sort(function (a, b) { return (a.created || 0) - (b.created || 0); });
      else if (sort === "newest") list.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
      else if (f.sla === "breached") list.sort(function (a, b) { return ((sla(b) || {}).overByMin || 0) - ((sla(a) || {}).overByMin || 0); });
      else if (f.idleMin != null || effective(plan).closed === false) list.sort(function (a, b) { return (idle(b) || 0) - (idle(a) || 0); });
      else list.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
      var total = list.length, lim = plan.limit || null, shown = lim ? list.slice(0, lim) : list;
      var a = { type: "tickets", title: total + (total === 1 ? " ticket" : " tickets"), total: total, items: shown.slice(0, 300).map(row), more: Math.max(0, shown.length - 300), chips: describe(plan),
        csv: csvTickets(shown, "tickets"), follow: total === 0 ? relaxChips(plan) : followChips(plan).filter(function (x) { return x.patch.metric !== "list"; }), limited: lim && total > lim ? total : 0 };
      a.slaContext = !!f.sla || !!plan.slaFocus;
      if (total === 0) a.emptyHint = "Nothing matches all of those conditions together. Try loosening one:";
      if (f_hasSla(plan) && !slaOk()) a.warn = "SLA data isn’t available on this page — open the Follow-up Tracker for SLA questions.";
      return a;
    };
    function drillPlan(plan, dim, value) {
      var p = clonePlan(plan); p.metric = "list"; p.group = null; p.top = null; p.sort = null; p.notes = [];
      if (dim === "age") { var b = AGE_B.filter(function (x) { return x[0] === value; })[0]; if (b) { p.f.ageMin = b[1] === 0 ? null : b[1]; p.f.ageMax = b[2] >= 1e9 ? null : b[2]; } return p; }
      if (value === "(none)" || value === "(unknown)") { p.f.missing = (p.f.missing || []).concat([dim === "project" ? "client" : dim]); return p; }
      p.f[FKEY[dim]] = [value]; return p;
    }
    B.group = function (plan) {
      var dim = plan.group || "project", ef = effective(plan), meas = plan.measure, groups = {};
      if (meas === "slaMet" && !slaOk()) return { type: "text", text: "SLA numbers come from the SLA Tracker data, which isn’t available on this page. Open the Follow-up Tracker and ask again.", chips: [] };
      var list = select(plan);
      list.forEach(function (t) { groupKeys(t, dim).forEach(function (k) { (groups[k] = groups[k] || []).push(t); }); });
      var rows = Object.keys(groups).map(function (k) {
        var g = groups[k], r = { label: k, n: g.length, list: g };
        if (meas === "avg") { var vals = g.map(function (t) { return ef.closed === true ? resDays(t) : age(t); }).filter(function (x) { return x != null; }); r.v = vals.length ? vals.reduce(function (x, y) { return x + y; }, 0) / vals.length : 0; }
        else if (meas === "slaMet") { var met = 0, mis = 0, nh = 0; g.forEach(function (t) { var s = sla(t); if (!s) { nh++; return; } if (s.state === "met") met++; else if (s.state === "missed") mis++; else if (s.state === "nohist") nh++; }); r.met = met; r.mis = mis; r.nh = nh; r.v = met + mis ? met / (met + mis) * 100 : -1; }
        else r.v = g.length;
        return r;
      });
      if (dim === "age") rows.sort(function (a, b) { return AGE_B.map(function (x) { return x[0]; }).indexOf(a.label) - AGE_B.map(function (x) { return x[0]; }).indexOf(b.label); });
      else { if (meas === "slaMet") rows = rows.filter(function (r) { return r.v >= 0; }); rows.sort(function (a, b) { return plan.asc ? a.v - b.v || a.n - b.n : b.v - a.v || b.n - a.n; }); }
      var total = rows.length, topN = plan.top || (which_most(plan) ? 5 : 12); if (dim !== "age") rows = rows.slice(0, topN);
      var max = rows.reduce(function (m, r) { return Math.max(m, r.v); }, 1), sumN = list.length;
      var title = (meas === "avg" ? (ef.closed === true ? "Average resolution days" : "Average age (days)") : meas === "slaMet" ? "SLA met %" : "Tickets") + " by " + DIMLBL[dim].toLowerCase();
      var a = { type: "table", title: title, columns: meas === "slaMet" ? [DIMLBL[dim], "SLA met", "Met", "Missed", "No history"] : meas === "avg" ? [DIMLBL[dim], ef.closed === true ? "Avg days" : "Avg age (d)", "Tickets"] : [DIMLBL[dim], "Tickets", "Share"],
        rows: rows.map(function (r) {
          var cells = meas === "slaMet" ? [r.label, r.v.toFixed(1) + "%", r.met, r.mis, r.nh] : meas === "avg" ? [r.label, Math.round(r.v * 10) / 10, r.n] : [r.label, r.n, pct(r.n, sumN) + "%"];
          return { cells: cells, bar: max ? Math.max(0, r.v) / (meas === "slaMet" ? 100 : max) : 0, drill: drillPlan(plan, dim, r.label) };
        }), foot: total > rows.length ? "Showing " + rows.length + " of " + total + " — ask “top 30 …” for more." : "", total: sumN, chips: describe(plan),
        csv: { name: "by-" + dim, header: meas === "slaMet" ? [DIMLBL[dim], "SLA met %", "Met", "Missed", "No history"] : meas === "avg" ? [DIMLBL[dim], "Average", "Tickets"] : [DIMLBL[dim], "Tickets"], rows: rows.map(function (r) { return meas === "slaMet" ? [r.label, r.v.toFixed(1), r.met, r.mis, r.nh] : meas === "avg" ? [r.label, Math.round(r.v * 10) / 10, r.n] : [r.label, r.n]; }) },
        follow: [{ label: "List all " + fmtN(sumN), patch: { metric: "list", group: null } }].concat(followChips(plan, dim).filter(function (x) { return x.patch.metric === "group"; }).slice(0, 3)), hint: "Click a row to see its tickets." };
      if (!rows.length) { a.type = "text"; a.text = "No tickets match, so there is nothing to group. Try loosening one of these:"; a.chips = describe(plan); a.follow = relaxChips(plan); a.csv = null; }
      if (f_hasSla(plan) && !slaOk()) a.warn = "SLA data isn’t available on this page — open the Follow-up Tracker for SLA questions.";
      return a;
    };
    function which_most(plan) { return !plan.top && plan.superl; }
    B.avg = function (plan) {
      var ef = effective(plan), list = select(plan), vals = list.map(function (t) { return ef.closed === true ? resDays(t) : age(t); }).filter(function (x) { return x != null; });
      var avg = vals.length ? vals.reduce(function (x, y) { return x + y; }, 0) / vals.length : 0, idl = ef.closed === true ? [] : list.map(function (t) { return idle(t); }).filter(function (x) { return x != null; });
      return { type: "number", title: ef.closed === true ? "Average resolution time" : "Average ticket age", value: Math.round(avg * 10) / 10, unit: "days",
        sub: vals.length ? "median " + Math.round(median(vals)) + " days · oldest " + Math.round(Math.max.apply(null, vals)) + " days · " + fmtN(vals.length) + " tickets" + (idl.length ? " · avg " + Math.round(idl.reduce(function (x, y) { return x + y; }, 0) / idl.length) + " days since last status change" : "") : "No tickets match.",
        chips: describe(plan), follow: followChips(plan).filter(function (x) { return x.patch.metric === "group"; }).slice(0, 4).map(function (x) { return { label: "Average " + x.label.toLowerCase(), patch: { metric: "group", group: x.patch.group, measure: "avg" } }; }) };
    };
    B.slaMet = function (plan) {
      if (!slaOk()) return { type: "text", text: "SLA numbers come from the SLA Tracker data, which isn’t available on this page. Open the Follow-up Tracker and ask again.", chips: [] };
      var list = select(plan), met = 0, mis = 0, nh = 0, none = 0;
      list.forEach(function (t) { var s = sla(t); if (!s) { nh++; return; } if (s.state === "met") met++; else if (s.state === "missed") mis++; else if (s.state === "nohist") nh++; else none++; });
      var dec = met + mis, v = dec ? pct(met, dec) : null;
      return { type: "number", title: "SLA met", value: v == null ? "—" : v, unit: v == null ? "" : "%", sub: dec ? fmtN(met) + " met · " + fmtN(mis) + " missed (of " + fmtN(dec) + " closed with history)" + (nh ? " · " + fmtN(nh) + " closed tickets have no history and are NOT counted" : "") : "No closed tickets with status history match.",
        chips: describe(plan), follow: [{ label: "By client", patch: { metric: "group", group: "project", measure: "slaMet" } }, { label: "By priority", patch: { metric: "group", group: "priority", measure: "slaMet" } }, { label: "Missed tickets", patch: { metric: "list", f: Object.assign({}, plan.f, { sla: "missed", closed: true }) } }] };
    };
    B.slaSummary = function (plan) {
      if (!slaOk()) return { type: "text", text: "SLA data isn’t available on this page — open the Follow-up Tracker.", chips: [] };
      var list = select(plan), c = { breached: 0, atrisk: 0, duesoon: 0, ontrack: 0, paused: 0, nohist: 0, none: 0 };
      list.forEach(function (t) { var s = sla(t); if (!s) return; if (s.state === "breached") c.breached++; else if (s.state === "paused") c.paused++; else if (s.state === "nohist") c.nohist++; else if (s.state === "none") c.none++; else if (s.state === "running") { if (s.level === "danger") c.duesoon++; else if (s.atRisk) c.atrisk++; else c.ontrack++; } });
      var defs = [["Breached", "breached"], ["Due soon", "duesoon"], ["At risk", "atrisk"], ["On track", "ontrack"], ["With client (paused)", "paused"], ["No SLA data", "nohist"], ["No target", "none"]], tot = list.length;
      return { type: "table", title: "SLA position", columns: ["State", "Tickets", "Share"], rows: defs.map(function (d) { var p = clonePlan(plan); p.metric = "list"; p.f.sla = d[1]; return { cells: [d[0], c[d[1]], pct(c[d[1]], tot) + "%"], bar: tot ? c[d[1]] / tot : 0, drill: p }; }), chips: describe(plan), hint: "Click a row to see its tickets.", total: tot, follow: [] };
    };
    B.focus = function (plan) {
      var base = clonePlan(plan); base.metric = "list"; base.group = null; base.top = null; base.notes = [];
      var items = [
        ["Fires — Critical / Show Stopper, no status change 14+ days", { priority: ["Show Stopper", "Critical"], idleMin: 14, closed: false }, false],
        ["SLA breached and still open", { sla: "breached", closed: false }, true],
        ["Will breach soon (at risk)", { sla: "atrisk", closed: false }, true],
        ["Waiting on the client — no movement 14+ days", { owner: ["client"], idleMin: 14, closed: false }, false],
        ["With Help Desk — our action needed", { owner: ["hd"], closed: false }, false],
        ["With engineering — no movement 14+ days", { owner: ["engg"], idleMin: 14, closed: false }, false],
        ["No status change for 90+ days", { idleMin: 90, closed: false }, false],
        ["Open tickets with no priority", { missing: ["priority"], closed: false }, false]
      ], rows = [], max = 1;
      items.forEach(function (it) {
        if (it[2] && !slaOk()) return;
        var p = clonePlan(base); Object.keys(it[1]).forEach(function (k) { p.f[k] = it[1][k]; });
        var n = select(p).length; if (n > max) max = n; rows.push({ cells: [it[0], n], bar: n, drill: p });
      });
      rows.forEach(function (r) { r.bar = r.bar / max; });
      return { type: "table", title: "What needs attention", columns: ["Area", "Tickets"], rows: rows, hint: "Click a row to see those tickets.", chips: describe(plan).filter(function (c) { return !/^(open|closed) tickets$|^all statuses$/.test(c); }), total: 0, follow: [] };
    };
    B.overview = function (plan) {
      var list = select(plan), p = profile(list);
      var lines = [["Open tickets", p.open], ["HD action", p.hd], ["Awaiting client", p.client], ["With engineering", p.engg], ["Fires (Critical/Show Stopper, 14+ days)", p.fires], ["No status change 14+ days", p.stale], ["No status change 90+ days", p.danger], ["Average age (days)", p.avgAge]];
      if (slaOk()) lines.splice(7, 0, ["SLA breached", p.breached], ["SLA at risk", p.atrisk]);
      var mx = Math.max(1, p.open);
      return { type: "table", title: "Overview", columns: ["Measure", "Value"], rows: lines.map(function (l) { return { cells: [l[0], l[1]], bar: /Average/.test(l[0]) ? 0 : l[1] / mx }; }), chips: describe(plan), total: p.open, follow: followChips(plan).slice(0, 4) };
    };
    B.compare = function (plan) {
      var f = plan.f, sets = [], dimName = "";
      if (f.client.length > 1) { dimName = "Client"; f.client.forEach(function (v) { sets.push([v, { client: [v] }]); }); }
      else if (f.worker.length + f.svm.length > 1) { dimName = "Person"; f.worker.forEach(function (v) { sets.push([v, { worker: [v] }]); }); f.svm.forEach(function (v) { sets.push([v + " (SVM)", { svm: [v] }]); }); }
      else if (f.priority.length > 1) { dimName = "Priority"; f.priority.forEach(function (v) { sets.push([v, { priority: [v] }]); }); }
      else if (f.type.length > 1) { dimName = "Type"; f.type.forEach(function (v) { sets.push([v, { type: [v] }]); }); }
      if (sets.length < 2) return { type: "text", text: "Tell me what to compare — for example “compare Vijay and Naveen”, “MILAHA vs SWIPHX”, or “Critical vs High”.", chips: describe(plan), suggest: [] };
      var cols = [dimName, "Open", "HD action", "With client", "With engg", "Fires", "Stale 14d+", "Avg age (d)"].concat(slaOk() ? ["Breached"] : []);
      var rows = sets.map(function (s) { var over = Object.assign({ client: [], worker: [], svm: [], priority: [], type: f.type }, s[1]), p = profile(select(plan, over)); return { cells: [s[0], p.open, p.hd, p.client, p.engg, p.fires, p.stale, p.avgAge].concat(slaOk() ? [p.breached] : []), bar: 0 }; });
      return { type: "table", title: "Comparison", columns: cols, rows: rows, chips: describe(plan).filter(function (c) { return !/^(client|worker|SVM)/.test(c); }), total: 0, follow: [], wide: true, csv: { name: "comparison", header: cols, rows: rows.map(function (r) { return r.cells; }) } };
    };
    B.trend = function (plan) {
      var bucket = plan.bucket || "month", both = plan.series === "both", f = plan.f, ef = effective(plan);
      var p2 = clonePlan(plan); p2.f.range = null; if (both) { p2.f.closed = null; }
      var list = select(p2, both ? { closed: null, range: null } : { range: null });
      var to = f.range ? new Date(f.range.to) : now, fromD;
      if (f.range) fromD = new Date(f.range.from); else { fromD = new Date(now); if (bucket === "week") fromD.setDate(fromD.getDate() - 7 * 11); else { fromD.setMonth(fromD.getMonth() - 5); fromD.setDate(1); } }
      function keyOf0(ms) { var d = new Date(ms); if (bucket === "week") { var x = sod(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return +x; } return +new Date(d.getFullYear(), d.getMonth(), 1); }
      function keyOf(ms) { return keyOf0(ms); }
      fromD = new Date(keyOf(+fromD));
      var keysList = [], cur = new Date(keyOf(+fromD)); while (+cur <= +to && keysList.length < 60) { keysList.push(+cur); cur = bucket === "week" ? new Date(+cur + 7 * DAY) : new Date(cur.getFullYear(), cur.getMonth() + 1, 1); }
      function lab(k) { var d = new Date(k); return bucket === "week" ? d.getDate() + " " + MONNAME[d.getMonth()] : MONNAME[d.getMonth()] + " " + String(d.getFullYear()).slice(2); }
      function series(name, getDate) { var c = {}; keysList.forEach(function (k) { c[k] = 0; }); list.forEach(function (t) { var d = getDate(t); if (d == null) return; var k = keyOf(d); if (c[k] !== undefined && d >= +fromD && d <= +to) c[k]++; }); return { name: name, values: keysList.map(function (k) { return c[k]; }) }; }
      var S = both ? [series("Created", function (t) { return t.created; }), series("Closed", function (t) { return t.closed ? closeDate(t) : null; })]
        : [series(ef.dateField === "resolved" ? "Closed" : ef.dateField === "updated" ? "Updated" : "Created", function (t) { return dateOf(t, ef.dateField); })];
      var chips = describe(plan).filter(function (c) { return !/^(created|closed|updated) /.test(c); }); chips.push((bucket === "week" ? "weekly" : "monthly") + ": " + lab(keysList[0]) + " → " + lab(keysList[keysList.length - 1]));
      return { type: "trend", title: both ? "Created vs closed" : S[0].name + " tickets", labels: keysList.map(lab), series: S, chips: chips,
        csv: { name: "trend", header: ["Period"].concat(S.map(function (s) { return s.name; })), rows: keysList.map(function (k, i) { return [lab(k)].concat(S.map(function (s) { return s.values[i]; })); }) },
        follow: [{ label: bucket === "week" ? "Monthly" : "Weekly", patch: { bucket: bucket === "week" ? "month" : "week" } }].concat(both ? [] : [{ label: "Created vs closed", patch: { series: "both" } }]) };
    };
    function ticketItem(t) {
      var s = sla(t), r = row(t), lk = t.linked ? t.linked.split(/\s*[,;]\s*/).filter(Boolean) : [];
      return { raw: t.raw, key: t.key, url: base + t.key, summary: t.summary, fields: [["Status", t.status], ["Priority", t.priority || "—"], ["Client", t.project || "—"], ["Type", t.type || "—"], ["Current worker", t.worker || "—"], ["SVM in charge", t.svmRaw || "—"],
        ["Created", fmtD(t.created) + (r.age != null ? " (" + r.age + " days ago)" : "")], ["In current status", r.idle != null ? r.idle + " days" : "—"], ["Root cause", t.root || "—"], ["Screen", t.screen || "—"]],
        sla: s && s.state !== "na" && s.state !== "loading" ? { label: s.label || s.state, tip: s.tip || "", tone: s.tone || "" } : null, linked: lk.map(function (k) { return { key: k, url: base + k }; }), closed: t.closed, owner: ownerOf(t) };
    }
    B.ticket = function (plan) {
      var out = [], missing = [];
      plan.keys.slice(0, 3).forEach(function (k) { var t = byKey[k.toLowerCase()]; if (t) out.push(t); else missing.push(k); });
      if (!out.length) return { type: "text", text: "I couldn’t find " + missing.join(", ") + " in the loaded data. It may be newer than the file, or from a project that isn’t in it.", chips: [] };
      return { type: "ticketDetail", focus: plan.slaFocus ? "sla" : "details", items: out.map(ticketItem), missing: missing, chips: [] };
    };

    /* ── fallback ── */
    function fallback(plan, text) {
      var u = describe(plan).slice(2), sug = [];
      var c = E.project.slice().sort(function (a, b) { return b.n - a.n; })[0], p = E.person.slice().sort(function (a, b) { return b.n - a.n; })[0];
      if (plan.f.client.length) { var cn = plan.f.client[0]; sug = ["Open tickets for " + cn, "Breached tickets for " + cn, cn + " by priority", cn + " trend by month"]; }
      else if (plan.f.worker.length || plan.f.svm.length) { var pn = (plan.f.worker[0] || plan.f.svm[0]); sug = ["Open tickets for " + pn, pn + " tickets by client", "Oldest 10 tickets for " + pn, "Overview of " + pn]; }
      else sug = ["How many open tickets?", "Fires", "Breached tickets", "Open tickets by client", c ? "Overview of " + c.value : "Help"].concat(p ? ["Open tickets for " + p.value] : []).slice(0, 5);
      return { type: "text", text: u.length ? "I understood part of that — " + u.join(" · ") + " — but I’m not sure what you want to know about it." : "I’m not sure how to answer that one yet.", ignored: plan.ignored, suggest: sug, miss: true };
    }

    /* ═════════ public ═════════ */
    function run(plan) {
      if (!plan || !plan.metric) return fallback(plan || parse(""), "");
      var fn = B[plan.metric]; var a = fn ? fn(plan) : fallback(plan, "");
      if (plan.notes && plan.notes.length && a.type !== "help") a.notes = plan.notes.slice(0, 4);
      if (plan.personBoth && plan.f.worker.length && a.follow) a.follow = [{ label: "As SVM in charge instead", patch: { f: { worker: [], svm: plan.f.worker } } }].concat(a.follow).slice(0, 5);
      if (plan.ignored && plan.ignored.length && a.type !== "text") a.ignored = plan.ignored;
      return a;
    }
    function ask(text, prev) {
      var plan = parse(text, prev);
      if (plan.reset && !plan.metric) return { type: "text", text: "Okay — starting fresh. What would you like to know?", chips: [], plan: null, question: text };
      var a = (!plan.metric) ? fallback(plan, text) : run(plan);
      a.plan = (a.type === "text" && a.miss) ? prev || null : plan; a.question = text;
      return a;
    }
    function suggest(prefix) {
      var p = nz(prefix).trim(); if (p.length < 2) return [];
      var out = [];
      [E.project, E.person, E.status, E.type, E.root, E.screen].forEach(function (list) { list.forEach(function (e) { if (nz(e.value).indexOf(" " + p) > -1) out.push({ value: e.value, n: e.n }); }); });
      out.sort(function (a, b) { return b.n - a.n; });
      return uniq(out.map(function (x) { return x.value; })).slice(0, 6);
    }
    function starters() {
      var c = E.project.slice().sort(function (a, b) { return b.n - a.n; })[0], list = ["What needs attention today?", "How many open tickets?", "What's overdue?", "Who has the most work?", "Open tickets by client", "How are we doing?"];
      if (c) list.splice(5, 0, "Tell me about " + c.value);
      return list.slice(0, 6);
    }
    return { ticketInfo: function (key) { var t = byKey[String(key || "").toLowerCase()]; return t ? ticketItem(t) : null; }, ask: ask, run: run, parse: parse, suggest: suggest, starters: starters, applyPatch: applyPatch,
      stats: { tickets: T.length, open: T.filter(function (t) { return !t.closed && t.support; }).length, clients: E.project.length, people: E.person.length } };
  }
  var api = { createEngine: createEngine, applyPatch: applyPatch, _util: { extractRange: extractRange, nz: nz } };
  if (typeof module === "object" && module.exports) module.exports = api; else root.HDChatEngine = api;
})(typeof self !== "undefined" ? self : this);


/* ══════════ HD Dashboards — "Ask" chat window ══════════
   Floating assistant for every dashboard. No AI: it answers from the tickets already stored in this browser
   (HDStore) using the engine above, with the same SLA numbers as the dashboards (HDSlaLink).
   Lives in a shadow root, so page styles can't touch it and it can't touch the page. */
(function () {
  "use strict";
  if (window.__hdChatUI || typeof document === "undefined") return; window.__hdChatUI = true;
  var Eng = window.HDChatEngine;
  if (!Eng) return;

  var S = { modal: null, engine: null, rows: null, loading: null, loadedAt: 0, stale: false, prev: null, answers: [], hist: [], hpos: 0, open: false, wide: false, misses: [] };
  try { S.misses = JSON.parse(localStorage.getItem("hd-chat-misses") || "[]") || []; } catch (e) { S.misses = []; }
  function saveMisses() { try { localStorage.setItem("hd-chat-misses", JSON.stringify(S.misses.slice(-200))); } catch (e) {} }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(n) { return typeof n === "number" ? n.toLocaleString("en-US") : esc(n); }

  /* ───────── data ───────── */
  function parseBlob(blob) {
    return new Promise(function (res, rej) {
      if (typeof XLSX === "undefined") return rej(new Error("The Excel reader is not loaded on this page."));
      var r = new FileReader();
      r.onload = function (e) {
        try {
          var wb = XLSX.read(e.target.result, { type: "array", cellDates: true });
          var sn = wb.SheetNames.filter(function (s) { return s.toLowerCase().indexOf("jira") > -1; })[0] || wb.SheetNames[1] || wb.SheetNames[0];
          res(XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: "" }));
        } catch (err) { rej(err); }
      };
      r.onerror = function () { rej(new Error("Could not read the saved file.")); };
      r.readAsArrayBuffer(blob);
    });
  }
  function buildEngine() {
    var L = window.HDSlaLink, C = window.HDClass;
    S.engine = Eng.createEngine({ rows: S.rows, now: Date.now(), classify3: C && C.classify3 ? function (s) { return C.classify3(s); } : null,
      slaGet: L && L.get ? function (r) { return L.get(r); } : null, lastMove: L && L.lastMove ? function (r) { return L.lastMove(r); } : null });
    S.stale = false;
  }
  function loadData(force) {
    if (S.loading && !force) return S.loading;
    S.loading = (function () {
      var HS = window.HDStore, L = window.HDSlaLink;
      var cfgP = HS && HS.loadConfig && window.HDClass && window.HDClass.setOverrides ? HS.loadConfig().then(function (c) { if (c && c.statusOverrides && !Object.keys(window.HDClass.getOverrides() || {}).length) window.HDClass.setOverrides(c.statusOverrides); }, function () {}) : Promise.resolve();
      var rowsP = HS && HS.loadRows ? HS.loadRows().catch(function () { return null; }) : Promise.resolve(null);
      return Promise.all([rowsP, cfgP]).then(function (a) {
        var rows = a[0];
        if (rows && rows.length) return rows;
        if (HS && HS.loadFile) return HS.loadFile().then(function (rec) { return rec && rec.blob ? parseBlob(rec.blob) : null; });
        return null;
      }).then(function (rows) {
        if (!rows || !rows.length) throw new Error("NODATA");
        S.rows = rows;
        return L && L.ready && !L.ready() && L.load ? L.load().catch(function () {}) : null;
      }).then(function () {
        buildEngine(); S.loadedAt = Date.now();
        if (window.HDSlaLink && window.HDSlaLink.subscribe && !S.sub) S.sub = window.HDSlaLink.subscribe(function () { S.stale = true; });
        setStatus();
      });
    })();
    S.loading["catch"](function () { S.loading = null; });
    return S.loading;
  }
  function ensureEngine() {
    return loadData().then(function () {
      if (S.stale && S.rows) buildEngine();
      return S.engine;
    });
  }

  /* ───────── shadow DOM shell ───────── */
  var host = document.createElement("div"); host.id = "hd-chat-host"; host.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147482000";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var CSS = "\
:host{all:initial}*{box-sizing:border-box;font-family:'Inter','Segoe UI',system-ui,-apple-system,sans-serif}\
.fab{position:fixed;right:22px;bottom:22px;height:52px;padding:0 18px 0 14px;border-radius:26px;border:none;cursor:pointer;display:flex;align-items:center;gap:9px;color:#fff;font-size:14px;font-weight:700;letter-spacing:-.1px;\
background:linear-gradient(135deg,#2563EB,#7C3AED);box-shadow:0 10px 28px -8px rgba(79,70,229,.6),0 2px 6px rgba(15,23,42,.18);transition:transform .15s,box-shadow .2s}\
.fab:hover{transform:translateY(-2px);box-shadow:0 14px 32px -8px rgba(79,70,229,.7),0 2px 6px rgba(15,23,42,.2)}.fab svg{flex-shrink:0}.fab.hide{display:none}\
.panel{position:fixed;right:22px;bottom:22px;width:min(440px,calc(100vw - 24px));height:min(700px,calc(100vh - 44px));background:#fff;border-radius:20px;border:1px solid #E2E8F0;display:none;flex-direction:column;overflow:hidden;\
box-shadow:0 24px 70px -12px rgba(15,23,42,.35),0 4px 14px rgba(15,23,42,.1);color:#0F172A}\
.panel.open{display:flex;animation:pop .22s cubic-bezier(.22,1,.36,1)}.panel.wide{width:min(820px,calc(100vw - 24px));height:calc(100vh - 44px)}\
@keyframes pop{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}\
@media(max-width:520px){.panel,.panel.wide{right:0;bottom:0;width:100vw;height:100vh;border-radius:0}.fab{right:14px;bottom:14px}#wide{display:none}}\
.hd{display:flex;align-items:center;gap:10px;padding:13px 14px 12px 16px;border-bottom:1px solid #EEF2F7;background:linear-gradient(120deg,#F8FAFF,#F3F0FF)}\
.logo{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,#2563EB,#7C3AED);display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0}\
.ttl{flex:1;min-width:0}.ttl b{display:block;font-size:14.5px;font-weight:800;letter-spacing:-.2px}.ttl span{display:block;font-size:11px;color:#64748B;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\
.ib{width:30px;height:30px;border-radius:9px;border:none;background:transparent;color:#475569;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:15px;position:relative}.ib:hover{background:rgba(15,23,42,.07)}\
.menu{position:absolute;right:10px;top:54px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;box-shadow:0 12px 30px -8px rgba(15,23,42,.3);padding:6px;display:none;z-index:5;min-width:210px}.menu.open{display:block}\
.menu button{display:block;width:100%;text-align:left;padding:8px 10px;border:none;background:none;border-radius:8px;font-size:12.5px;color:#334155;cursor:pointer}.menu button:hover{background:#F1F5F9}\
.msgs{flex:1;overflow-y:auto;padding:16px 14px 8px;background:#F8FAFC;scroll-behavior:smooth}\
.row{display:flex;margin-bottom:12px}.row.u{justify-content:flex-end}.u .bub{background:linear-gradient(135deg,#2563EB,#4F46E5);color:#fff;border-radius:16px 16px 4px 16px;padding:9px 14px;font-size:13.5px;max-width:84%;word-break:break-word;box-shadow:0 4px 12px -4px rgba(37,99,235,.5)}\
.b{max-width:100%;width:100%;animation:up .25s ease both}@keyframes up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}\
.card{background:#fff;border:1px solid #E5EAF1;border-radius:16px;padding:14px 15px;box-shadow:0 1px 2px rgba(15,23,42,.04)}\
.card h4{margin:0 0 2px;font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:#64748B}\
.big{font-size:42px;font-weight:800;letter-spacing:-1.5px;line-height:1.05;color:#0F172A;font-variant-numeric:tabular-nums}.big small{font-size:15px;font-weight:700;color:#64748B;letter-spacing:0;margin-left:6px}\
.sub{font-size:12.5px;color:#475569;margin-top:5px;line-height:1.45}\
.say{font-size:13.5px;line-height:1.5;color:#1E293B}.say b{font-weight:700}\
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:11px;align-items:center}.chips .lab{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#94A3B8;margin-right:2px}\
.tag{font-size:11px;font-weight:600;padding:3px 9px;border-radius:99px;background:#EEF2FF;color:#3730A3;border:1px solid #E0E7FF;white-space:nowrap}\
.fl{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;padding-top:11px;border-top:1px dashed #E5EAF1}\
.btn,.chip{font-size:12px;font-weight:600;padding:6px 12px;border-radius:99px;border:1px solid #D7DEEA;background:#fff;color:#1E293B;cursor:pointer;transition:all .12s;text-align:left}\
.btn:hover,.chip:hover{border-color:#6366F1;color:#4338CA;background:#F5F3FF;transform:translateY(-1px)}.btn.pri{background:#2563EB;border-color:#2563EB;color:#fff}.btn.pri:hover{background:#1D4ED8;color:#fff}\
.warn{margin-top:10px;font-size:12px;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:7px 10px}\
.ign{margin-top:9px;font-size:11.5px;color:#94A3B8}\
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}th{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#94A3B8;text-align:left;padding:5px 8px;border-bottom:1px solid #E5EAF1}\
td{padding:7px 8px;border-bottom:1px solid #F1F5F9;vertical-align:middle}tr.dr{cursor:pointer}tr.dr:hover td{background:#F5F7FF}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}td.l{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
.bar{height:6px;border-radius:9px;background:#EEF2F7;overflow:hidden;min-width:60px}.bar i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,#3B82F6,#6366F1)}\
.tw{overflow-x:auto}.hint{font-size:11.5px;color:#94A3B8;margin-top:8px}\
.tr{padding:9px 0;border-bottom:1px solid #F1F5F9}.tr:last-child{border:none}.t1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}\
a.key{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:12px;color:#2563EB;text-decoration:none}a.key:hover{text-decoration:underline}\
.pill{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:99px;background:#F1F5F9;color:#475569;white-space:nowrap}\
.p-show-stopper,.p-critical{background:#FFE4E6;color:#BE123C}.p-high{background:#FEF3C7;color:#B45309}.p-medium{background:#DBEAFE;color:#1D4ED8}.p-low{background:#DCFCE7;color:#047857}\
.sla{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:6px;white-space:nowrap}.s-red{background:#FEE2E2;color:#BE123C}.s-orange{background:#FFEDD5;color:#C2410C}.s-amber{background:#FEF3C7;color:#B45309}.s-green{background:#DCFCE7;color:#047857}.s-grey{background:#F1F5F9;color:#475569}\
.t2{font-size:12.5px;color:#334155;margin-top:3px;line-height:1.4}.t3{font-size:11px;color:#94A3B8;margin-top:2px}\
.legend{display:flex;gap:12px;font-size:11.5px;color:#475569;margin:8px 0 2px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}\
.kv{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin-top:10px}.kv div{font-size:12.5px;color:#0F172A;font-weight:600;word-break:break-word}.kv span{display:block;font-size:10px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#94A3B8;margin-bottom:1px}\
.tl{margin-top:12px;border-left:2px solid #E2E8F0;padding-left:12px}.tl div{font-size:12px;color:#334155;margin:0 0 7px;position:relative}.tl div:before{content:'';position:absolute;left:-17px;top:5px;width:8px;height:8px;border-radius:50%;background:#6366F1}.tl small{color:#94A3B8}\
.ex h5{margin:12px 0 6px;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#64748B}.ex .chips{margin-top:0}\
.typing{display:inline-flex;gap:4px;padding:12px 14px;background:#fff;border:1px solid #E5EAF1;border-radius:14px}.typing i{width:6px;height:6px;border-radius:50%;background:#94A3B8;animation:bl 1.1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes bl{0%,60%,100%{opacity:.25}30%{opacity:1}}\
.foot{border-top:1px solid #EEF2F7;padding:10px 12px 12px;background:#fff;position:relative}\
.ac{position:absolute;left:12px;right:12px;bottom:58px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;box-shadow:0 12px 30px -8px rgba(15,23,42,.3);padding:5px;display:none;z-index:4}.ac.open{display:block}\
.ac button{display:block;width:100%;text-align:left;border:none;background:none;padding:7px 10px;border-radius:8px;font-size:12.5px;color:#334155;cursor:pointer}.ac button:hover,.ac button.on{background:#EEF2FF;color:#3730A3}\
.in{display:flex;gap:8px;align-items:center;background:#F1F5F9;border:1.5px solid transparent;border-radius:14px;padding:4px 4px 4px 14px;transition:all .15s}.in:focus-within{background:#fff;border-color:#6366F1;box-shadow:0 0 0 4px rgba(99,102,241,.12)}\
.in input{flex:1;border:none;background:transparent;outline:none;font-size:14px;color:#0F172A;padding:9px 0;min-width:0}.in input::placeholder{color:#94A3B8}\
.send{width:36px;height:36px;border-radius:11px;border:none;background:linear-gradient(135deg,#2563EB,#4F46E5);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}.send:disabled{opacity:.45;cursor:default}\
.note{font-size:10.5px;color:#94A3B8;text-align:center;margin-top:7px}\
.tr{cursor:pointer;border-radius:10px;padding:9px 8px;margin:0 -8px;transition:background .12s}.tr:hover{background:#F5F7FF}.tr .key{color:#2563EB}\
.ov{position:fixed;inset:0;background:rgba(15,23,42,.5);backdrop-filter:blur(3px);display:none;align-items:flex-start;justify-content:center;padding:26px 14px;overflow:auto;z-index:10}.ov.open{display:flex;animation:fade .15s ease}@keyframes fade{from{opacity:0}to{opacity:1}}\
.mod{background:#fff;border-radius:20px;width:min(920px,100%);box-shadow:0 30px 80px -10px rgba(15,23,42,.5);margin:auto 0;animation:pop .22s cubic-bezier(.22,1,.36,1);color:#0F172A}\
.mh{display:flex;gap:14px;align-items:flex-start;padding:18px 22px 14px;border-bottom:1px solid #EEF2F7;position:sticky;top:0;background:#fff;border-radius:20px 20px 0 0;z-index:2}.mh .l{flex:1;min-width:0}\
.mt{font-size:15px;font-weight:600;margin-top:6px;line-height:1.35}.mm{font-size:11.5px;color:#64748B;margin-top:4px;line-height:1.5}\
.tabs{display:flex;gap:4px;padding:0 22px;border-bottom:1px solid #EEF2F7;background:#fff}.tabs button{border:none;background:none;padding:11px 14px;font-size:12.5px;font-weight:700;color:#64748B;cursor:pointer;border-bottom:2.5px solid transparent;margin-bottom:-1px}.tabs button.on{color:#2563EB;border-bottom-color:#2563EB}\
.mb{padding:16px 22px 24px}.kpis{display:flex;gap:10px;flex-wrap:wrap}.kp{flex:1 1 170px;border:1px solid #E5EAF1;border-left:4px solid #94A3B8;border-radius:12px;padding:12px 14px;background:#fff}\
.kv1{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:21px;font-weight:800;line-height:1.1}.kl{font-size:12px;font-weight:600;color:#475569;margin-top:6px}.ks{font-size:11px;color:#94A3B8;margin-top:1px}\
.expl{background:#F8FAFC;border:1px solid #E5EAF1;border-radius:10px;padding:11px 14px;font-size:12.5px;color:#475569;line-height:1.65;margin:10px 0}.expl b{color:#0F172A}.expl .w{color:#B45309;margin-top:6px}\
.bx{border:1px solid #E5EAF1;border-radius:10px;padding:10px 14px;margin:0 0 12px;background:#fff}.bx h5{margin:0 0 6px;font-size:13px;font-weight:700;color:#0F172A}.bx h5 span{font-weight:500;font-size:11.5px;color:#94A3B8}\
.bx table{margin:0}.bx th{width:120px;text-align:left;font-weight:600;color:#94A3B8;padding:4px 10px 4px 0;vertical-align:top;font-size:12px;letter-spacing:0;text-transform:none;border:none;white-space:nowrap}.bx td{padding:4px 0;font-size:12.5px;color:#475569;border:none;white-space:normal}\
.h6{font-size:13px;font-weight:700;margin:14px 0 6px}.kc{padding:2px 9px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap}\
.sh{height:10px;background:#E8EDF3;border-radius:5px;overflow:hidden;min-width:120px}.sh i{display:block;height:100%}\
.empty{padding:34px 18px;text-align:center;color:#475569;font-size:13px;line-height:1.6}.empty b{color:#0F172A}\
details.st{margin-top:12px;border:1px solid #E5EAF1;border-radius:10px;padding:0 12px}details.st summary{cursor:pointer;font-size:13px;font-weight:700;padding:10px 0;color:#0F172A}details.st table{margin-bottom:10px}\
a.btn{text-decoration:none;display:inline-block;color:#1E293B}a.btn:hover{color:#4338CA}\
@media(max-width:520px){.ov{padding:0}.mod{border-radius:0;min-height:100%}.mh{border-radius:0}.mb{padding:14px 14px 22px}.tabs{padding:0 12px}}\
";
  var SVG_CHAT = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14.5h4"/></svg>';
  root.innerHTML = '<style>' + CSS + '</style>' +
    '<button class="fab" id="fab" title="Ask questions about your tickets">' + SVG_CHAT + '<span>Ask HD</span></button>' +
    '<div class="panel" id="panel" role="dialog" aria-label="Ask HD data">' +
      '<div class="hd"><div class="logo">' + SVG_CHAT + '</div><div class="ttl"><b>Ask HD Data</b><span id="status">Answers come from the tickets loaded in this app</span></div>' +
      '<button class="ib" id="reload" title="Reload data">↻</button><button class="ib" id="wide" title="Make bigger">⤢</button><button class="ib" id="more" title="More">⋯</button><button class="ib" id="close" title="Close">✕</button></div>' +
      '<div class="menu" id="menu"><button data-m="clear">Clear conversation</button><button data-m="misses">Questions I couldn’t answer (<span id="mc">0</span>)</button><button data-m="help">What can I ask?</button></div>' +
      '<div class="msgs" id="msgs"></div>' +
      '<div class="foot"><div class="ac" id="ac"></div><div class="in"><input id="inp" type="text" autocomplete="off" spellcheck="false" placeholder="Ask about tickets, clients, SLA, workers…" maxlength="300"/><button class="send" id="send" title="Send">' +
      '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>' +
      '<div class="note">Rule-based assistant — no AI, nothing leaves your browser.</div></div></div>' +
    '<div class="ov" id="ov"></div>';
  function $(id) { return root.getElementById ? root.getElementById(id) : root.querySelector("#" + id); }
  var fab, panel, msgs, inp, send, ac, menu, ov;

  function setStatus() {
    var el = $("status"); if (!el) return;
    if (!S.engine) { el.textContent = "Answers come from the tickets loaded in this app"; return; }
    var st = S.engine.stats; el.textContent = fmt(st.open) + " open · " + fmt(st.tickets) + " tickets · " + fmt(st.clients) + " clients loaded";
    var mc = $("mc"); if (mc) mc.textContent = S.misses.length;
  }
  function scrollDown() { setTimeout(function () { msgs.scrollTop = msgs.scrollHeight; }, 30); }
  function addRow(cls, html) { var d = document.createElement("div"); d.className = "row " + cls; d.innerHTML = html; msgs.appendChild(d); scrollDown(); return d; }
  function userMsg(t) { addRow("u", '<div class="bub">' + esc(t) + "</div>"); }
  function typing() { return addRow("b", '<div class="typing"><i></i><i></i><i></i></div>'); }

  /* ───────── answer cards ───────── */
  function notesHtml(a) { return a.notes && a.notes.length ? '<div class="ign">ℹ ' + a.notes.map(esc).join(" · ") + "</div>" : ""; }
  function chipsHtml(chips) { return chips && chips.length ? '<div class="chips"><span class="lab">Showing</span>' + chips.map(function (c) { return '<span class="tag">' + esc(c) + "</span>"; }).join("") + "</div>" : ""; }
  function followHtml(a, id) {
    var h = "";
    if (a.follow && a.follow.length) h += a.follow.map(function (f, i) { return '<button class="chip" data-act="follow" data-a="' + id + '" data-i="' + i + '">' + esc(f.label) + "</button>"; }).join("");
    if (a.csv && a.csv.rows && a.csv.rows.length) h += '<button class="btn" data-act="csv" data-a="' + id + '">⬇ Download CSV (' + fmt(a.csv.rows.length) + ")</button>";
    return h ? '<div class="fl">' + h + "</div>" : "";
  }
  function tone(s) {
    if (!s) return "grey"; if (s.tone) return { red: "red", orange: "orange", amber: "amber", green: "green", grey: "grey" }[s.tone] || "grey";
    return s.state === "breached" || s.state === "missed" ? "red" : s.state === "met" ? "green" : "grey";
  }
  function ticketRow(t, id, i) {
    var pr = t.priority ? '<span class="pill p-' + esc(t.priority.toLowerCase().replace(/\s+/g, "-")) + '">' + esc(t.priority) + "</span>" : "";
    var sl = t.sla && t.sla.label ? '<span class="sla s-' + tone(t.sla) + '">' + esc(t.sla.label) + "</span>" : "";
    var meta = [t.project, t.worker, t.age != null ? t.age + "d old" : "", t.idle != null ? t.idle + "d in status" : ""].filter(Boolean).map(esc).join(" · ");
    return '<div class="tr" data-act="open" data-a="' + id + '" data-i="' + i + '" title="Click for details"><div class="t1"><span class="key" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:12px">' + esc(t.key) + '</span><span class="pill">' + esc(t.status) + "</span>" + pr + sl + '</div><div class="t2">' + esc(t.summary) + '</div><div class="t3">' + meta + "</div></div>";
  }
  function barSvg(a) {
    var W = 400, H = 176, L = 28, B = 24, T = 10, labels = a.labels, ns = a.series.length, max = 1;
    a.series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    var step = max <= 5 ? 1 : Math.ceil(max / 4 / 5) * 5, top = Math.ceil(max / step) * step, ph = H - T - B, pw = W - L - 6, gw = pw / labels.length, bw = Math.min(26, gw * 0.72 / ns), cols = ["#2563EB", "#10B981"], svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img">';
    for (var g = 0; g <= top; g += step) { var y = T + ph - g / top * ph; svg += '<line x1="' + L + '" x2="' + (W - 4) + '" y1="' + y + '" y2="' + y + '" stroke="#EEF2F7"/><text x="' + (L - 5) + '" y="' + (y + 3.5) + '" font-size="9.5" fill="#94A3B8" text-anchor="end">' + g + "</text>"; }
    labels.forEach(function (lb, i) {
      var cx = L + gw * i + gw / 2;
      a.series.forEach(function (s, k) {
        var v = s.values[i], h = v / top * ph, x = cx - (bw * ns) / 2 + k * bw;
        svg += '<rect x="' + x.toFixed(1) + '" y="' + (T + ph - h).toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + Math.max(h, v ? 1.5 : 0).toFixed(1) + '" rx="3" fill="' + cols[k % 2] + '"><title>' + esc(s.name + " · " + lb + ": " + v) + "</title></rect>";
        if (labels.length <= 14 && ns === 1) svg += '<text x="' + (x + (bw - 2) / 2).toFixed(1) + '" y="' + (T + ph - h - 3).toFixed(1) + '" font-size="9.5" fill="#475569" text-anchor="middle" font-weight="700">' + v + "</text>";
      });
      if (labels.length <= 16 || i % Math.ceil(labels.length / 12) === 0) svg += '<text x="' + cx.toFixed(1) + '" y="' + (H - 7) + '" font-size="9.5" fill="#64748B" text-anchor="middle">' + esc(lb) + "</text>";
    });
    return svg + "</svg>";
  }
  function render(a, id) {
    var h = "";
    switch (a.type) {
      case "number":
        h = '<div class="card"><h4>' + esc(a.title) + '</h4><div class="big">' + fmt(a.value) + (a.unit ? "<small>" + esc(a.unit) + "</small>" : "") + "</div>" + (a.sub ? '<div class="sub">' + esc(a.sub) + "</div>" : "") +
          (a.warn ? '<div class="warn">' + esc(a.warn) + "</div>" : "") + chipsHtml(a.chips) + notesHtml(a) + followHtml(a, id) + (a.ignored && a.ignored.length ? '<div class="ign">Ignored: ' + a.ignored.map(esc).join(", ") + "</div>" : "") + "</div>"; break;
      case "tickets": {
        var items = a.items, first = items.slice(0, 8);
        h = '<div class="card"><h4>' + esc(a.title) + (a.limited ? " · showing " + a.items.length : "") + '</h4>' + (a.total ? '<div class="hint" style="margin:2px 0 4px">Click a ticket for its ' + (a.slaContext ? "SLA breakdown" : "details and SLA") + ".</div>" : "") + (a.total ? '<div data-list="' + id + '">' + first.map(function (t, i) { return ticketRow(t, id, i); }).join("") + "</div>" : '<div class="say">No tickets match.' + (a.emptyHint ? "<br><span style=\"color:#64748B\">" + esc(a.emptyHint) + "</span>" : "") + "</div>") +
          (items.length > 8 ? '<div class="fl" style="border:none;margin-top:4px;padding-top:0"><button class="btn" data-act="more" data-a="' + id + '">Show more (' + fmt(items.length - 8) + ")</button></div>" : "") +
          (a.more ? '<div class="hint">+' + fmt(a.more) + " more — download the CSV to see all.</div>" : "") + (a.warn ? '<div class="warn">' + esc(a.warn) + "</div>" : "") + chipsHtml(a.chips) + notesHtml(a) + followHtml(a, id) +
          (a.ignored && a.ignored.length ? '<div class="ign">Ignored: ' + a.ignored.map(esc).join(", ") + "</div>" : "") + "</div>"; break; }
      case "table": {
        var meas = a.rows.length && typeof a.rows[0].bar === "number";
        h = '<div class="card"><h4>' + esc(a.title) + '</h4><div class="tw"><table><thead><tr>' + a.columns.map(function (c, i) { return "<th" + (i > 0 ? ' class="n"' : "") + ">" + esc(c) + "</th>"; }).join("") + (meas && !a.wide ? "<th></th>" : "") + "</tr></thead><tbody>" +
          a.rows.map(function (r, ri) { return '<tr class="' + (r.drill ? "dr" : "") + '"' + (r.drill ? ' data-act="drill" data-a="' + id + '" data-i="' + ri + '"' : "") + ">" + r.cells.map(function (c, i) { return i === 0 ? '<td class="l" title="' + esc(c) + '">' + esc(c) + "</td>" : '<td class="n">' + fmt(c) + "</td>"; }).join("") + (meas && !a.wide ? '<td style="width:22%"><div class="bar"><i style="width:' + Math.round(Math.min(1, r.bar) * 100) + '%"></i></div></td>' : "") + "</tr>"; }).join("") + "</tbody></table></div>" +
          (a.hint ? '<div class="hint">' + esc(a.hint) + "</div>" : "") + (a.foot ? '<div class="hint">' + esc(a.foot) + "</div>" : "") + (a.warn ? '<div class="warn">' + esc(a.warn) + "</div>" : "") + chipsHtml(a.chips) + notesHtml(a) + followHtml(a, id) + (a.ignored && a.ignored.length ? '<div class="ign">Ignored: ' + a.ignored.map(esc).join(", ") + "</div>" : "") + "</div>"; break; }
      case "trend":
        h = '<div class="card"><h4>' + esc(a.title) + "</h4>" + (a.series.length > 1 ? '<div class="legend"><span><i style="background:#2563EB"></i>' + esc(a.series[0].name) + '</span><span><i style="background:#10B981"></i>' + esc(a.series[1].name) + "</span></div>" : "") + barSvg(a) + chipsHtml(a.chips) + notesHtml(a) + followHtml(a, id) + "</div>"; break;
      case "ticketDetail":
        h = a.items.map(function (t, i) {
          var slaBlock = a.focus === "sla" ? slaHtml(t.raw, true) : (t.sla && t.sla.tip ? '<div class="sub" style="margin-top:6px">' + esc(t.sla.tip) + "</div>" : "");
          return '<div class="card" style="margin-bottom:8px"><h4>Ticket</h4><div class="t1" style="margin-top:2px"><span class="key" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;font-size:15px">' + esc(t.key) + "</span>" + (t.sla ? '<span class="sla s-' + tone(t.sla) + '">' + esc(t.sla.label) + "</span>" : "") + "</div>" +
            '<div class="say" style="margin-top:4px">' + esc(t.summary) + "</div>" + (a.focus === "sla" ? '<div style="margin-top:10px">' + slaBlock + "</div>" : slaBlock) + '<div class="kv">' + t.fields.map(function (f) { return "<div><span>" + esc(f[0]) + "</span>" + esc(f[1]) + "</div>"; }).join("") + "</div>" +
            (t.linked.length ? '<div class="chips"><span class="lab">Linked</span>' + t.linked.map(function (l) { return '<a class="tag" style="text-decoration:none" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.key) + "</a>"; }).join("") + "</div>" : "") +
            '<div class="fl"><button class="btn pri" data-act="openk" data-a="' + id + '" data-i="' + i + '">Full SLA breakdown</button><a class="btn" href="' + esc(t.url) + '" target="_blank" rel="noopener">Open in Jira ↗</a></div></div>';
        }).join("") + (a.missing && a.missing.length ? '<div class="card"><div class="say">Not found in the data: ' + a.missing.map(esc).join(", ") + "</div></div>" : ""); break;
      case "help":
        h = '<div class="card ex"><h4>What you can ask</h4><div class="say" style="margin-top:4px">Counts, lists, rankings, SLA, trends and comparisons — in your own words. Click any example:</div>' +
          a.examples.map(function (g) { return "<h5>" + esc(g[0]) + '</h5><div class="chips">' + g[1].map(function (q) { return '<button class="chip" data-act="ask" data-q="' + esc(q) + '">' + esc(q) + "</button>"; }).join("") + "</div>"; }).join("") + '<div class="hint" style="margin-top:12px">' + esc(a.note) + "</div></div>"; break;
      default: {
        h = '<div class="card"><div class="say">' + esc(a.text || "") + "</div>" + (a.warn ? '<div class="warn">' + esc(a.warn) + "</div>" : "") + chipsHtml(a.chips && a.chips.length ? a.chips : []) + notesHtml(a) +
          (a.ignored && a.ignored.length ? '<div class="ign">Words I didn’t understand: ' + a.ignored.map(esc).join(", ") + "</div>" : "") +
          (a.follow && a.follow.length ? followHtml(a, id) : "") + (a.suggest && a.suggest.length ? '<div class="fl" style="border:none;padding-top:0"><span class="lab" style="width:100%;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#94A3B8">Try one of these</span>' + a.suggest.map(function (q) { return '<button class="chip" data-act="ask" data-q="' + esc(q) + '">' + esc(q) + "</button>"; }).join("") + "</div>" : "") + "</div>";
      }
    }
    return '<div class="b">' + h + "</div>";
  }
  function showAnswer(a) {
    var id = S.answers.push(a) - 1, d = addRow("b", render(a, id));
    /* a tall answer starts at its top, so you read it from the first line instead of landing at its end */
    setTimeout(function () { if (d.offsetHeight > msgs.clientHeight * 0.75) msgs.scrollTop = Math.max(0, d.offsetTop - 12); }, 60);
    if (a.type === "text" && a.miss && a.question) { S.misses.push({ q: a.question, t: new Date().toISOString().slice(0, 16).replace("T", " ") }); saveMisses(); var mc = $("mc"); if (mc) mc.textContent = S.misses.length; }
    return d;
  }

  /* ───────── ticket pop-up: SLA breakdown + ticket details (same numbers as the SLA Tracker) ───────── */
  var IST = "Asia/Kolkata", KIND = { hd: ["Help Desk", "#0F766E", "#D6F3EE", "#14B8A6"], engg: ["Engineering", "#5B57D8", "#E2E1FB", "#5B57D8"], client: ["Client", "#B45309", "#FEF3C7", "#F0A838"], closed: ["Closed", "#475569", "#E5E9EF", "#B8C2CF"] };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function W(ms) { return ms == null ? "—" : new Date(ms).toLocaleString("en-GB", { timeZone: IST, weekday: "short", day: "2-digit", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
  function isoTxt(iso) { var p = iso.split("-"); return p[2] + " " + MON[+p[1] - 1] + " " + p[0].slice(2); }
  function kindChip(k) { var c = KIND[k] || KIND.hd; return '<span class="kc" style="background:' + c[2] + ";color:" + c[1] + '">' + c[0] + "</span>"; }
  function kpi(label, value, sub, color) { return '<div class="kp" style="border-left-color:' + color + '"><div class="kv1">' + esc(value) + '</div><div class="kl">' + esc(label) + '</div><div class="ks">' + esc(sub) + "</div></div>"; }
  function breachSentence(bi, d) {
    var F = d.fmt; if (!bi) return "";
    switch (bi.state) {
      case "running": return "At the current pace it <b>breaches on " + W(bi.breachAt) + " IST</b> (" + F(bi.remainingMin) + " of working time left). ";
      case "paused": return "The clock is <b>paused</b> while the ticket is with the client, with " + F(bi.remainingMin) + " of working time left. If it came back now it would breach on <b>" + W(bi.ifResumedAt) + " IST</b>. ";
      case "breached": return "<b>Breached on " + W(bi.breachedAt) + " IST</b> and now " + F(bi.overByMin) + " over target. ";
      case "missed": return "Closed after breaching on <b>" + W(bi.breachedAt) + " IST</b>. ";
    } return "";
  }
  /* compact = the four clock tiles + one explanation (used inside a chat card); full = the whole breakdown */
  function slaHtml(raw, compact) {
    var L = window.HDSlaLink;
    if (!raw) return "";
    if (!L || !L.detail) return '<div class="empty"><b>SLA data isn’t available on this page.</b><br>Open the Follow-up Tracker for SLA details.</div>';
    var d, x, r; try { d = L.detail(raw); } catch (er) { return '<div class="empty"><b>Could not work out the SLA for this ticket.</b></div>'; }
    x = d.info || {}; r = d.r;
    if (!r) {
      var ttl = x.state === "na" ? "Not tracked for SLA" : x.state === "none" ? "No SLA target" : x.state === "nohist" ? "No valid status history for this ticket" : "SLA data isn’t ready yet";
      return '<div class="empty"><b>' + ttl + "</b><br>" + esc(x.tip || "") + (x.state === "nohist" && L.bridgeReady && L.bridgeReady() ? '<div style="margin-top:14px"><button class="btn pri" data-act="fetchsla">Load history for this ticket</button></div><div id="fetchmsg" class="hint"></div>' : "") + "</div>";
    }
    var F = d.fmt, C = d.fcal, bi = d.bi, e = d.entry;
    var tiles = '<div class="kpis">' + kpi("Working time counted", F(r.elapsedMin), "of " + (r.targetMin != null ? F(r.targetMin) + " target" : "no target"), "#EA580C") +
      kpi(r.remainingMin != null && r.remainingMin < 0 ? "Over target by" : "Remaining", r.remainingMin == null ? "—" : r.remainingMin === 0 ? "At limit" : F(Math.abs(r.remainingMin)), r.pct != null ? Math.round(r.pct) + "% used" : "", r.remainingMin != null && r.remainingMin <= 0 ? "#BE123C" : "#059669") +
      kpi("Not counted (with client)", F(r.pausedMin), r.clientRounds + " time" + (r.clientRounds === 1 ? "" : "s") + " with client", "#F0A838") +
      kpi("Age since created", C(r.ageCalMin), "calendar time, incl. weekends", "#334155") + "</div>";
    var s = "";
    if (!r.isClosed && !r.isPaused && r.elapsedMin < 0.5 && window.HDSla && window.HDSla.nextWorkStart) { var nw = window.HDSla.nextWorkStart(d.now, d.cal); if (nw) s += "<b>No working time has passed yet</b> — the ticket was raised outside working hours, so the clock starts <b>" + W(nw) + " IST</b>. "; }
    s += breachSentence(bi, d) + (r.isClosed ? "Closed " + d.fdt(r.closedAt) + ". " : "") + "Created <b>" + C(r.ageCalMin) + "</b> ago on the calendar. Only working time counts (" + esc(d.calText) + "), which came to <b>" + F(r.elapsedMin) + "</b>" +
      (r.targetMin != null ? " against a target of <b>" + F(r.targetMin) + "</b>" : "") + ". " + (r.pausedMin > 0 ? "<b>" + F(r.pausedMin) + "</b> of working time was spent with the client and was <b>not</b> counted." : "This ticket has not been with the client.");
    if (compact) return tiles + '<div class="expl">' + s + "</div>";

    var cur = d.classify(raw.Status || ""), notes = "";
    notes += '<div style="margin-top:6px">Current status <b>“' + esc(raw.Status) + "”</b> is classified as " + kindChip(cur.kind) + " in Master Data — clock " + (cur.kind === "client" ? "paused" : cur.kind === "closed" ? "stopped" : "running") + ".</div>";
    if (r.statusMismatch) notes += '<div class="w">Jira’s history ends in “' + esc(r.statusMismatch.history) + "” (usually an old name of a renamed status); the time since that last recorded change is counted under the current status.</div>";
    if (e && e.suspect) notes += '<div class="w"><b>Unverified:</b> Jira returned no status changes for this ticket even when checked one by one, so it is shown as one status for its whole life. Compare with the History tab in Jira.</div>';
    if (r.unmapped && r.unmapped.length) notes += '<div class="w">Status(es) not in Master Data (counted as running): <b>' + r.unmapped.map(esc).join(", ") + "</b>.</div>";
    if (e && e.fetchedAt) notes += '<div class="ks" style="margin-top:6px">History fetched ' + W(e.fetchedAt) + " IST</div>";
    var out = tiles + '<div class="expl">' + s + notes + "</div>";

    var B = d.basis, LF = d.life;
    if (B && LF) {
      var cn = esc(raw.Project || B.prefix), R = function (k, v) { return "<tr><th>" + k + "</th><td>" + v + "</td></tr>"; }, M = function (z) { return '<span style="color:#94A3B8">' + z + "</span>"; }, nc = [];
      if (LF.weekend > 0.5) nc.push("<b>" + LF.nWeekendDays + " weekend day" + (LF.nWeekendDays === 1 ? "" : "s") + "</b> (" + C(LF.weekend) + ")");
      if (LF.holiday > 0.5) nc.push("<b>" + LF.nHolidayDays + " holiday" + (LF.nHolidayDays === 1 ? "" : "s") + "</b> (" + C(LF.holiday) + ")");
      if (LF.night > 0.5) nc.push("<b>" + C(LF.night) + "</b> outside working hours");
      if (r.pausedMin > 0) nc.push("<b>" + F(r.pausedMin) + "</b> of working time with the client");
      out += '<div class="bx"><h5>How this SLA was calculated <span>· rules from SLA Tracker → Settings</span></h5><table><tbody>' +
        R("Calendar", B.own ? "<b>" + cn + "’s own calendar</b> " + M("(Client calendars · " + esc(B.prefix) + ")") : "<b>Default working calendar</b> " + M("(" + cn + " has no calendar of its own)")) +
        R("Working days", "<b>" + esc(B.days) + "</b> · " + M(B.offDays.length ? "not counted: " + B.offDays.join(", ") : "weekends count")) +
        R("Working hours", "<b>" + esc(B.hours) + "</b>" + (B.dayMin < 1440 ? " · " + M("1 working day = " + C(B.dayMin).replace(/ 0m$/, "")) : "")) +
        R("Holidays", B.holidaysSkipped ? "<b>Skipped</b> · " + B.holidaysListed + " listed · " + (B.holidaysInLife.length ? "in this ticket’s life: " + B.holidaysInLife.map(function (h) { return "<b>" + isoTxt(h.date) + "</b>" + (h.name ? " " + esc(h.name) : ""); }).join(", ") : M("none fell in this ticket’s life")) : "<b>Not skipped</b> " + M("(this client’s calendar works on holidays)")) +
        R("Target", B.targetH ? "<b>" + esc(B.sevName) + " · " + B.targetH + "h of working time</b>" + (B.dayMin < 1440 && B.targetH * 60 >= B.dayMin ? " = " + F(B.targetH * 60) : "") + " · " + M(B.targetSrc === "client" ? cn + "’s own target" : "default target for " + esc(B.sevName)) : "<b>None</b> " + M("(priority “" + esc(raw.Priority || "blank") + "” has no target)")) +
        R("Clock", "Runs while with <b>Help Desk</b> or <b>Engineering</b> · pauses while with the <b>client</b> · stops when <b>closed</b> · " + M("At risk from " + B.warnPct + "%, Due soon from " + B.dangerPct + "%")) +
        R("Not counted", nc.length ? nc.join(" · ") : "Nothing — every minute was working time with Help Desk or Engineering.") + "</tbody></table>" +
        (!B.is247 && B.dayMin >= 1440 && B.offDays.length > 0 ? '<div class="expl" style="background:#FEF3C7;color:#B45309;margin:8px 0 0">This calendar runs <b>24 hours a day</b> but only on <b>' + esc(B.days) + "</b>, so " + B.offDays.join(" and ") + " are still not counted. For a true 24/7 contract, tick every day (or use the 24/7 button) in SLA Tracker → Settings.</div>" : "") + "</div>";
    }
    var tot = r.segs.reduce(function (acc, sg) { return acc + Math.max(sg.calMin, 0); }, 0) || 1, kinds = ["hd", "engg", "client", "closed"].filter(function (k) { return r.byKind[k].cal > 0.5; });
    out += '<div class="h6">Who had this ticket</div><div class="tw"><table><thead><tr><th>Held by</th><th class="n">Working time</th><th class="n">Calendar time</th><th>Share of its life</th><th>Counts towards SLA?</th></tr></thead><tbody>' + kinds.map(function (k) {
      var o = r.byKind[k], counted = k === "hd" || k === "engg";
      return "<tr><td>" + kindChip(k) + '</td><td class="n">' + (k === "closed" ? "—" : F(o.biz)) + '</td><td class="n">' + C(o.cal) + '</td><td><div class="sh"><i style="width:' + Math.max(1, o.cal / tot * 100).toFixed(1) + "%;background:" + KIND[k][3] + '"></i></div></td><td>' + (counted ? (o.biz >= 0.5 ? "Yes — counted" : "Yes — none in working hours yet") : k === "client" ? "No — clock paused" : "No — clock stopped") + "</td></tr>";
    }).join("") + "</tbody></table></div>";
    out += '<details class="st"><summary>Status by status (' + r.segs.length + " step" + (r.segs.length === 1 ? "" : "s") + ')</summary><div class="tw"><table><thead><tr><th>Status</th><th>Held by</th><th>From</th><th>To</th><th class="n">Calendar</th><th class="n">Working</th></tr></thead><tbody>' + r.segs.map(function (sg) {
      return "<tr><td>" + esc(sg.status) + "</td><td>" + kindChip(sg.kind) + "</td><td>" + esc(d.fdt(sg.start)) + "</td><td>" + (sg.open ? "now" : esc(d.fdt(sg.end))) + '</td><td class="n">' + C(sg.calMin) + '</td><td class="n">' + (sg.kind === "client" || sg.kind === "closed" ? "—" : F(sg.bizMin)) + "</td></tr>";
    }).join("") + "</tbody></table></div></details>";
    return out;
  }
  function detailsHtml(raw) {
    var info = S.engine ? S.engine.ticketInfo(raw.Key) : null; if (!info) return '<div class="empty">No details found for this ticket.</div>';
    return '<div class="kv" style="margin-top:0">' + info.fields.map(function (f) { return "<div><span>" + esc(f[0]) + "</span>" + esc(f[1]) + "</div>"; }).join("") + "</div>" +
      (info.linked.length ? '<div class="chips"><span class="lab">Linked</span>' + info.linked.map(function (l) { return '<a class="tag" style="text-decoration:none" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.key) + "</a>"; }).join("") + "</div>" : "");
  }
  function renderModal() {
    var m = S.modal; if (!m) return; var raw = m.raw, L = window.HDSlaLink, x = null, url = (S.engine && S.engine.ticketInfo(raw.Key) || {}).url || "#";
    try { x = L && L.get ? L.get(raw) : null; } catch (er) {}
    var badge = x && x.label && x.state !== "na" && x.state !== "loading" ? '<span class="sla s-' + tone(x) + '">' + esc(x.label) + "</span>" : "";
    var created = raw.Created instanceof Date ? raw.Created.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : String(raw.Created || "");
    var meta = [raw.Project, raw["Issue Type"], raw.Priority || "No priority", "status " + (raw.Status || "?"), "worker " + (raw["Current Worker"] || "?"), "SVM " + (raw["SVM In Charge"] || "?"), created ? "created " + created : ""].filter(Boolean).map(esc).join(" · ");
    ov.innerHTML = '<div class="mod" role="dialog" aria-label="Ticket details"><div class="mh"><div class="l"><div class="t1"><a class="key" style="font-size:15px" href="' + esc(url) + '" target="_blank" rel="noopener" title="Open in Jira">' + esc(raw.Key) + " ↗</a>" + badge + '</div><div class="mt">' + esc(raw.Summary) + '</div><div class="mm">' + meta + "</div></div>" +
      '<button class="ib" data-act="mclose" title="Close" style="border:1px solid #E2E8F0">✕</button></div>' +
      '<div class="tabs"><button data-act="mtab" data-t="sla" class="' + (m.tab === "sla" ? "on" : "") + '">SLA</button><button data-act="mtab" data-t="details" class="' + (m.tab === "details" ? "on" : "") + '">Ticket details</button></div>' +
      '<div class="mb">' + (m.tab === "sla" ? slaHtml(raw, false) : detailsHtml(raw)) + "</div></div>";
  }
  function openTicket(raw, tab) { if (!raw) return; S.modal = { raw: raw, tab: tab === "details" || !window.HDSlaLink ? "details" : "sla" }; renderModal(); ov.className = "ov open"; ov.scrollTop = 0; }
  function closeModal() { S.modal = null; ov.className = "ov"; ov.innerHTML = ""; }

  /* ───────── CSV ───────── */
  function csvCell(v) { var s = String(v == null ? "" : v); if (/^[=+@]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function downloadCsv(c) {
    var text = "\ufeff" + [c.header].concat(c.rows).map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "hd-" + String(c.name || "export").replace(/[^\w\-]+/g, "-") + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ───────── asking ───────── */
  function noData(err) {
    var m = err && err.message === "NODATA" ? "I don’t have any ticket data yet. Go to the launcher (Home), upload your Jira Excel export or fetch from Jira, then ask again." : "I couldn’t load the data: " + ((err && err.message) || err);
    showAnswer({ type: "text", text: m, chips: [] });
  }
  function run(fn) {
    var t = typing();
    ensureEngine().then(function (eng) { setTimeout(function () { var a; try { a = fn(eng); } catch (e) { a = { type: "text", text: "Something went wrong while working that out (" + (e && e.message) + "). Try rephrasing." }; } t.remove(); S.prev = a.plan || S.prev; showAnswer(a); }, 20); }, function (e) { t.remove(); noData(e); });
  }
  function ask(q) {
    q = String(q || "").trim(); if (!q) return;
    userMsg(q); S.hist.push(q); S.hpos = S.hist.length; inp.value = ""; closeAc();
    run(function (eng) { return eng.ask(q, S.prev); });
  }
  function followUp(id, i) {
    var a = S.answers[id], f = a && a.follow && a.follow[i]; if (!f || !a.plan) return;
    userMsg("→ " + f.label); run(function (eng) { var r = eng.run(Eng.applyPatch(a.plan, f.patch)); r.plan = Eng.applyPatch(a.plan, f.patch); return r; });
  }
  function drill(id, i) {
    var a = S.answers[id], r = a && a.rows && a.rows[i]; if (!r || !r.drill) return;
    userMsg("→ " + r.cells[0]); run(function (eng) { var x = eng.run(r.drill); x.plan = r.drill; return x; });
  }

  /* ───────── autocomplete ───────── */
  var acList = [], acPos = -1;
  function closeAc() { ac.className = "ac"; ac.innerHTML = ""; acList = []; acPos = -1; }
  function updateAc() {
    if (!S.engine) return closeAc();
    var m = /([A-Za-z0-9&\-\.]{2,})$/.exec(inp.value); if (!m) return closeAc();
    var list = S.engine.suggest(m[1]).filter(function (x) { return x.toLowerCase() !== m[1].toLowerCase(); }); if (!list.length) return closeAc();
    acList = list; acPos = -1; ac.innerHTML = list.map(function (x, i) { return '<button data-i="' + i + '">' + esc(x) + "</button>"; }).join(""); ac.className = "ac open";
  }
  function pickAc(i) { var m = /([A-Za-z0-9&\-\.]{2,})$/.exec(inp.value); if (!m || !acList[i]) return; inp.value = inp.value.slice(0, m.index) + acList[i] + " "; closeAc(); inp.focus(); }

  /* ───────── wiring ───────── */
  function welcome() {
    msgs.innerHTML = ""; S.answers = []; S.prev = null;
    addRow("b", '<div class="b"><div class="card"><div class="say"><b>Hi! Ask me about your tickets.</b><br>Just type it the way you’d say it — “what’s overdue?”, “who has the most work?”, “anything urgent for MILAHA?”. Spelling mistakes are fine. I answer straight from the data loaded in this app.</div>' +
      '<div class="fl" id="starters" style="border:none;padding-top:6px"></div></div></div>');
    var st = msgs.querySelector("#starters"), list = S.engine ? S.engine.starters() : ["How many open tickets?", "Fires", "Breached tickets", "Open tickets by client", "Created vs closed by month"];
    st.innerHTML = list.concat(["What can I ask?"]).map(function (q) { return '<button class="chip" data-act="ask" data-q="' + esc(q === "What can I ask?" ? "help" : q) + '">' + esc(q) + "</button>"; }).join("");
  }
  function openPanel() {
    S.open = true; panel.className = "panel open" + (S.wide ? " wide" : ""); fab.className = "fab hide"; inp.focus();
    if (!S.engine && !S.loading) loadData().then(function () { welcomeIfEmpty(); }, function () {});
    else if (S.engine && S.rows && Date.now() - S.loadedAt > 10 * 60000) loadData(true).then(function () {}, function () {});
  }
  function welcomeIfEmpty() { if (S.engine && msgs.querySelectorAll(".row").length <= 1) welcome(); }
  function closePanel() { S.open = false; panel.className = "panel" + (S.wide ? " wide" : ""); fab.className = "fab"; menu.className = "menu"; }

  function init() {
    document.body.appendChild(host);
    ov = $("ov"); fab = $("fab"); panel = $("panel"); msgs = $("msgs"); inp = $("inp"); send = $("send"); ac = $("ac"); menu = $("menu");
    welcome();
    var PH = ["What needs attention today?", "What’s overdue for MILAHA?", "Who has the most work?", "How many tickets are pending with the client?", "Which tickets are stuck?", "How are we doing?", "Tickets raised each month", "Are we meeting SLA?"], phI = 0;
    setInterval(function () { if (S.open && !inp.value) { phI = (phI + 1) % PH.length; inp.placeholder = "Try: " + PH[phI]; } }, 4000);
    fab.addEventListener("click", openPanel);
    $("close").addEventListener("click", closePanel);
    $("wide").addEventListener("click", function () { S.wide = !S.wide; panel.className = "panel open" + (S.wide ? " wide" : ""); });
    $("more").addEventListener("click", function (e) { e.stopPropagation(); menu.className = menu.className.indexOf("open") > -1 ? "menu" : "menu open"; var mc = $("mc"); if (mc) mc.textContent = S.misses.length; });
    root.addEventListener("click", function (e) {
      var t = e.target; if (!(t instanceof Element)) return;
      if (t.id === "ov") { closeModal(); return; }
      if (menu.className.indexOf("open") > -1 && !t.closest("#menu") && t.id !== "more") menu.className = "menu";
      if (!t.closest(".ac") && t.id !== "inp") closeAc();
      var m = t.closest("[data-m]"); if (m) { menu.className = "menu"; var k = m.getAttribute("data-m");
        if (k === "clear") welcome(); else if (k === "help") ask("help");
        else if (k === "misses") { if (!S.misses.length) showAnswer({ type: "text", text: "No unanswered questions so far — everything you asked was understood.", chips: [] }); else { var txt = S.misses.map(function (x) { return x.t + "  " + x.q; }).join("\n"); try { navigator.clipboard.writeText(txt); } catch (er) {} showAnswer({ type: "text", text: S.misses.length + " question(s) I couldn’t answer (copied to your clipboard — send them to the developer to teach me):\n\n" + txt.split("\n").slice(-15).join("\n"), chips: [] }); } }
        return; }
      var el = t.closest("[data-act]"); if (!el) { var ab = t.closest("#ac button"); if (ab) pickAc(+ab.getAttribute("data-i")); return; }
      var act = el.getAttribute("data-act"), id = +el.getAttribute("data-a"), i = +el.getAttribute("data-i");
      if (act === "ask") ask(el.getAttribute("data-q")); else if (act === "follow") followUp(id, i); else if (act === "drill") drill(id, i);
      else if (act === "csv") { var a = S.answers[id]; if (a && a.csv) downloadCsv(a.csv); }
      else if (act === "open") { var ao = S.answers[id], it = ao && ao.items && ao.items[i]; if (it) openTicket(it.raw, ao.slaContext ? "sla" : "details"); }
      else if (act === "openk") { var ak = S.answers[id], ik = ak && ak.items && ak.items[i]; if (ik) openTicket(ik.raw, "sla"); }
      else if (act === "mclose") closeModal();
      else if (act === "mtab") { if (S.modal) { S.modal.tab = el.getAttribute("data-t"); renderModal(); } }
      else if (act === "fetchsla") {
        var Lf = window.HDSlaLink, mm = S.modal; if (!Lf || !mm) return; el.disabled = true; el.textContent = "Loading…";
        Lf.fetchMissing([mm.raw], { force: true }).then(function (res) { if (S.modal === mm) { renderModal(); if (res && res.failed && res.failed.length) { var fm = ov.querySelector("#fetchmsg"); if (fm) fm.textContent = res.failed[0].reason; } } }, function (er) { if (S.modal === mm) { renderModal(); var fm = ov.querySelector("#fetchmsg"); if (fm) fm.textContent = String((er && er.message) || er).replace(/^BUSY:/, ""); } });
      }
      else if (act === "more") {
        var a2 = S.answers[id], box = msgs.querySelector('[data-list="' + id + '"]'); if (!a2 || !box) return; var shown = box.children.length, next = a2.items.slice(shown, shown + 25);
        box.insertAdjacentHTML("beforeend", next.map(function (t, k) { return ticketRow(t, id, shown + k); }).join("")); var left = a2.items.length - box.children.length; if (left > 0) el.textContent = "Show more (" + fmt(left) + ")"; else el.remove();
      }
    });
    $("reload").addEventListener("click", function () { S.engine = null; S.loading = null; $("status").textContent = "Reloading data…"; loadData(true).then(function () { welcome(); showAnswer({ type: "text", text: "Data reloaded — " + fmt(S.engine.stats.tickets) + " tickets.", chips: [] }); }, noData); });
    send.addEventListener("click", function () { ask(inp.value); });
    inp.addEventListener("input", updateAc);
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { if (acPos > -1) { pickAc(acPos); e.preventDefault(); return; } ask(inp.value); e.preventDefault(); }
      else if (e.key === "Tab" && acList.length) { pickAc(acPos > -1 ? acPos : 0); e.preventDefault(); }
      else if (e.key === "ArrowDown" && acList.length) { acPos = (acPos + 1) % acList.length; Array.prototype.forEach.call(ac.children, function (b, k) { b.className = k === acPos ? "on" : ""; }); e.preventDefault(); }
      else if (e.key === "ArrowUp") { if (acList.length) { acPos = (acPos - 1 + acList.length) % acList.length; Array.prototype.forEach.call(ac.children, function (b, k) { b.className = k === acPos ? "on" : ""; }); } else if (S.hist.length) { S.hpos = Math.max(0, S.hpos - 1); inp.value = S.hist[S.hpos] || ""; } e.preventDefault(); }
      else if (e.key === "Escape") { if (S.modal) closeModal(); else if (acList.length) closeAc(); else closePanel(); }
    });
    ["keydown", "keyup", "keypress"].forEach(function (ev) { panel.addEventListener(ev, function (e) { e.stopPropagation(); }); ov.addEventListener(ev, function (e) { e.stopPropagation(); }); });
    /* Escape closes the pop-up even when focus has fallen back to the page (the pop-up redraws when you switch tabs) */
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.modal) { closeModal(); e.stopPropagation(); e.preventDefault(); } }, true);   // page shortcuts must not fire while typing here
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.HDChat = { open: function () { openPanel(); }, close: closePanel, ask: function (q) { openPanel(); ask(q); } };
})();
