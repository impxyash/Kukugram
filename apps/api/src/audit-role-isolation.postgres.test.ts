import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `kukugram_acl_${suffix}`;
const appRole = `kg_acl_app_${suffix}`;
const resolverRole = `kg_acl_resolver_${suffix}`;
const resolverFunction =
  "moderation.resolve_audit_actor_ref(uuid,character varying)";
const actorMapTable = "moderation.audit_actor_identity_map";

integration("PostgreSQL audit resolver role isolation", () => {
  let admin: Client | undefined;
  let isolatedPool: Pool | undefined;

  function database() {
    if (!isolatedPool) throw new Error("Isolated PostgreSQL fixture is not initialized.");
    return isolatedPool;
  }

  beforeAll(
    async () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for this integration test.");
      admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}"`);

      const isolatedUrl = new URL(databaseUrl);
      isolatedUrl.pathname = `/${databaseName}`;
      isolatedPool = new Pool({ connectionString: isolatedUrl.toString(), max: 4 });

      const migrationsFolder = fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url)
      );
      const migrations = (await readdir(migrationsFolder))
        .filter((filename) => filename.endsWith(".sql"))
        .sort();

      for (const filename of migrations) {
        await database().query(await readFile(join(migrationsFolder, filename), "utf8"));
      }
    },
    30_000
  );

  afterAll(
    async () => {
      await isolatedPool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS "${appRole}"`);
        await admin.query(`DROP ROLE IF EXISTS "${resolverRole}"`);
        await admin.end();
      }
    },
    30_000
  );

  it(
    "confirms migration 0007 defaults, then proves a least-privilege resolver split",
    async () => {
      const baseline = await database().query<{
        securityDefiner: boolean;
        functionConfig: string[] | null;
        publicExecute: boolean;
      }>(
        `SELECT
           p.prosecdef AS "securityDefiner",
           p.proconfig AS "functionConfig",
           EXISTS (
             SELECT 1
             FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           ) AS "publicExecute"
         FROM pg_proc p
         WHERE p.oid = $1::regprocedure`,
        [resolverFunction]
      );

      expect(baseline.rows).toHaveLength(1);
      expect(baseline.rows[0]?.securityDefiner).toBe(true);
      expect(baseline.rows[0]?.functionConfig).toContain("search_path=pg_catalog, moderation");
      // Migration 0007 creates a SECURITY DEFINER function but does not revoke
      // PostgreSQL's default PUBLIC EXECUTE privilege.
      expect(baseline.rows[0]?.publicExecute).toBe(true);

      await database().query(`CREATE ROLE "${appRole}" NOLOGIN`);
      await database().query(`CREATE ROLE "${resolverRole}" NOLOGIN`);
      await database().query(
        `GRANT USAGE ON SCHEMA moderation TO "${appRole}", "${resolverRole}"`
      );
      await database().query(
        `REVOKE ALL PRIVILEGES ON TABLE ${actorMapTable} FROM PUBLIC, "${appRole}", "${resolverRole}"`
      );
      await database().query(
        `REVOKE EXECUTE ON FUNCTION ${resolverFunction} FROM PUBLIC`
      );
      await database().query(
        `GRANT EXECUTE ON FUNCTION ${resolverFunction} TO "${resolverRole}"`
      );

      const privileges = await database().query<{
        appCanExecute: boolean;
        resolverCanExecute: boolean;
        appCanReadMap: boolean;
        resolverCanReadMap: boolean;
        appCanInsertMap: boolean;
        resolverCanInsertMap: boolean;
      }>(
        `SELECT
           has_function_privilege($1, $3::regprocedure, 'EXECUTE') AS "appCanExecute",
           has_function_privilege($2, $3::regprocedure, 'EXECUTE') AS "resolverCanExecute",
           has_table_privilege($1, $4, 'SELECT') AS "appCanReadMap",
           has_table_privilege($2, $4, 'SELECT') AS "resolverCanReadMap",
           has_table_privilege($1, $4, 'INSERT') AS "appCanInsertMap",
           has_table_privilege($2, $4, 'INSERT') AS "resolverCanInsertMap"`,
        [appRole, resolverRole, resolverFunction, actorMapTable]
      );

      expect(privileges.rows[0]).toEqual({
        appCanExecute: false,
        resolverCanExecute: true,
        appCanReadMap: false,
        resolverCanReadMap: false,
        appCanInsertMap: false,
        resolverCanInsertMap: false
      });

      await database().query(`SET ROLE "${appRole}"`);
      try {
        await expect(
          database().query(
            `SELECT moderation.resolve_audit_actor_ref($1, 'moderation.audit.role_test')`,
            [randomUUID()]
          )
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await database().query("RESET ROLE");
      }

      const actorId = randomUUID();
      await database().query(`SET ROLE "${resolverRole}"`);
      let resolvedReference: string | undefined;
      try {
        const result = await database().query<{ actorRef: string }>(
          `SELECT moderation.resolve_audit_actor_ref($1, 'moderation.audit.role_test') AS "actorRef"`,
          [actorId]
        );
        resolvedReference = result.rows[0]?.actorRef;
      } finally {
        await database().query("RESET ROLE");
      }

      expect(resolvedReference).toEqual(expect.any(String));
      const mapping = await database().query<{ actorRef: string }>(
        `SELECT actor_ref AS "actorRef"
         FROM ${actorMapTable}
         WHERE purpose_scope = 'moderation.audit.role_test' AND actor_user_id = $1`,
        [actorId]
      );
      expect(mapping.rows).toEqual([{ actorRef: resolvedReference }]);
    },
    30_000
  );
});
