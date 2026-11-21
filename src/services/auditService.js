import { query } from '../config/db.js';

/**
 * Append-only audit trail. Never throws into the caller's path: a failed audit
 * insert must not turn a successful business action into an error, but it must
 * be visible in logs.
 */
export async function audit(entry) {
  const {
    client = null,
    actorUserId = null,
    actorRole = null,
    action,
    entityType,
    entityId = null,
    oldValues = null,
    newValues = null,
    reason = null,
    ip = null,
    userAgent = null,
  } = entry;

  // Inside a business transaction the audit row must join that transaction,
  // otherwise a rollback leaves an audit entry for something that never happened.
  const runner = client ? client.query.bind(client) : query;

  try {
    // Inside a transaction a failed INSERT aborts the WHOLE transaction (Postgres marks it
    // 'current transaction is aborted'), so the caller's COMMIT would silently write nothing while
    // the API still answered 200. A savepoint keeps the business write alive if only the audit
    // insert fails.
    if (client) await client.query('SAVEPOINT audit_sp');
    await runner(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, entity_type, entity_id,
         old_values, new_values, reason, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        actorUserId,
        actorRole,
        action,
        entityType,
        entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        reason,
        ip,
        userAgent ? String(userAgent).slice(0, 400) : null,
      ],
    );
    if (client) await client.query('RELEASE SAVEPOINT audit_sp');
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT audit_sp');
      } catch (rollbackError) {
        // the transaction was already aborted by something else; nothing more we can do here
        console.error('[audit] could not roll back to the audit savepoint', rollbackError.message);
      }
    }
    console.error('[audit] failed to write audit entry', { action, entityType, entityId, error });
  }
}

export default audit;
