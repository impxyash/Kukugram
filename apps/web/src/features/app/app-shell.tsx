"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { request } from "./api-client";
import {
  createMountedRequestScope,
  createSessionRequestSequence,
  loadSession
} from "./session-bootstrap";
import type {
  AccountControlResponse,
  AppealSummaryResponse,
  CommentResponse,
  FollowRequestResponse,
  ModerationAppealQueueItemResponse,
  ModerationReportSummaryResponse,
  NotificationResponse,
  PostResponse,
  ProfileResponse,
  ReportSummaryResponse
} from "@kukugram/api-contract";

type User = ProfileResponse;
type Post = PostResponse;
type Notice = NotificationResponse;
type Comment = CommentResponse;
type FollowRequest = FollowRequestResponse;
type AccountControl = AccountControlResponse;
type ReportRecord = ReportSummaryResponse;
type ModerationReport = ModerationReportSummaryResponse;
type AppealRecord = AppealSummaryResponse;
type ModerationAppeal = ModerationAppealQueueItemResponse;

export function reconcileSessionActivity<TPost, TNotice>(
  previousUserId: string | null,
  nextUserId: string,
  previousPosts: TPost[],
  previousNotices: TNotice[],
  nextPosts: TPost[] | undefined,
  nextNotices: TNotice[] | undefined
) {
  const sameUser = previousUserId === nextUserId;
  return {
    posts: nextPosts ?? (sameUser ? previousPosts : []),
    notices: nextNotices ?? (sameUser ? previousNotices : [])
  };
}

async function reportContent(
  targetType: "profile" | "post" | "comment",
  targetId: string,
  onError: (message: string) => void
) {
  const category = window.prompt(
    "Report reason: harassment, spam, impersonation, self_harm, violence, nudity, copyright, other",
    "spam"
  );
  if (!category) return;
  const details = window.prompt("Additional context (optional, up to 1000 characters):") ?? "";
  try {
    await request("/reports", {
      method: "POST",
      body: JSON.stringify({ targetType, targetId, category, details: details.trim() || undefined })
    });
    window.alert("Thanks. Your report has been sent privately to the safety team.");
  } catch (reason) {
    onError((reason as Error).message);
  }
}

function Avatar({
  user,
  small = false
}: {
  user: Pick<User | Post, "displayName" | "avatarUrl">;
  small?: boolean;
}) {
  return user.avatarUrl ? (
    <img className={`avatar ${small ? "small" : ""}`} src={user.avatarUrl} alt="" />
  ) : (
    <span className={`avatar fallback ${small ? "small" : ""}`}>
      {user.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AppShell() {
  const [user, setUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const activeUserId = useRef<string | null>(null);
  const sessionRequestSequence = useRef(createSessionRequestSequence());
  const [tab, setTab] = useState<
    "home" | "discover" | "activity" | "profile" | "settings" | "moderation"
  >("home");
  const [moderatorUserId, setModeratorUserId] = useState<string | null>(null);
  const canModerate = moderatorUserId === user?.id;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");

  async function refresh() {
    const requestId = sessionRequestSequence.current.begin();
    // Keep an authenticated shell mounted during background refreshes so a
    // user can still log out and newer refreshes can supersede older ones.
    if (!user) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await loadSession<User, Post, Notice>();
      if (!sessionRequestSequence.current.isCurrent(requestId)) return;

      if (result.status === "unauthenticated") {
        activeUserId.current = null;
        setModeratorUserId(null);
        setUser(null);
        setPosts([]);
        setNotices([]);
        setError(result.error);
        return;
      }

      const activity = reconcileSessionActivity(
        activeUserId.current,
        result.user.id,
        posts,
        notices,
        result.posts,
        result.notifications
      );
      if (activeUserId.current !== result.user.id) {
        setModeratorUserId(null);
      }
      activeUserId.current = result.user.id;
      setUser(result.user);
      setPosts(activity.posts);
      setNotices(activity.notices);
      if (result.activityError) {
        setError("Some of your latest activity could not be loaded. Please refresh and try again.");
      } else {
        setError(null);
      }
    } finally {
      if (sessionRequestSequence.current.isCurrent(requestId)) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!user) {
      setModeratorUserId(null);
      return;
    }

    let cancelled = false;
    // Fail closed while permissions are being revalidated, including refreshes
    // where the authenticated user ID has not changed.
    setModeratorUserId(null);
    void request<{ reports: ModerationReport[] }>("/moderation/reports?limit=1")
      .then(() => {
        if (!cancelled) setModeratorUserId(user.id);
      })
      .catch(() => {
        if (!cancelled) setModeratorUserId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  if (loading)
    return (
      <main className="app-loading">
        <span className="pulse-dot" aria-hidden="true" />
        <p role="status" aria-live="polite">
          Loading your corner...
        </p>
      </main>
    );
  if (!user)
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        onAuthenticated={refresh}
        sessionError={error}
      />
    );

  const unread = notices.filter((notice) => !notice.readAt).length;

  return (
    <main className="app-shell">
      <aside className="side-nav">
        <a className="brand" href="/">
          <span className="brand-mark">k</span> kukugram
        </a>
        <p className="nav-kicker">your social orbit</p>
        <nav aria-label="Primary navigation" className="primary-nav">
          {(
            [
              ["home", "Home"],
              ["discover", "Discover"],
              ["activity", `Activity${unread ? ` (${unread})` : ""}`],
              ["profile", "Profile"],
              ["settings", "Settings"],
              ...(canModerate ? ([["moderation", "Moderation"]] as const) : [])
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "nav-item active" : "nav-item"}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <button
          className="nav-item logout"
          onClick={() => {
            void (async () => {
              try {
                await request("/auth/logout", { method: "POST" });
                sessionRequestSequence.current.invalidate();
                activeUserId.current = null;
                setModeratorUserId(null);
                setUser(null);
                setPosts([]);
                setNotices([]);
                setError(null);
                setLoading(false);
              } catch (reason) {
                setError((reason as Error).message);
              }
            })();
          }}
        >
          Log out
        </button>
      </aside>
      <section className="main-pane">
        {error && (
          <div className="banner error" role="alert" aria-live="assertive">
            <p>{error}</p>
            <button
              className="secondary-button"
              type="button"
              disabled={loading}
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        )}
        {tab === "home" && (
          <Home user={user} posts={posts} setPosts={setPosts} onError={setError} />
        )}
        {tab === "discover" && <Discover onError={setError} />}
        {tab === "activity" && (
          <Activity notices={notices} setNotices={setNotices} onError={setError} />
        )}
        {tab === "profile" && (
          <Profile
            user={user}
            setUser={setUser}
            posts={posts.filter((post) => post.authorId === user.id)}
            onError={setError}
          />
        )}
        {tab === "settings" && (
          <Settings key={user.id} user={user} setUser={setUser} onError={setError} />
        )}
        {tab === "moderation" && canModerate && (
          <ModerationPanel key={user.id} onError={setError} />
        )}
      </section>
    </main>
  );
}

function AuthScreen({
  mode,
  setMode,
  onAuthenticated,
  sessionError
}: {
  mode: "login" | "signup";
  setMode: (mode: "login" | "signup") => void;
  onAuthenticated: () => Promise<void>;
  sessionError: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(form);
    try {
      await request(`/auth/${mode}`, { method: "POST", body: JSON.stringify(values) });
      await onAuthenticated();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-layout">
        <section className="auth-visual" aria-label="Welcome to Kukugram">
          <a className="brand auth-brand" href="/">
            <span className="brand-mark">k</span> kukugram
          </a>
          <div className="auth-visual-copy">
            <p className="eyebrow">A little more you. A little less noise.</p>
            <h1>
              Share the
              <br />
              <em>good stuff.</em>
            </h1>
            <p>Find your people, share your moments, and make your own corner of the internet.</p>
          </div>
          <div className="auth-orbit" aria-hidden="true">
            <span className="orbit-bubble bubble-one">✳</span>
            <span className="orbit-bubble bubble-two">k</span>
            <span className="orbit-bubble bubble-three">♡</span>
            <span className="orbit-ring ring-one" />
            <span className="orbit-ring ring-two" />
          </div>
          <p className="auth-visual-foot">YOUR PEOPLE. YOUR PACE. YOUR SPACE.</p>
        </section>

        <section className="auth-panel">
          <div className="auth-card auth-card-modern">
            <div className="auth-mobile-brand">
              <a className="brand" href="/">
                <span className="brand-mark">k</span> kukugram
              </a>
            </div>
            <div className="auth-card-heading">
              <p className="eyebrow">
                {mode === "signup" ? "JOIN THE COMMUNITY" : "GOOD TO SEE YOU AGAIN"}
              </p>
              <h2>{mode === "signup" ? "Create an account" : "Welcome back"}</h2>
              <p>
                {mode === "signup"
                  ? "Sign up to see photos, posts and moments from your people."
                  : "Log in to catch up with your people."}
              </p>
            </div>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {sessionError && (
              <>
                <p className="form-error" role="alert">
                  {sessionError}
                </p>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void onAuthenticated()}
                >
                  Retry session
                </button>
              </>
            )}
            <form
              className="auth-form"
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              {mode === "signup" && (
                <>
                  <label>
                    Full name
                    <input
                      required
                      name="displayName"
                      maxLength={60}
                      autoComplete="name"
                      placeholder="Your name"
                    />
                  </label>
                  <label>
                    Username
                    <input
                      required
                      name="handle"
                      pattern="[a-z0-9_]{3,30}"
                      title="Use 3-30 lowercase letters, numbers, or underscores."
                      autoComplete="username"
                      placeholder="Choose a username"
                    />
                  </label>
                </>
              )}
              <label>
                Email address
                <input
                  required
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@example.com"
                />
              </label>
              <label>
                Password
                <input
                  required
                  name="password"
                  type="password"
                  minLength={mode === "signup" ? 12 : 1}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  placeholder={mode === "signup" ? "At least 12 characters" : "Your password"}
                />
              </label>
              {mode === "signup" && (
                <p className="auth-terms">
                  By signing up, you agree to our Terms and Privacy Policy.
                </p>
              )}
              <button className="primary-button auth-submit" disabled={busy}>
                {busy ? "Please wait..." : mode === "signup" ? "Create account" : "Log in"}
              </button>
            </form>

            <div className="auth-switch">
              {mode === "signup" ? "Already have an account?" : "Don't have an account?"}
              <button
                className="auth-switch-button"
                onClick={() => {
                  setError(null);
                  setMode(mode === "signup" ? "login" : "signup");
                }}
              >
                {mode === "signup" ? "Log in" : "Sign up"}
              </button>
            </div>
          </div>
          <p className="auth-footer">
            © {new Date().getFullYear()} Kukugram · Made for your people
          </p>
        </section>
      </div>
    </main>
  );
}

function Home({
  user,
  posts,
  setPosts,
  onError
}: {
  user: User;
  posts: Post[];
  setPosts: (posts: Post[]) => void;
  onError: (message: string | null) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const { post } = await request<{ post: Post }>("/posts", {
        method: "POST",
        body: JSON.stringify({ body })
      });
      setPosts([post, ...posts]);
      setBody("");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="pane-header">
        <p className="eyebrow">Following</p>
        <h2>Your people, in motion.</h2>
      </header>
      <form
        className="composer"
        onSubmit={(event) => {
          void publish(event);
        }}
      >
        <Avatar user={user} />
        <textarea
          aria-label="Write a post"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="What is moving through your mind?"
          maxLength={2000}
        />
        <div>
          <span>{body.length}/2000</span>
          <button className="primary-button" disabled={busy || !body.trim()}>
            {busy ? "Posting..." : "Publish"}
          </button>
        </div>
      </form>
      {posts.length ? (
        <div className="feed">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              user={user}
              onChange={(updated) =>
                setPosts(posts.map((item) => (item.id === updated.id ? updated : item)))
              }
              onDelete={() => setPosts(posts.filter((item) => item.id !== post.id))}
              onError={onError}
            />
          ))}
        </div>
      ) : (
        <section className="empty-state">
          <span className="orbit">*</span>
          <h3>Your feed is waiting.</h3>
          <p>Follow people in Discover, or make the first post in your corner.</p>
        </section>
      )}
    </>
  );
}

function PostCard({
  post,
  user,
  onChange,
  onDelete,
  onError
}: {
  post: Post;
  user: User;
  onChange: (post: Post) => void;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [comment, setComment] = useState("");

  async function toggleLike() {
    try {
      await request(`/posts/${post.id}/like`, { method: post.likedByViewer ? "DELETE" : "POST" });
      onChange({
        ...post,
        likedByViewer: !post.likedByViewer,
        likeCount: String(Number(post.likeCount) + (post.likedByViewer ? -1 : 1))
      });
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  async function showComments() {
    if (comments) {
      setComments(null);
      return;
    }
    try {
      setComments((await request<{ comments: Comment[] }>(`/posts/${post.id}/comments`)).comments);
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  async function addComment(event: FormEvent) {
    event.preventDefault();
    if (!comment.trim()) return;
    try {
      await request(`/posts/${post.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: comment })
      });
      setComment("");
      setComments(null);
      onChange({ ...post, commentCount: String(Number(post.commentCount) + 1) });
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  async function deletePost() {
    try {
      await request(`/posts/${post.id}`, { method: "DELETE" });
      onDelete();
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  return (
    <article className="post-card">
      <header>
        <Avatar user={post} small />
        <div>
          <strong>{post.displayName}</strong>
          <span>
            @{post.handle} · {new Date(post.createdAt).toLocaleDateString()}
          </span>
        </div>
        {post.authorId === user.id && (
          <button
            className="icon-button delete"
            onClick={() => {
              void deletePost();
            }}
          >
            Delete
          </button>
        )}
      </header>
      <p className="post-body">{post.body}</p>
      <div className="post-actions">
        <button
          className={post.likedByViewer ? "liked" : ""}
          onClick={() => {
            void toggleLike();
          }}
        >
          ♥ {post.likeCount}
        </button>
        <button
          onClick={() => {
            void showComments();
          }}
        >
          Reply {post.commentCount}
        </button>
        {post.authorId !== user.id && (
          <button
            onClick={() => {
              void reportContent("post", post.id, onError);
            }}
          >
            Report
          </button>
        )}
      </div>
      {comments && (
        <div className="comments">
          {comments.map((item) => (
            <p key={item.id}>
              <b>{item.displayName}</b> <span>@{item.handle}</span> {item.body}
              {item.handle !== user.handle && (
                <button
                  className="secondary-button"
                  onClick={() => {
                    void reportContent("comment", item.id, onError);
                  }}
                >
                  Report
                </button>
              )}
            </p>
          ))}
          <form
            onSubmit={(event) => {
              void addComment(event);
            }}
          >
            <input
              aria-label="Write a comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={1000}
              placeholder="Add to the conversation"
            />
            <button>Send</button>
          </form>
        </div>
      )}
    </article>
  );
}

function Discover({ onError }: { onError: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      setUsers(
        (await request<{ users: User[] }>(`/users/search?q=${encodeURIComponent(query)}`)).users
      );
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function toggleFollow(person: User) {
    try {
      if (person.isFollowing || person.isRequested) {
        await request(`/users/${person.handle}/follow`, { method: "DELETE" });
        setUsers(
          users.map((item) =>
            item.id === person.id ? { ...item, isFollowing: false, isRequested: false } : item
          )
        );
      } else {
        const result = await request<{ user: User }>(`/users/${person.handle}/follow`, {
          method: "POST"
        });
        setUsers(
          users.map((item) =>
            item.id === person.id
              ? {
                  ...item,
                  isFollowing: result.user.isFollowing,
                  isRequested: result.user.isRequested
                }
              : item
          )
        );
      }
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  async function mutePerson(person: User) {
    try {
      await request(`/users/${person.handle}/mute`, { method: "POST" });
      setUsers(users.filter((item) => item.id !== person.id));
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  async function blockPerson(person: User) {
    if (
      !window.confirm(
        `Block @${person.handle}? You will both be removed from each other's follow lists.`
      )
    )
      return;
    try {
      await request(`/users/${person.handle}/block`, { method: "POST" });
      setUsers(users.filter((item) => item.id !== person.id));
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  return (
    <>
      <header className="pane-header">
        <p className="eyebrow">Discover</p>
        <h2>Find your next familiar face.</h2>
      </header>
      <form
        className="search"
        onSubmit={(event) => {
          void search(event);
        }}
      >
        <input
          aria-label="Search people by name or username"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search username or name"
        />
        <button className="primary-button" disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>
      <div className="results">
        {users.map((person) => (
          <article key={person.id} className="person">
            <Avatar user={person} />
            <div>
              <strong>{person.displayName}</strong>
              <span>@{person.handle}</span>
              <p>{person.bio}</p>
            </div>
            <div className="person-actions">
              <button
                className={person.isFollowing ? "secondary-button" : "primary-button"}
                onClick={() => {
                  void toggleFollow(person);
                }}
              >
                {person.isFollowing ? "Following" : person.isRequested ? "Requested" : "Follow"}
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  void mutePerson(person);
                }}
              >
                Mute
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  void blockPerson(person);
                }}
              >
                Block
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  void reportContent("profile", person.id, onError);
                }}
              >
                Report
              </button>
            </div>
          </article>
        ))}
      </div>
      {query && !loading && !users.length && (
        <section className="empty-state">
          <h3>No one surfaced yet.</h3>
          <p>Try another name or username.</p>
        </section>
      )}
    </>
  );
}

function Activity({
  notices,
  setNotices,
  onError
}: {
  notices: Notice[];
  setNotices: (notices: Notice[]) => void;
  onError: (message: string) => void;
}) {
  useEffect(() => {
    void request("/notifications/read", { method: "POST" })
      .then(() => {
        setNotices(
          notices.map((notice) => ({
            ...notice,
            readAt: notice.readAt ?? new Date().toISOString()
          }))
        );
      })
      .catch((reason) => onError((reason as Error).message));
  }, []);

  return (
    <>
      <header className="pane-header">
        <p className="eyebrow">Activity</p>
        <h2>The ripples from your corner.</h2>
      </header>
      {notices.length ? (
        <div className="results">
          {notices.map((notice) => (
            <article className="notice" key={notice.id}>
              <span className="notice-mark">
                {notice.type === "follow"
                  ? "+"
                  : notice.type === "follow_request"
                    ? "⌁"
                    : notice.type === "like"
                      ? "♥"
                      : "↳"}
              </span>
              <p>
                <b>{notice.displayName ?? "Someone"}</b>{" "}
                {notice.type === "follow"
                  ? "followed you"
                  : notice.type === "follow_request"
                    ? "requested to follow you"
                    : notice.type === "like"
                      ? "liked your post"
                      : "replied to your post"}
                .<span>{new Date(notice.createdAt).toLocaleDateString()}</span>
              </p>
            </article>
          ))}
        </div>
      ) : (
        <section className="empty-state">
          <h3>Quiet, for now.</h3>
          <p>Your follows and conversations will collect here.</p>
        </section>
      )}
    </>
  );
}

function Profile({
  user,
  setUser,
  posts,
  onError
}: {
  user: User;
  setUser: (user: User) => void;
  posts: Post[];
  onError: (message: string) => void;
}) {
  const mountedRequestScope = useRef(createMountedRequestScope());

  useEffect(() => {
    const scope = createMountedRequestScope();
    mountedRequestScope.current = scope;
    return () => scope.invalidate();
  }, []);

  async function editProfile() {
    const name = window.prompt("Display name", user.displayName);
    if (!name) return;
    const scope = mountedRequestScope.current;
    try {
      const result = await request<{ user: User }>("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: name })
      });
      if (scope.isActive()) setUser(result.user);
    } catch (reason) {
      if (scope.isActive()) onError((reason as Error).message);
    }
  }

  return (
    <>
      <header className="profile-hero">
        <Avatar user={user} />
        <div>
          <p className="eyebrow">@{user.handle}</p>
          <h2>{user.displayName}</h2>
          <p>{user.bio || "No bio yet. Let your posts do the talking."}</p>
          <span>
            {user.followers} followers · {user.following} following
          </span>
        </div>
      </header>
      <button
        className="secondary-button"
        onClick={() => {
          void editProfile();
        }}
      >
        Edit profile
      </button>
      <h3 className="section-title">Your posts</h3>
      {posts.length ? (
        <div className="feed">
          {posts.map((post) => (
            <article className="post-card compact" key={post.id}>
              <p className="post-body">{post.body}</p>
              <span>
                {post.likeCount} likes · {post.commentCount} replies
              </span>
            </article>
          ))}
        </div>
      ) : (
        <section className="empty-state">
          <h3>Nothing published yet.</h3>
          <p>Your posts will live here.</p>
        </section>
      )}
    </>
  );
}

function ModerationPanel({ onError }: { onError: (message: string) => void }) {
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [appeals, setAppeals] = useState<ModerationAppeal[]>([]);
  const [filter, setFilter] = useState("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [expandedAppeal, setExpandedAppeal] = useState<string | null>(null);
  const [reportDetails, setReportDetails] = useState<
    Record<string, { targetId: string; details: string | null }>
  >({});
  const [appealDetails, setAppealDetails] = useState<Record<string, string>>({});
  const queueRequestSequence = useRef(createSessionRequestSequence());
  const reportDetailSequence = useRef(createSessionRequestSequence());
  const appealDetailSequence = useRef(createSessionRequestSequence());
  const mountedRequestScope = useRef(createMountedRequestScope());

  useEffect(() => {
    const scope = createMountedRequestScope();
    const sequence = createSessionRequestSequence();
    mountedRequestScope.current = scope;
    queueRequestSequence.current = sequence;

    return () => {
      scope.invalidate();
      sequence.invalidate();
      reportDetailSequence.current.invalidate();
      appealDetailSequence.current.invalidate();
    };
  }, []);

  async function toggleReportDetails(id: string) {
    if (expandedReport === id) {
      reportDetailSequence.current.invalidate();
      setExpandedReport(null);
      return;
    }
    const requestId = reportDetailSequence.current.begin();
    setExpandedReport(id);
    if (reportDetails[id]) return;
    const scope = mountedRequestScope.current;
    try {
      const result = await request<{
        report: { targetId: string; details: string | null };
      }>(`/moderation/reports/${id}`);
      if (scope.isActive() && reportDetailSequence.current.isCurrent(requestId)) {
        setReportDetails((current) => ({ ...current, [id]: result.report }));
      }
    } catch (reason) {
      if (scope.isActive() && reportDetailSequence.current.isCurrent(requestId)) {
        onError((reason as Error).message);
      }
    }
  }

  async function toggleAppealDetails(id: string) {
    if (expandedAppeal === id) {
      appealDetailSequence.current.invalidate();
      setExpandedAppeal(null);
      return;
    }
    const requestId = appealDetailSequence.current.begin();
    setExpandedAppeal(id);
    if (appealDetails[id] !== undefined) return;
    const scope = mountedRequestScope.current;
    try {
      const result = await request<{ appeal: { details: string } }>(`/moderation/appeals/${id}`);
      if (scope.isActive() && appealDetailSequence.current.isCurrent(requestId)) {
        setAppealDetails((current) => ({ ...current, [id]: result.appeal.details }));
      }
    } catch (reason) {
      if (scope.isActive() && appealDetailSequence.current.isCurrent(requestId)) {
        onError((reason as Error).message);
      }
    }
  }

  async function refresh() {
    const scope = mountedRequestScope.current;
    const requestId = queueRequestSequence.current.begin();
    setLoading(true);
    setLoadError(null);
    try {
      const [reportResult, appealResult] = await Promise.all([
        request<{ reports: ModerationReport[] }>(`/moderation/reports?status=${filter}&limit=50`),
        request<{ appeals: typeof appeals }>("/moderation/appeals")
      ]);
      if (!scope.isActive() || !queueRequestSequence.current.isCurrent(requestId)) {
        return;
      }
      setReports(reportResult.reports);
      setAppeals(appealResult.appeals);
    } catch (reason) {
      if (scope.isActive() && queueRequestSequence.current.isCurrent(requestId)) {
        setLoadError((reason as Error).message);
      }
    } finally {
      if (scope.isActive() && queueRequestSequence.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    setActionNotice(null);
    setExpandedReport(null);
    setExpandedAppeal(null);
    setReportDetails({});
    setAppealDetails({});
    reportDetailSequence.current.invalidate();
    appealDetailSequence.current.invalidate();
    void refresh();
  }, [filter]);

  async function updateReport(id: string, status: "reviewing" | "resolved" | "dismissed") {
    const scope = mountedRequestScope.current;
    setBusy(id);
    setActionNotice(null);
    try {
      await request(`/moderation/reports/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      if (!scope.isActive()) return;
      setActionNotice(`Report marked as ${status.replaceAll("_", " ")}.`);
      await refresh();
    } catch (reason) {
      if (scope.isActive()) {
        setActionNotice(null);
        onError((reason as Error).message);
      }
    } finally {
      if (scope.isActive()) setBusy(null);
    }
  }

  async function reviewAppeal(id: string, status: "accepted" | "rejected") {
    const scope = mountedRequestScope.current;
    setBusy(id);
    setActionNotice(null);
    try {
      await request(`/moderation/appeals/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      if (!scope.isActive()) return;
      setActionNotice(`Appeal ${status}.`);
      await refresh();
    } catch (reason) {
      if (scope.isActive()) {
        setActionNotice(null);
        onError((reason as Error).message);
      }
    } finally {
      if (scope.isActive()) setBusy(null);
    }
  }

  return (
    <>
      <header className="pane-header">
        <p className="eyebrow">Trust & Safety</p>
        <h2>Moderation queue.</h2>
        <p>Review reports and appeals. Every decision is recorded in the audit log.</p>
      </header>
      {actionNotice && (
        <p className="success" role="status">
          {actionNotice}
        </p>
      )}
      <section className="settings-section">
        <label>
          Report status
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="open">Open</option>
            <option value="reviewing">Reviewing</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </label>
        {loading ? (
          <p role="status">Loading moderation queue...</p>
        ) : loadError ? (
          <div role="alert">
            <p>{loadError}</p>
            <button className="secondary-button" onClick={() => void refresh()}>
              Retry loading queue
            </button>
          </div>
        ) : reports.length ? (
          reports.map((report) => (
            <article className="person" key={report.id} aria-busy={busy === report.id}>
              <div>
                <strong>
                  {report.category.replaceAll("_", " ")} · {report.targetType}
                </strong>
                <span>{new Date(report.createdAt).toLocaleString()}</span>
                <span className="status">{report.status}</span>
                <button
                  className="secondary-button"
                  onClick={() => void toggleReportDetails(report.id)}
                >
                  {expandedReport === report.id ? "Hide case details" : "View case details"}
                </button>
                {expandedReport === report.id && reportDetails[report.id] && (
                  <div className="account-note">
                    <span>Target reference: {reportDetails[report.id]?.targetId}</span>
                    {reportDetails[report.id]?.details && (
                      <p>{reportDetails[report.id]?.details}</p>
                    )}
                  </div>
                )}
              </div>
              {report.status !== "resolved" && report.status !== "dismissed" && (
                <>
                  {busy === report.id && <p role="status">Saving report decision...</p>}
                  <div className="inline-actions">
                    <button
                      disabled={busy !== null}
                      aria-label={`Review report ${report.id.slice(0, 8)}`}
                      onClick={() => void updateReport(report.id, "reviewing")}
                    >
                      Review
                    </button>
                    <button
                      disabled={busy !== null}
                      aria-label={`Resolve report ${report.id.slice(0, 8)}`}
                      onClick={() => void updateReport(report.id, "resolved")}
                    >
                      Resolve
                    </button>
                    <button
                      disabled={busy !== null}
                      aria-label={`Dismiss report ${report.id.slice(0, 8)}`}
                      onClick={() => void updateReport(report.id, "dismissed")}
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
            </article>
          ))
        ) : (
          <p>No reports in this queue.</p>
        )}
      </section>
      <section className="settings-section">
        <p className="eyebrow">Appeals</p>
        {loading ? (
          <p role="status">Loading appeals...</p>
        ) : loadError ? (
          <p role="alert">Appeals could not be loaded. Retry the queue above.</p>
        ) : appeals.length ? (
          appeals.map((appeal) => (
            <article className="person" key={appeal.id} aria-busy={busy === appeal.id}>
              <div>
                <strong>Case {appeal.reportId.slice(0, 8)}</strong>
                <span>{new Date(appeal.createdAt).toLocaleString()}</span>
                <button
                  className="secondary-button"
                  onClick={() => void toggleAppealDetails(appeal.id)}
                >
                  {expandedAppeal === appeal.id ? "Hide appeal details" : "View appeal details"}
                </button>
                {expandedAppeal === appeal.id && appealDetails[appeal.id] !== undefined && (
                  <p>{appealDetails[appeal.id]}</p>
                )}
              </div>
              {busy === appeal.id && <p role="status">Saving appeal decision...</p>}
              <div className="inline-actions">
                <button
                  disabled={busy !== null}
                  aria-label={`Accept appeal for case ${appeal.reportId.slice(0, 8)}`}
                  onClick={() => void reviewAppeal(appeal.id, "accepted")}
                >
                  Accept
                </button>
                <button
                  disabled={busy !== null}
                  aria-label={`Reject appeal for case ${appeal.reportId.slice(0, 8)}`}
                  onClick={() => void reviewAppeal(appeal.id, "rejected")}
                >
                  Reject
                </button>
              </div>
            </article>
          ))
        ) : (
          <p>No open appeals.</p>
        )}
      </section>
    </>
  );
}

function Settings({
  user,
  setUser,
  onError
}: {
  user: User;
  setUser: (user: User) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [privacy, setPrivacy] = useState(user.privacy);
  const [saved, setSaved] = useState(false);
  const [followRequests, setFollowRequests] = useState<FollowRequest[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<AccountControl[]>([]);
  const [mutedUsers, setMutedUsers] = useState<AccountControl[]>([]);
  const [reportHistory, setReportHistory] = useState<ReportRecord[]>([]);
  const [appealHistory, setAppealHistory] = useState<AppealRecord[]>([]);
  const mountedRequestScope = useRef(createMountedRequestScope());

  useEffect(() => {
    const scope = createMountedRequestScope();
    mountedRequestScope.current = scope;
    return () => scope.invalidate();
  }, []);

  useEffect(() => {
    const scope = mountedRequestScope.current;
    void request<{ requests: FollowRequest[] }>("/me/follow-requests")
      .then((result) => {
        if (scope.isActive()) setFollowRequests(result.requests);
      })
      .catch((reason) => {
        if (scope.isActive()) onError((reason as Error).message);
      });
  }, []);
  useEffect(() => {
    const scope = mountedRequestScope.current;
    void Promise.all([
      request<{ users: AccountControl[] }>("/me/blocked"),
      request<{ users: AccountControl[] }>("/me/muted")
    ])
      .then(([blocked, muted]) => {
        if (!scope.isActive()) return;
        setBlockedUsers(blocked.users);
        setMutedUsers(muted.users);
      })
      .catch((reason) => {
        if (scope.isActive()) onError((reason as Error).message);
      });
  }, []);
  useEffect(() => {
    const scope = mountedRequestScope.current;
    void request<{ reports: ReportRecord[] }>("/me/reports")
      .then((result) => {
        if (scope.isActive()) setReportHistory(result.reports);
      })
      .catch((reason) => {
        if (scope.isActive()) onError((reason as Error).message);
      });
  }, []);
  useEffect(() => {
    const scope = mountedRequestScope.current;
    void request<{ appeals: AppealRecord[] }>("/me/appeals")
      .then((result) => {
        if (scope.isActive()) setAppealHistory(result.appeals);
      })
      .catch((reason) => {
        if (scope.isActive()) onError((reason as Error).message);
      });
  }, []);

  async function submitAppeal(reportId: string) {
    const details = window.prompt(
      "Explain why this report decision should be reconsidered (20–2000 characters):"
    );
    if (!details) return;
    const scope = mountedRequestScope.current;
    try {
      await request(`/reports/${reportId}/appeals`, {
        method: "POST",
        body: JSON.stringify({ details })
      });
      if (!scope.isActive()) return;
      const result = await request<{ appeals: AppealRecord[] }>("/me/appeals");
      if (scope.isActive()) setAppealHistory(result.appeals);
    } catch (reason) {
      if (scope.isActive()) onError((reason as Error).message);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = mountedRequestScope.current;
    try {
      const result = await request<{ user: User }>("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          displayName: name,
          bio: bio || null,
          avatarUrl: avatarUrl || null,
          privacy
        })
      });
      if (!scope.isActive()) return;
      setUser(result.user);
      setSaved(true);
    } catch (reason) {
      if (scope.isActive()) onError((reason as Error).message);
    }
  }

  return (
    <>
      <header className="pane-header">
        <p className="eyebrow">Settings</p>
        <h2>Shape your presence.</h2>
      </header>
      <form
        className="settings-form"
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <label>
          Display name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
        </label>
        <label>
          Bio
          <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={500} />
        </label>
        <label>
          Avatar image URL
          <input
            value={avatarUrl}
            onChange={(event) => setAvatarUrl(event.target.value)}
            type="url"
            placeholder="https://..."
          />
        </label>
        <label>
          Account privacy
          <select
            value={privacy}
            onChange={(event) => setPrivacy(event.target.value as User["privacy"])}
          >
            <option value="public">Public — anyone can see your posts</option>
            <option value="private">Private — approve followers first</option>
            <option value="restricted_creator">Creator — public creator profile</option>
          </select>
        </label>
        <button className="primary-button">Save profile</button>
        {saved && <p className="success">Profile saved.</p>}
      </form>
      <section className="account-note">
        <p className="eyebrow">Follow requests</p>
        {followRequests.length ? (
          followRequests.map((item) => (
            <article className="person" key={item.id}>
              <Avatar user={{ displayName: item.displayName, avatarUrl: item.avatarUrl }} />
              <div>
                <strong>{item.displayName}</strong>
                <span>@{item.handle}</span>
              </div>
              <button
                className="primary-button"
                onClick={() => {
                  const scope = mountedRequestScope.current;
                  void request(`/me/follow-requests/${item.handle}/accept`, { method: "POST" })
                    .then(() => {
                      if (scope.isActive()) {
                        setFollowRequests((items) => items.filter((entry) => entry.id !== item.id));
                      }
                    })
                    .catch((reason) => {
                      if (scope.isActive()) {
                        onError((reason as Error).message);
                      }
                    });
                }}
              >
                Accept
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  const scope = mountedRequestScope.current;
                  void request(`/me/follow-requests/${item.handle}`, { method: "DELETE" })
                    .then(() => {
                      if (scope.isActive()) {
                        setFollowRequests((items) => items.filter((entry) => entry.id !== item.id));
                      }
                    })
                    .catch((reason) => {
                      if (scope.isActive()) {
                        onError((reason as Error).message);
                      }
                    });
                }}
              >
                Decline
              </button>
            </article>
          ))
        ) : (
          <p>No pending follow requests.</p>
        )}
      </section>
      <section className="account-note">
        <p className="eyebrow">Blocked accounts</p>
        {blockedUsers.length ? (
          blockedUsers.map((item) => (
            <article className="person" key={item.id}>
              <Avatar user={{ displayName: item.displayName, avatarUrl: item.avatarUrl }} />
              <div>
                <strong>{item.displayName}</strong>
                <span>@{item.handle}</span>
              </div>
              <button
                className="secondary-button"
                onClick={() => {
                  const scope = mountedRequestScope.current;
                  void request(`/users/${item.handle}/block`, { method: "DELETE" })
                    .then(() => {
                      if (scope.isActive()) {
                        setBlockedUsers((items) => items.filter((entry) => entry.id !== item.id));
                      }
                    })
                    .catch((reason) => {
                      if (scope.isActive()) {
                        onError((reason as Error).message);
                      }
                    });
                }}
              >
                Unblock
              </button>
            </article>
          ))
        ) : (
          <p>No blocked accounts.</p>
        )}
      </section>
      <section className="account-note">
        <p className="eyebrow">Muted accounts</p>
        {mutedUsers.length ? (
          mutedUsers.map((item) => (
            <article className="person" key={item.id}>
              <Avatar user={{ displayName: item.displayName, avatarUrl: item.avatarUrl }} />
              <div>
                <strong>{item.displayName}</strong>
                <span>@{item.handle}</span>
              </div>
              <button
                className="secondary-button"
                onClick={() => {
                  const scope = mountedRequestScope.current;
                  void request(`/users/${item.handle}/mute`, { method: "DELETE" })
                    .then(() => {
                      if (scope.isActive()) {
                        setMutedUsers((items) => items.filter((entry) => entry.id !== item.id));
                      }
                    })
                    .catch((reason) => {
                      if (scope.isActive()) {
                        onError((reason as Error).message);
                      }
                    });
                }}
              >
                Unmute
              </button>
            </article>
          ))
        ) : (
          <p>No muted accounts.</p>
        )}
      </section>
      <section className="account-note">
        <p className="eyebrow">Your reports</p>
        {reportHistory.length ? (
          reportHistory.map((report) => (
            <article className="person" key={report.id}>
              <div>
                <strong>{report.category.replaceAll("_", " ")}</strong>
                <span>
                  {report.targetType} · {new Date(report.createdAt).toLocaleDateString()}
                </span>
              </div>
              <span className="status">{report.status}</span>
              {(report.status === "resolved" || report.status === "dismissed") &&
                !appealHistory.some((appeal) => appeal.reportId === report.id) && (
                  <button className="secondary-button" onClick={() => void submitAppeal(report.id)}>
                    Appeal decision
                  </button>
                )}
            </article>
          ))
        ) : (
          <p>You have not submitted any reports.</p>
        )}
      </section>
      <section className="account-note">
        <p className="eyebrow">Your appeals</p>
        {appealHistory.length ? (
          appealHistory.map((appeal) => (
            <article className="person" key={appeal.id}>
              <div>
                <strong>Case {appeal.reportId.slice(0, 8)}</strong>
                <span>{new Date(appeal.createdAt).toLocaleDateString()}</span>
              </div>
              <span className="status">{appeal.status}</span>
            </article>
          ))
        ) : (
          <p>You have not submitted any appeals.</p>
        )}
      </section>
      <section className="account-note">
        <p className="eyebrow">Account</p>
        <p>
          Sessions use opaque, secure cookies. Password changes and image uploads are not available
          in this phase.
        </p>
      </section>
    </>
  );
}
