/**
 * Phase 19: OAuth & SSO.
 * Passport strategies for GitHub and Google.
 * User lookup by provider+id; userId format: github-123 or google-sub.
 * Phase 68: oauth-users.json via json-path-store (Postgres / SQLite / file).
 */
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function oauthUsersPath() {
  return join(getDataDir(), "oauth-users.json");
}

/**
 * Create or lookup user by provider + provider ID.
 * @returns {Promise<{ userId: string, provider: string }>}
 */
export async function getOrCreateUser(provider, providerId) {
  const path = oauthUsersPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, users: [] });
    const users = Array.isArray(data.users) ? [...data.users] : [];
    const key = `${provider}:${providerId}`;
    const existing = users.find((u) => `${u.provider}:${u.providerId}` === key);
    if (existing) {
      return { userId: existing.userId, provider: existing.provider };
    }
    const userId = `${provider}-${String(providerId).replace(/[^a-zA-Z0-9._-]/g, "")}`.slice(0, 100);
    users.push({ provider, providerId: String(providerId), userId });
    await writeJsonPath(path, { _version: 1, users });
    return { userId, provider };
  });
}

function initGitHubStrategy() {
  const clientID = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const callbackURL = process.env.GITHUB_CALLBACK_URL || "/auth/github/callback";

  if (!clientID || !clientSecret) return false;

  const baseUrl = process.env.BASE_URL || (process.env.NODE_ENV !== "production" ? `http://localhost:${process.env.PORT || 3000}` : "");
  const fullCallbackUrl = baseUrl ? (baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl) + callbackURL : `http://localhost:${process.env.PORT || 3000}${callbackURL}`;

  passport.use(
    new GitHubStrategy(
      {
        clientID,
        clientSecret,
        callbackURL: fullCallbackUrl,
        scope: ["user:email"],
      },
      (accessToken, refreshToken, profile, done) => {
        void (async () => {
          try {
            const providerId = profile.id || profile.username;
            if (!providerId) return done(new Error("GitHub profile missing id"));
            const { userId } = await getOrCreateUser("github", providerId);
            return done(null, { userId, provider: "github" });
          } catch (err) {
            return done(err);
          }
        })();
      }
    )
  );
  return true;
}

function initGoogleStrategy() {
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const callbackURL = process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback";

  if (!clientID || !clientSecret) return false;

  const baseUrl = process.env.BASE_URL || (process.env.NODE_ENV !== "production" ? `http://localhost:${process.env.PORT || 3000}` : "");
  const fullCallbackUrl = baseUrl ? (baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl) + callbackURL : `http://localhost:${process.env.PORT || 3000}${callbackURL}`;

  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL: fullCallbackUrl,
      },
      (accessToken, refreshToken, profile, done) => {
        void (async () => {
          try {
            const providerId = profile.id || profile.sub;
            if (!providerId) return done(new Error("Google profile missing id"));
            const { userId } = await getOrCreateUser("google", providerId);
            return done(null, { userId, provider: "google" });
          } catch (err) {
            return done(err);
          }
        })();
      }
    )
  );
  return true;
}

/**
 * Initialize Passport with configured strategies.
 * Returns { github: boolean, google: boolean }.
 */
export function initPassport() {
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  const github = initGitHubStrategy();
  const google = initGoogleStrategy();

  return { github, google };
}

/**
 * Check if any OAuth provider is configured.
 */
export function isOAuthConfigured() {
  const hasGitHub = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return hasGitHub || hasGoogle;
}
