/** Injected into board.html. No-ops on file://; EventSource only on 127.0.0.1/localhost. */
export const LIVE_CLIENT_SNIPPET = `
<script data-rooms-live>
(function () {
  if (location.protocol === "file:") return;
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return;
  // The chip says what is true now. It read "Live" from the moment the page loaded, including
  // with no server behind it at all, so a board whose server had stopped looked current.
  var chip = document.createElement("div");
  chip.className = "live-chip";
  chip.setAttribute("aria-live", "polite");
  var loaded = new Date();
  function set(state, text) {
    chip.setAttribute("data-state", state);
    chip.textContent = text;
  }
  function asOf() {
    return loaded.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  set("connecting", "Connecting…");
  document.body.appendChild(chip);
  var es = new EventSource("/stream");
  es.onopen = function () { set("live", "Live · localhost"); };
  es.onmessage = function () { location.reload(); };
  // CLOSED means the browser has given up — a 404, or no stream here at all. CONNECTING means the
  // server went away and the browser is retrying; the page is still the one loaded at asOf().
  es.onerror = function () {
    if (es.readyState === 2) set("offline", "Offline · page from " + asOf());
    else set("reconnecting", "Reconnecting · page from " + asOf());
  };
})();
</script>
`.trim();
