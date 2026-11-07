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
