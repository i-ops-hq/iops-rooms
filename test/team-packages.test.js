// Cross-member package surface (observe): names/versions and member counts from package_rollups —
// never lockfile bodies or install scripts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPackageSurface,
  renderPackageSurfaceText,
} from "../src/team-packages.js";
import { git, scratch, teamOfTwo } from "./team-helpers.js";

test("buildPackageSurface joins names across members", () => {
  const surface = buildPackageSurface({
    packageRollups: [
      {
        member: "alice",
        project: "web",
        at: "2026-10-15T10:00Z",
        packages: [
          { name: "lodash", version: "4.17.21", manager: "npm" },
          { name: "only-alice", version: "1.0.0" },
        ],
      },
      {
        member: "bob",
        project: "web",
        at: "2026-10-16T10:00Z",
        packages: [{ name: "lodash", version: "4.17.21", manager: "npm" }],
      },
    ],
  });
  assert.equal(surface.kind, "team_packages");
  assert.equal(surface.totals.members, 2);
  assert.equal(surface.totals.multiMember, 1);
  const lodash = surface.packages.find((p) => p.name === "lodash");
  assert.equal(lodash.members, 2);
  assert.deepEqual(lodash.memberLogins, ["alice", "bob"]);
  const multi = buildPackageSurface({
    packageRollups: [
      { member: "alice", packages: [{ name: "lodash", version: "4.17.21" }] },
      { member: "bob", packages: [{ name: "lodash", version: "4.17.21" }] },
    ],
    multiOnly: true,
  });
  assert.equal(multi.packages.length, 1);
  const md = renderPackageSurfaceText(surface, { teamId: "acme/team" });
  assert.match(md, /lodash@4\.17\.21/);
  assert.doesNotMatch(md, /package-lock|install script|node_modules/);
});

test("rooms team packages reads hub rollups only", async () => {
  await scratch(async (dir) => {
    const { alice, bob } = await teamOfTwo(dir);
    const plant = async (clone, member, pkgs) => {
      const rel = `rollups/${member}/web.packages.json`;
      await mkdir(join(clone, "rollups", member), { recursive: true });
      await writeFile(
        join(clone, rel),
        `${JSON.stringify(
          {
            v: 1,
            kind: "package_rollup",
            member,
            project: "web",
            at: "2026-10-16T12:00Z",
            packages: pkgs,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await git(clone, "add", rel);
    };
    await plant(alice.team, "alice", [{ name: "left-pad", version: "1.3.0", manager: "npm" }]);
    await plant(alice.team, "bob", [
      { name: "left-pad", version: "1.3.0", manager: "npm" },
      { name: "secret-body-pkg", version: "9.9.9" },
    ]);
    await git(alice.team, "commit", "-q", "-m", "package rollups for test");
    await git(alice.team, "push", "-q", "origin", "main");
    await git(bob.team, "pull", "-q");

    const listed = await bob.rooms(bob.web, "team", "packages", "--json");
    assert.equal(listed.code, 0, listed.err);
    const data = JSON.parse(listed.out);
    assert.equal(data.kind, "team_packages");
    assert.ok(data.packages.some((p) => p.name === "left-pad" && p.members === 2));
    assert.doesNotMatch(listed.out, /"body"|lockfile contents|postinstall/);

    const multi = await bob.rooms(bob.web, "team", "packages", "--multi");
    assert.equal(multi.code, 0, multi.err);
    assert.match(multi.out, /left-pad@1\.3\.0/);
    assert.doesNotMatch(multi.out, /secret-body-pkg/);
  });
});
