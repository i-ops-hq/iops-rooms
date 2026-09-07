/** Injected into board.html. No-ops on file://; EventSource only on 127.0.0.1/localhost. */
export const LIVE_CLIENT_SNIPPET = `
<script data-rooms-live>
(function () {
  if (location.protocol === "file:") return;
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return;
  var chip = document.createElement("div");
  chip.className = "live-chip";
  chip.setAttribute("aria-live", "polite");
  chip.textContent = "Live · localhost";
  document.body.appendChild(chip);
  var es = new EventSource("/stream");
  es.onmessage = function () { location.reload(); };
  es.onerror = function () { /* browser retries */ };
})();
</script>
`.trim();
