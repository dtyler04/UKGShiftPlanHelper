// ==UserScript==
// @name         UKG getScheduleForEmployeeList -> CSV (date picker, break flag, re-prompt on new week)
// @namespace    darcy.ukg.capture
// @version      1.4.0
// @description  Intercept UKG WS, show a date picker (up to 7 days), export CSV with Day + Break Required; auto re-prompt on new data
// @match        https://endeavourgroup-sso.prd.mykronos.com/*
// @run-at       document-start
// @inject-into  page
// @grant        GM_download
// ==/UserScript==

(() => {
  const NAME_PREFIX = "locationSchedule.employee.getScheduleForEmployeeList";
  const BRIDGE_EVENT = "tm-ukg-ws-capture";
  const hasGMDownload = typeof GM_download === "function";

  // State
  let currentShifts = [];
  let currentEmpMap = new Map();
  let overlayRef = null;         // overlay DOM element if visible
  let currentDatesKey = "";      // joined dates string to detect change

  // Listen for the matching WS payload
  window.addEventListener(BRIDGE_EVENT, (e) => {
    try {
      const { rawMessage } = e.detail || {};
      if (!rawMessage) return;

      const text = String(rawMessage);
      const roots = extractJsonCandidates(text);
      if (!roots.length) return;

      const allShifts = collectShifts(roots);
      if (!allShifts.length) return;

      const empMap = buildEmployeeMap(roots);

      // Unique local dates (from start/end) limited to 7
      const dateSet = new Set();
      for (const sh of allShifts) {
        const s = toDate(sh.startDateTime);
        const e2 = toDate(sh.endDateTime);
        if (s) dateSet.add(ymdLocal(s));
        if (e2) dateSet.add(ymdLocal(e2));
      }
      const dates = Array.from(dateSet).sort().slice(0, 7);
      if (!dates.length) return;

      // If dates changed (e.g., user clicked "Next week"), reprompt/update
      const newKey = dates.join("|");
      const datesChanged = newKey !== currentDatesKey;

      // Update state
      currentShifts = allShifts;
      currentEmpMap = empMap;

      if (datesChanged) {
        currentDatesKey = newKey;
        if (overlayRef) {
          // Update the existing picker with new dates
          updateDatePicker(overlayRef, dates, (picked) => exportCSVForDate(picked));
        } else {
          // Show a fresh picker
          overlayRef = showDatePicker(dates, (picked) => {
            closeOverlay();
            exportCSVForDate(picked);
          });
        }
      }
    } catch (err) {
      console.warn("[UKG] WS parse error:", err);
    }
  });

  // -------- CSV export for a chosen date --------
  function exportCSVForDate(targetYMD) {
    if (!currentShifts.length) return;

    const dayLabel = formatDayLabel(fromYMD(targetYMD)); // e.g., "Monday 11/08/2025"
    const rows = [["Day","EmployeeID","Employee Name","Shift Start","Shift End","Break Required"]];

    for (const sh of currentShifts) {
      const start = toDate(sh.startDateTime);
      const end   = toDate(sh.endDateTime);
      if (!start || !end) continue;

      // Include if either start OR end is on the chosen date (local)
      if (ymdLocal(start) !== targetYMD && ymdLocal(end) !== targetYMD) continue;

      const empId =
        (sh.employee && (sh.employee.qualifier || sh.employee.id)) || "";
      if (!empId) continue; // extra guard

      const name =
        (sh.employee && (currentEmpMap.get(String(sh.employee.qualifier)) ||
                         currentEmpMap.get(String(sh.employee.id)))) || "";

      const hours = durationHours(start, end);
      const breakRequired = hours > 6 ? "Yes" : "No";

      rows.push([
        dayLabel,
        String(empId),
        String(name),
        timeHM(start),
        timeHM(end),
        breakRequired
      ]);
    }

    if (rows.length === 1) {
      alert(`No shifts found for ${targetYMD}.`);
      return;
    }

    // Sort by start time (HH:MM)
    rows.splice(1, rows.length-1, ...rows.slice(1).sort((a,b)=>a[3].localeCompare(b[3])));

    const csv = rows.map(r => r.map(escapeCsv).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const filename = `ukg_roster_${targetYMD}.csv`;

    if (hasGMDownload) {
      GM_download({
        url, name: filename, saveAs: false,
        onload: () => URL.revokeObjectURL(url),
        ontimeout: () => URL.revokeObjectURL(url),
        onerror: () => URL.revokeObjectURL(url),
      });
    } else {
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
    console.log(`[UKG] CSV exported: ${filename}`);
  }

  // -------- Date picker UI --------
  function showDatePicker(dates, onPick) {
    const overlay = document.createElement("div");
    overlay.id = "ukg-date-picker";
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.35)",
      zIndex: 2147483647,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "system-ui, sans-serif",
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      background: "#fff",
      borderRadius: "14px",
      minWidth: "320px",
      maxWidth: "90vw",
      padding: "16px",
      boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
    });

    const title = document.createElement("div");
    title.textContent = "Select a date to export";
    Object.assign(title.style, {
      fontSize: "16px",
      fontWeight: "600",
      marginBottom: "10px",
    });

    const grid = document.createElement("div");
    grid.id = "ukg-date-grid";
    Object.assign(grid.style, {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "8px",
      marginTop: "8px",
      marginBottom: "10px",
    });

    fillGridWithDates(grid, dates, onPick);

    const actions = document.createElement("div");
    actions.style.textAlign = "right";

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    Object.assign(cancel.style, {
      padding: "8px 12px",
      borderRadius: "8px",
      border: "1px solid #ccc",
      background: "#fff",
      cursor: "pointer",
      fontSize: "12px",
    });
    cancel.addEventListener("click", () => { closeOverlay(); });

    actions.appendChild(cancel);
    panel.appendChild(title);
    panel.appendChild(grid);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // ESC closes
    const onKey = (e) => {
      if (e.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", onKey, true);
    overlay._onKey = onKey; // remember listener for cleanup
    overlay._grid = grid;   // save grid ref for updates

    return overlay;
  }

  function updateDatePicker(overlay, dates, onPick) {
    if (!overlay || !overlay._grid) return;
    fillGridWithDates(overlay._grid, dates, onPick);
  }

  function fillGridWithDates(gridEl, dates, onPick) {
    gridEl.innerHTML = "";
    dates.forEach(d => {
      const label = formatDayLabel(fromYMD(d));
      const btn = document.createElement("button");
      btn.textContent = label;
      Object.assign(btn.style, {
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid #ccc",
        background: "#f9f9f9",
        cursor: "pointer",
        fontSize: "13px",
        textAlign: "left",
      });
      btn.addEventListener("mouseenter", () => btn.style.background = "#f1f1f1");
      btn.addEventListener("mouseleave", () => btn.style.background = "#f9f9f9");
      btn.addEventListener("click", () => {
        onPick(d);
      });
      gridEl.appendChild(btn);
    });
  }

  function closeOverlay() {
    if (!overlayRef) return;
    const onKey = overlayRef._onKey;
    if (onKey) window.removeEventListener("keydown", onKey, true);
    if (document.body.contains(overlayRef)) document.body.removeChild(overlayRef);
    overlayRef = null;
  }

  // -------- Helpers --------
  function safeStr(v){ return v == null ? "" : String(v); }
  function escapeCsv(v){ const s=safeStr(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }

  function extractJsonCandidates(text){
    const out = [];
    if (!text) return out;
    // SockJS array frames: a["...","..."]
    if (text[0] === "a") {
      try {
        const arr = JSON.parse(text.slice(1));
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item === "string") { try { out.push(JSON.parse(item)); } catch {} }
            else if (item && typeof item === "object") out.push(item);
          }
        }
      } catch {}
      return out;
    }
    try { out.push(JSON.parse(text)); } catch {}
    return out;
  }

  function* walk(obj){
    if (!obj || typeof obj !== "object") return;
    yield obj;
    if (Array.isArray(obj)) for (const v of obj) yield* walk(v);
    else for (const k of Object.keys(obj)) yield* walk(obj[k]);
  }

  // ---------- Strict shift collection ----------
  function collectShifts(roots){
    const out = [];
    for (const root of roots) {
      for (const node of walk(root)) {
        if (!node || typeof node !== "object") continue;

        // Only likely containers
        const containers = [];
        if (Array.isArray(node.shifts)) containers.push(node.shifts);
        if (Array.isArray(node.employeeShifts)) containers.push(node.employeeShifts);
        if (Array.isArray(node.scheduleItems)) containers.push(node.scheduleItems);

        for (const arr of containers) {
          for (const sh of arr) {
            const n = normalizeShift(sh);
            if (n) out.push(n);
          }
        }
      }
    }

    // Dedup by employee + times
    const seen = new Set();
    const dedup = [];
    for (const s of out) {
      const k = `${s.employee?.id ?? ""}|${s.employee?.qualifier ?? ""}|${s.startDateTime}|${s.endDateTime}`;
      if (!seen.has(k)) { seen.add(k); dedup.push(s); }
    }
    return dedup;
  }

  function normalizeShift(sh){
    if (!sh || typeof sh !== "object") return null;

    // Reject non-shift types
    const kind = String(sh.itemType || sh.type || sh.category || sh.shiftType || "").toUpperCase();
    if (/(BREAK|MEAL|TIME\s*OFF|AVAIL)/.test(kind)) return null;
    if (sh.isOpenShift === true || sh.openShift === true || sh.isOpen === true || sh.open === true) return null;

    // Start/End
    const start = sh.startDateTime ?? sh.startTime ?? sh.start ?? sh.startDate ?? null;
    const end   = sh.endDateTime   ?? sh.endTime   ?? sh.end   ?? sh.endDate   ?? null;
    if (!start || !end) return null;

    // Must have employee ref
    const empRef = sh.employee ?? sh.employeeRef ?? sh.owner?.employeeRef ?? null;
    const employee = empRef ? {
      id:        empRef.id ?? empRef.employeeId ?? empRef.personId ?? sh.employeeId ?? sh.personId ?? null,
      qualifier: empRef.qualifier ?? sh.employeeNumber ?? null
    } : null;

    if (!employee || (employee.id == null && employee.qualifier == null)) return null;

    return { id: sh.id ?? sh.shiftId ?? null, startDateTime: start, endDateTime: end, employee };
  }

  function buildEmployeeMap(roots){
    const map = new Map();
    for (const root of roots) {
      for (const node of walk(root)) {
        if (Array.isArray(node.employees)) {
          for (const e of node.employees) mapEmployee(map, e);
        }
        if (Array.isArray(node.employeeList)) {
          for (const e of node.employeeList) mapEmployee(map, e);
        }
      }
    }
    return map;
  }

  function mapEmployee(map, e){
    if (!e || typeof e !== "object") return;
    const name = e.fullName || e.name || [e.firstName, e.lastName].filter(Boolean).join(" ");
    const ref = e.employeeRef || e.personRef || {};
    const id = e.id ?? ref.id ?? e.employeeId ?? e.personId;
    const qual = e.qualifier ?? ref.qualifier ?? e.employeeNumber;
    if (name) {
      if (id   != null) map.set(String(id),   name);
      if (qual != null) map.set(String(qual), name);
    }
  }

  // ---------- Date/time utils ----------
  function toDate(v){
    try {
      if (v == null) return null;
      if (typeof v === "number") return new Date(v);
      if (typeof v === "string") {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d;
        const n = Number(v);
        if (!Number.isNaN(n)) {
          const d2 = new Date(n);
          if (!isNaN(d2.getTime())) return d2;
        }
      }
    } catch {}
    return null;
  }

  function ymdLocal(d){
    const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }
  function fromYMD(ymd){
    const [y,m,d]=ymd.split("-").map(n=>parseInt(n,10));
    return new Date(y, m-1, d);
  }
  function timeHM(d){
    const pad=(n)=>String(n).padStart(2,"0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function durationHours(start, end){
    let ms = end.getTime() - start.getTime();
    if (ms < 0) ms += 24*60*60*1000; // wrap once if crosses midnight
    return ms / 3600000;
  }
  function formatDayLabel(dateObj){
    // "Monday 11/08/2025" in local time
    const weekday = dateObj.toLocaleDateString("en-AU", { weekday: "long" });
    const ddmmyyyy = dateObj.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
    return `${weekday} ${ddmmyyyy}`;
  }

  // -------- Inject page-context WS wrapper --------
  const inject = () => {
    const script = document.createElement("script");
    script.textContent = `
      (function(){
        const NAME_PREFIX = ${JSON.stringify(NAME_PREFIX)};
        const BRIDGE_EVENT = ${JSON.stringify(BRIDGE_EVENT)};

        async function toText(data){
          try {
            if (typeof data === "string") return data;
            if (data instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(data);
            if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
            return JSON.stringify(data);
          } catch { try { return String(data); } catch { return "" } }
        }
        function extractJsonCandidates(text){
          const out = [];
          if (!text) return out;
          if (text[0] === "a") {
            try {
              const arr = JSON.parse(text.slice(1));
              if (Array.isArray(arr)) {
                for (const item of arr) {
                  if (typeof item === "string") { try { out.push(JSON.parse(item)); } catch {} }
                  else if (item && typeof item === "object") out.push(item);
                }
              }
            } catch {}
            return out;
          }
          try { out.push(JSON.parse(text)); } catch {}
          return out;
        }
        function bridge(matchedName, rawMessage){
          try { window.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail: { matchedName, rawMessage } })); } catch {}
        }

        const NativeWS = window.WebSocket;
        if (!NativeWS) return;

        window.WebSocket = new Proxy(NativeWS, {
          construct(target, args) {
            const ws = new target(...args);
            ws.addEventListener("message", async (evt) => {
              try {
                const text = await toText(evt.data);
                const cands = (function extract(text){
                  const out=[]; if(!text) return out;
                  if(text[0]==="a"){ try{ const arr=JSON.parse(text.slice(1)); if(Array.isArray(arr)){ for(const it of arr){ if(typeof it==="string"){ try{ out.push(JSON.parse(it)); }catch{} } else if (it&&typeof it==="object"){ out.push(it); } } } }catch{} return out; }
                  try{ out.push(JSON.parse(text)); }catch{};
                  return out;
                })(text);
                for (const msg of cands) {
                  const name = msg && msg.name;
                  if (typeof name === "string" && name.startsWith(NAME_PREFIX)) {
                    bridge(name, text || msg);
                  }
                }
              } catch {}
            });
            return ws;
          }
        });
      })();
    `;
    document.documentElement.appendChild(script);
  };

  inject();
})();
