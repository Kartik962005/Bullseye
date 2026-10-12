from __future__ import annotations

import logging
from typing import Any

from app.core.supabase_client import supabase


logger = logging.getLogger(__name__)

# Every table that holds rows tied to a signed-in user, children before parents.
# Most of these cascade when the auth user goes, but deleting them explicitly
# keeps the result the same on a database where a cascade was never added.
USER_TABLES = (
    "alert_events",
    "user_alerts",
    "strategy_signals",
    "user_strategies",
    "ask_ai_messages",
    "ask_ai_conversations",
    "email_logs",
    "audit_logs",
    "notification_preferences",
    "daily_update_subscriptions",
)


def delete_account(user_id: str) -> dict[str, Any]:
    """Remove everything stored for one user, then the sign-in account itself."""
    if not supabase:
        raise ValueError("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
    if not user_id:
        raise ValueError("Your login session could not be verified.")

    skipped: list[str] = []
    for table in USER_TABLES:
        try:
            supabase.table(table).delete().eq("user_id", user_id).execute()
        except Exception as exc:
            # A table that does not exist in this project has nothing to delete.
            logger.warning("Account delete skipped %s: %s", table, exc)
            skipped.append(table)

    supabase.auth.admin.delete_user(user_id)
    return {"deleted": True, "skipped_tables": skipped}
