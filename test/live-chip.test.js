// The live chip in the corner of the board.
//
// It read "Live · localhost" from the moment the page loaded, whether or not anything was serving
// it: open the board, stop `rooms live`, and the chip still said Live over a page that would never
// change again. These run the chip's own script against a stand-in stream, so they test what it
// does rather than what its source says.

import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_CLIENT_SNIPPET } from "../src/live-client.js";

/** Runs the snippet with a fake page and stream; returns the chip and the stream to drive. */
function mount({ protocol = "http:", hostname = "127.0.0.1" } = {}) {
  const body = LIVE_CLIENT_SNIPPET.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  const chip = {
    attrs: {},
    textContent: "",
    className: "",
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
  };
  const page = { chip: null, stream: null, reloads: 0 };
  const document = {
    createElement: () => chip,
    body: {
      appendChild(el) {
        page.chip = el;
      },
    },
  };
  const location = { protocol, hostname, reload: () => (page.reloads += 1) };
  class FakeStream {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      page.stream = this;
    }
  }
  new Function("document", "location", "EventSource", body)(document, location, FakeStream);
  return page;
}

test("it says Connecting until the stream answers, not Live", () => {
  const { chip } = mount();
  assert.equal(chip.textContent, "Connecting…");
  assert.equal(chip.attrs["data-state"], "connecting");
});

test("it says Live only while the stream is open", () => {
  const { chip, stream } = mount();
  stream.onopen();
  assert.equal(chip.textContent, "Live · localhost");
  assert.equal(chip.attrs["data-state"], "live");
});

test("a server that went away reads as reconnecting, and says how old the page is", () => {
  const { chip, stream } = mount();
  stream.onopen();
  stream.readyState = 0; // the browser is retrying
  stream.onerror();
  assert.match(chip.textContent, /^Reconnecting · page from \d/);
  stream.onopen();
  assert.equal(chip.textContent, "Live · localhost", "and Live again once it is back");
});

test("no stream at all reads as offline, which is the board served by anything but rooms live", () => {
  const { chip, stream } = mount();
  stream.readyState = 2; // closed: a 404, or nothing listening that speaks the stream
  stream.onerror();
  assert.match(chip.textContent, /^Offline · page from \d/);
  assert.equal(chip.attrs["data-state"], "offline");
});

test("an update reloads the page, as before", () => {
  const page = mount();
  page.stream.onmessage();
  assert.equal(page.reloads, 1);
});

test("nothing is mounted for a file or a host that is not this machine", () => {
  assert.equal(mount({ protocol: "file:" }).chip, null);
  assert.equal(mount({ hostname: "example.com" }).chip, null);
});
