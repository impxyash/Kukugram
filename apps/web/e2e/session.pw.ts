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

test("keyboard navigation exposes a visible focus ring on auth inputs", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => unauthenticated(route) });
  await page.goto("/");

  const displayName = page.locator('.auth-card-modern input[name="displayName"]');
  for (let index = 0; index < 12; index += 1) {
    if (await displayName.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }

  await expect(displayName).toBeFocused();
  const focus = await displayName.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor
    };
  });
  expect(focus).toEqual({
    visible: true,
    outlineStyle: "solid",
    outlineWidth: "2px",
    outlineColor: "rgb(95, 53, 168)"
  });
});

test("auth card buttons use a visible high-contrast keyboard focus ring", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => unauthenticated(route) });
  await page.goto("/");
  const switchMode = page.getByRole("button", { name: "Log in" });
  await switchMode.focus();

  const focus = await switchMode.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth
    };
  });
  expect(focus).toEqual({
    outlineColor: "rgb(95, 53, 168)",
    outlineStyle: "solid",
    outlineWidth: "2px"
  });
});

test("dark search inputs expose a visible control boundary", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => authenticated(route) });
  await page.goto("/");
  await page.getByRole("button", { name: "Discover" }).click();
  const searchInput = page.locator(".search input");
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveCSS("border-top-color", "rgba(246, 243, 236, 0.38)");
});

test("auth input and secondary button boundaries remain visible", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => unavailable(route) });
  await page.goto("/");
  const email = page.getByLabel("Email address");
  const retry = page.getByRole("button", { name: "Retry session" });
  const styles = await Promise.all([
    email.evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderColor: style.borderTopColor, backgroundColor: style.backgroundColor };
    }),
    retry.evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderColor: style.borderTopColor, color: style.color };
    })
  ]);
  expect(styles).toEqual([
    { borderColor: "rgb(143, 137, 149)", backgroundColor: "rgb(250, 249, 251)" },
    { borderColor: "rgb(107, 101, 114)", color: "rgb(81, 75, 89)" }
  ]);
});

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

async function verifyPendingAppealReviewAfterIdentitySwitch(page: Page, responseStatus: 200 | 500) {
  const appealId = "00000000-0000-4000-8000-000000000041";
  const reportId = "10000000-0000-4000-8000-000000000045";
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000043",
    handle: "moderator-appeals",
    displayName: "Moderator Appeals"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000044",
    handle: "member-after-appeals",
    displayName: "Member After Appeals"
  };
  let switchToAccountB = false;
  let meCalls = 0;
  let feedCalls = 0;
  let moderatorProbeCalls = 0;
  let releaseAction!: () => void;
  let markActionPending!: () => void;
  const actionPending = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  const actionSeen = new Promise<void>((resolve) => {
    markActionPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
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
      if (url.searchParams.has("status")) {
        await reply(route, 200, { reports: [] });
      } else {
        moderatorProbeCalls += 1;
        await reply(route, switchToAccountB ? 403 : 200, { reports: [] });
      }
      return;
    }
    if (pathname === "/v1/moderation/appeals") {
      await reply(route, 200, {
        appeals: [
          {
            id: appealId,
            reportId,
            status: "open",
            createdAt: "2026-11-01T00:00:00.000Z"
          }
        ]
      });
      return;
    }
    if (pathname === `/v1/moderation/appeals/${appealId}`) {
      markActionPending();
      await actionPending;
      await reply(
        route,
        responseStatus,
        responseStatus === 200 ? {} : { title: "Service unavailable" }
      );
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Moderation" })).toBeVisible();
  await page.getByRole("button", { name: "Moderation" }).click();
  const actionName =
    responseStatus === 200
      ? `Accept appeal for case ${reportId.slice(0, 8)}`
      : `Reject appeal for case ${reportId.slice(0, 8)}`;
  await page.getByRole("button", { name: actionName }).click();
  await actionSeen;

  // Switch identities while the moderation mutation is still pending.
  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Moderation" })).toHaveCount(0);
  await expect.poll(() => meCalls).toBeGreaterThan(1);
  await expect.poll(() => moderatorProbeCalls).toBeGreaterThan(1);

  // Complete the old-account request only after the moderation panel unmounts.
  releaseAction();
  await expect(
    page.getByText(responseStatus === 200 ? "Appeal accepted." : "Service unavailable")
  ).toHaveCount(0);
}

test("a pending appeal acceptance cannot update a different identity", async ({ page }) => {
  await verifyPendingAppealReviewAfterIdentitySwitch(page, 200);
});

test("pending appeal rejection cannot report errors after identity switch", async ({ page }) => {
  await verifyPendingAppealReviewAfterIdentitySwitch(page, 500);
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
                avatarUrl: null
              }
            ]
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
                avatarUrl: null
              }
            ]
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
                status: "resolved"
              }
            ]
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

test("a moderator permission revocation hides the panel while the same identity is rechecked", async ({
  page
}) => {
  let feedCalls = 0;
  let probeCalls = 0;
  let releaseRevokedProbe!: () => void;
  let markRevokedProbePending!: () => void;
  const revokedProbeGate = new Promise<void>((resolve) => {
    releaseRevokedProbe = resolve;
  });
  const revokedProbeSeen = new Promise<void>((resolve) => {
    markRevokedProbePending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/v1/me") {
      await authenticated(route);
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
      if (url.searchParams.has("status")) {
        await reply(route, 200, { reports: [] });
        return;
      }
      probeCalls += 1;
      if (probeCalls === 1) {
        await reply(route, 200, { reports: [] });
      } else {
        markRevokedProbePending();
        await revokedProbeGate;
        await reply(route, 403, { title: "Forbidden" });
      }
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
  await page.getByRole("button", { name: "Retry" }).click();
  await revokedProbeSeen;

  // The user ID is unchanged, but the role check is pending and must fail closed.
  await expect(page.getByRole("button", { name: "Moderation" })).toHaveCount(0);
  releaseRevokedProbe();
  await expect(page.getByRole("button", { name: "Moderation" })).toHaveCount(0);
});

test("a collapsed appeal detail response is invalidated instead of cached", async ({ page }) => {
  const appealId = "00000000-0000-4000-8000-000000000071";
  const reportId = "00000000-0000-4000-8000-000000000072";
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
      await reply(route, 200, { reports: [] });
      return;
    }
    if (pathname === "/v1/moderation/appeals") {
      await reply(route, 200, {
        appeals: [
          {
            id: appealId,
            reportId,
            createdAt: "2026-11-01T00:00:00.000Z",
            status: "pending"
          }
        ]
      });
      return;
    }
    if (pathname === `/v1/moderation/appeals/${appealId}` && route.request().method() === "GET") {
      detailCalls += 1;
      if (detailCalls === 1) {
        markFirstDetailPending();
        await firstDetailGate;
      }
      await reply(route, 200, { appeal: { details: "Confidential appeal evidence" } });
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Moderation" }).click();
  await page.getByRole("button", { name: "View appeal details" }).click();
  await firstDetailSeen;
  await page.getByRole("button", { name: "Hide appeal details" }).click();
  releaseFirstDetail();

  await page.getByRole("button", { name: "View appeal details" }).click();
  await expect(page.getByText("Confidential appeal evidence")).toBeVisible();
  expect(detailCalls).toBe(2);
});

test("an appeal history refresh from account A cannot overwrite account B", async ({ page }) => {
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000081",
    handle: "appeal-a",
    displayName: "Appeal Account A"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000082",
    handle: "appeal-b",
    displayName: "Appeal Account B"
  };
  const reportId = "00000000-0000-4000-8000-000000000083";
  let switchToAccountB = false;
  let feedCalls = 0;
  let accountAAppealReads = 0;
  let releaseAppealRefresh!: () => void;
  let markAppealRefreshPending!: () => void;
  const appealRefreshGate = new Promise<void>((resolve) => {
    releaseAppealRefresh = resolve;
  });
  const appealRefreshSeen = new Promise<void>((resolve) => {
    markAppealRefreshPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") {
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
      await reply(route, 200, { requests: [] });
      return;
    }
    if (pathname === "/v1/me/blocked" && method === "GET") {
      await reply(route, 200, { users: [] });
      return;
    }
    if (pathname === "/v1/me/muted" && method === "GET") {
      await reply(route, 200, { users: [] });
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
                status: "resolved"
              }
            ]
      });
      return;
    }
    if (pathname === "/v1/me/appeals" && method === "GET") {
      if (switchToAccountB) {
        await reply(route, 200, { appeals: [] });
        return;
      }
      accountAAppealReads += 1;
      if (accountAAppealReads === 1) {
        await reply(route, 200, { appeals: [] });
      } else {
        markAppealRefreshPending();
        await appealRefreshGate;
        await reply(route, 200, {
          appeals: [
            {
              id: "00000000-0000-4000-8000-000000000084",
              reportId,
              createdAt: "2026-11-01T00:00:00.000Z",
              status: "pending"
            }
          ]
        });
      }
      return;
    }
    if (pathname === `/v1/reports/${reportId}/appeals` && method === "POST") {
      await reply(route, 201, {});
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
  await expect(page.getByText("spam", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Appeal decision" })).toBeVisible();
  await page.getByRole("button", { name: "Appeal decision" }).click();
  await appealRefreshSeen;

  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByLabel("Display name")).toHaveValue("Appeal Account B");
  await expect(page.getByText("You have not submitted any appeals.")).toBeVisible();

  releaseAppealRefresh();
  await expect(page.getByLabel("Display name")).toHaveValue("Appeal Account B");
  await expect(page.getByText("You have not submitted any appeals.")).toBeVisible();
  await expect(page.getByText("Case 00000000")).toHaveCount(0);
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

test("changing moderation filters resets expanded report and appeal details", async ({ page }) => {
  const reportId = "00000000-0000-4000-8000-000000000091";
  const appealId = "00000000-0000-4000-8000-000000000092";
  let reportDetailCalls = 0;
  let appealDetailCalls = 0;

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
      await reply(
        route,
        200,
        url.searchParams.has("status")
          ? {
              reports: [
                {
                  id: reportId,
                  category: "spam",
                  targetType: "post",
                  createdAt: "2026-11-01T00:00:00.000Z",
                  status: "open"
                }
              ]
            }
          : { reports: [] }
      );
      return;
    }
    if (pathname === "/v1/moderation/appeals") {
      await reply(route, 200, {
        appeals: [
          {
            id: appealId,
            reportId,
            createdAt: "2026-11-01T00:00:00.000Z",
            status: "pending"
          }
        ]
      });
      return;
    }
    if (pathname === `/v1/moderation/reports/${reportId}` && route.request().method() === "GET") {
      reportDetailCalls += 1;
      await reply(route, 200, {
        report: { targetId: "target-reference", details: "Report detail evidence" }
      });
      return;
    }
    if (pathname === `/v1/moderation/appeals/${appealId}` && route.request().method() === "GET") {
      appealDetailCalls += 1;
      await reply(route, 200, { appeal: { details: "Appeal detail evidence" } });
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Moderation" }).click();
  await page.getByRole("button", { name: "View case details" }).click();
  await expect(page.getByText("Report detail evidence")).toBeVisible();
  await page.getByRole("button", { name: "View appeal details" }).click();
  await expect(page.getByText("Appeal detail evidence")).toBeVisible();

  await page.getByLabel("Report status").selectOption("resolved");
  await expect(page.getByRole("button", { name: "View case details" })).toBeVisible();
  await expect(page.getByRole("button", { name: "View appeal details" })).toBeVisible();
  await expect(page.getByText("Report detail evidence")).toHaveCount(0);
  await expect(page.getByText("Appeal detail evidence")).toHaveCount(0);

  await page.getByRole("button", { name: "View case details" }).click();
  await expect(page.getByText("Report detail evidence")).toBeVisible();
  await page.getByRole("button", { name: "View appeal details" }).click();
  await expect(page.getByText("Appeal detail evidence")).toBeVisible();
  expect(reportDetailCalls).toBe(2);
  expect(appealDetailCalls).toBe(2);
});

test("Discover search response is discarded after an identity switch", async ({ page }) => {
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000101",
    handle: "discover-a",
    displayName: "Discover Account A"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000102",
    handle: "discover-b",
    displayName: "Discover Account B"
  };
  let switchToAccountB = false;
  let feedCalls = 0;
  let releaseSearch!: () => void;
  let markSearchPending!: () => void;
  const searchGate = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  const searchSeen = new Promise<void>((resolve) => {
    markSearchPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") {
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
    if (pathname === "/v1/users/search") {
      markSearchPending();
      await searchGate;
      await reply(route, 200, {
        users: [
          {
            ...user,
            id: "00000000-0000-4000-8000-000000000103",
            handle: "stale-discover-result",
            displayName: "Account A stale search result"
          }
        ]
      });
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Discover" }).click();
  await page.getByLabel("Search people by name or username").fill("stale");
  await page.getByRole("button", { name: "Search" }).click();
  await searchSeen;

  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Discover" })).toBeVisible();

  releaseSearch();
  await expect(page.getByText("Account A stale search result")).toHaveCount(0);
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

test("Profile edit response is discarded after an identity switch", async ({ page }) => {
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000111",
    handle: "profile-a",
    displayName: "Profile Account A"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000112",
    handle: "profile-b",
    displayName: "Profile Account B"
  };
  let switchToAccountB = false;
  let feedCalls = 0;
  let releaseEdit!: () => void;
  let markEditPending!: () => void;
  const editGate = new Promise<void>((resolve) => {
    releaseEdit = resolve;
  });
  const editSeen = new Promise<void>((resolve) => {
    markEditPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") {
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
    if (pathname === "/v1/me/profile" && method === "PATCH") {
      markEditPending();
      await editGate;
      await reply(route, 200, { user: { ...accountA, displayName: "Account A stale edit" } });
      return;
    }
    await reply(route, 200, {});
  });

  page.on("dialog", async (dialog) => {
    await dialog.accept("Account A edited");
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await editSeen;

  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Profile Account B" })).toBeVisible();

  releaseEdit();
  await expect(page.getByRole("heading", { name: "Profile Account B" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account A stale edit" })).toHaveCount(0);
});

test("PostCard like response is discarded after an identity switch", async ({ page }) => {
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000121",
    handle: "post-a",
    displayName: "Post Account A"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000122",
    handle: "post-b",
    displayName: "Post Account B"
  };
  const post = {
    id: "00000000-0000-4000-8000-000000000123",
    authorId: "00000000-0000-4000-8000-000000000124",
    handle: "creator",
    displayName: "Creator",
    avatarUrl: null,
    body: "Shared feed post",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  let switchToAccountB = false;
  let notificationCalls = 0;
  let releaseLike!: () => void;
  let markLikePending!: () => void;
  const likeGate = new Promise<void>((resolve) => {
    releaseLike = resolve;
  });
  const likeSeen = new Promise<void>((resolve) => {
    markLikePending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") {
      await reply(route, 200, { user: switchToAccountB ? accountB : accountA });
      return;
    }
    if (pathname === "/v1/feed") {
      await reply(route, 200, { posts: [post] });
      return;
    }
    if (pathname === "/v1/notifications") {
      notificationCalls += 1;
      await (notificationCalls === 1
        ? unavailable(route)
        : reply(route, 200, { notifications: [] }));
      return;
    }
    if (pathname === "/v1/moderation/reports") {
      await reply(route, 403, { title: "Forbidden" });
      return;
    }
    if (pathname === `/v1/posts/${post.id}/like` && method === "POST") {
      markLikePending();
      await likeGate;
      await reply(route, 200, {});
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.locator(".post-actions button").first().click();
  await likeSeen;

  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByRole("button", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Post Account B" })).toBeVisible();
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByText("Shared feed post")).toBeVisible();

  releaseLike();
  await expect(page.locator(".post-actions button.liked")).toHaveCount(0);
});

test("keyboard navigation works in the app", async ({ page }) => {
  await installApi(page, { me: async (_call, route) => authenticated(route) });
  await page.goto("/");
  const home = page.getByRole("button", { name: "Home" });
  const discover = page.getByRole("button", { name: "Discover" });
  const activity = page.getByRole("button", { name: "Activity" });
  const profile = page.getByRole("button", { name: "Profile" });

  await home.focus();
  await expect(home).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(discover).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(activity).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(profile).toBeFocused();

  const focus = await profile.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth
    };
  });
  expect(focus).toEqual({ visible: true, outlineStyle: "solid", outlineWidth: "2px" });
});

test("Discover search results are announced", async ({ page }) => {
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [] });
    if (pathname === "/v1/notifications") {
      return reply(route, 200, { notifications: [] });
    }
    if (pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    if (pathname === "/v1/users/search") {
      return reply(route, 200, {
        users: [
          {
            ...user,
            id: "00000000-0000-4000-8000-000000000077",
            handle: "discover-friend",
            displayName: "Discover Friend"
          }
        ]
      });
    }
    return reply(route, 200, {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Discover" }).click();
  await page.getByRole("textbox", { name: "Search people by name or username" }).fill("friend");
  await page.getByRole("button", { name: "Search" }).click();

  const status = page.getByRole("status");
  await expect(status).toHaveText("1 people found.");
  await expect(page.getByText("Discover Friend")).toBeVisible();
  await expect(page.locator(".results")).toHaveAttribute("aria-busy", "false");
});

test("PostCard like button exposes pressed state", async ({ page }) => {
  const post = {
    id: "00000000-0000-4000-8000-000000000231",
    authorId: "00000000-0000-4000-8000-000000000232",
    handle: "creator",
    displayName: "Creator",
    avatarUrl: null,
    body: "Accessible like state post",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "2",
    commentCount: "0",
    likedByViewer: false
  };

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [post] });
    if (pathname === "/v1/notifications") {
      return reply(route, 200, { notifications: [] });
    }
    if (pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    if (pathname === `/v1/posts/${post.id}/like`) return reply(route, 200, {});
    return reply(route, 200, {});
  });

  await page.goto("/");
  const like = page.getByRole("button", { name: "Like post by Creator. 2 likes" });
  await expect(like).toHaveAttribute("aria-pressed", "false");
  await like.click();

  const unlike = page.getByRole("button", { name: "Unlike post by Creator. 3 likes" });
  await expect(unlike).toHaveAttribute("aria-pressed", "true");
});

test("PostCard comments region is accessible", async ({ page }) => {
  const post = {
    id: "00000000-0000-4000-8000-000000000241",
    authorId: "00000000-0000-4000-8000-000000000242",
    handle: "creator",
    displayName: "Creator",
    avatarUrl: null,
    body: "Accessible comments region post",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "1",
    likedByViewer: false
  };
  const comment = {
    id: "00000000-0000-4000-8000-000000000243",
    body: "A readable comment",
    createdAt: "2026-11-02T00:00:00.000Z",
    handle: "commenter",
    displayName: "Commenter",
    avatarUrl: null
  };

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [post] });
    if (pathname === "/v1/notifications") {
      return reply(route, 200, { notifications: [] });
    }
    if (pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    if (pathname === `/v1/posts/${post.id}/comments`) {
      return reply(route, 200, { comments: [comment] });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Reply 1" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const regionId = await toggle.getAttribute("aria-controls");
  if (!regionId) throw new Error("Expected the comments region to have an id");
  const region = page.locator(`#${regionId}`);
  await expect(region).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: "Comments on Creator's post" })).toBeVisible();
  await expect(region).toHaveAttribute("aria-live", "polite");
  await expect(region).toContainText("A readable comment");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(region).toBeHidden();
});

test("concurrent likes on different posts do not overwrite each other", async ({ page }) => {
  const posts = [
    {
      id: "00000000-0000-4000-8000-000000000251",
      authorId: "00000000-0000-4000-8000-000000000261",
      handle: "creator-one",
      displayName: "Creator One",
      avatarUrl: null,
      body: "First concurrent post",
      createdAt: "2026-11-01T00:00:00.000Z",
      likeCount: "0",
      commentCount: "0",
      likedByViewer: false
    },
    {
      id: "00000000-0000-4000-8000-000000000252",
      authorId: "00000000-0000-4000-8000-000000000262",
      handle: "creator-two",
      displayName: "Creator Two",
      avatarUrl: null,
      body: "Second concurrent post",
      createdAt: "2026-11-01T00:00:00.000Z",
      likeCount: "0",
      commentCount: "0",
      likedByViewer: false
    }
  ];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let markFirstPending!: () => void;
  let markSecondPending!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const firstSeen = new Promise<void>((resolve) => {
    markFirstPending = resolve;
  });
  const secondSeen = new Promise<void>((resolve) => {
    markSecondPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts });
    if (pathname === "/v1/notifications") {
      return reply(route, 200, { notifications: [] });
    }
    if (pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    if (pathname === `/v1/posts/${posts[0].id}/like`) {
      markFirstPending();
      await firstGate;
      return reply(route, 200, {});
    }
    if (pathname === `/v1/posts/${posts[1].id}/like`) {
      markSecondPending();
      await secondGate;
      return reply(route, 200, {});
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Like post by Creator One. 0 likes" }).click();
  await firstSeen;
  await page.getByRole("button", { name: "Like post by Creator Two. 0 likes" }).click();
  await secondSeen;

  releaseFirst();
  const firstUnlike = page.getByRole("button", { name: "Unlike post by Creator One. 1 likes" });
  await expect(firstUnlike).toHaveAttribute("aria-pressed", "true");

  releaseSecond();
  const secondUnlike = page.getByRole("button", { name: "Unlike post by Creator Two. 1 likes" });
  await expect(secondUnlike).toHaveAttribute("aria-pressed", "true");
  await expect(firstUnlike).toHaveAttribute("aria-pressed", "true");
});

test("Activity read response is ignored after an identity switch", async ({ page }) => {
  const accountA = {
    ...user,
    id: "00000000-0000-4000-8000-000000000131",
    handle: "activity-a",
    displayName: "Activity Account A"
  };
  const accountB = {
    ...user,
    id: "00000000-0000-4000-8000-000000000132",
    handle: "activity-b",
    displayName: "Activity Account B"
  };
  let switchToAccountB = false;
  let feedCalls = 0;
  let readCalls = 0;
  let releaseFirstRead!: () => void;
  let markFirstReadPending!: () => void;
  let markSecondReadPending!: () => void;
  let markFirstReadSettled!: () => void;
  const firstReadGate = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });
  const firstReadSeen = new Promise<void>((resolve) => {
    markFirstReadPending = resolve;
  });
  const secondReadSeen = new Promise<void>((resolve) => {
    markSecondReadPending = resolve;
  });
  const firstReadSettled = new Promise<void>((resolve) => {
    markFirstReadSettled = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") {
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
    if (pathname === "/v1/notifications/read") {
      readCalls += 1;
      if (readCalls === 1) {
        markFirstReadPending();
        await firstReadGate;
        await reply(route, 500, { title: "Account A read failed" });
        markFirstReadSettled();
        return;
      }
      markSecondReadPending();
      await reply(route, 200, {});
      return;
    }
    await reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Activity" }).click();
  await firstReadSeen;

  switchToAccountB = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "The ripples from your corner." })).toBeVisible();
  await secondReadSeen;

  releaseFirstRead();
  await firstReadSettled;
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

test("rapid repeated likes on one post issue only one request", async ({ page }) => {
  const post = {
    id: "00000000-0000-4000-8000-000000000271",
    authorId: "00000000-0000-4000-8000-000000000272",
    handle: "single-like",
    displayName: "Single Like",
    avatarUrl: null,
    body: "Prevent duplicate like requests",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  let likeCalls = 0;
  let releaseLike!: () => void;
  let markLikePending!: () => void;
  const likeGate = new Promise<void>((resolve) => {
    releaseLike = resolve;
  });
  const likeSeen = new Promise<void>((resolve) => {
    markLikePending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [post] });
    if (pathname === "/v1/notifications") {
      return reply(route, 200, { notifications: [] });
    }
    if (pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    if (pathname === `/v1/posts/${post.id}/like`) {
      likeCalls += 1;
      markLikePending();
      await likeGate;
      return reply(route, 200, {});
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  const like = page.getByRole("button", { name: "Like post by Single Like. 0 likes" });
  await like.evaluate((button) => {
    button.addEventListener(
      "click",
      () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      { capture: true, once: true }
    );
  });
  await like.click();
  await likeSeen;
  await expect(like).toBeDisabled();
  releaseLike();

  const unlike = page.getByRole("button", { name: "Unlike post by Single Like. 1 likes" });
  await expect(unlike).toHaveAttribute("aria-pressed", "true");
  expect(likeCalls).toBe(1);
});

test("late authentication errors do not leak across login and signup modes", async ({ page }) => {
  let releaseSignup!: () => void;
  let markSignupPending!: () => void;
  const signupGate = new Promise<void>((resolve) => {
    releaseSignup = resolve;
  });
  const signupSeen = new Promise<void>((resolve) => {
    markSignupPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return unauthenticated(route);
    if (pathname === "/v1/auth/signup") {
      markSignupPending();
      await signupGate;
      return reply(route, 400, { title: "Stale signup failure" });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByLabel("Full name").fill("Test Creator");
  await page.getByLabel("Username").fill("test_creator");
  await page.getByLabel("Email address").fill("creator@example.com");
  await page.getByLabel("Password").fill("a-secure-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await signupSeen;

  const switchMode = page.getByRole("button", { name: "Log in" });
  await expect(switchMode).toBeDisabled();
  const busySubmit = page.getByRole("button", { name: "Please wait..." });
  const busyStyles = await busySubmit.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      opacity: style.opacity
    };
  });
  expect(busyStyles).toEqual({
    backgroundColor: "rgb(101, 64, 174)",
    color: "rgb(255, 255, 255)",
    opacity: "1"
  });
  releaseSignup();

  await expect(page.getByText("Stale signup failure")).toBeVisible();
  await expect(switchMode).toBeEnabled();
});

test("logout prevents a competing session retry until the request settles", async ({ page }) => {
  let releaseLogout!: () => void;
  let markLogoutPending!: () => void;
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  const logoutSeen = new Promise<void>((resolve) => {
    markLogoutPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return unavailable(route);
    if (pathname === "/v1/notifications") {
      return reply(route, 200, { notifications: [] });
    }
    if (pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    if (pathname === "/v1/auth/logout") {
      markLogoutPending();
      await logoutGate;
      return reply(route, 500, { title: "Logout failed" });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  const logout = page.getByRole("button", { name: "Log out" });
  await logout.click();
  await logoutSeen;

  await expect(logout).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry" })).toBeDisabled();
  releaseLogout();

  await expect(page.getByRole("heading", { name: "Your people, in motion." })).toBeVisible();
  await expect(logout).toBeEnabled();
});

test("rapid comment submissions create only one comment", async ({ page }) => {
  const post = {
    id: "00000000-0000-4000-8000-000000000281",
    authorId: "00000000-0000-4000-8000-000000000282",
    handle: "comment-creator",
    displayName: "Comment Creator",
    avatarUrl: null,
    body: "Comment submission race",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  let commentCalls = 0;
  let releaseComment!: () => void;
  let markCommentPending!: () => void;
  const commentGate = new Promise<void>((resolve) => {
    releaseComment = resolve;
  });
  const commentSeen = new Promise<void>((resolve) => {
    markCommentPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [post] });
    if (pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (pathname === "/v1/moderation/reports") return reply(route, 403, { title: "Forbidden" });
    if (pathname === `/v1/posts/${post.id}/comments` && method === "GET") {
      return reply(route, 200, { comments: [] });
    }
    if (pathname === `/v1/posts/${post.id}/comments` && method === "POST") {
      commentCalls += 1;
      markCommentPending();
      await commentGate;
      return reply(route, 201, {});
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Reply 0" }).click();
  const commentInput = page.getByRole("textbox", { name: "Write a comment" });
  await commentInput.fill("One comment only");
  const send = page.getByRole("button", { name: "Send" });
  await send.click();
  await commentSeen;
  await send.click();
  releaseComment();

  await expect(page.getByRole("button", { name: "Reply 1" })).toBeVisible();
  expect(commentCalls).toBe(1);
});

test("rapid repeated delete clicks issue only one delete request", async ({ page }) => {
  const post = {
    id: "00000000-0000-4000-8000-000000000291",
    authorId: user.id,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: null,
    body: "Delete request race",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  let deleteCalls = 0;
  let releaseDelete!: () => void;
  let markDeletePending!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const deleteSeen = new Promise<void>((resolve) => {
    markDeletePending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [post] });
    if (pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (pathname === "/v1/moderation/reports") return reply(route, 403, { title: "Forbidden" });
    if (pathname === `/v1/posts/${post.id}` && method === "DELETE") {
      deleteCalls += 1;
      markDeletePending();
      await deleteGate;
      return reply(route, 200, {});
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  const deleteButton = page.getByRole("button", { name: "Delete" });
  await deleteButton.click();
  await deleteSeen;
  await deleteButton.click();
  releaseDelete();

  await expect(page.getByText("Delete request race")).toHaveCount(0);
  expect(deleteCalls).toBe(1);
});

test("repeated comment expansion clicks issue only one comments request", async ({ page }) => {
  const post = {
    id: "00000000-0000-4000-8000-000000000301",
    authorId: "00000000-0000-4000-8000-000000000302",
    handle: "comments-creator",
    displayName: "Comments Creator",
    avatarUrl: null,
    body: "Comments loading race",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "1",
    likedByViewer: false
  };
  let commentsCalls = 0;
  let releaseComments!: () => void;
  let markCommentsPending!: () => void;
  const commentsGate = new Promise<void>((resolve) => {
    releaseComments = resolve;
  });
  const commentsSeen = new Promise<void>((resolve) => {
    markCommentsPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [post] });
    if (pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (pathname === "/v1/moderation/reports") return reply(route, 403, { title: "Forbidden" });
    if (pathname === `/v1/posts/${post.id}/comments`) {
      commentsCalls += 1;
      markCommentsPending();
      await commentsGate;
      return reply(route, 200, { comments: [] });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  const replyButton = page.getByRole("button", { name: "Reply 1" });
  await replyButton.click();
  await commentsSeen;
  await replyButton.click();
  releaseComments();

  const commentsRegion = page.getByRole("region", {
    name: "Comments on Comments Creator's post"
  });
  await expect(commentsRegion).toBeVisible();
  expect(commentsCalls).toBe(1);
});

test("rapid repeated follow clicks issue only one follow request", async ({ page }) => {
  const person = {
    id: "00000000-0000-4000-8000-000000000311",
    handle: "follow-race",
    displayName: "Follow Race",
    bio: "A test creator",
    avatarUrl: null,
    privacy: "public",
    isFollowing: false,
    isRequested: false
  };
  let followCalls = 0;
  let releaseFollow!: () => void;
  let markFollowPending!: () => void;
  const followGate = new Promise<void>((resolve) => {
    releaseFollow = resolve;
  });
  const followSeen = new Promise<void>((resolve) => {
    markFollowPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [] });
    if (pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (pathname === "/v1/moderation/reports") return reply(route, 403, { title: "Forbidden" });
    if (pathname === "/v1/users/search") return reply(route, 200, { users: [person] });
    if (pathname === `/v1/users/${person.handle}/follow` && route.request().method() === "POST") {
      followCalls += 1;
      markFollowPending();
      await followGate;
      return reply(route, 200, { user: { ...person, isFollowing: true } });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Discover" }).click();
  await page.getByRole("textbox", { name: "Search people by name or username" }).fill("follow");
  await page.getByRole("button", { name: "Search" }).click();
  const follow = page.getByRole("button", { name: "Follow" });
  await expect(follow).toBeVisible();
  await follow.click();
  await followSeen;
  await follow.click();
  releaseFollow();

  await expect(page.getByRole("button", { name: "Following" })).toBeVisible();
  expect(followCalls).toBe(1);
});

test("rapid repeated mute clicks issue only one mute request", async ({ page }) => {
  const person = {
    id: "00000000-0000-4000-8000-000000000321",
    handle: "mute-race",
    displayName: "Mute Race",
    bio: "A test creator",
    avatarUrl: null,
    privacy: "public",
    isFollowing: false,
    isRequested: false
  };
  let muteCalls = 0;
  let releaseMute!: () => void;
  let markMutePending!: () => void;
  const muteGate = new Promise<void>((resolve) => {
    releaseMute = resolve;
  });
  const muteSeen = new Promise<void>((resolve) => {
    markMutePending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [] });
    if (pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (pathname === "/v1/moderation/reports") return reply(route, 403, { title: "Forbidden" });
    if (pathname === "/v1/users/search") return reply(route, 200, { users: [person] });
    if (pathname === `/v1/users/${person.handle}/mute`) {
      muteCalls += 1;
      markMutePending();
      await muteGate;
      return reply(route, 200, {});
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Discover" }).click();
  await page.getByRole("textbox", { name: "Search people by name or username" }).fill("mute");
  await page.getByRole("button", { name: "Search" }).click();
  const mute = page.getByRole("button", { name: "Mute" });
  await expect(mute).toBeVisible();
  await mute.click();
  await muteSeen;
  await mute.click();
  releaseMute();

  await expect(page.getByText("Mute Race")).toHaveCount(0);
  expect(muteCalls).toBe(1);
});

test("rapid profile save submissions issue only one update request", async ({ page }) => {
  let saveCalls = 0;
  let releaseSave!: () => void;
  let markSavePending!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saveSeen = new Promise<void>((resolve) => {
    markSavePending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [] });
    if (pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (pathname === "/v1/moderation/reports") return reply(route, 403, { title: "Forbidden" });
    if (pathname === "/v1/me/follow-requests") return reply(route, 200, { requests: [] });
    if (pathname === "/v1/me/blocked" || pathname === "/v1/me/muted") {
      return reply(route, 200, { users: [] });
    }
    if (pathname === "/v1/me/reports") return reply(route, 200, { reports: [] });
    if (pathname === "/v1/me/appeals") return reply(route, 200, { appeals: [] });
    if (pathname === "/v1/me/profile" && method === "PATCH") {
      saveCalls += 1;
      markSavePending();
      await saveGate;
      return reply(route, 200, { user: { ...user, displayName: "Updated Creator" } });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const save = page.getByRole("button", { name: "Save profile" });
  await save.click();
  await saveSeen;
  await save.click();
  releaseSave();

  await expect(page.getByText("Profile saved.")).toBeVisible();
  expect(saveCalls).toBe(1);
});

test("rapid follow-request decisions send only one mutation", async ({ page }) => {
  const followRequest = {
    id: "00000000-0000-4000-8000-000000000331",
    handle: "pending-creator",
    displayName: "Pending Creator",
    avatarUrl: null
  };
  let acceptCalls = 0;
  let releaseAccept!: () => void;
  let markAcceptPending!: () => void;
  const acceptGate = new Promise<void>((resolve) => {
    releaseAccept = resolve;
  });
  const acceptSeen = new Promise<void>((resolve) => {
    markAcceptPending = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/me") return authenticated(route);
    if (pathname === "/v1/feed") return reply(route, 200, { posts: [] });
    if (pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (pathname === "/v1/moderation/reports") return reply(route, 403, { title: "Forbidden" });
    if (pathname === "/v1/me/follow-requests") {
      return reply(route, 200, { requests: [followRequest] });
    }
    if (pathname === `/v1/me/follow-requests/${followRequest.handle}/accept`) {
      acceptCalls += 1;
      markAcceptPending();
      await acceptGate;
      return reply(route, 200, {});
    }
    if (pathname === "/v1/me/blocked" || pathname === "/v1/me/muted") {
      return reply(route, 200, { users: [] });
    }
    if (pathname === "/v1/me/reports") return reply(route, 200, { reports: [] });
    if (pathname === "/v1/me/appeals") return reply(route, 200, { appeals: [] });
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const accept = page.getByRole("button", { name: "Accept" });
  await expect(accept).toBeVisible();
  await accept.click();
  await acceptSeen;
  await accept.click();
  releaseAccept();

  await expect(page.getByText("No pending follow requests.")).toBeVisible();
  expect(acceptCalls).toBe(1);
});

test("feed Load more requests the next cursor once and stops at the final page", async ({
  page
}) => {
  let feedCalls = 0;
  let releaseSecondPage!: () => void;
  let markSecondPagePending!: () => void;
  const secondPagePending = new Promise<void>((resolve) => {
    markSecondPagePending = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseSecondPage = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/me") return reply(route, 200, { user });
    if (url.pathname === "/v1/feed") {
      feedCalls += 1;
      if (feedCalls === 1) {
        return reply(route, 200, { posts: [], nextCursor: "cursor-page-two" });
      }
      expect(url.searchParams.get("cursor")).toBe("cursor-page-two");
      markSecondPagePending();
      await release;
      return reply(route, 200, { posts: [] });
    }
    if (url.pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (url.pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();
  await loadMore.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await secondPagePending;
  expect(feedCalls).toBe(2);
  await expect(page.getByRole("button", { name: "Loading..." })).toBeDisabled();

  releaseSecondPage();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(feedCalls).toBe(2);
});

test("refresh invalidates an in-flight page and advances from the refreshed cursor", async ({
  page
}) => {
  const initialPost = {
    id: "00000000-0000-4000-8000-000000000301",
    authorId: "00000000-0000-4000-8000-000000000311",
    handle: "creator",
    displayName: "Creator",
    avatarUrl: null,
    body: "Initial feed item",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  const refreshedPost = {
    ...initialPost,
    id: "00000000-0000-4000-8000-000000000302",
    body: "Refreshed feed item"
  };
  const stalePost = {
    ...initialPost,
    id: "00000000-0000-4000-8000-000000000303",
    body: "Stale pagination item"
  };
  let feedCalls = 0;
  let notificationCalls = 0;
  let releaseStalePage!: () => void;
  let markStalePagePending!: () => void;
  const stalePagePending = new Promise<void>((resolve) => {
    markStalePagePending = resolve;
  });
  const stalePageGate = new Promise<void>((resolve) => {
    releaseStalePage = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/me") return reply(route, 200, { user });
    if (url.pathname === "/v1/feed") {
      feedCalls += 1;
      if (feedCalls === 1) {
        return reply(route, 200, { posts: [initialPost], nextCursor: "cursor-initial" });
      }
      if (feedCalls === 2) {
        expect(url.searchParams.get("cursor")).toBe("cursor-initial");
        markStalePagePending();
        await stalePageGate;
        return reply(route, 200, { posts: [stalePost] });
      }
      if (feedCalls === 3) {
        return reply(route, 200, { posts: [refreshedPost], nextCursor: "cursor-refreshed" });
      }
      expect(url.searchParams.get("cursor")).toBe("cursor-refreshed");
      return reply(route, 200, { posts: [] });
    }
    if (url.pathname === "/v1/notifications") {
      notificationCalls += 1;
      return notificationCalls === 1
        ? unavailable(route)
        : reply(route, 200, { notifications: [] });
    }
    if (url.pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByText("Initial feed item")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await stalePagePending;
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("Refreshed feed item")).toBeVisible();
  await expect(page.getByText("Initial feed item")).toHaveCount(0);
  releaseStalePage();
  await expect(page.getByText("Stale pagination item")).toHaveCount(0);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(feedCalls).toBe(4);
});

test("a pending feed page from account A cannot append after switching to account B", async ({
  page
}) => {
  const accountA = { ...user, id: "00000000-0000-4000-8000-000000000321", handle: "feed-a" };
  const accountB = { ...user, id: "00000000-0000-4000-8000-000000000322", handle: "feed-b" };
  const accountAPost = {
    id: "00000000-0000-4000-8000-000000000323",
    authorId: accountA.id,
    handle: accountA.handle,
    displayName: "Account A post",
    avatarUrl: null,
    body: "Account A feed item",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  const accountBPost = {
    ...accountAPost,
    id: "00000000-0000-4000-8000-000000000324",
    authorId: accountB.id,
    handle: accountB.handle,
    displayName: "Account B post",
    body: "Account B feed item"
  };
  const stalePost = {
    ...accountAPost,
    id: "00000000-0000-4000-8000-000000000325",
    body: "Account A stale page"
  };
  let meCalls = 0;
  let feedCalls = 0;
  let notificationCalls = 0;
  let releaseStalePage!: () => void;
  let markStalePagePending!: () => void;
  const stalePagePending = new Promise<void>((resolve) => {
    markStalePagePending = resolve;
  });
  const stalePageGate = new Promise<void>((resolve) => {
    releaseStalePage = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/me") {
      meCalls += 1;
      return reply(route, 200, { user: meCalls === 1 ? accountA : accountB });
    }
    if (url.pathname === "/v1/feed") {
      feedCalls += 1;
      if (feedCalls === 1) {
        return reply(route, 200, { posts: [accountAPost], nextCursor: "account-a-cursor" });
      }
      if (feedCalls === 2) {
        markStalePagePending();
        await stalePageGate;
        return reply(route, 200, { posts: [stalePost] });
      }
      return reply(route, 200, { posts: [accountBPost] });
    }
    if (url.pathname === "/v1/notifications") {
      notificationCalls += 1;
      return notificationCalls === 1
        ? unavailable(route)
        : reply(route, 200, { notifications: [] });
    }
    if (url.pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByText("Account A feed item")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await stalePagePending;
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("Account B feed item")).toBeVisible();
  await expect(page.getByText("Account A feed item")).toHaveCount(0);
  releaseStalePage();
  await expect(page.getByText("Account A stale page")).toHaveCount(0);
  await expect(page.getByText("Account B feed item")).toBeVisible();
  expect(meCalls).toBe(2);
});

test("logout invalidates an in-flight feed page before it can update the signed-out view", async ({
  page
}) => {
  const firstPagePost = {
    id: "00000000-0000-4000-8000-000000000331",
    authorId: "00000000-0000-4000-8000-000000000332",
    handle: "creator",
    displayName: "Creator",
    avatarUrl: null,
    body: "Signed-in feed item",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  const stalePost = {
    ...firstPagePost,
    id: "00000000-0000-4000-8000-000000000333",
    body: "Post after logout"
  };
  let feedCalls = 0;
  let releasePage!: () => void;
  let markPagePending!: () => void;
  const pagePending = new Promise<void>((resolve) => {
    markPagePending = resolve;
  });
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/me") return reply(route, 200, { user });
    if (url.pathname === "/v1/feed") {
      feedCalls += 1;
      if (feedCalls === 1) {
        return reply(route, 200, { posts: [firstPagePost], nextCursor: "logout-cursor" });
      }
      markPagePending();
      await pageGate;
      return reply(route, 200, { posts: [stalePost] });
    }
    if (url.pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (url.pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    if (url.pathname === "/v1/auth/logout") return reply(route, 200, { ok: true });
    return reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByText("Signed-in feed item")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await pagePending;
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator(".auth-card-modern")).toBeVisible();
  releasePage();
  await expect(page.getByText("Post after logout")).toHaveCount(0);
  await expect(page.locator(".auth-card-modern")).toBeVisible();
});

test("the advanced feed cursor survives leaving Home and returning", async ({ page }) => {
  const makePost = (id: string, body: string) => ({
    id,
    authorId: "00000000-0000-4000-8000-000000000401",
    handle: "creator",
    displayName: "Creator",
    avatarUrl: null,
    body,
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  });
  const first = makePost("00000000-0000-4000-8000-000000000402", "First feed page");
  const second = makePost("00000000-0000-4000-8000-000000000403", "Second feed page");
  const third = makePost("00000000-0000-4000-8000-000000000404", "Third feed page");
  let feedCalls = 0;

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/me") return reply(route, 200, { user });
    if (url.pathname === "/v1/feed") {
      feedCalls += 1;
      if (feedCalls === 1) {
        return reply(route, 200, { posts: [first], nextCursor: "cursor-page-two" });
      }
      if (feedCalls === 2) {
        expect(url.searchParams.get("cursor")).toBe("cursor-page-two");
        return reply(route, 200, { posts: [second], nextCursor: "cursor-page-three" });
      }
      expect(url.searchParams.get("cursor")).toBe("cursor-page-three");
      return reply(route, 200, { posts: [third] });
    }
    if (url.pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (url.pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Second feed page")).toBeVisible();

  await page.getByRole("button", { name: "Discover" }).click();
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByText("First feed page")).toBeVisible();
  await expect(page.getByText("Second feed page")).toBeVisible();

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Third feed page")).toBeVisible();
  expect(feedCalls).toBe(3);
});

test("a failed feed page keeps its cursor so Load more can retry", async ({ page }) => {
  const first = {
    id: "00000000-0000-4000-8000-000000000411",
    authorId: "00000000-0000-4000-8000-000000000412",
    handle: "creator",
    displayName: "Creator",
    avatarUrl: null,
    body: "Retry first page",
    createdAt: "2026-11-01T00:00:00.000Z",
    likeCount: "0",
    commentCount: "0",
    likedByViewer: false
  };
  const second = {
    ...first,
    id: "00000000-0000-4000-8000-000000000413",
    body: "Retry second page"
  };
  let feedCalls = 0;

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/me") return reply(route, 200, { user });
    if (url.pathname === "/v1/feed") {
      feedCalls += 1;
      if (feedCalls === 1) {
        return reply(route, 200, { posts: [first], nextCursor: "cursor-retry" });
      }
      expect(url.searchParams.get("cursor")).toBe("cursor-retry");
      if (feedCalls === 2) return unavailable(route);
      return reply(route, 200, { posts: [second] });
    }
    if (url.pathname === "/v1/notifications") return reply(route, 200, { notifications: [] });
    if (url.pathname === "/v1/moderation/reports") {
      return reply(route, 403, { title: "Forbidden" });
    }
    return reply(route, 200, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".banner.error")).toContainText("Service unavailable");
  await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled();

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Retry second page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(feedCalls).toBe(3);
});
