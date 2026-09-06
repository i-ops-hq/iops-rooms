/** Injected into board.html. No-ops on file://; EventSource only on 127.0.0.1/localhost. */
export const LIVE_CLIENT_SNIPPET = `
<script data-rooms-live>
(function () {
  if (location.protocol === "file:") return;
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return;
  var es = new EventSource("/stream");
  es.onmessage = function () { location.reload(); };
  es.onerror = function () { /* browser retries */ };
})();
</script>
`.trim();
