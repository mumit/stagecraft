// Validates that core/deploy/ adapters exist and README table stays in sync.
// Adding an adapter without updating both will cause these tests to fail.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT } = require("./_helpers");

const DEPLOY_DIR = path.join(REPO_ROOT, "core", "deploy");
const README = path.join(DEPLOY_DIR, "README.md");

describe("deploy adapters", () => {
  describe("core/deploy/README.md table vs filesystem", () => {
    it("README lists local adapter as the default", () => {
      const content = fs.readFileSync(README, "utf8");
      assert.ok(content.includes("`local` (default)"), "README missing default `local` entry");
      assert.ok(content.includes("local.md"), "README missing local.md reference");
    });

    it("README lists cloud-run adapter", () => {
      const content = fs.readFileSync(README, "utf8");
      assert.ok(content.includes("`cloud-run`"), "README missing `cloud-run` entry");
    });

    it("README cloud-run row references cloud-run.md", () => {
      const content = fs.readFileSync(README, "utf8");
      assert.ok(content.includes("cloud-run.md"), "README missing cloud-run.md reference");
    });
  });

  describe("core/deploy/local.md", () => {
    const ADAPTER = path.join(DEPLOY_DIR, "local.md");

    it("file exists", () => {
      assert.ok(fs.existsSync(ADAPTER), "core/deploy/local.md does not exist");
    });

    it("contains required adapter sections and honest external-deploy marker", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      for (const heading of ["## Assumptions", "## Procedure", "## Runbook hooks"]) {
        assert.ok(content.includes(heading), `missing ${heading} section`);
      }
      assert.ok(content.includes('"external_deploy": false'), "local adapter must mark external_deploy false");
      assert.ok(content.includes('"deploy_adapter": "local"'), "local adapter gate must identify deploy_adapter local");
      assert.ok(content.includes("deploy_requested: false"), "local adapter must handle deploy_requested false");
      assert.ok(content.includes("not an escalation"), "local adapter must not escalate deploy_requested false");
    });
  });

  describe("core/deploy/cloud-run.md", () => {
    const ADAPTER = path.join(DEPLOY_DIR, "cloud-run.md");

    it("file exists", () => {
      assert.ok(fs.existsSync(ADAPTER), "core/deploy/cloud-run.md does not exist");
    });

    it("contains ## Assumptions", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Assumptions"), "missing ## Assumptions section");
    });

    it("contains ## Config", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Config"), "missing ## Config section");
    });

    it("contains ## Procedure", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Procedure"), "missing ## Procedure section");
    });

    it("contains ## Runbook hooks", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Runbook hooks"), "missing ## Runbook hooks section");
    });

    it("gate body uses deploy_completed", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("deploy_completed"), "missing deploy_completed field");
    });

    it("gate body uses smoke_tests_passed", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("smoke_tests_passed"), "missing smoke_tests_passed field");
    });

    it("gate body uses rollback_executed", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("rollback_executed"), "missing rollback_executed field");
    });
  });

  describe("core/deploy/README.md table vs filesystem — gizmos", () => {
    it("README lists gizmos adapter", () => {
      const content = fs.readFileSync(README, "utf8");
      assert.ok(content.includes("`gizmos`"), "README missing `gizmos` entry");
    });

    it("README gizmos row references gizmos.md", () => {
      const content = fs.readFileSync(README, "utf8");
      assert.ok(content.includes("gizmos.md"), "README missing gizmos.md reference");
    });
  });

  describe("core/deploy/gizmos.md", () => {
    const ADAPTER = path.join(DEPLOY_DIR, "gizmos.md");

    it("file exists", () => {
      assert.ok(fs.existsSync(ADAPTER), "core/deploy/gizmos.md does not exist");
    });

    it("contains ## Assumptions", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Assumptions"), "missing ## Assumptions section");
    });

    it("contains ## Config", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Config"), "missing ## Config section");
    });

    it("contains ## Procedure", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Procedure"), "missing ## Procedure section");
    });

    it("contains ## Runbook hooks", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Runbook hooks"), "missing ## Runbook hooks section");
    });

    it("contains ## Platform constraints", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("## Platform constraints"), "missing ## Platform constraints section");
    });

    it("gate body uses deploy_completed", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("deploy_completed"), "missing deploy_completed field");
    });

    it("gate body uses smoke_tests_passed", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("smoke_tests_passed"), "missing smoke_tests_passed field");
    });

    it("gate body uses rollback_executed", () => {
      const content = fs.readFileSync(ADAPTER, "utf8");
      assert.ok(content.includes("rollback_executed"), "missing rollback_executed field");
    });
  });
});
