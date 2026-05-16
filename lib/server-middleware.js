/**
 * Base middleware stack assembly: creates the Express app and installs CORS,
 * compression, JSON body parsing, request-id, request context, security
 * headers (helmet), session, and passport.
 *
 * Extracted from server.js so the entry point reads as a composition root.
 * Returns the app plus the OAuth/SSO provider descriptors that route modules
 * receive via `deps`.
 */
import { randomUUID } from "crypto";
import express from "express";
import session from "express-session";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import passport from "passport";
import { initPassport, isOAuthConfigured } from "./oauth.js";
import { configureSSO, isSSOConfigured } from "./sso.js";
import { otelHttpEnrichmentMiddleware } from "./otel-context.js";
import { requestContextMiddleware } from "./request-context.js";

/**
 * Build the Express app and install the base middleware stack.
 *
 * @param {object} cfg
 * @param {boolean} cfg.IS_PRODUCTION
 * @returns {Promise<{app: import('express').Express, oauthProviders: object, ssoProviders: object}>}
 */
export async function buildApp({ IS_PRODUCTION }) {
  const app = express();

  // Phase 42: Granular CORS - use CORS_ORIGINS when set (comma-separated)
  const CORS_ORIGINS = process.env.CORS_ORIGINS?.trim();
  const corsOpts = CORS_ORIGINS
    ? {
        origin: CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
        credentials: process.env.CORS_ALLOW_CREDENTIALS !== "0",
      }
    : { credentials: true, origin: true };
  app.use(cors(corsOpts));

  const ENABLE_COMPRESSION = process.env.ENABLE_COMPRESSION !== "0" && (IS_PRODUCTION || process.env.ENABLE_COMPRESSION === "1");
  if (ENABLE_COMPRESSION) {
    app.use(
      compression({ filter: (req, _res) => !req.path?.startsWith("/v1/chat/completions") && !req.path?.startsWith("/v1/agent/swarm") })
    );
  }

  app.use(express.json({
    verify: (req, _res, buf) => {
      // Store raw body for webhook signature verification (Slack, Discord)
      if (req.url?.includes("/integrations/slack/") || req.url?.includes("/integrations/discord/")) {
        req.rawBody = buf.toString("utf8");
      }
    },
  }));
  app.use(otelHttpEnrichmentMiddleware());

  // Phase 106: Desktop model manager routes (Ollama management)
  if (process.env.ELECTRON_DESKTOP === "1") {
    try {
      const mod = await import("../electron/model-manager.cjs");
      const registerModelRoutes = mod.registerModelRoutes || mod.default?.registerModelRoutes;
      if (registerModelRoutes) registerModelRoutes(app);
    } catch (_) {
      /* model-manager only needed in desktop builds */
    }
  }

  // Phase 34: Request ID for all responses (k8s/tracing)
  app.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });

  // Request context propagation (AsyncLocalStorage) -- after requestId is set
  app.use(requestContextMiddleware());

  // Phase 34: Security headers (configurable; disabled for dev if DISABLE_SECURITY_HEADERS=1)
  const DISABLE_SECURITY_HEADERS = process.env.DISABLE_SECURITY_HEADERS === "1";
  const ENABLE_CSP = process.env.ENABLE_CSP === "1" && IS_PRODUCTION;
  if (!DISABLE_SECURITY_HEADERS) {
    const helmetOpts = {
      contentSecurityPolicy: false,
      strictTransportSecurity: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true } : false,
    };
    if (ENABLE_CSP) {
      helmetOpts.contentSecurityPolicy = {
        reportOnly: process.env.CSP_ENFORCE !== "1",
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
          "style-src": ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "https:"],
          "connect-src": ["'self'", "https://api.openai.com", "wss:", "ws:"],
          "font-src": ["'self'", "https://cdn.jsdelivr.net", "https:"],
          "frame-ancestors": ["'self'"],
          "base-uri": ["'self'"],
        },
      };
    }
    app.use(helmet(helmetOpts));
  }

  // Phase 19: Session middleware
  // Secret rotation: when SESSION_SECRET_PREVIOUS is set, express-session receives an
  // array of secrets — it signs with the first and validates against all.
  const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    (IS_PRODUCTION ? null : "dev-secret-change-in-production");
  const SESSION_SECRET_PREVIOUS = process.env.SESSION_SECRET_PREVIOUS?.trim() || null;
  const sessionSecretValue = SESSION_SECRET_PREVIOUS ? [SESSION_SECRET, SESSION_SECRET_PREVIOUS] : SESSION_SECRET;
  if (isOAuthConfigured() && !SESSION_SECRET) {
    console.warn("[auth] OAuth configured but SESSION_SECRET not set. OAuth login will not persist. Set SESSION_SECRET in production.");
  }
  if (SESSION_SECRET) {
    app.use(
      session({
        secret: sessionSecretValue,
        resave: false,
        saveUninitialized: false,
        cookie: {
          secure: IS_PRODUCTION,
          httpOnly: true,
          sameSite: IS_PRODUCTION ? "lax" : "lax",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        },
      })
    );
  }

  // Phase 19: Passport (when OAuth or SSO configured)
  let oauthProviders = { github: false, google: false };
  let ssoProviders = { oidc: false, saml: false };
  const needsPassport = isOAuthConfigured() || isSSOConfigured();
  if (needsPassport) {
    app.use(passport.initialize());
    app.use(passport.session());
    oauthProviders = initPassport();
    ssoProviders = configureSSO(app, passport);
  }

  return { app, oauthProviders, ssoProviders };
}
