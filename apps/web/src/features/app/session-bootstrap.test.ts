import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.js";
import { loadSession } from "./session-bootstrap.js";
import { reconcileSessionActivity } from "./app-shell.js";

type TestUser = { id: string };
type TestPost = { id: string };
type TestNotification = { id: string };

describe("session bootstrap", () => {
  it("loads the signed-in user, feed and notifications", async () => {
    const requester = vi.fn(<T>(path: string): Promise<T> => {
      const values = {
        "/me": { user: { id: "user-1" } },
        "/feed": { posts: [{ id: "post-1" }] },
        "/notifications": { notifications: [{ id: "notice-1" }] }
      };
      return Promise.resolve(values[path as keyof typeof values] as T);
    });

    await expect(loadSession<TestUser, TestPost, TestNotification>(requester)).resolves.toEqual({
      status: "authenticated",
      user: { id: "user-1" },
      posts: [{ id: "post-1" }],
      notifications: [{ id: "notice-1" }],
      activityError: false
    });
    expect(requester).toHaveBeenCalledTimes(3);
  });

  it("treats expired or missing sessions as unauthenticated without requesting activity", async () => {
    const requester = vi.fn(
      <T>(): Promise<T> => Promise.reject(new ApiError("Authentication required", 401))
    );

    await expect(loadSession<TestUser, TestPost, TestNotification>(requester)).resolves.toEqual({
      status: "unauthenticated",
      error: null
    });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("surfaces non-authentication session failures", async () => {
    const requester = vi.fn(
      <T>(): Promise<T> => Promise.reject(new ApiError("Service unavailable", 503))
    );

    await expect(loadSession<TestUser, TestPost, TestNotification>(requester)).resolves.toEqual({
      status: "unauthenticated",
      error: "Service unavailable"
    });
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("keeps successful activity when feed loading fails and signals a retry", async () => {
    const requester = vi.fn(<T>(path: string): Promise<T> => {
      if (path === "/me") return Promise.resolve({ user: { id: "user-1" } } as T);
      if (path === "/feed") return Promise.reject(new ApiError("Feed unavailable", 503));
      return Promise.resolve({ notifications: [{ id: "notice-1" }] } as T);
    });

    await expect(loadSession<TestUser, TestPost, TestNotification>(requester)).resolves.toEqual({
      status: "authenticated",
      user: { id: "user-1" },
      posts: undefined,
      notifications: [{ id: "notice-1" }],
      activityError: true
    });
  });

  it("keeps the feed when notification loading fails and signals a retry", async () => {
    const requester = vi.fn(<T>(path: string): Promise<T> => {
      if (path === "/me") return Promise.resolve({ user: { id: "user-1" } } as T);
      if (path === "/notifications") {
        return Promise.reject(new ApiError("Notifications unavailable", 503));
      }
      return Promise.resolve({ posts: [{ id: "post-1" }] } as T);
    });

    await expect(loadSession<TestUser, TestPost, TestNotification>(requester)).resolves.toEqual({
      status: "authenticated",
      user: { id: "user-1" },
      posts: [{ id: "post-1" }],
      notifications: undefined,
      activityError: true
    });
  });

  it("preserves same-user activity but clears activity when the account changes", () => {
    const sameUser = reconcileSessionActivity(
      "user-1",
      "user-1",
      [{ id: "post-old" }],
      [{ id: "notice-old" }],
      undefined,
      [{ id: "notice-new" }]
    );
    expect(sameUser).toEqual({
      posts: [{ id: "post-old" }],
      notices: [{ id: "notice-new" }]
    });

    const changedUser = reconcileSessionActivity(
      "user-1",
      "user-2",
      [{ id: "private-post" }],
      [{ id: "private-notice" }],
      undefined,
      [{ id: "new-notice" }]
    );
    expect(changedUser).toEqual({
      posts: [],
      notices: [{ id: "new-notice" }]
    });
  });
});
