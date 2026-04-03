/**
 * SSO configuration hub — auto-configures OIDC and SAML providers
 * based on environment variables.
 *
 * Registers Passport strategies and routes for:
 *   /auth/oidc, /auth/oidc/callback
 *   /auth/saml, /auth/saml/callback, /auth/saml/metadata
 */
import passport from "passport";
import { configureOIDC, isOIDCConfigured, createOIDCStrategy } from "./oidc.js";
import { configureSAML, isSAMLConfigured, createSAMLStrategy, generateMetadata } from "./saml.js";
import { getOrCreateUser } from "./oauth.js";

/**
 * Auto-configure available SSO providers and register routes.
 * @param {import('express').Express} app
 * @param {import('passport').PassportStatic} passportInstance
 * @returns {{ oidc: boolean, saml: boolean }}
 */
export function configureSSO(app, passportInstance = passport) {
  const result = { oidc: false, saml: false };

  // --- OIDC ---
  const oidcConfig = configureOIDC();
  if (oidcConfig) {
    const oidcStrategy = createOIDCStrategy(oidcConfig);

    // Wrap strategy success to do user lookup via getOrCreateUser
    const originalAuthenticate = oidcStrategy.authenticate;
    oidcStrategy.authenticate = function (req, options) {
      const origSuccess = this.success.bind(this);
      this.success = async (oidcUser) => {
        try {
          const { userId } = await getOrCreateUser("oidc", oidcUser.id);
          origSuccess({ userId, provider: "oidc", displayName: oidcUser.displayName, email: oidcUser.email });
        } catch (err) {
          this.error(err);
        }
      };
      return originalAuthenticate.call(this, req, options);
    };

    passportInstance.use(oidcStrategy);

    app.get("/auth/oidc", passportInstance.authenticate("oidc"));
    app.get("/auth/oidc/callback",
      passportInstance.authenticate("oidc", { failureRedirect: "/?auth_error=oidc" }),
      ssoCallback
    );

    result.oidc = true;
    console.log("[sso] OIDC provider configured (issuer: %s)", oidcConfig.issuer);
  }

  // --- SAML ---
  const samlConfig = configureSAML();
  if (samlConfig) {
    const samlStrategy = createSAMLStrategy(samlConfig);

    // Wrap strategy success to do user lookup via getOrCreateUser
    const originalAuthenticate = samlStrategy.authenticate;
    samlStrategy.authenticate = function (req, options) {
      const origSuccess = this.success.bind(this);
      this.success = async (samlUser) => {
        try {
          const { userId } = await getOrCreateUser("saml", samlUser.id);
          origSuccess({ userId, provider: "saml", displayName: samlUser.displayName, email: samlUser.email });
        } catch (err) {
          this.error(err);
        }
      };
      return originalAuthenticate.call(this, req, options);
    };

    passportInstance.use(samlStrategy);

    app.get("/auth/saml", passportInstance.authenticate("saml"));
    app.post("/auth/saml/callback",
      passportInstance.authenticate("saml", { failureRedirect: "/?auth_error=saml" }),
      ssoCallback
    );

    // SP metadata endpoint
    app.get("/auth/saml/metadata", (_req, res) => {
      res.type("application/xml").send(generateMetadata(samlConfig));
    });

    result.saml = true;
    console.log("[sso] SAML provider configured (issuer: %s)", samlConfig.issuer);
  }

  return result;
}

/**
 * Check if any SSO provider (OIDC or SAML) is configured.
 */
export function isSSOConfigured() {
  return isOIDCConfigured() || isSAMLConfigured();
}

/**
 * Shared SSO callback handler — stores userId in session and redirects.
 */
function ssoCallback(req, res) {
  if (!req.session) return res.redirect("/?auth_error=session");
  req.session.userId = req.user?.userId;
  res.redirect("/");
}
