import { describe, expect, it } from "vitest";
import { ApiClient, ApiClientError } from "../src/api/client.ts";

describe("ApiClient", () => {
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
