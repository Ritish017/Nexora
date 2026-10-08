import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveComputerToken,
  hashArguments,
  createApprovalSignature,
  verifyApprovalSignature,
  PolicyEngine,
  ApprovalBridge,
  SupervisorBridge,
} from "../src/index.ts";

describe("Phase 4: Cryptographic Credential Derivation & HMAC Isolation", () => {
  const validMaster = "super-secret-master-token-with-at-least-24-chars";

  it("rejects master secrets shorter than 24 characters", () => {
    assert.throws(
      () => deriveComputerToken("short-key", "dot-1"),
      /COMPUTER_TOKEN must contain at least 24 characters/
    );
  });

  it("rejects invalid dot identifiers", () => {
    assert.throws(
      () => deriveComputerToken(validMaster, ""),
      /Invalid dotId/
    );
    assert.throws(
      () => deriveComputerToken(validMaster, "invalid/dot/id"),
      /Invalid dotId/
    );
  });

  it("produces deterministic per-Dot container tokens", () => {
    const token1 = deriveComputerToken(validMaster, "dot-alpha");
    const token2 = deriveComputerToken(validMaster, "dot-alpha");
    assert.equal(token1, token2);
    assert.equal(token1.length, 64); // SHA-256 hex
  });

  it("ensures different dots receive cryptographically distinct tokens", () => {
    const tokenA = deriveComputerToken(validMaster, "dot-alpha");
    const tokenB = deriveComputerToken(validMaster, "dot-beta");
    assert.notEqual(tokenA, tokenB);
  });

  it("hashes arguments canonically regardless of object key order", () => {
    const hash1 = hashArguments({ command: "npm test", timeout: 5000, env: { FOO: "bar" } });
    const hash2 = hashArguments({ env: { FOO: "bar" }, timeout: 5000, command: "npm test" });
    assert.equal(hash1, hash2);

    const hash3 = hashArguments({ command: "npm start", timeout: 5000 });
    assert.notEqual(hash1, hash3);
  });

  it("signs and verifies approval binding parameters", () => {
    const secret = "signing-secret-with-over-16-chars";
    const params = {
      action: "exec",
      argumentsHash: hashArguments({ command: "ls" }),
      resource: "container://default/exec",
      actor: "agent-1",
      runId: "run-101",
      policyVersion: "1.0.0",
      expiry: Date.now() + 60000,
    };

    const signature = createApprovalSignature(secret, params);
    assert.ok(signature.length > 0);

    const valid = verifyApprovalSignature(secret, params, signature);
    assert.equal(valid, true);

    // Tampered params should fail
    const tampered = { ...params, action: "files_write" };
    const invalid = verifyApprovalSignature(secret, tampered, signature);
    assert.equal(invalid, false);
  });
});

describe("Phase 4: Policy Engine & Security Invariants", () => {
  const policyEngine = new PolicyEngine({ mode: "supervised" });

  it("identifies mutating vs read-only actions", () => {
    assert.equal(policyEngine.isMutatingAction("exec"), true);
    assert.equal(policyEngine.isMutatingAction("files_write"), true);
    assert.equal(policyEngine.isMutatingAction("browser_click"), true);
    assert.equal(policyEngine.isMutatingAction("files_read"), false);
    assert.equal(policyEngine.isMutatingAction("browser_screenshot"), false);
  });

  it("blocks directory traversal attempts in paths", () => {
    const eval1 = policyEngine.evaluateAction("files_read", { path: "../outside.txt" });
    assert.equal(eval1.allowed, false);
    assert.match(eval1.reason!, /Path traversal sequence/);

    const eval2 = policyEngine.evaluateAction("files_write", { path: "subdir/../../escape.json" });
    assert.equal(eval2.allowed, false);
    assert.match(eval2.reason!, /Path traversal sequence/);

    const eval3 = policyEngine.evaluateAction("files_read", { path: "/etc/passwd" });
    assert.equal(eval3.allowed, false);
    assert.match(eval3.reason!, /Absolute root path traversal prohibited/);

    const eval4 = policyEngine.evaluateAction("files_read", { path: "C:\\Windows\\System32" });
    assert.equal(eval4.allowed, false);
    assert.match(eval4.reason!, /Absolute root path traversal prohibited/);
  });

  it("blocks prohibited shell commands on denylist", () => {
    const eval1 = policyEngine.evaluateAction("exec", { command: "rm -rf /" });
    assert.equal(eval1.allowed, false);
    assert.match(eval1.reason!, /prohibited system command/);

    const eval2 = policyEngine.evaluateAction("exec", { command: "mkfs.ext4 /dev/sda1" });
    assert.equal(eval2.allowed, false);
    assert.match(eval2.reason!, /prohibited system command/);
  });

  it("requires owner approval for mutating actions in supervised mode", () => {
    const evaluation = policyEngine.evaluateAction("exec", { command: "npm test" }, "agent");
    assert.equal(evaluation.allowed, true);
    assert.equal(evaluation.requiresApproval, true);
    assert.equal(evaluation.isMutating, true);
  });

  it("permits safe read actions in supervised mode without approval pause", () => {
    const evaluation = policyEngine.evaluateAction("files_read", { path: "README.md" }, "agent");
    assert.equal(evaluation.allowed, true);
    assert.equal(evaluation.requiresApproval, false);
    assert.equal(evaluation.isMutating, false);
  });

  it("owner actions bypass approval requirement", () => {
    const evaluation = policyEngine.evaluateAction("exec", { command: "npm test" }, "owner");
    assert.equal(evaluation.allowed, true);
    assert.equal(evaluation.requiresApproval, false);
  });
});

describe("Phase 4: Approval Bridge & Exact Argument Hash Verification", () => {
  const secret = "platform-approval-secret-32-chars-long";
  const bridge = new ApprovalBridge(secret);

  it("creates approval request and enforces exact argument match", () => {
    const originalArgs = { command: "echo hello", cwd: "/workspace" };
    const request = bridge.createRequest({
      id: "appr-01",
      runId: "run-001",
      action: "exec",
      args: originalArgs,
      resource: "container://agent-1/exec",
      actor: "agent-1",
      policyVersion: "1.0.0",
      ttlMs: 60000,
    });

    assert.equal(request.status, "pending");
    assert.equal(request.consumed, false);

    // Cannot authorize before owner approval
    const preCheck = bridge.authorizeExecution({
      approvalId: "appr-01",
      runId: "run-001",
      proposedArgs: originalArgs,
      actor: "agent-1",
    });
    assert.equal(preCheck.authorized, false);
    assert.match(preCheck.reason!, /expected 'approved'/);

    // Owner approves
    bridge.resolveRequest("appr-01", true, "owner-alice");
    assert.equal(request.status, "approved");

    // Attempt execution with mutated arguments must fail!
    const mutatedArgs = { command: "echo rm -rf /", cwd: "/workspace" };
    const mutateCheck = bridge.authorizeExecution({
      approvalId: "appr-01",
      runId: "run-001",
      proposedArgs: mutatedArgs,
      actor: "agent-1",
    });
    assert.equal(mutateCheck.authorized, false);
    assert.match(mutateCheck.reason!, /Proposed arguments do not match approved argument hash/);

    // Execution with original arguments succeeds
    const validExecution = bridge.authorizeExecution({
      approvalId: "appr-01",
      runId: "run-001",
      proposedArgs: originalArgs,
      actor: "agent-1",
    });
    assert.equal(validExecution.authorized, true);

    // Replay attempt must fail (consumed once)
    const replayCheck = bridge.authorizeExecution({
      approvalId: "appr-01",
      runId: "run-001",
      proposedArgs: originalArgs,
      actor: "agent-1",
    });
    assert.equal(replayCheck.authorized, false);
    assert.match(replayCheck.reason!, /already been consumed/);
  });

  it("rejects cross-run or cross-actor authorization attempts", () => {
    const args = { file: "doc.txt" };
    const request = bridge.createRequest({
      id: "appr-02",
      runId: "run-002",
      action: "files_write",
      args,
      resource: "container://agent-1/file",
      actor: "agent-1",
      policyVersion: "1.0.0",
    });

    bridge.resolveRequest("appr-02", true, "owner-alice");

    const crossRun = bridge.authorizeExecution({
      approvalId: "appr-02",
      runId: "run-999", // Different run
      proposedArgs: args,
      actor: "agent-1",
    });
    assert.equal(crossRun.authorized, false);
    assert.match(crossRun.reason!, /Run ID mismatch/);

    const crossActor = bridge.authorizeExecution({
      approvalId: "appr-02",
      runId: "run-002",
      proposedArgs: args,
      actor: "agent-2", // Different actor
    });
    assert.equal(crossActor.authorized, false);
    assert.match(crossActor.reason!, /Actor mismatch/);
  });

  it("rejects expired approval requests", () => {
    const args = { action: "read" };
    const request = bridge.createRequest({
      id: "appr-03",
      runId: "run-003",
      action: "files_read",
      args,
      resource: "container://agent-1/file",
      actor: "agent-1",
      policyVersion: "1.0.0",
      ttlMs: -1000, // Already expired
    });

    assert.throws(
      () => bridge.resolveRequest("appr-03", true, "owner-alice"),
      /has expired/
    );
  });
});

describe("Phase 4: OpenBot Container Supervisor Bridge & Offline Resilience", () => {
  const masterKey = "master-token-openbot-supervisor-24-chars-min";

  it("computes container spec and volume attachments matching OpenBot pin b6932d31", () => {
    const supervisor = new SupervisorBridge({
      supervisorUrl: "http://127.0.0.1:4312",
      supervisorToken: "sup-token-123",
      computerToken: masterKey,
      namespace: "nexora",
    });

    const spec = supervisor.getContainerSpec("specialist-7");
    assert.equal(spec.containerName, "nexora-computer-specialist-7");
    assert.equal(spec.workspaceVolume, "nexora-computer-specialist-7-workspace");
    assert.equal(spec.profileVolume, "nexora-computer-specialist-7-profile");

    const derivedToken = supervisor.getContainerToken("specialist-7");
    assert.equal(derivedToken, deriveComputerToken(masterKey, "specialist-7"));
  });

  it("handles offline / unreachable Docker daemon gracefully without crashing", async () => {
    // Unreachable loopback port simulates stopped Docker daemon or missing supervisor
    const supervisor = new SupervisorBridge({
      supervisorUrl: "http://127.0.0.1:59999",
      supervisorToken: "sup-token-123",
      computerToken: masterKey,
      namespace: "nexora",
    });

    const status = await supervisor.getStatus("specialist-7");
    assert.equal(status.status, "unavailable");
    assert.ok(status.error?.includes("Computer supervisor unreachable") || status.error?.includes("Docker daemon"));
    assert.equal(status.volumes?.workspace, "nexora-computer-specialist-7-workspace");
    assert.equal(status.volumes?.profile, "nexora-computer-specialist-7-profile");
  });

  it("communicates container lifecycle with mock supervisor transport", async () => {
    const mockTransport: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/computers") && init?.method === "GET") {
        return new Response(
          JSON.stringify({
            computers: [
              {
                botId: "specialist-1",
                container: "nexora-computer-specialist-1",
                status: "running",
                port: 4101,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (urlStr.includes("/computers/specialist-1/ensure") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            botId: "specialist-1",
            container: "nexora-computer-specialist-1",
            status: "running",
            port: 4101,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (urlStr.includes("/computers/specialist-1/stop") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    };

    const supervisor = new SupervisorBridge({
      supervisorUrl: "http://127.0.0.1:4312",
      supervisorToken: "sup-token-123",
      computerToken: masterKey,
      namespace: "nexora",
      transport: mockTransport,
    });

    const status = await supervisor.getStatus("specialist-1");
    assert.equal(status.status, "running");
    assert.equal(status.port, 4101);

    const ensured = await supervisor.ensureContainer("specialist-1");
    assert.equal(ensured.status, "running");

    await supervisor.stopContainer("specialist-1");
  });
});
