/**
 * Phase 39.5: Redshift adapter for the data warehouse exporter.
 *
 * Redshift bulk loads use COPY FROM an S3 staging location. This adapter
 * writes batches as JSONL to a configured S3 bucket and issues COPY via the
 * Redshift Data API (so no native pg client is required). The Redshift
 * Data API is part of the existing AWS SDK installation chain.
 *
 * connect(config)
 *   config: {
 *     clusterIdentifier?, workgroupName?, // serverless or provisioned
 *     database, dbUser?, secretArn?,
 *     stagingBucket, stagingPrefix?,
 *     iamRoleArn,
 *     region?
 *   }
 */

import { buildCreateTableSQL } from "../warehouse-schemas.js";

async function loadRedshiftDataSdk() {
  try {
    return await import("@aws-sdk/client-redshift-data");
  } catch (e) {
    throw new Error(`redshift adapter: @aws-sdk/client-redshift-data not available: ${e.message}`, { cause: e });
  }
}

async function loadS3Sdk() {
  try {
    return await import("@aws-sdk/client-s3");
  } catch (e) {
    throw new Error(`redshift adapter: @aws-sdk/client-s3 not available: ${e.message}`, { cause: e });
  }
}

export async function connect(config = {}) {
  if (!config.database) throw new Error("redshift: database required");
  if (!config.stagingBucket) throw new Error("redshift: stagingBucket required");
  if (!config.iamRoleArn) throw new Error("redshift: iamRoleArn required");
  if (!config.clusterIdentifier && !config.workgroupName) {
    throw new Error("redshift: clusterIdentifier or workgroupName required");
  }

  const region = config.region || process.env.AWS_REGION || "us-east-1";
  let dataClient;
  let s3Client;
  let ExecuteStatementCommand;
  let PutObjectCommand;

  if (config.dataClient && config.s3Client) {
    // Test injection
    dataClient = config.dataClient;
    s3Client = config.s3Client;
    ExecuteStatementCommand = config.ExecuteStatementCommand || class {};
    PutObjectCommand = config.PutObjectCommand || class {};
  } else {
    const dataMod = await loadRedshiftDataSdk();
    const s3Mod = await loadS3Sdk();
    dataClient = new dataMod.RedshiftDataClient({ region });
    s3Client = new s3Mod.S3Client({ region });
    ExecuteStatementCommand = dataMod.ExecuteStatementCommand;
    PutObjectCommand = s3Mod.PutObjectCommand;
  }

  async function executeSql(sql) {
    const cmd = new ExecuteStatementCommand({
      Database: config.database,
      Sql: sql,
      ClusterIdentifier: config.clusterIdentifier,
      WorkgroupName: config.workgroupName,
      DbUser: config.dbUser,
      SecretArn: config.secretArn,
    });
    return dataClient.send(cmd);
  }

  const stagingPrefix = (config.stagingPrefix || "siskelbot-warehouse/").replace(/\/?$/, "/");

  return {
    destination: "redshift",
    config,
    async createTable(tableName, schema) {
      const sql = buildCreateTableSQL("redshift", tableName, schema);
      await executeSql(sql);
    },
    async insertBatch(tableName, rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      // Stage NDJSON to S3.
      const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const key = `${stagingPrefix}${tableName}/${ts}-${rows.length}.json`;
      await s3Client.send(
        new PutObjectCommand({
          Bucket: config.stagingBucket,
          Key: key,
          Body: ndjson,
          ContentType: "application/x-ndjson",
        })
      );
      // COPY FROM the staged file.
      const sql = `COPY ${tableName} FROM 's3://${config.stagingBucket}/${key}' IAM_ROLE '${config.iamRoleArn}' FORMAT AS JSON 'auto'`;
      await executeSql(sql);
    },
    async close() {
      try {
        if (typeof dataClient.destroy === "function") dataClient.destroy();
        if (typeof s3Client.destroy === "function") s3Client.destroy();
      } catch {
        // best-effort
      }
    },
    _executeSql: executeSql,
  };
}
