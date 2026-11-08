import { ApiError, request } from "./api-client";

type Requester = (path: string) => Promise<unknown>;

type SessionUser = { user: unknown };
type Feed = { posts: unknown[]; nextCursor?: string };
type Activity = { notifications: unknown[]; nextCursor?: string };

export type SessionBootstrapResult<TUser, TPost, TNotification> =
  | { status: "unauthenticated"; error: string | null }
  | {
      status: "authenticated";
      user: TUser;
      posts: TPost[] | undefined;
      nextCursor?: string;
      notifications: TNotification[] | undefined;
      notificationCursor?: string;
      activityError: boolean;
    };

export async function loadSession<TUser, TPost, TNotification>(
  requester: Requester = request
): Promise<SessionBootstrapResult<TUser, TPost, TNotification>> {
  let session: SessionUser;
  try {
    session = (await requester("/me")) as SessionUser;
  } catch (reason) {
    const isUnauthenticated = reason instanceof ApiError && [401, 403].includes(reason.status);
    return {
      status: "unauthenticated",
      error: isUnauthenticated ? null : (reason as Error).message
    };
  }

  const [feedResult, activityResult] = await Promise.allSettled([
    requester("/feed") as Promise<Feed>,
    requester("/notifications") as Promise<Activity>
  ]);

  return {
    status: "authenticated",
    user: session.user as TUser,
    posts: feedResult.status === "fulfilled" ? (feedResult.value.posts as TPost[]) : undefined,
    notifications:
      activityResult.status === "fulfilled"
        ? (activityResult.value.notifications as TNotification[])
        : undefined,
    ...(feedResult.status === "fulfilled" && feedResult.value.nextCursor
      ? { nextCursor: feedResult.value.nextCursor }
      : {}),
    ...(activityResult.status === "fulfilled" && activityResult.value.nextCursor
      ? { notificationCursor: activityResult.value.nextCursor }
      : {}),
    activityError: feedResult.status === "rejected" || activityResult.status === "rejected"
  };
}

/**
 * Tracks the newest session refresh so stale responses cannot overwrite a
 * newer refresh or a completed logout.
 */
export function createSessionRequestSequence() {
  let currentRequestId = 0;

  return {
    begin(): number {
      currentRequestId += 1;
      return currentRequestId;
    },
    isCurrent(requestId: number): boolean {
      return requestId === currentRequestId;
    },
    invalidate(): number {
      currentRequestId += 1;
      return currentRequestId;
    }
  };
}

/**
 * Prevents asynchronous component work from committing state after its
 * account-scoped component has unmounted (for example, during account switch).
 */
export function createMountedRequestScope() {
  let active = true;

  return {
    isActive(): boolean {
      return active;
    },
    invalidate(): void {
      active = false;
    }
  };
}

/** Runs an async completion only while its originating component scope is active. */
export async function runIfRequestScopeActive(
  scope: Pick<ReturnType<typeof createMountedRequestScope>, "isActive">,
  action: () => Promise<void>
): Promise<void> {
  if (scope.isActive()) await action();
}

/** Merge a page into the current feed without duplicating posts across boundaries. */
export function mergeFeedPosts<TPost extends { id: string }>(
  current: TPost[],
  incoming: TPost[]
): TPost[] {
  const seen = new Set(current.map((post) => post.id));
  return [...current, ...incoming.filter((post) => !seen.has(post.id) && seen.add(post.id))];
}

export const mergeNotifications = mergeFeedPosts;
