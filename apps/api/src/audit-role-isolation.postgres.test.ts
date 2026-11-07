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
const actorRefFunction = "moderation.resolve_audit_actor_ref(uuid,character varying)";
const actorIdentityFunction = "moderation.resolve_audit_actor_identity(uuid,character varying)";
const logTriggerFunction = "moderation.reject_audit_identity_resolution_log_mutation()";
const actorMapTable = "moderation.audit_actor_identity_map";
const resolutionLogTable = "moderation.audit_identity_resolution_log";

integration("PostgreSQL audit resolver role isolation", () => {
  let admin: Client | undefined;
  let isolatedPool: Pool | undefined;
  let appClient: Client | undefined;
  let resolverClient: Client | undefined;

  function database() {
    if (!isolatedPool) throw new Error("Isolated PostgreSQL fixture is not initialized.");
    return isolatedPool;
  }

  beforeAll(async () => {
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
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await resolverClient?.end();
    await isolatedPool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${appRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${resolverRole}"`);
      await admin.end();
    }
  }, 30_000);

  it("verifies audit ACL defaults, append-only logging and distinct non-superuser roles", async () => {
    const functionAcl = await database().query<{
      functionName: string;
      securityDefiner: boolean;
      functionConfig: string[] | null;
      publicExecute: boolean;
    }>(
      `SELECT
           p.oid::regprocedure::text AS "functionName",
           p.prosecdef AS "securityDefiner",
           p.proconfig AS "functionConfig",
           EXISTS (
             SELECT 1
             FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
             WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           ) AS "publicExecute"
         FROM pg_proc p
         WHERE p.oid IN ($1::regprocedure, $2::regprocedure, $3::regprocedure)`,
      [actorRefFunction, actorIdentityFunction, logTriggerFunction]
    );
    const actorRefAcl = functionAcl.rows.find((row) =>
      row.functionName.includes("resolve_audit_actor_ref")
    );
    const actorIdentityAcl = functionAcl.rows.find((row) =>
      row.functionName.includes("resolve_audit_actor_identity")
    );
    const triggerFunctionAcl = functionAcl.rows.find((row) =>
      row.functionName.includes("reject_audit_identity_resolution_log_mutation")
    );

    expect(actorRefAcl?.securityDefiner).toBe(true);
    expect(actorRefAcl?.functionConfig).toContain("search_path=pg_catalog, moderation");
    // Migration 0007 does not revoke PostgreSQL's default PUBLIC EXECUTE.
    expect(actorRefAcl?.publicExecute).toBe(true);
    expect(actorIdentityAcl?.securityDefiner).toBe(true);
    expect(actorIdentityAcl?.functionConfig).toContain("search_path=pg_catalog, moderation");
    expect(actorIdentityAcl?.publicExecute).toBe(false);
    expect(triggerFunctionAcl?.publicExecute).toBe(false);

    const logTableAcl = await database().query<{ publicPrivileges: string[] }>(
      `SELECT COALESCE(
           array_agg(DISTINCT acl.privilege_type ORDER BY acl.privilege_type)
             FILTER (WHERE acl.grantee = 0),
           ARRAY[]::text[]
         ) AS "publicPrivileges"
         FROM pg_class c
         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
         WHERE c.oid = $1::regclass`,
      [resolutionLogTable]
    );
    expect(logTableAcl.rows[0]?.publicPrivileges).toEqual([]);

    const actorId = randomUUID();
    const opaqueActorRef = randomUUID();
    await database().query(
      `INSERT INTO ${resolutionLogTable}
           (requester_user_id, actor_ref, purpose_scope, reason, outcome, request_id)
         VALUES ($1, $2, 'moderation.audit.acl_test', $3, 'resolved', $4)`,
      [
        randomUUID(),
        opaqueActorRef,
        "Documented test of immutable audit log behavior.",
        randomUUID()
      ]
    );
    await expect(
      database().query(
        `UPDATE ${resolutionLogTable} SET reason = 'tampered audit log entry' WHERE actor_ref = $1`,
        [opaqueActorRef]
      )
    ).rejects.toThrow("append-only");
    await expect(
      database().query(`DELETE FROM ${resolutionLogTable} WHERE actor_ref = $1`, [opaqueActorRef])
    ).rejects.toThrow("append-only");

    await database().query(`CREATE ROLE "${appRole}" LOGIN PASSWORD '${appPassword}'`);
    await database().query(`CREATE ROLE "${resolverRole}" LOGIN PASSWORD '${resolverPassword}'`);
    await database().query(`GRANT USAGE ON SCHEMA moderation TO "${appRole}", "${resolverRole}"`);
    await database().query(
      `REVOKE ALL PRIVILEGES ON TABLE ${actorMapTable}, ${resolutionLogTable} FROM PUBLIC, "${appRole}", "${resolverRole}"`
    );
    await database().query(
      `REVOKE EXECUTE ON FUNCTION ${actorRefFunction}, ${actorIdentityFunction} FROM PUBLIC`
    );
    await database().query(
      `GRANT EXECUTE ON FUNCTION ${actorRefFunction}, ${actorIdentityFunction} TO "${resolverRole}"`
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
      canResolveActorRef: boolean;
      canResolveActorIdentity: boolean;
      canReadActorMap: boolean;
      canReadResolutionLog: boolean;
    }>(
      `SELECT
           current_user AS "currentRole",
           rolsuper AS "isSuperuser",
           has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS "canResolveActorRef",
           has_function_privilege(current_user, $2::regprocedure, 'EXECUTE') AS "canResolveActorIdentity",
           has_table_privilege(current_user, $3, 'SELECT') AS "canReadActorMap",
           has_table_privilege(current_user, $4, 'SELECT') AS "canReadResolutionLog"
         FROM pg_roles WHERE rolname = current_user`,
      [actorRefFunction, actorIdentityFunction, actorMapTable, resolutionLogTable]
    );
    const resolverPrivileges = await resolverClient.query<{
      currentRole: string;
      isSuperuser: boolean;
      canResolveActorRef: boolean;
      canResolveActorIdentity: boolean;
      canReadActorMap: boolean;
      canReadResolutionLog: boolean;
    }>(
      `SELECT
           current_user AS "currentRole",
           rolsuper AS "isSuperuser",
           has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS "canResolveActorRef",
           has_function_privilege(current_user, $2::regprocedure, 'EXECUTE') AS "canResolveActorIdentity",
           has_table_privilege(current_user, $3, 'SELECT') AS "canReadActorMap",
           has_table_privilege(current_user, $4, 'SELECT') AS "canReadResolutionLog"
         FROM pg_roles WHERE rolname = current_user`,
      [actorRefFunction, actorIdentityFunction, actorMapTable, resolutionLogTable]
    );

    expect(appPrivileges.rows[0]).toEqual({
      currentRole: appRole,
      isSuperuser: false,
      canResolveActorRef: false,
      canResolveActorIdentity: false,
      canReadActorMap: false,
      canReadResolutionLog: false
    });
    expect(resolverPrivileges.rows[0]).toEqual({
      currentRole: resolverRole,
      isSuperuser: false,
      canResolveActorRef: true,
      canResolveActorIdentity: true,
      canReadActorMap: false,
      canReadResolutionLog: false
    });

    await expect(
      appClient.query(
        `SELECT moderation.resolve_audit_actor_ref($1, 'moderation.audit.role_test')`,
        [actorId]
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(appClient.query(`SELECT * FROM ${actorMapTable} LIMIT 1`)).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      resolverClient.query(`SELECT * FROM ${actorMapTable} LIMIT 1`)
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      resolverClient.query(`SELECT * FROM ${resolutionLogTable} LIMIT 1`)
    ).rejects.toMatchObject({ code: "42501" });

    const actorReference = await resolverClient.query<{ actorRef: string }>(
      `SELECT moderation.resolve_audit_actor_ref($1, 'moderation.audit.role_test') AS "actorRef"`,
      [actorId]
    );
    const resolvedReference = actorReference.rows[0]?.actorRef;
    expect(resolvedReference).toEqual(expect.any(String));

    const resolvedIdentity = await resolverClient.query<{ userId: string }>(
      `SELECT moderation.resolve_audit_actor_identity($1, 'moderation.audit.role_test') AS "userId"`,
      [resolvedReference]
    );
    expect(resolvedIdentity.rows[0]?.userId).toBe(actorId);
  }, 30_000);
});
