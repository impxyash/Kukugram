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

test("a late Settings response from account A cannot overwrite account B after an identity switch", async ({
  page
}) => {
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
  let switchToAccountB = false;
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
      await reply(route, 200, { user: switchToAccountB ? accountB : accountA });
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
      if (!switchToAccountB) {
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
  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Display name")).toHaveValue("Account B");
  await expect(page.getByText("Account B private record")).toBeVisible();
  await expect.poll(() => meCalls).toBeGreaterThan(1);
  await expect.poll(() => blockedCalls).toBeGreaterThan(1);

  // Resolve the old account's private response only after B is mounted.
  releaseAccountABlocked();
  await expect(page.getByText("Account A private record")).toHaveCount(0);
  await expect(page.getByText("Account B private record")).toBeVisible();
});

test("moderation case work is discarded when switching to a non-moderator account", async ({
  page
}) => {
  const reportId = "00000000-0000-4000-8000-000000000099";
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000031",
    handle: "moderator-a",
    displayName: "Moderator A"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000032",
    handle: "member-b",
    displayName: "Member B"
  };
  let switchToAccountB = false;
  let meCalls = 0;
  let feedCalls = 0;
  let moderatorProbeCalls = 0;
  let releaseDetails!: () => void;
  let releaseAction!: () => void;
  let markDetailsPending!: () => void;
  let markActionPending!: () => void;
  const detailsPending = new Promise<void>((resolve) => {
    releaseDetails = resolve;
  });
  const actionPending = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  const detailsSeen = new Promise<void>((resolve) => {
    markDetailsPending = resolve;
  });
  const actionSeen = new Promise<void>((resolve) => {
    markActionPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") {
      meCalls += 1;
      await reply(route, 200, { user: switchToAccountB ? accountB : accountA });
      return;
    }
    if (pathname === "/v1/feed") {
      feedCalls += 1;
      if (feedCalls === 1) {
        await unavailable(route);
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
      if (url.searchParams.has("status")) {
        await reply(route, 200, {
          reports: [
            {
              id: reportId,
              category: "spam",
              targetType: "post",
              createdAt: "2026-11-01T00:00:00.000Z",
              status: "open"
            }
          ]
        });
      } else {
        moderatorProbeCalls += 1;
        await reply(route, switchToAccountB ? 403 : 200, { reports: [] });
      }
      return;
    }
    if (pathname === "/v1/moderation/appeals") {
      await reply(route, 200, { appeals: [] });
      return;
    }
    if (pathname === `/v1/moderation/reports/${reportId}`) {
      if (method === "GET") {
        markDetailsPending();
        await detailsPending;
        await reply(route, 200, {
          report: {
            targetId: "private-target-a",
            details: "Account A confidential report details"
          }
        });
      } else if (method === "PATCH") {
        markActionPending();
        await actionPending;
        await reply(route, 200, {});
      }
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your people, in motion." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Moderation" })).toBeVisible();
  await page.getByRole("button", { name: "Moderation" }).click();
  await page.getByRole("button", { name: "View case details" }).click();
  await detailsSeen;
  await page.getByRole("button", { name: `Resolve report ${reportId.slice(0, 8)}` }).click();
  await actionSeen;

  // Switch from a moderator identity to a distinct non-moderator identity.
  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Moderation" })).toHaveCount(0);
  await expect.poll(() => meCalls).toBeGreaterThan(1);
  await expect.poll(() => moderatorProbeCalls).toBeGreaterThan(1);

  // Complete both old-account requests after its moderation panel unmounts.
  releaseDetails();
  releaseAction();
  await expect(page.getByText("Account A confidential report details")).toHaveCount(0);
  await expect(page.getByText("Report marked as resolved.")).toHaveCount(0);
});

test("pending Settings mutations cannot commit after switching to another identity", async ({
  page
}) => {
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000041",
    handle: "settings-a",
    displayName: "Settings Account A"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000042",
    handle: "settings-b",
    displayName: "Settings Account B"
  };
  const reportId = "00000000-0000-4000-8000-000000000043";
  let switchToAccountB = false;
  let meCalls = 0;
  let feedCalls = 0;
  let pendingCount = 0;
  let markPending!: () => void;
  let releasePending!: () => void;
  const pendingSeen = new Promise<void>((resolve) => {
    markPending = resolve;
  });
  const pendingGate = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  const holdMutation = async (route: Route) => {
    pendingCount += 1;
    if (pendingCount === 6) markPending();
    await pendingGate;
    await reply(route, 200, {});
  };

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") {
      meCalls += 1;
      await reply(route, 200, { user: switchToAccountB ? accountB : accountA });
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
    if (pathname === "/v1/me/follow-requests" && method === "GET") {
      await reply(route, 200, {
        requests: switchToAccountB
          ? []
          : [
              { id: "follow-a", handle: "follow-a", displayName: "Follow A", avatarUrl: null },
              { id: "follow-b", handle: "follow-b", displayName: "Follow B", avatarUrl: null }
            ]
      });
      return;
    }
    if (pathname === "/v1/me/blocked" && method === "GET") {
      await reply(route, 200, {
        users: switchToAccountB
          ? []
          : [
              {
                id: "blocked-a",
                handle: "blocked-a",
                displayName: "Blocked A",
                avatarUrl: null,
              },
            ],
      });
      return;
    }
    if (pathname === "/v1/me/muted" && method === "GET") {
      await reply(route, 200, {
        users: switchToAccountB
          ? []
          : [
              {
                id: "muted-a",
                handle: "muted-a",
                displayName: "Muted A",
                avatarUrl: null,
              },
            ],
      });
      return;
    }
    if (pathname === "/v1/me/reports" && method === "GET") {
      await reply(route, 200, {
        reports: switchToAccountB
          ? []
          : [
              {
                id: reportId,
                category: "spam",
                targetType: "post",
                createdAt: "2026-11-01T00:00:00.000Z",
                status: "resolved",
              },
            ],
      });
      return;
    }
    if (pathname === "/v1/me/appeals" && method === "GET") {
      await reply(route, 200, { appeals: [] });
      return;
    }
    if (
      (pathname === "/v1/me/profile" && method === "PATCH") ||
      (pathname === "/v1/me/follow-requests/follow-a/accept" && method === "POST") ||
      (pathname === "/v1/me/follow-requests/follow-b" && method === "DELETE") ||
      (pathname === "/v1/users/blocked-a/block" && method === "DELETE") ||
      (pathname === "/v1/users/muted-a/mute" && method === "DELETE") ||
      (pathname === `/v1/reports/${reportId}/appeals` && method === "POST")
    ) {
      await holdMutation(route);
      return;
    }
    await reply(route, 200, {});
  });

  page.on("dialog", async (dialog) => {
    await dialog.accept("This decision should be reconsidered.");
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Follow A")).toBeVisible();
  await expect(page.getByText("Follow B")).toBeVisible();
  await expect(page.getByText("Blocked A").first()).toBeVisible();
  await expect(page.getByText("Muted A").first()).toBeVisible();

  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByRole("button", { name: "Accept" }).first().click();
  await page.getByRole("button", { name: "Decline" }).last().click();
  await page.getByRole("button", { name: "Unblock" }).click();
  await page.getByRole("button", { name: "Unmute" }).click();
  await page.getByRole("button", { name: "Appeal decision" }).click();
  await pendingSeen;

  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Display name")).toHaveValue("Settings Account B");
  await expect(page.getByText("No pending follow requests.")).toBeVisible();
  await expect(page.getByText("No blocked accounts.")).toBeVisible();
  await expect(page.getByText("No muted accounts.")).toBeVisible();
  await expect(page.getByText("You have not submitted any reports.")).toBeVisible();

  releasePending();
  await expect(page.getByLabel("Display name")).toHaveValue("Settings Account B");
  await expect(page.getByText("No pending follow requests.")).toBeVisible();
  await expect(page.getByText("No blocked accounts.")).toBeVisible();
  await expect(page.getByText("No muted accounts.")).toBeVisible();
  await expect(page.getByText("You have not submitted any reports.")).toBeVisible();
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

test("a collapsed moderation detail response is invalidated instead of cached", async ({
  page
}) => {
  const reportId = "00000000-0000-4000-8000-000000000051";
  let detailCalls = 0;
  let releaseFirstDetail!: () => void;
  let markFirstDetailPending!: () => void;
  const firstDetailGate = new Promise<void>((resolve) => {
    releaseFirstDetail = resolve;
  });
  const firstDetailSeen = new Promise<void>((resolve) => {
    markFirstDetailPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/v1/me") {
      await authenticated(route);
      return;
    }
    if (pathname === "/v1/feed") {
      await reply(route, 200, { posts: [] });
      return;
    }
    if (pathname === "/v1/notifications") {
      await reply(route, 200, { notifications: [] });
      return;
    }
    if (pathname === "/v1/moderation/reports") {
      if (url.searchParams.has("status")) {
        await reply(route, 200, {
          reports: [
            {
              id: reportId,
              category: "spam",
              targetType: "post",
              createdAt: "2026-11-01T00:00:00.000Z",
              status: "open"
            }
          ]
        });
      } else {
        await reply(route, 200, { reports: [] });
      }
      return;
    }
    if (pathname === `/v1/moderation/reports/${reportId}` && route.request().method() === "GET") {
      detailCalls += 1;
      if (detailCalls === 1) {
        markFirstDetailPending();
        await firstDetailGate;
      }
      await reply(route, 200, {
        report: { targetId: "private-target", details: "Confidential report evidence" }
      });
      return;
    }
    if (pathname === "/v1/moderation/appeals") {
      await reply(route, 200, { appeals: [] });
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Moderation" })).toBeVisible();
  await page.getByRole("button", { name: "Moderation" }).click();
  await page.getByRole("button", { name: "View case details" }).click();
  await firstDetailSeen;
  await page.getByRole("button", { name: "Hide case details" }).click();
  releaseFirstDetail();

  await page.getByRole("button", { name: "View case details" }).click();
  await expect(page.getByText("Confidential report evidence")).toBeVisible();
  expect(detailCalls).toBe(2);
});
