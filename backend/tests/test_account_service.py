import unittest
from unittest import mock

from app.services import account_service


class _Query:
    def __init__(self, client, table):
        self.client = client
        self.table = table

    def delete(self):
        return self

    def eq(self, column, value):
        self.client.deletes.append((self.table, column, value))
        return self

    def execute(self):
        if self.table in self.client.missing:
            raise RuntimeError(f"relation public.{self.table} does not exist")
        return mock.Mock(data=[])


class _FakeSupabase:
    def __init__(self, missing=()):
        self.deletes = []
        self.missing = set(missing)
        self.auth = mock.Mock()

    def table(self, name):
        return _Query(self, name)


class DeleteAccountTests(unittest.TestCase):
    def test_removes_every_user_table_then_the_auth_user(self):
        fake = _FakeSupabase()
        with mock.patch.object(account_service, "supabase", fake):
            result = account_service.delete_account("user-1")

        self.assertTrue(result["deleted"])
        self.assertEqual([t for t, _, _ in fake.deletes], list(account_service.USER_TABLES))
        self.assertTrue(all(col == "user_id" and val == "user-1" for _, col, val in fake.deletes))
        fake.auth.admin.delete_user.assert_called_once_with("user-1")

    def test_children_are_deleted_before_their_parents(self):
        order = list(account_service.USER_TABLES)
        self.assertLess(order.index("alert_events"), order.index("user_alerts"))
        self.assertLess(order.index("strategy_signals"), order.index("user_strategies"))
        self.assertLess(order.index("ask_ai_messages"), order.index("ask_ai_conversations"))

    def test_a_missing_table_does_not_stop_the_delete(self):
        fake = _FakeSupabase(missing={"daily_update_subscriptions"})
        with mock.patch.object(account_service, "supabase", fake):
            result = account_service.delete_account("user-1")

        self.assertEqual(result["skipped_tables"], ["daily_update_subscriptions"])
        fake.auth.admin.delete_user.assert_called_once_with("user-1")

    def test_requires_a_user_id(self):
        with mock.patch.object(account_service, "supabase", _FakeSupabase()):
            with self.assertRaises(ValueError):
                account_service.delete_account("")


if __name__ == "__main__":
    unittest.main()
