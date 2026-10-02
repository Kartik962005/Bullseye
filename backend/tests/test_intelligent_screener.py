import unittest

from app.services.intelligent_screener_service import (
    SqlValidationError,
    _execute,
    _parse_plan,
    validate_sql,
)
from app.services.stock_snapshot_service import _with_derived_fields

ROWS = [
    {"symbol": "HDFCBANK", "name": "HDFC Bank Limited", "sector": "Financial Services", "market_cap_cr": 1100000.0, "dividend_yield": 1.2, "ret_1y": -22.0},
    {"symbol": "SBIN", "name": "State Bank of India", "sector": "Financial Services", "market_cap_cr": 880000.0, "dividend_yield": None, "ret_1y": 11.0},
    {"symbol": "TCS", "name": "Tata Consultancy Services", "sector": "Technology", "market_cap_cr": None, "dividend_yield": 3.1, "ret_1y": -35.0},
]


def run(sql):
    return _execute(validate_sql(sql), ROWS)


class SandboxTests(unittest.TestCase):
    def test_rejects_writes_and_other_tables(self):
        for sql in [
            "DROP TABLE stock_snapshot",
            "DELETE FROM stock_snapshot",
            "SELECT * FROM users",
            "SELECT symbol FROM stock_snapshot; DROP TABLE stock_snapshot",
            "SELECT pg_sleep(5) FROM stock_snapshot",
        ]:
            with self.subTest(sql=sql), self.assertRaises(SqlValidationError):
                validate_sql(sql)

    def test_text_matching_is_case_insensitive(self):
        _, rows = run("SELECT symbol FROM stock_snapshot WHERE name LIKE '%bank%'")
        self.assertEqual({r[0] for r in rows}, {"HDFCBANK", "SBIN"})
        _, rows = run("SELECT symbol FROM stock_snapshot WHERE name ILIKE '%STATE%'")
        self.assertEqual([r[0] for r in rows], ["SBIN"])

    def test_not_like_keeps_its_negation(self):
        _, rows = run("SELECT symbol FROM stock_snapshot WHERE name NOT LIKE '%BANK%'")
        self.assertEqual([r[0] for r in rows], ["TCS"])
        _, rows = run("SELECT symbol FROM stock_snapshot WHERE name NOT ILIKE '%tata%' AND sector = 'Financial Services'")
        self.assertEqual({r[0] for r in rows}, {"HDFCBANK", "SBIN"})

    def test_sorting_skips_blank_values_instead_of_crashing(self):
        # A NULL in the sort key used to crash the executor's Python sort and
        # sent "banking stocks" and similar searches to an empty fallback.
        _, rows = run("SELECT symbol FROM stock_snapshot ORDER BY dividend_yield DESC")
        self.assertEqual([r[0] for r in rows], ["TCS", "HDFCBANK"])
        _, rows = run("SELECT symbol, market_cap_cr / 100 AS cap FROM stock_snapshot ORDER BY cap DESC")
        self.assertEqual([r[0] for r in rows], ["HDFCBANK", "SBIN"])

    def test_grouped_sort_keeps_every_group(self):
        _, rows = run("SELECT sector, AVG(dividend_yield) AS y FROM stock_snapshot GROUP BY sector ORDER BY y DESC")
        self.assertEqual([r[0] for r in rows], ["Technology", "Financial Services"])

    def test_row_cap_is_enforced(self):
        self.assertIn("LIMIT 60", validate_sql("SELECT symbol FROM stock_snapshot").sql())
        self.assertIn("LIMIT 300", validate_sql("SELECT symbol FROM stock_snapshot LIMIT 5000").sql())


class PlanParsingTests(unittest.TestCase):
    def test_json_plan(self):
        plan = _parse_plan('```json\n{"kind":"screen","sql":"SELECT symbol FROM stock_snapshot;","summary":"x","caveat":null}\n```')
        self.assertEqual(plan["sql"], "SELECT symbol FROM stock_snapshot")
        self.assertEqual(plan["summary"], "x")

    def test_answer_plan(self):
        self.assertEqual(_parse_plan('{"kind":"answer","text":"Hi"}')["kind"], "answer")

    def test_bare_sql_still_accepted(self):
        self.assertEqual(_parse_plan("SELECT symbol FROM stock_snapshot")["sql"], "SELECT symbol FROM stock_snapshot")


class DerivedFieldTests(unittest.TestCase):
    def test_roe_is_filled_from_pb_over_pe(self):
        row = _with_derived_fields([{"trailing_pe": 20.0, "price_to_book": 3.0}])[0]
        self.assertAlmostEqual(row["roe"], 15.0)

    def test_reported_roe_is_kept(self):
        row = _with_derived_fields([{"roe": 12.0, "trailing_pe": 20.0, "price_to_book": 3.0}])[0]
        self.assertEqual(row["roe"], 12.0)

    def test_broken_or_one_off_earnings_are_set_aside(self):
        cases = [
            {"trailing_pe": 2.5, "forward_pe": 33.6, "price_to_book": 6.9},  # ZF CV
            {"trailing_pe": 9.0, "forward_pe": 40.0, "price_to_book": 2.0},  # one-off quarter
            {"trailing_pe": 6.5, "profit_margin": 3188.0, "price_to_book": 1.0, "sector": "Basic Materials"},
        ]
        for case in cases:
            with self.subTest(case=case):
                row = _with_derived_fields([case])[0]
                self.assertIsNone(row["trailing_pe"])
                self.assertEqual(row["trailing_pe_raw"], case["trailing_pe"])
                self.assertIsNone(row.get("roe"))

    def test_holding_company_margins_are_not_flagged(self):
        row = _with_derived_fields([{"trailing_pe": 13.4, "profit_margin": 734.0, "sector": "Financial Services"}])[0]
        self.assertEqual(row["trailing_pe"], 13.4)

    def test_market_cap_is_filled_from_enterprise_value(self):
        # TCS's snapshot row: no marketCap from Yahoo, but EV, debt and cash.
        row = _with_derived_fields([{"enterprise_value": 7.18e12, "total_debt": 1.13e11, "total_cash": 4.50e11}])[0]
        self.assertAlmostEqual(row["market_cap_cr"], 751700, delta=1)

    def test_reported_market_cap_is_kept(self):
        row = _with_derived_fields([{"market_cap_cr": 5.0, "enterprise_value": 9e12, "total_debt": 0, "total_cash": 0}])[0]
        self.assertEqual(row["market_cap_cr"], 5.0)

    def test_implausible_derived_roe_is_left_blank(self):
        row = _with_derived_fields([{"trailing_pe": 5.0, "price_to_book": 10.0}])[0]
        self.assertIsNone(row.get("roe"))


if __name__ == "__main__":
    unittest.main()
