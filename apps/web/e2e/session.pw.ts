import { expect, test, type Page, type Route } from "@playwright/test";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  handle: "yash",
  displayName: "Yash",
  bio: null,
  avatarUrl: null,
  followers: "0",
  following: "0",
  isFollowing: false,
  isRequested: false,
  privacy: "public" as const,
  canViewContent: true,
  isBlocked: false
};

async function reply(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function installApi(
  page: Page,
  options: {
    me: (call: number, route: Route) => Promise<void>;
    feed?: (call: number, route: Route) => Promise<void>;
  }
) {
  let meCalls = 0;
  let feedCalls = 0;
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") {
      meCalls += 1;
      await options.me(meCalls, route);
      return;
    }
    if (pathname === "/v1/feed") {
      feedCalls += 1;
      if (options.feed) {
        await options.feed(feedCalls, route);
      } else {
        await reply(route, 200, { posts: [] });
      }
      return;
    }
    if (pathname === "/v1/notifications") {
      await reply(route, 200, { notifications: [] });
      return;
    }
    if (pathname === "/v1/moderation/reports") {
      await reply(route, 403, { title: "Forbidden" });
      return;
    }
    if (pathname === "/v1/auth/logout") {
      await reply(route, 200, { ok: true });
      return;
    }
    await reply(route, 200, {});
  });
  return {
    get meCalls() {
      return meCalls;
    },
    get feedCalls() {
      return feedCalls;
    }
  };
}

const unavailable = (route: Route) => reply(route, 503, { title: "Service unavailable" });
const unauthenticated = (route: Route) => reply(route, 401, { title: "Authentication required" });
const authenticated = (route: Route) => reply(route, 200, { user });

test("starts in the unauthenticated state when the session is missing", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => unauthenticated(route) });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry session" })).toHaveCount(0);
});

test("displays a session error when the session endpoint is unavailable", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => unavailable(route) });
  await page.goto("/");

  await expect(page.locator(".form-error")).toContainText("Service unavailable");
  await expect(page.getByRole("button", { name: "Retry session" })).toBeVisible();
});

test("the actual Retry session button retries the session request", async ({ page }) => {
  await installApi(page, {
    me: async (call, route) => (call === 1 ? unavailable(route) : unauthenticated(route))
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry session" })).toBeVisible();

  await page.getByRole("button", { name: "Retry session" }).click();

  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry session" })).toHaveCount(0);
});

test("keeps the session error visible when a retry also fails", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => unavailable(route) });
  await page.goto("/");
  await page.getByRole("button", { name: "Retry session" }).click();

  await expect(page.locator(".form-error")).toContainText("Service unavailable");
  await expect(page.getByRole("button", { name: "Retry session" })).toBeVisible();
});

test("recovers authentication after a successful retry", async ({ page }) => {
  await installApi(page, {
    me: async (call, route) => (call === 1 ? unavailable(route) : authenticated(route))
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Retry session" }).click();

  await expect(page.getByRole("heading", { name: "Your people, in motion." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Write a post" })).toBeVisible();
});

test("renders the recovered dashboard and feed after session recovery", async ({ page }) => {
  await installApi(page, {
    me: async (call, route) => (call === 1 ? unavailable(route) : authenticated(route))
  });
  await page.goto("/");
  await expect(page.locator(".form-error")).toBeVisible();
  await page.getByRole("button", { name: "Retry session" }).click();

  await expect(page.getByRole("heading", { name: "Your feed is waiting." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
});

test("only the newest of concurrent retries can update the dashboard", async ({ page }) => {
  let releaseOlder!: () => void;
  const olderResponse = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });
  const calls = await installApi(page, {
    me: async (call, route) => {
      if (call === 1) return authenticated(route);
      if (call === 2) {
        await olderResponse;
        await unavailable(route);
        return;
      }
      await authenticated(route);
    },
    feed: async (call, route) => {
      if (call === 1) {
        await unavailable(route);
      } else {
        await reply(route, 200, { posts: [] });
      }
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });

  await expect.poll(() => calls.meCalls).toBe(3);
  await expect(page.getByRole("heading", { name: "Your people, in motion." })).toBeVisible();
  releaseOlder();
  await expect(page.getByRole("heading", { name: "Your people, in motion." })).toBeVisible();
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

test("allows logout while a background session refresh is pending", async ({ page }) => {
  let releaseRefresh!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await installApi(page, {
    me: async (call, route) => {
      if (call === 2) await pendingRefresh;
      await authenticated(route);
    },
    feed: async (call, route) =>
      call === 1 ? unavailable(route) : reply(route, 200, { posts: [] })
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();

  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  releaseRefresh();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
});

test("a stale successful session response cannot restore a logged-out user", async ({ page }) => {
  let releaseRefresh!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await installApi(page, {
    me: async (call, route) => {
      if (call === 2) await pendingRefresh;
      await authenticated(route);
    },
    feed: async (call, route) =>
      call === 1 ? unavailable(route) : reply(route, 200, { posts: [] })
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();

  releaseRefresh();
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);
});


test(
  "a late Settings response from account A cannot overwrite account B after an identity switch",
  async ({ page }) => {
    const accountA = {
      ...user,
      id: "00000000-0000-4000-8000-000000000011",
      handle: "account-a",
      displayName: "Account A"
    };
    const accountB = {
      ...user,
      id: "00000000-0000-4000-8000-000000000022",
      handle: "account-b",
      displayName: "Account B"
    };
    let meCalls = 0;
    let feedCalls = 0;
    let blockedCalls = 0;
    let releaseAccountABlocked!: () => void;
    let markAccountABlockedPending!: () => void;
    const accountABlockedPending = new Promise<void>((resolve) => {
      releaseAccountABlocked = resolve;
    });
    const accountABlockedSeen = new Promise<void>((resolve) => {
      markAccountABlockedPending = resolve;
    });

    await page.route("**/v1/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/v1/me") {
        meCalls += 1;
        await reply(route, 200, { user: meCalls === 1 ? accountA : accountB });
        return;
      }
      if (pathname === "/v1/feed") {
        feedCalls += 1;
        await (feedCalls === 1 ? unavailable(route) : reply(route, 200, { posts: [] }));
        return;
      }
      if (pathname === "/v1/notifications") {
        await reply(route, 200, { notifications: [] });
        return;
      }
      if (pathname === "/v1/moderation/reports") {
        await reply(route, 403, { title: "Forbidden" });
        return;
      }
      if (pathname === "/v1/me/follow-requests") {
        await reply(route, 200, { requests: [] });
        return;
      }
      if (pathname === "/v1/me/blocked") {
        blockedCalls += 1;
        if (blockedCalls === 1) {
          markAccountABlockedPending();
          await accountABlockedPending;
          await reply(route, 200, {
            users: [
              {
                id: "blocked-a",
                handle: "private-a",
                displayName: "Account A private record",
                avatarUrl: null
              }
            ]
          });
        } else {
          await reply(route, 200, {
            users: [
              {
                id: "blocked-b",
                handle: "private-b",
                displayName: "Account B private record",
                avatarUrl: null
              }
            ]
          });
        }
        return;
      }
      if (pathname === "/v1/me/muted") {
        await reply(route, 200, { users: [] });
        return;
      }
      if (pathname === "/v1/me/reports") {
        await reply(route, 200, { reports: [] });
        return;
      }
      if (pathname === "/v1/me/appeals") {
        await reply(route, 200, { appeals: [] });
        return;
      }
      await reply(route, 200, {});
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your people, in motion." })).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    await accountABlockedSeen;

    // A second session refresh returns a distinct authenticated identity.
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByLabel("Display name")).toHaveValue("Account B");
    await expect(page.getByText("Account B private record")).toBeVisible();
    expect(meCalls).toBe(2);
    expect(blockedCalls).toBe(2);

    // Resolve the old account's private response only after B is mounted.
    releaseAccountABlocked();
    await expect(page.getByText("Account A private record")).toHaveCount(0);
    await expect(page.getByText("Account B private record")).toBeVisible();
  }
);
