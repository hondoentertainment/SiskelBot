// OAuth routes extracted from server.js

export function mountAuthRoutes(app, deps) {
  const { oauthProviders, passport, oauthCallback } = deps;

  if (oauthProviders.github) {
    app.get("/auth/github", passport.authenticate("github", { scope: ["user:email"] }));
    app.get("/auth/github/callback", passport.authenticate("github", { failureRedirect: "/?auth_error=1" }), oauthCallback);
  }
  if (oauthProviders.google) {
    app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
    app.get("/auth/google/callback", passport.authenticate("google", { failureRedirect: "/?auth_error=1" }), oauthCallback);
  }
  app.get("/auth/logout", (req, res) => {
    req.session?.destroy?.();
    res.redirect("/");
  });
  app.get("/auth/me", (req, res) => {
    if (req.session?.userId) {
      const provider = req.user?.provider || (req.session.userId?.startsWith("github-") ? "github" : req.session.userId?.startsWith("google-") ? "google" : null);
      return res.json({ userId: req.session.userId, provider });
    }
    return res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
  });
}
