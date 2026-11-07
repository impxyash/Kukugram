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
const appPassword = randomUUID() + randomUUID();
const resolverPassword = randomUUID() + randomUUID();
const resolverFunction = "moderation.resolve_audit_actor_ref(uuid,character varying)";
const actorMapTable = "moderation.audit_actor_identity_map";

integration("PostgreSQL audit resolver role isolation", () => {
  let admin: Client | undefined;
  let isolatedPool: Pool | undefined;
  let appClient: Client | undefined;
  let resolverClient: Client | undefined;

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
      await appClient?.end();
      await resolverClient?.end();
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
    "confirms migration 0007 defaults and enforces separate non-superuser principals",
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

      await database().query(`CREATE ROLE "${appRole}" LOGIN PASSWORD '${appPassword}'`);
      await database().query(`CREATE ROLE "${resolverRole}" LOGIN PASSWORD '${resolverPassword}'`);
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

      const appUrl = new URL(databaseUrl!);
      appUrl.pathname = `/${databaseName}`;
      appUrl.username = appRole;
      appUrl.password = appPassword;
      appClient = new Client({ connectionString: appUrl.toString() });
      await appClient.connect();

      const resolverUrl = new URL(databaseUrl!);
      resolverUrl.pathname = `/${databaseName}`;
      resolverUrl.username = resolverRole;
      resolverUrl.password = resolverPassword;
      resolverClient = new Client({ connectionString: resolverUrl.toString() });
      await resolverClient.connect();

      const appPrivileges = await appClient.query<{
        currentRole: string;
        isSuperuser: boolean;
        canExecute: boolean;
        canReadMap: boolean;
        canInsertMap: boolean;
      }>(
        `SELECT
           current_user AS "currentRole",
           rolsuper AS "isSuperuser",
           has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS "canExecute",
           has_table_privilege(current_user, $2, 'SELECT') AS "canReadMap",
           has_table_privilege(current_user, $2, 'INSERT') AS "canInsertMap"
         FROM pg_roles WHERE rolname = current_user`,
        [resolverFunction, actorMapTable]
      );
      const resolverPrivileges = await resolverClient.query<{
        currentRole: string;
        isSuperuser: boolean;
        canExecute: boolean;
        canReadMap: boolean;
        canInsertMap: boolean;
      }>(
        `SELECT
           current_user AS "currentRole",
           rolsuper AS "isSuperuser",
           has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS "canExecute",
           has_table_privilege(current_user, $2, 'SELECT') AS "canReadMap",
           has_table_privilege(current_user, $2, 'INSERT') AS "canInsertMap"
         FROM pg_roles WHERE rolname = current_user`,
        [resolverFunction, actorMapTable]
      );

      expect(appPrivileges.rows[0]).toEqual({
        currentRole: appRole,
        isSuperuser: false,
        canExecute: false,
        canReadMap: false,
        canInsertMap: false
      });
      expect(resolverPrivileges.rows[0]).toEqual({
        currentRole: resolverRole,
        isSuperuser: false,
        canExecute: true,
        canReadMap: false,
        canInsertMap: false
      });

      await expect(
        appClient.query(
          `SELECT moderation.resolve_audit_actor_ref($1, 'moderation.audit.role_test')`,
          [randomUUID()]
        )
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        appClient.query(`SELECT * FROM ${actorMapTable} LIMIT 1`)
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        resolverClient.query(`SELECT * FROM ${actorMapTable} LIMIT 1`)
      ).rejects.toMatchObject({ code: "42501" });

      const actorId = randomUUID();
      const result = await resolverClient.query<{ actorRef: string }>(
        `SELECT moderation.resolve_audit_actor_ref($1, 'moderation.audit.role_test') AS "actorRef"`,
        [actorId]
      );
      const resolvedReference = result.rows[0]?.actorRef;
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
