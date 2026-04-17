import { describe, expect, it } from "vitest";
import { buildDefaultClient } from "../src/acp/client.ts";

/**
 * The ACP permission dialog gives the agent a list of `options` and we pick
 * one by matching against the configured `permissionPolicy`. These tests
 * lock down the fail-CLOSED behavior: if the user asks to reject and the
 * agent didn't offer the exact reject kind, we must never silently allow.
 *
 * Regression coverage for the original bug where a missing policy match
 * would fall through to `options[0]` — which is typically `allow_once`,
 * so `"reject_once"` policy would silently become an allow.
 */

type PermissionOption = {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  name?: string;
};

function buildRequest(options: PermissionOption[]) {
  return {
    sessionId: "s1",
    toolCall: {
      toolCallId: "tc1",
      status: "pending" as const,
      title: "Edit file",
    },
    options,
  };
}

// The ACP Client type expects these methods to exist. We only exercise
// `requestPermission` here, but we need the shape to satisfy TypeScript.
const noopDispatch = () => {};

describe("ACP permission policy", () => {
  it("honors an exact match for allow_once", async () => {
    const client = buildDefaultClient(noopDispatch, { permissionPolicy: "allow_once" });
    const res = await client.requestPermission!(
      buildRequest([
        { optionId: "a", kind: "allow_once" },
        { optionId: "b", kind: "reject_once" },
      ]),
    );
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "a" });
  });

  it("honors an exact match for reject_once", async () => {
    const client = buildDefaultClient(noopDispatch, { permissionPolicy: "reject_once" });
    const res = await client.requestPermission!(
      buildRequest([
        { optionId: "a", kind: "allow_once" },
        { optionId: "b", kind: "reject_once" },
      ]),
    );
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "b" });
  });

  it("falls back to another reject kind when the exact reject option is missing", async () => {
    const client = buildDefaultClient(noopDispatch, { permissionPolicy: "reject_once" });
    const res = await client.requestPermission!(
      buildRequest([
        { optionId: "a", kind: "allow_once" },
        { optionId: "b", kind: "reject_always" },
      ]),
    );
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "b" });
  });

  it("cancels when no reject option is present and policy is reject_*", async () => {
    const client = buildDefaultClient(noopDispatch, { permissionPolicy: "reject_once" });
    const res = await client.requestPermission!(
      buildRequest([
        { optionId: "a", kind: "allow_once" },
        { optionId: "b", kind: "allow_always" },
      ]),
    );
    // Fail closed: must NOT pick options[0] (which would be allow_once).
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("falls back to another allow kind when the exact allow option is missing", async () => {
    const client = buildDefaultClient(noopDispatch, { permissionPolicy: "allow_always" });
    const res = await client.requestPermission!(
      buildRequest([
        { optionId: "a", kind: "allow_once" },
        { optionId: "b", kind: "reject_once" },
      ]),
    );
    // No allow_always exists — but allow_once is still an allow, prefer it
    // over falling through to options[0] which might be a reject.
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "a" });
  });

  it("falls back to options[0] only when the allow-kind policy has no kind-matching option at all", async () => {
    const client = buildDefaultClient(noopDispatch, { permissionPolicy: "allow_once" });
    // Hypothetical: custom agent uses non-standard kinds. With no allow_*
    // matches we still fall through to options[0] rather than cancel.
    const res = await client.requestPermission!(
      buildRequest([
        { optionId: "x", kind: "reject_once" },
        { optionId: "y", kind: "reject_always" },
      ]),
    );
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "x" });
  });

  it("cancels when options is empty regardless of policy", async () => {
    const client = buildDefaultClient(noopDispatch, { permissionPolicy: "allow_once" });
    const res = await client.requestPermission!(buildRequest([]));
    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("defaults to allow_once policy when no option is specified", async () => {
    const client = buildDefaultClient(noopDispatch);
    const res = await client.requestPermission!(
      buildRequest([
        { optionId: "a", kind: "allow_once" },
        { optionId: "b", kind: "reject_once" },
      ]),
    );
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "a" });
  });
});
