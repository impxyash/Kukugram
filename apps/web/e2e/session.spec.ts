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
