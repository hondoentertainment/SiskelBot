#
# SiskelBot Edge — Fastly VCL
#
# Mirrors the behaviour of edge/cloudflare/worker.js using Varnish
# Configuration Language. Caches read-only API endpoints at the Fastly
# POPs and forwards everything else to the origin.
#
# Cached paths (TTL):
#   /config                       30s
#   /api/v1/knowledge/search      60s   (vary on q,workspace)
#   /api/v1/recipes               60s   (vary on workspace)
#   /api/docs/openapi.json        3600s
#
# Special:
#   /health/live    -> served entirely from edge (no origin call)
#   /metrics        -> proxied, never cached
#

vcl 4.0;

# Origin backend definition. Replace host/port for your environment or
# define via the Fastly UI / `terraform-provider-fastly`.
backend F_origin {
  .host = "api.siskelbot.example.com";
  .port = "443";
  .ssl = true;
  .ssl_cert_hostname = "api.siskelbot.example.com";
  .ssl_sni_hostname = "api.siskelbot.example.com";
  .first_byte_timeout = 30s;
  .between_bytes_timeout = 10s;
  .probe = {
    .request = "GET /health/live HTTP/1.1" "Host: api.siskelbot.example.com" "Connection: close";
    .timeout = 2s;
    .interval = 10s;
    .window = 5;
    .threshold = 3;
  }
}

# ACL of authorised purge sources (origin server IPs go here).
acl purge_acl {
  "127.0.0.1";
  # "203.0.113.10";
}

sub vcl_recv {
  set req.backend_hint = F_origin;

  # 1. Instant edge response for /health/live (no origin round-trip).
  if (req.url == "/health/live" && (req.method == "GET" || req.method == "HEAD")) {
    error 900 "edge-health";
  }

  # 2. Allow PURGE requests from authorised sources.
  if (req.method == "PURGE") {
    if (!client.ip ~ purge_acl) {
      error 405 "Not allowed";
    }
    return (lookup);
  }

  # 3. Pass-through writes (no caching, no normalisation).
  if (req.method != "GET" && req.method != "HEAD") {
    return (pass);
  }

  # 4. Never cache /metrics — always forward.
  if (req.url ~ "^/metrics(\?|$)") {
    return (pass);
  }

  # 5. Authenticated requests bypass the cache.
  if (req.http.Authorization || req.http.X-API-Key || req.http.Cookie) {
    return (pass);
  }

  # 6. Normalise the cache key for the cacheable endpoints.
  #    We strip *all* query string params, then re-add only the configured
  #    "vary" params in sorted order.
  if (req.url ~ "^/config(\?|$)") {
    set req.url = "/config";
    return (lookup);
  }

  if (req.url ~ "^/api/docs/openapi\.json(\?|$)") {
    set req.url = "/api/docs/openapi.json";
    return (lookup);
  }

  if (req.url ~ "^/api/v1/knowledge/search(\?|$)") {
    # vary on: q, workspace
    set req.url = "/api/v1/knowledge/search?"
      + "q=" + regsub(req.url, ".*[?&]q=([^&]*).*", "\1")
      + "&workspace=" + regsub(req.url, ".*[?&]workspace=([^&]*).*", "\1");
    return (lookup);
  }

  if (req.url ~ "^/api/v1/recipes(\?|$)") {
    # vary on: workspace
    set req.url = "/api/v1/recipes?"
      + "workspace=" + regsub(req.url, ".*[?&]workspace=([^&]*).*", "\1");
    return (lookup);
  }

  # 7. Anything else: forward to origin without caching.
  return (pass);
}

sub vcl_fetch {
  # Apply per-path TTLs.
  if (req.url ~ "^/config") {
    set beresp.ttl = 30s;
    set beresp.http.X-Edge-TTL = "30";
  } else if (req.url ~ "^/api/docs/openapi\.json") {
    set beresp.ttl = 3600s;
    set beresp.http.X-Edge-TTL = "3600";
  } else if (req.url ~ "^/api/v1/knowledge/search") {
    set beresp.ttl = 60s;
    set beresp.http.X-Edge-TTL = "60";
  } else if (req.url ~ "^/api/v1/recipes") {
    set beresp.ttl = 60s;
    set beresp.http.X-Edge-TTL = "60";
  }

  # Only cache 200 responses.
  if (beresp.status != 200) {
    set beresp.ttl = 0s;
    set beresp.cacheable = false;
    return (pass);
  }

  # Allow soft-purge / stale-while-revalidate semantics.
  set beresp.stale_while_revalidate = 30s;
  set beresp.stale_if_error = 600s;

  return (deliver);
}

sub vcl_deliver {
  set resp.http.X-Edge = "fastly";
  if (fastly_info.state ~ "^HIT") {
    set resp.http.X-Edge-Cache = "HIT";
  } else if (fastly_info.state ~ "^MISS") {
    set resp.http.X-Edge-Cache = "MISS";
  } else if (fastly_info.state ~ "^PASS") {
    set resp.http.X-Edge-Cache = "BYPASS";
  } else {
    set resp.http.X-Edge-Cache = fastly_info.state;
  }
  return (deliver);
}

sub vcl_error {
  # Synthetic /health/live response.
  if (obj.status == 900) {
    set obj.status = 200;
    set obj.response = "OK";
    set obj.http.Content-Type = "application/json";
    set obj.http.X-Edge = "fastly";
    set obj.http.X-Edge-Cache = "BYPASS";
    synthetic {"{"status":"ok","edge":"fastly"}"};
    return (deliver);
  }
  return (deliver);
}
