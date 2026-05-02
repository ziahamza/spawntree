import { describe, expect, it } from "vitest";
import { ApiClient, ApiClientError } from "../src/api/client.ts";

describe("ApiClient", () => {
  it("does not send a content-type header when the request has no body", async () => {
    let seenHeaders: Headers | undefined;
    const client = new ApiClient({
      fetchFn: async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            version: "test",
            pid: 1,
            uptime: 0,
            repos: 0,
            activeEnvs: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    await client.getDaemonInfo();
    expect(seenHeaders?.has("Content-Type")).toBe(false);
  });

  it("preserves raw error text when the ApiError schema does not match", async () => {
    const client = new ApiClient({
      fetchFn: async () =>
        new Response(JSON.stringify({ message: "server said no" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        }),
    });

    await expect(client.getDaemonInfo()).rejects.toMatchObject<ApiClientError>({
      message: JSON.stringify({ message: "server said no" }),
      statusCode: 400,
    });
  });
});
