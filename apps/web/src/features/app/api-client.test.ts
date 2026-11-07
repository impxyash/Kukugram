import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "./api-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API client", () => {
  it("includes credentials and parses successful JSON responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(request<{ status: string }>("/health")).resolves.toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/health$/),
      expect.objectContaining({
        credentials: "include",
        headers: { "content-type": "application/json" }
      })
    );
  });

  it("returns undefined for successful no-content responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(request<void>("/notifications/read", { method: "POST" })).resolves.toBeUndefined();
  });

  it("preserves the HTTP status and Problem Details title for API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ title: "Authentication required" }), {
          status: 401,
          headers: { "content-type": "application/problem+json" }
        })
      )
    );

    const result = request("/me");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      name: "ApiError",
      message: "Authentication required",
      status: 401
    });
  });

  it("uses a safe fallback when an error response has no readable Problem Details body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));

    await expect(request("/feed")).rejects.toMatchObject({
      name: "ApiError",
      message: "Something went wrong. Please try again.",
      status: 503
    });
  });
});
