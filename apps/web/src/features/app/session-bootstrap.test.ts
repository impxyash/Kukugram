import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client.js";
import {
  createMountedRequestScope,
  createSessionRequestSequence,
  loadSession,
  mergeFeedPosts,
  mergeNotifications,
  runIfRequestScopeActive
} from "./session-bootstrap.js";
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

describe("session request sequencing", () => {
  it("allows only the newest concurrent refresh to update session state", () => {
    const sequence = createSessionRequestSequence();
    const firstRefresh = sequence.begin();
    const secondRefresh = sequence.begin();

    expect(sequence.isCurrent(firstRefresh)).toBe(false);
    expect(sequence.isCurrent(secondRefresh)).toBe(true);
  });

  it("invalidates an in-flight refresh when logout completes", () => {
    const sequence = createSessionRequestSequence();
    const pendingRefresh = sequence.begin();

    sequence.invalidate();

    expect(sequence.isCurrent(pendingRefresh)).toBe(false);
    const refreshAfterLogout = sequence.begin();
    expect(sequence.isCurrent(refreshAfterLogout)).toBe(true);
  });

  it("keeps loading ownership with the newest refresh", () => {
    const sequence = createSessionRequestSequence();
    const olderRefresh = sequence.begin();
    const latestRefresh = sequence.begin();

    expect(sequence.isCurrent(olderRefresh)).toBe(false);
    expect(sequence.isCurrent(latestRefresh)).toBe(true);
  });
});

describe("request-scoped async completion", () => {
  it("does not start authentication completion after its scope is invalidated", async () => {
    const scope = createMountedRequestScope();
    const onAuthenticated = vi.fn(() => Promise.resolve());
    let resolveAuth!: () => void;
    const pendingAuth = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });
    const completion = pendingAuth.then(() => runIfRequestScopeActive(scope, onAuthenticated));

    scope.invalidate();
    resolveAuth();
    await completion;

    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe("mounted request scope", () => {
  it("rejects a pending account request after its component is invalidated", async () => {
    const scope = createMountedRequestScope();
    let resolveRequest!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const committed: string[] = [];
    const completion = pending.then((value) => {
      if (scope.isActive()) committed.push(value);
    });

    scope.invalidate();
    resolveRequest("account-a-private-data");
    await completion;

    expect(scope.isActive()).toBe(false);
    expect(committed).toEqual([]);
  });

  it("allows the current account component to commit its own response", async () => {
    const scope = createMountedRequestScope();
    const committed: string[] = [];
    await Promise.resolve("account-b-data").then((value) => {
      if (scope.isActive()) committed.push(value);
    });

    expect(committed).toEqual(["account-b-data"]);
  });
});

describe("feed cursor bootstrap", () => {
  it("preserves the initial feed cursor for the authenticated session", async () => {
    const requester = vi.fn(<T>(path: string): Promise<T> => {
      const values = {
        "/me": { user: { id: "user-1" } },
        "/feed": { posts: [{ id: "post-1" }], nextCursor: "cursor-user-1-page-2" },
        "/notifications": { notifications: [] }
      };
      return Promise.resolve(values[path as keyof typeof values] as T);
    });

    await expect(
      loadSession<TestUser, TestPost, TestNotification>(requester)
    ).resolves.toMatchObject({
      status: "authenticated",
      posts: [{ id: "post-1" }],
      nextCursor: "cursor-user-1-page-2"
    });
  });

  it("leaves the initial cursor undefined when the feed has no next page", async () => {
    const requester = vi.fn(<T>(path: string): Promise<T> => {
      const values = {
        "/me": { user: { id: "user-1" } },
        "/feed": { posts: [{ id: "post-1" }] },
        "/notifications": { notifications: [] }
      };
      return Promise.resolve(values[path as keyof typeof values] as T);
    });

    const result = await loadSession<TestUser, TestPost, TestNotification>(requester);
    expect(result).toMatchObject({ status: "authenticated", posts: [{ id: "post-1" }] });
    expect(result).not.toHaveProperty("nextCursor");
  });
});

describe("notification pagination bootstrap", () => {
  it("preserves the first notification cursor from session bootstrap", async () => {
    const requester = vi.fn(<T>(path: string): Promise<T> => {
      const values = {
        "/me": { user: { id: "user-1" } },
        "/feed": { posts: [] },
        "/notifications": {
          notifications: [{ id: "notice-1" }],
          nextCursor: "notification-cursor-user-1"
        }
      };
      return Promise.resolve(values[path as keyof typeof values] as T);
    });
    await expect(
      loadSession<TestUser, TestPost, TestNotification>(requester)
    ).resolves.toMatchObject({
      status: "authenticated",
      notifications: [{ id: "notice-1" }],
      notificationCursor: "notification-cursor-user-1"
    });
  });

  it("deduplicates notification pages without changing existing order", () => {
    expect(
      mergeNotifications(
        [{ id: "notice-1" }, { id: "notice-2" }],
        [{ id: "notice-2" }, { id: "notice-3" }]
      )
    ).toEqual([{ id: "notice-1" }, { id: "notice-2" }, { id: "notice-3" }]);
  });
});

describe("feed page merging", () => {
  it("deduplicates posts by ID while preserving the existing feed order", () => {
    expect(
      mergeFeedPosts([{ id: "post-1" }, { id: "post-2" }], [{ id: "post-2" }, { id: "post-3" }])
    ).toEqual([{ id: "post-1" }, { id: "post-2" }, { id: "post-3" }]);
  });
});
