import { ApiError, request } from "./api-client";

type Requester = (path: string) => Promise<unknown>;

type SessionUser = { user: unknown };
type Feed = { posts: unknown[] };
type Activity = { notifications: unknown[] };

export type SessionBootstrapResult<TUser, TPost, TNotification> =
  | { status: "unauthenticated"; error: string | null }
  | {
      status: "authenticated";
      user: TUser;
      posts: TPost[] | undefined;
      notifications: TNotification[] | undefined;
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
