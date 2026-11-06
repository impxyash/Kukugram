"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type User = { id: string; handle: string; displayName: string; bio: string | null; avatarUrl: string | null; followers: string; following: string; isFollowing: boolean; isRequested: boolean; privacy: "public" | "private" | "restricted_creator"; canViewContent: boolean };
type Post = { id: string; body: string; createdAt: string; handle: string; displayName: string; avatarUrl: string | null; likeCount: string; commentCount: string; likedByViewer: boolean; authorId: string };
type Notice = { id: string; type: "follow" | "follow_request" | "like" | "comment"; postId: string | null; createdAt: string; readAt: string | null; handle: string | null; displayName: string | null };
type Comment = { id: string; body: string; handle: string; displayName: string; createdAt: string };
type FollowRequest = { id: string; handle: string; displayName: string; avatarUrl: string | null; requestedAt: string };

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}/v1${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...options.headers },
    ...options
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { title?: string } | null;
    throw new Error(problem?.title ?? "Something went wrong. Please try again.");
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

function Avatar({ user, small = false }: { user: Pick<User | Post, "displayName" | "avatarUrl">; small?: boolean }) {
  return user.avatarUrl
    ? <img className={`avatar ${small ? "small" : ""}`} src={user.avatarUrl} alt="" />
    : <span className={`avatar fallback ${small ? "small" : ""}`}>{user.displayName.slice(0, 1).toUpperCase()}</span>;
}

export function AppShell() {
  const [user, setUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [tab, setTab] = useState<"home" | "discover" | "activity" | "profile" | "settings">("home");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const me = await request<{ user: User }>("/me");
      setUser(me.user);
      const [feed, activity] = await Promise.all([
        request<{ posts: Post[] }>("/feed"),
        request<{ notifications: Notice[] }>("/notifications")
      ]);
      setPosts(feed.posts);
      setNotices(activity.notifications);
    } catch (reason) {
      setUser(null);
      if ((reason as Error).message !== "Internal server error") setError(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  if (loading) return <main className="app-loading"><span className="pulse-dot" /> Loading your corner...</main>;
  if (!user) return <AuthScreen mode={authMode} setMode={setAuthMode} onAuthenticated={refresh} />;

  const unread = notices.filter((notice) => !notice.readAt).length;

  return (
    <main className="app-shell">
      <aside className="side-nav">
        <a className="brand" href="/"><span className="brand-mark">k</span> kukugram</a>
        <p className="nav-kicker">your social orbit</p>
        {([
          ["home", "Home"],
          ["discover", "Discover"],
          ["activity", `Activity${unread ? ` (${unread})` : ""}`],
          ["profile", "Profile"],
          ["settings", "Settings"]
        ] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? "nav-item active" : "nav-item"} onClick={() => setTab(id)}>{label}</button>
        ))}
        <button
          className="nav-item logout"
          onClick={() => {
            void (async () => {
              try {
                await request("/auth/logout", { method: "POST" });
                setUser(null);
                setPosts([]);
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
        {error && <p className="banner error">{error}</p>}
        {tab === "home" && <Home user={user} posts={posts} setPosts={setPosts} onError={setError} />}
        {tab === "discover" && <Discover onError={setError} />}
        {tab === "activity" && <Activity notices={notices} setNotices={setNotices} />}
        {tab === "profile" && <Profile user={user} setUser={setUser} posts={posts.filter((post) => post.authorId === user.id)} onError={setError} />}
        {tab === "settings" && <Settings user={user} setUser={setUser} onError={setError} />}
      </section>
    </main>
  );
}

function AuthScreen({ mode, setMode, onAuthenticated }: { mode: "login" | "signup"; setMode: (mode: "login" | "signup") => void; onAuthenticated: () => Promise<void> }) {
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
          <a className="brand auth-brand" href="/"><span className="brand-mark">k</span> kukugram</a>
          <div className="auth-visual-copy">
            <p className="eyebrow">A little more you. A little less noise.</p>
            <h1>Share the<br /><em>good stuff.</em></h1>
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
            <div className="auth-mobile-brand"><a className="brand" href="/"><span className="brand-mark">k</span> kukugram</a></div>
            <div className="auth-card-heading">
              <p className="eyebrow">{mode === "signup" ? "JOIN THE COMMUNITY" : "GOOD TO SEE YOU AGAIN"}</p>
              <h2>{mode === "signup" ? "Create an account" : "Welcome back"}</h2>
              <p>{mode === "signup" ? "Sign up to see photos, posts and moments from your people." : "Log in to catch up with your people."}</p>
            </div>

            {error && <p className="form-error" role="alert">{error}</p>}
            <form className="auth-form" onSubmit={(event) => { void submit(event); }}>
              {mode === "signup" && (
                <>
                  <label>Full name<input required name="displayName" maxLength={60} autoComplete="name" placeholder="Your name" /></label>
                  <label>Username<input required name="handle" pattern="[a-z0-9_]{3,30}" title="Use 3-30 lowercase letters, numbers, or underscores." autoComplete="username" placeholder="Choose a username" /></label>
                </>
              )}
              <label>Email address<input required name="email" type="email" autoComplete="email" placeholder="name@example.com" /></label>
              <label>Password<input required name="password" type="password" minLength={mode === "signup" ? 12 : 1} autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={mode === "signup" ? "At least 12 characters" : "Your password"} /></label>
              {mode === "signup" && <p className="auth-terms">By signing up, you agree to our Terms and Privacy Policy.</p>}
              <button className="primary-button auth-submit" disabled={busy}>
                {busy ? "Please wait..." : mode === "signup" ? "Create account" : "Log in"}
              </button>
            </form>

            <div className="auth-switch">
              {mode === "signup" ? "Already have an account?" : "Don't have an account?"}
              <button className="auth-switch-button" onClick={() => { setError(null); setMode(mode === "signup" ? "login" : "signup"); }}>
                {mode === "signup" ? "Log in" : "Sign up"}
              </button>
            </div>
          </div>
          <p className="auth-footer">© {new Date().getFullYear()} Kukugram · Made for your people</p>
        </section>
      </div>
    </main>
  );
}

function Home({ user, posts, setPosts, onError }: { user: User; posts: Post[]; setPosts: (posts: Post[]) => void; onError: (message: string | null) => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const { post } = await request<{ post: Post }>("/posts", { method: "POST", body: JSON.stringify({ body }) });
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
      <header className="pane-header"><p className="eyebrow">Following</p><h2>Your people, in motion.</h2></header>
      <form className="composer" onSubmit={(event) => { void publish(event); }}>
        <Avatar user={user} />
        <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="What is moving through your mind?" maxLength={2000} />
        <div><span>{body.length}/2000</span><button className="primary-button" disabled={busy || !body.trim()}>{busy ? "Posting..." : "Publish"}</button></div>
      </form>
      {posts.length ? (
        <div className="feed">
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              user={user}
              onChange={(updated) => setPosts(posts.map((item) => item.id === updated.id ? updated : item))}
              onDelete={() => setPosts(posts.filter((item) => item.id !== post.id))}
              onError={onError}
            />
          ))}
        </div>
      ) : (
        <section className="empty-state"><span className="orbit">*</span><h3>Your feed is waiting.</h3><p>Follow people in Discover, or make the first post in your corner.</p></section>
      )}
    </>
  );
}

function PostCard({ post, user, onChange, onDelete, onError }: { post: Post; user: User; onChange: (post: Post) => void; onDelete: () => void; onError: (message: string) => void }) {
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
      await request(`/posts/${post.id}/comments`, { method: "POST", body: JSON.stringify({ body: comment }) });
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
        <div><strong>{post.displayName}</strong><span>@{post.handle} · {new Date(post.createdAt).toLocaleDateString()}</span></div>
        {post.authorId === user.id && <button className="icon-button delete" onClick={() => { void deletePost(); }}>Delete</button>}
      </header>
      <p className="post-body">{post.body}</p>
      <div className="post-actions">
        <button className={post.likedByViewer ? "liked" : ""} onClick={() => { void toggleLike(); }}>♥ {post.likeCount}</button>
        <button onClick={() => { void showComments(); }}>Reply {post.commentCount}</button>
      </div>
      {comments && (
        <div className="comments">
          {comments.map((item) => <p key={item.id}><b>{item.displayName}</b> <span>@{item.handle}</span> {item.body}</p>)}
          <form onSubmit={(event) => { void addComment(event); }}>
            <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={1000} placeholder="Add to the conversation" />
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
      setUsers((await request<{ users: User[] }>(`/users/search?q=${encodeURIComponent(query)}`)).users);
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
        setUsers(users.map((item) => item.id === person.id ? { ...item, isFollowing: false, isRequested: false } : item));
      } else {
        const result = await request<{ user: User }>(`/users/${person.handle}/follow`, { method: "POST" });
        setUsers(users.map((item) => item.id === person.id ? { ...item, isFollowing: result.user.isFollowing, isRequested: result.user.isRequested } : item));
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
    if (!window.confirm(`Block @${person.handle}? You will both be removed from each other's follow lists.`)) return;
    try {
      await request(`/users/${person.handle}/block`, { method: "POST" });
      setUsers(users.filter((item) => item.id !== person.id));
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  return (
    <>
      <header className="pane-header"><p className="eyebrow">Discover</p><h2>Find your next familiar face.</h2></header>
      <form className="search" onSubmit={(event) => { void search(event); }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search username or name" />
        <button className="primary-button" disabled={loading}>{loading ? "Searching..." : "Search"}</button>
      </form>
      <div className="results">
        {users.map((person) => (
          <article key={person.id} className="person">
            <Avatar user={person} />
            <div><strong>{person.displayName}</strong><span>@{person.handle}</span><p>{person.bio}</p></div>
            <div className="person-actions">
              <button className={person.isFollowing ? "secondary-button" : "primary-button"} onClick={() => { void toggleFollow(person); }}>
                {person.isFollowing ? "Following" : person.isRequested ? "Requested" : "Follow"}
              </button>
              <button className="secondary-button" onClick={() => { void mutePerson(person); }}>Mute</button>
              <button className="secondary-button" onClick={() => { void blockPerson(person); }}>Block</button>
            </div>
          </article>
        ))}
      </div>
      {query && !loading && !users.length && <section className="empty-state"><h3>No one surfaced yet.</h3><p>Try another name or username.</p></section>}
    </>
  );
}

function Activity({ notices, setNotices }: { notices: Notice[]; setNotices: (notices: Notice[]) => void }) {
  useEffect(() => {
    void request("/notifications/read", { method: "POST" }).then(() => {
      setNotices(notices.map((notice) => ({ ...notice, readAt: notice.readAt ?? new Date().toISOString() })));
    });
  }, []);

  return (
    <>
      <header className="pane-header"><p className="eyebrow">Activity</p><h2>The ripples from your corner.</h2></header>
      {notices.length ? (
        <div className="results">
          {notices.map((notice) => (
            <article className="notice" key={notice.id}>
              <span className="notice-mark">{notice.type === "follow" ? "+" : notice.type === "follow_request" ? "⌁" : notice.type === "like" ? "♥" : "↳"}</span>
              <p><b>{notice.displayName ?? "Someone"}</b> {notice.type === "follow" ? "followed you" : notice.type === "follow_request" ? "requested to follow you" : notice.type === "like" ? "liked your post" : "replied to your post"}.<span>{new Date(notice.createdAt).toLocaleDateString()}</span></p>
            </article>
          ))}
        </div>
      ) : (
        <section className="empty-state"><h3>Quiet, for now.</h3><p>Your follows and conversations will collect here.</p></section>
      )}
    </>
  );
}

function Profile({ user, setUser, posts, onError }: { user: User; setUser: (user: User) => void; posts: Post[]; onError: (message: string) => void }) {
  async function editProfile() {
    const name = window.prompt("Display name", user.displayName);
    if (!name) return;
    try {
      const result = await request<{ user: User }>("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: name })
      });
      setUser(result.user);
    } catch (reason) {
      onError((reason as Error).message);
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
          <span>{user.followers} followers · {user.following} following</span>
        </div>
      </header>
      <button className="secondary-button" onClick={() => { void editProfile(); }}>Edit profile</button>
      <h3 className="section-title">Your posts</h3>
      {posts.length ? (
        <div className="feed">
          {posts.map((post) => (
            <article className="post-card compact" key={post.id}>
              <p className="post-body">{post.body}</p>
              <span>{post.likeCount} likes · {post.commentCount} replies</span>
            </article>
          ))}
        </div>
      ) : (
        <section className="empty-state"><h3>Nothing published yet.</h3><p>Your posts will live here.</p></section>
      )}
    </>
  );
}

function Settings({ user, setUser, onError }: { user: User; setUser: (user: User) => void; onError: (message: string) => void }) {
  const [name, setName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [privacy, setPrivacy] = useState(user.privacy);
  const [saved, setSaved] = useState(false);
  const [followRequests, setFollowRequests] = useState<FollowRequest[]>([]);
  useEffect(() => {
    void request<{ requests: FollowRequest[] }>("/me/follow-requests")
      .then((result) => setFollowRequests(result.requests))
      .catch((reason) => onError((reason as Error).message));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const result = await request<{ user: User }>("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: name, bio: bio || null, avatarUrl: avatarUrl || null, privacy })
      });
      setUser(result.user);
      setSaved(true);
    } catch (reason) {
      onError((reason as Error).message);
    }
  }

  return (
    <>
      <header className="pane-header"><p className="eyebrow">Settings</p><h2>Shape your presence.</h2></header>
      <form className="settings-form" onSubmit={(event) => { void save(event); }}>
        <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} /></label>
        <label>Bio<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={500} /></label>
        <label>Avatar image URL<input value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} type="url" placeholder="https://..." /></label>
        <label>Account privacy
          <select value={privacy} onChange={(event) => setPrivacy(event.target.value as User["privacy"])}>
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
        {followRequests.length ? followRequests.map((item) => (
          <article className="person" key={item.id}>
            <Avatar user={{ displayName: item.displayName, avatarUrl: item.avatarUrl }} />
            <div><strong>{item.displayName}</strong><span>@{item.handle}</span></div>
            <button className="primary-button" onClick={() => {
              void request(`/me/follow-requests/${item.handle}/accept`, { method: "POST" })
                .then(() => setFollowRequests((items) => items.filter((entry) => entry.id !== item.id)))
                .catch((reason) => onError((reason as Error).message));
            }}>Accept</button>
            <button className="secondary-button" onClick={() => {
              void request(`/me/follow-requests/${item.handle}`, { method: "DELETE" })
                .then(() => setFollowRequests((items) => items.filter((entry) => entry.id !== item.id)))
                .catch((reason) => onError((reason as Error).message));
            }}>Decline</button>
          </article>
        )) : <p>No pending follow requests.</p>}
      </section>
      <section className="account-note">
        <p className="eyebrow">Account</p>
        <p>Sessions use opaque, secure cookies. Password changes and image uploads are not available in this phase.</p>
      </section>
    </>
  );
}
