#!/usr/bin/env node
/**
 * Phase 40.2: Generate a DNS zone file for geo-based routing.
 *
 * Reads regions from the GEO_REGIONS env var (or --regions flag) and writes
 * a BIND-compatible zone file with per-continent A/AAAA records, plus a
 * Cloudflare-style export and a Route 53 batch JSON for cross-provider use.
 *
 * Usage:
 *   node scripts/generate-geodns.mjs --domain=example.com [--out=zone.txt] [--ttl=300]
 *   GEO_REGIONS="us-east:38.13,-78.45:https://us-east.example.com,..." \
 *     node scripts/generate-geodns.mjs --domain=example.com
 *
 * Optional:
 *   --regions  Override GEO_REGIONS (same format)
 *   --format   bind | cloudflare | route53 | all  (default: all)
 *   --out      Output file path (defaults to stdout when omitted)
 *   --ttl      Record TTL in seconds (default 300)
 *
 * The script does not need network access; it just emits configuration that
 * you upload to your DNS provider. See docs/MULTI_REGION_HA.md for details.
 */

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// Load .env if dotenv is available (best-effort, does not fail on missing dep)
try {
  const dotenv = (await import("dotenv")).default;
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });
} catch { /* optional */ }

// Use the same parser the runtime uses so configs stay in sync
const { parseRegionsConfig } = await import("../lib/geo-routing.js");

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function continentFromCoords(lat, lon) {
  // Very rough heuristic so the script can label regions when no MaxMind
  // database is available. Override at the DNS provider level if needed.
  if (lat >= 15 && lat <= 80 && lon >= -170 && lon <= -50) return "NA"; // North America
  if (lat >= -60 && lat <= 15 && lon >= -90 && lon <= -30) return "SA"; // South America
  if (lat >= 35 && lat <= 75 && lon >= -25 && lon <= 45) return "EU"; // Europe
  if (lat >= -40 && lat <= 38 && lon >= -20 && lon <= 55) return "AF"; // Africa
  if (lat >= 5 && lat <= 80 && lon >= 25 && lon <= 180) return "AS"; // Asia
  if (lat >= -50 && lat <= 0 && lon >= 110 && lon <= 180) return "OC"; // Oceania
  return "DEFAULT";
}

function hostnameFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function emitBindZone(domain, regions, ttl) {
  const lines = [];
  const serial = Math.floor(Date.now() / 1000);
  lines.push(`$ORIGIN ${domain}.`);
  lines.push(`$TTL ${ttl}`);
  lines.push("");
  lines.push(`@ IN SOA ns1.${domain}. hostmaster.${domain}. (`);
  lines.push(`    ${serial} ; serial`);
  lines.push(`    7200       ; refresh`);
  lines.push(`    3600       ; retry`);
  lines.push(`    1209600    ; expire`);
  lines.push(`    300 )      ; minimum`);
  lines.push("");
  lines.push(`@ IN NS ns1.${domain}.`);
  lines.push(`@ IN NS ns2.${domain}.`);
  lines.push("");
  lines.push("; --- Per-region records ---");
  for (const r of regions) {
    const host = hostnameFromUrl(r.url) || `${r.regionId}.${domain}`;
    lines.push(`; ${r.regionId} (${r.latitude},${r.longitude}) -> ${host}`);
    lines.push(`${r.regionId} IN CNAME ${host}.`);
  }
  lines.push("");
  lines.push("; --- Continent-routed views (use a geo-aware DNS server) ---");
  for (const r of regions) {
    const cont = continentFromCoords(r.latitude, r.longitude);
    const host = hostnameFromUrl(r.url) || `${r.regionId}.${domain}`;
    lines.push(`; view=${cont} -> ${r.regionId} (${host})`);
    lines.push(`api.${cont.toLowerCase()} IN CNAME ${host}.`);
  }
  lines.push("");
  return lines.join("\n");
}

function emitCloudflare(domain, regions, ttl) {
  // Cloudflare supports geo-steering via Load Balancers; here we emit a
  // simple JSON of pools that an operator can paste into the API or Terraform.
  const pools = regions.map((r) => ({
    name: `pool-${r.regionId}`,
    description: `${r.regionId} region`,
    enabled: true,
    monitor_region: continentFromCoords(r.latitude, r.longitude),
    origins: [
      {
        name: r.regionId,
        address: hostnameFromUrl(r.url) || `${r.regionId}.${domain}`,
        enabled: true,
        weight: 1,
        latitude: r.latitude,
        longitude: r.longitude,
      },
    ],
  }));
  const loadBalancer = {
    name: `api.${domain}`,
    fallback_pool: pools[0]?.name || null,
    default_pools: pools.map((p) => p.name),
    region_pools: regions.reduce((acc, r) => {
      const cont = continentFromCoords(r.latitude, r.longitude);
      acc[cont] = acc[cont] || [];
      acc[cont].push(`pool-${r.regionId}`);
      return acc;
    }, {}),
    proxied: true,
    steering_policy: "geo",
    ttl,
  };
  return JSON.stringify({ pools, load_balancer: loadBalancer }, null, 2);
}

function emitRoute53(domain, regions, ttl) {
  // AWS Route 53 ChangeBatch — geo-location routing policy.
  const changes = [];
  for (const r of regions) {
    const host = hostnameFromUrl(r.url) || `${r.regionId}.${domain}`;
    const cont = continentFromCoords(r.latitude, r.longitude);
    changes.push({
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: `api.${domain}.`,
        Type: "CNAME",
        SetIdentifier: r.regionId,
        GeoLocation: cont === "DEFAULT" ? { CountryCode: "*" } : { ContinentCode: cont },
        TTL: ttl,
        ResourceRecords: [{ Value: host }],
      },
    });
  }
  // Default catch-all to first region
  if (regions[0]) {
    const host = hostnameFromUrl(regions[0].url) || `${regions[0].regionId}.${domain}`;
    changes.push({
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: `api.${domain}.`,
        Type: "CNAME",
        SetIdentifier: "default",
        GeoLocation: { CountryCode: "*" },
        TTL: ttl,
        ResourceRecords: [{ Value: host }],
      },
    });
  }
  return JSON.stringify({ Comment: `Geo-routing for ${domain}`, Changes: changes }, null, 2);
}

export function generateGeoDns({ domain, regions, ttl = 300, format = "all" }) {
  if (!domain) throw new Error("domain is required");
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new Error("at least one region is required");
  }
  const out = {};
  if (format === "bind" || format === "all") out.bind = emitBindZone(domain, regions, ttl);
  if (format === "cloudflare" || format === "all") out.cloudflare = emitCloudflare(domain, regions, ttl);
  if (format === "route53" || format === "all") out.route53 = emitRoute53(domain, regions, ttl);
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    process.stdout.write(`Usage: generate-geodns.mjs --domain=example.com [--out=zone.txt] [--ttl=300] [--format=bind|cloudflare|route53|all]\n`);
    return;
  }
  const domain = args.domain;
  if (!domain) {
    process.stderr.write("Error: --domain is required\n");
    process.exit(1);
  }
  const ttl = parseInt(args.ttl, 10) || 300;
  const format = args.format || "all";
  const regions = parseRegionsConfig(args.regions);
  if (regions.length === 0) {
    process.stderr.write("Error: no regions found. Set GEO_REGIONS env var or pass --regions=...\n");
    process.exit(1);
  }
  const out = generateGeoDns({ domain, regions, ttl, format });

  if (args.out) {
    if (format === "all") {
      // Write three sibling files
      writeFileSync(`${args.out}.zone`, out.bind || "");
      writeFileSync(`${args.out}.cloudflare.json`, out.cloudflare || "");
      writeFileSync(`${args.out}.route53.json`, out.route53 || "");
      process.stderr.write(`Wrote ${args.out}.zone, ${args.out}.cloudflare.json, ${args.out}.route53.json\n`);
    } else {
      writeFileSync(args.out, out[format] || "");
      process.stderr.write(`Wrote ${args.out}\n`);
    }
  } else {
    if (format === "all") {
      process.stdout.write("; ===== BIND zone =====\n");
      process.stdout.write((out.bind || "") + "\n\n");
      process.stdout.write("// ===== Cloudflare =====\n");
      process.stdout.write((out.cloudflare || "") + "\n\n");
      process.stdout.write("// ===== Route 53 =====\n");
      process.stdout.write((out.route53 || "") + "\n");
    } else {
      process.stdout.write((out[format] || "") + "\n");
    }
  }
}

// Only run main when invoked directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
