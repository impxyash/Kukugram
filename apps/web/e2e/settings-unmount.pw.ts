import { expect, test, type Route } from "@playwright/test";

const accountA = {
  id: "00000000-0000-4000-8000-000000000061",
  handle: "settings-a",
  displayName: "Settings Account A",
  bio: null,
  avatarUrl: null,
  followers: "0",
  following: "0",
  isFollowing: false,
  isRequested: false,
  privacy: "public" as const,
  canViewContent: true,
  isBlocked: false,
};

const accountB = {
  ...accountA,
  id: "00000000-0000-4000-8000-000000000062",
  handle: "settings-b",
  displayName: "Settings Account B",
};

async function reply(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

test("pending Settings history requests cannot update state or errors after account unmount", async ({
  page,
}) => {
  const pendingPaths = new Set([
    "/v1/me/follow-requests",
    "/v1/me/blocked",
    "/v1/me/muted",
    "/v1/me/reports",
    "/v1/me/appeals",
  ]);
  const pendingRoutes = new Map<string, Route>();
  let markAllPending!: () => void;
  const allPending = new Promise<void>((resolve) => {
    markAllPending = resolve;
  });
  let meCalls = 0;
  let feedCalls = 0;
  let switchingToB = false;

  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (pathname === "/v1/me") {
      meCalls += 1;
      await reply(route, 200, { user: switchingToB ? accountB : accountA });
      return;
    }
    if (pathname === "/v1/feed") {
      feedCalls += 1;
      await reply(
        route,
        feedCalls === 1 ? 503 : 200,
        feedCalls === 1 ? { title: "Service unavailable" } : { posts: [] },
      );
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

    if (method === "GET" && pendingPaths.has(pathname)) {
      if (!switchingToB) {
        pendingRoutes.set(pathname, route);
        if (pendingRoutes.size === pendingPaths.size) markAllPending();
        return;
      }

      const emptyResponses: Record<string, unknown> = {
        "/v1/me/follow-requests": { requests: [] },
        "/v1/me/blocked": { users: [] },
        "/v1/me/muted": { users: [] },
        "/v1/me/reports": { reports: [] },
        "/v1/me/appeals": { appeals: [] },
      };
      await reply(route, 200, emptyResponses[pathname]);
      return;
    }

    await reply(route, 200, {});
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await allPending;

  expect(pendingRoutes.size).toBe(5);
  switchingToB = true;
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByLabel("Display name")).toHaveValue(
    "Settings Account B",
  );
  await expect(page.getByText("No pending follow requests.")).toBeVisible();
  await expect(page.getByText("No blocked accounts.")).toBeVisible();
  await expect(page.getByText("No muted accounts.")).toBeVisible();
  await expect(
    page.getByText("You have not submitted any reports."),
  ).toBeVisible();
  await expect(
    page.getByText("You have not submitted any appeals."),
  ).toBeVisible();
  await expect.poll(() => meCalls).toBe(2);

  // Resolve the previous identity's requests only after B's Settings view is mounted.
  for (const [path, route] of pendingRoutes) {
    if (path === "/v1/me/follow-requests") {
      await reply(route, 503, { title: "Stale account A request failed" });
    } else if (path === "/v1/me/blocked" || path === "/v1/me/muted") {
      await reply(route, 200, {
        users: [
          {
            id: "private-account-a",
            handle: "private-a",
            displayName: "Account A private control",
            avatarUrl: null,
          },
        ],
      });
    } else if (path === "/v1/me/reports") {
      await reply(route, 200, {
        reports: [
          {
            id: "00000000-0000-4000-8000-000000000063",
            category: "spam",
            targetType: "post",
            createdAt: "2026-11-01T00:00:00.000Z",
            status: "resolved",
          },
        ],
      });
    } else {
      await reply(route, 200, {
        appeals: [
          {
            id: "00000000-0000-4000-8000-000000000064",
            reportId: "00000000-0000-4000-8000-000000000063",
            createdAt: "2026-11-01T00:00:00.000Z",
            status: "pending",
          },
        ],
      });
    }
  }

  await expect(page.getByLabel("Display name")).toHaveValue(
    "Settings Account B",
  );
  await expect(page.getByText("Account A private control")).toHaveCount(0);
  await expect(page.getByText("spam", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Case 00000000")).toHaveCount(0);
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

