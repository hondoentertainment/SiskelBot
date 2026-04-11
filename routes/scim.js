/**
 * Phase 46.2: SCIM 2.0 routes (RFC 7644).
 *
 * All routes are mounted under /scim/v2/* and authenticated with the SCIM
 * bearer token middleware. Identity providers (Okta, Azure AD, OneLogin,
 * Google Workspace) call these endpoints to provision and deprovision
 * users and groups.
 *
 * Routes:
 *   GET    /scim/v2/ServiceProviderConfig
 *   GET    /scim/v2/ResourceTypes
 *   GET    /scim/v2/Schemas
 *   GET    /scim/v2/Users
 *   GET    /scim/v2/Users/:id
 *   POST   /scim/v2/Users
 *   PUT    /scim/v2/Users/:id
 *   PATCH  /scim/v2/Users/:id
 *   DELETE /scim/v2/Users/:id
 *   GET    /scim/v2/Groups
 *   GET    /scim/v2/Groups/:id
 *   POST   /scim/v2/Groups
 *   PUT    /scim/v2/Groups/:id
 *   PATCH  /scim/v2/Groups/:id
 *   DELETE /scim/v2/Groups/:id
 */
import express from "express";
import {
  SCIM_SCHEMAS,
  createSCIMUser,
  getSCIMUser,
  updateSCIMUser,
  patchSCIMUser,
  deleteSCIMUser,
  listSCIMUsers,
  createSCIMGroup,
  getSCIMGroup,
  updateSCIMGroup,
  patchSCIMGroup,
  deleteSCIMGroup,
  listSCIMGroups,
} from "../lib/scim.js";
import { scimAuthMiddleware, scimErrorBody } from "../lib/scim-auth.js";

// Identity providers send Content-Type: application/scim+json. The default
// app-level express.json() only parses application/json, so we add a SCIM
// body parser scoped to this route.
const scimJsonParser = express.json({
  type: ["application/json", "application/scim+json"],
  limit: "1mb",
});

const SCIM_CONTENT_TYPE = "application/scim+json";

function sendScim(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", SCIM_CONTENT_TYPE);
  res.json(body);
}

function sendScimError(res, status, detail, scimType) {
  sendScim(res, status, scimErrorBody(status, detail, scimType));
}

function handleError(res, err) {
  const status = err?.status || 500;
  const detail = err?.message || "Internal server error";
  const scimType = err?.scimType;
  return sendScimError(res, status, detail, scimType);
}

// ─── Static SCIM discovery responses ────────────────────────────────────────

function buildServiceProviderConfig() {
  return {
    schemas: [SCIM_SCHEMAS.serviceProviderConfig],
    documentationUri: "https://docs.siskelbot.example/scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        name: "OAuth Bearer Token",
        description: "Authentication via OAuth 2.0 bearer token shared with the IdP.",
        specUri: "https://www.rfc-editor.org/info/rfc6750",
        documentationUri: "https://docs.siskelbot.example/scim#auth",
        type: "oauthbearertoken",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: "/scim/v2/ServiceProviderConfig",
    },
  };
}

function buildResourceTypes() {
  return {
    schemas: [SCIM_SCHEMAS.listResponse],
    totalResults: 2,
    Resources: [
      {
        schemas: [SCIM_SCHEMAS.resourceType],
        id: "User",
        name: "User",
        endpoint: "/Users",
        description: "User accounts",
        schema: SCIM_SCHEMAS.user,
        schemaExtensions: [
          {
            schema: SCIM_SCHEMAS.enterpriseUser,
            required: false,
          },
        ],
        meta: { resourceType: "ResourceType", location: "/scim/v2/ResourceTypes/User" },
      },
      {
        schemas: [SCIM_SCHEMAS.resourceType],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        description: "User groups",
        schema: SCIM_SCHEMAS.group,
        meta: { resourceType: "ResourceType", location: "/scim/v2/ResourceTypes/Group" },
      },
    ],
  };
}

function buildSchemas() {
  return {
    schemas: [SCIM_SCHEMAS.listResponse],
    totalResults: 3,
    Resources: [
      {
        id: SCIM_SCHEMAS.user,
        name: "User",
        description: "SCIM core User schema (RFC 7643)",
        attributes: [
          { name: "userName", type: "string", required: true, uniqueness: "server" },
          { name: "name", type: "complex", required: false },
          { name: "displayName", type: "string", required: false },
          { name: "active", type: "boolean", required: false },
          { name: "emails", type: "complex", multiValued: true, required: false },
        ],
        meta: { resourceType: "Schema", location: `/scim/v2/Schemas/${SCIM_SCHEMAS.user}` },
      },
      {
        id: SCIM_SCHEMAS.group,
        name: "Group",
        description: "SCIM core Group schema (RFC 7643)",
        attributes: [
          { name: "displayName", type: "string", required: true },
          { name: "members", type: "complex", multiValued: true, required: false },
        ],
        meta: { resourceType: "Schema", location: `/scim/v2/Schemas/${SCIM_SCHEMAS.group}` },
      },
      {
        id: SCIM_SCHEMAS.enterpriseUser,
        name: "EnterpriseUser",
        description: "Enterprise user extension (RFC 7643)",
        attributes: [
          { name: "employeeNumber", type: "string" },
          { name: "department", type: "string" },
          { name: "manager", type: "complex" },
        ],
        meta: { resourceType: "Schema", location: `/scim/v2/Schemas/${SCIM_SCHEMAS.enterpriseUser}` },
      },
    ],
  };
}

export function mountScimRoutes(app, _deps) {
  const auth = scimAuthMiddleware();

  // ─── Discovery endpoints ──────────────────────────────────────────────────

  app.get("/scim/v2/ServiceProviderConfig", auth, (_req, res) => {
    sendScim(res, 200, buildServiceProviderConfig());
  });

  app.get("/scim/v2/ResourceTypes", auth, (_req, res) => {
    sendScim(res, 200, buildResourceTypes());
  });

  app.get("/scim/v2/Schemas", auth, (_req, res) => {
    sendScim(res, 200, buildSchemas());
  });

  // ─── Users ────────────────────────────────────────────────────────────────

  app.get("/scim/v2/Users", auth, async (req, res) => {
    try {
      const filter = req.query.filter ? String(req.query.filter) : null;
      const startIndex = req.query.startIndex ? parseInt(String(req.query.startIndex), 10) : 1;
      const count = req.query.count ? parseInt(String(req.query.count), 10) : 100;
      const result = await listSCIMUsers(filter, startIndex, count);
      sendScim(res, 200, result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/scim/v2/Users/:id", auth, async (req, res) => {
    try {
      const user = await getSCIMUser(req.params.id);
      if (!user) {
        return sendScimError(res, 404, `User ${req.params.id} not found`);
      }
      sendScim(res, 200, user);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post("/scim/v2/Users", auth, scimJsonParser, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return sendScimError(res, 400, "Request body must be a JSON object", "invalidSyntax");
      }
      const user = await createSCIMUser(req.body);
      res.setHeader("Location", `/scim/v2/Users/${user.id}`);
      sendScim(res, 201, user);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.put("/scim/v2/Users/:id", auth, scimJsonParser, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return sendScimError(res, 400, "Request body must be a JSON object", "invalidSyntax");
      }
      const user = await updateSCIMUser(req.params.id, req.body);
      sendScim(res, 200, user);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.patch("/scim/v2/Users/:id", auth, scimJsonParser, async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || !Array.isArray(body.Operations)) {
        return sendScimError(
          res,
          400,
          "PATCH body must include an Operations array",
          "invalidSyntax",
        );
      }
      const user = await patchSCIMUser(req.params.id, body.Operations);
      sendScim(res, 200, user);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.delete("/scim/v2/Users/:id", auth, async (req, res) => {
    try {
      const ok = await deleteSCIMUser(req.params.id);
      if (!ok) {
        return sendScimError(res, 404, `User ${req.params.id} not found`);
      }
      res.status(204);
      res.setHeader("Content-Type", SCIM_CONTENT_TYPE);
      res.end();
    } catch (err) {
      handleError(res, err);
    }
  });

  // ─── Groups ───────────────────────────────────────────────────────────────

  app.get("/scim/v2/Groups", auth, async (req, res) => {
    try {
      const filter = req.query.filter ? String(req.query.filter) : null;
      const startIndex = req.query.startIndex ? parseInt(String(req.query.startIndex), 10) : 1;
      const count = req.query.count ? parseInt(String(req.query.count), 10) : 100;
      const result = await listSCIMGroups(filter, startIndex, count);
      sendScim(res, 200, result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/scim/v2/Groups/:id", auth, async (req, res) => {
    try {
      const group = await getSCIMGroup(req.params.id);
      if (!group) {
        return sendScimError(res, 404, `Group ${req.params.id} not found`);
      }
      sendScim(res, 200, group);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post("/scim/v2/Groups", auth, scimJsonParser, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return sendScimError(res, 400, "Request body must be a JSON object", "invalidSyntax");
      }
      const group = await createSCIMGroup(req.body);
      res.setHeader("Location", `/scim/v2/Groups/${group.id}`);
      sendScim(res, 201, group);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.put("/scim/v2/Groups/:id", auth, scimJsonParser, async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object") {
        return sendScimError(res, 400, "Request body must be a JSON object", "invalidSyntax");
      }
      const group = await updateSCIMGroup(req.params.id, req.body);
      sendScim(res, 200, group);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.patch("/scim/v2/Groups/:id", auth, scimJsonParser, async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || !Array.isArray(body.Operations)) {
        return sendScimError(
          res,
          400,
          "PATCH body must include an Operations array",
          "invalidSyntax",
        );
      }
      const group = await patchSCIMGroup(req.params.id, body.Operations);
      sendScim(res, 200, group);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.delete("/scim/v2/Groups/:id", auth, async (req, res) => {
    try {
      const ok = await deleteSCIMGroup(req.params.id);
      if (!ok) {
        return sendScimError(res, 404, `Group ${req.params.id} not found`);
      }
      res.status(204);
      res.setHeader("Content-Type", SCIM_CONTENT_TYPE);
      res.end();
    } catch (err) {
      handleError(res, err);
    }
  });
}

export default mountScimRoutes;
