/**
 * Team device sync — sketch / runbook, not hosted multiplayer.
 * Real sync later: shared .room via git --share, export/import, or peer watch.
 */
export function syncHint() {
  return {
    status: "sketch",
    message:
      "Team device sync is not auto-magic yet. Use --share + git, or rooms export-room / import-room, so teammates see the same .room/ on devices they control. No I-Ops cloud.",
    steps: [
      "rooms init --share   # commit .room/ with the project",
      "teammate: git pull && rooms join <CODE>",
      "or: rooms export-room /tmp/room-bundle && hand off && rooms import-room /tmp/room-bundle",
      "rooms live on each machine still binds 127.0.0.1 only",
    ],
  };
}
