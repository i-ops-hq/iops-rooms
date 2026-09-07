/**
 * Team device sync — on their machines only (export / merge). No I-Ops cloud.
 */
export function syncHint() {
  return {
    status: "dogfood",
    message:
      "Share .room/ among devices you control: export on A, merge on B. Same room code required. Live board stays 127.0.0.1 on each machine.",
    steps: [
      "# Device A",
      "rooms export-room /tmp/room-bundle",
      "# copy /tmp/room-bundle to Device B (AirDrop, USB, git --share, …)",
      "# Device B (room already inited with same code, or import-room once)",
      "rooms sync-merge /tmp/room-bundle",
      "rooms live   # see unioned events",
      "# Or commit .room/ with rooms init --share and git pull on teammates",
    ],
  };
}
