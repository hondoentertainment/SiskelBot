/**
 * Phase 19: OAuth & SSO.
 * Passport strategies for GitHub and Google.
 * User lookup by provider+id; userId format: github-123 or google-sub.
 */
import passport from "passport";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const OAUTH_USERS_PATH = join(process.cwd(), "data", "oauth-users.json");

function ensureDataDir() {
  const dir = dirname(OAUTH_USERS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadOAuthUsers() {
  try {
    if (existsSync(OAUTH_USERS_PATH)) {
      const raw = readFileSync(OAUTH_USERS_PATH, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data.users) ? data.users : [];
    }
  } catch (e) {
    console.warn("[oauth] Failed to load oauth-users.json:", e.message);
  }
  return [];
}

function saveOAuthUsers(users) {
  ensureDataDir();
  writeFileSync(OAUTH_USERS_PATH, JSON.stringify({ _version: 1, users }, null, 0), "utf8");
}

/**
 * Create or lookup user by provider + provider ID.
 * Returns { userId, provider }.
 */
export function getOrCreateUser(provider, providerId) {
  const users = loadOAuthUsers();
  const key = `${provider}:${providerId}`;
  const existing = users.find((u) => `${u.provider}:${u.providerId}` === key);
  if (existing) {
    return { userId: existing.userId, provider: existing.provider };
  }
  const userId = `${provider}-${String(providerId).replace(/[^a-zA-Z0-9._-]/g, "")}`.slice(0, 100);
  users.push({ provider, providerId: String(providerId), userId });
  saveOAuthUsers(users);
  return { userId, provider };
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
        try {
          const providerId = profile.id || profile.username;
          if (!providerId) return done(new Error("GitHub profile missing id"));
          const { userId } = getOrCreateUser("github", providerId);
          return done(null, { userId, provider: "github" });
        } catch (err) {
          return done(err);
        }
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
        try {
          const providerId = profile.id || profile.sub;
          if (!providerId) return done(new Error("Google profile missing id"));
          const { userId } = getOrCreateUser("google", providerId);
          return done(null, { userId, provider: "google" });
        } catch (err) {
          return done(err);
        }
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
