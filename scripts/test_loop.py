"""Tests for the pure selection logic in loop.py (synthetic issues, no network)."""

import unittest

from loop import pick_next


def issue(number, milestone=None, *labels):
    return {
        "number": number,
        "title": f"Issue {number}",
        "labels": [{"name": name} for name in labels],
        "milestone": {"title": milestone, "number": 1} if milestone else None,
    }


class PickNextTest(unittest.TestCase):
    def test_resumes_the_issue_in_progress(self):
        issues = [issue(3, "M0 Foundation", "status: ready"), issue(7, "M1 Core", "status: in progress")]
        self.assertEqual(pick_next(issues), ("resume", [issues[1]]))

    def test_takes_lowest_number_in_earliest_milestone(self):
        issues = [issue(2, "M1 Core"), issue(9, "M0 Foundation"), issue(5, "M0 Foundation")]
        action, picked = pick_next(issues)
        self.assertEqual((action, picked[0]["number"]), ("start", 5))

    def test_milestones_sort_by_number_not_text(self):
        issues = [issue(1, "M10 Later"), issue(2, "M2 Capture")]
        self.assertEqual(pick_next(issues)[1][0]["number"], 2)

    def test_skips_blocked_issues(self):
        issues = [issue(4, "M0 Foundation", "status: blocked"), issue(6, "M0 Foundation")]
        self.assertEqual(pick_next(issues)[1][0]["number"], 6)

    def test_stops_at_a_checkpoint(self):
        issues = [issue(8, "M2 Capture", "type: checkpoint", "status: blocked"), issue(9, "M3 Agent kit")]
        self.assertEqual(pick_next(issues), ("checkpoint", [issues[0]]))

    def test_does_not_skip_past_an_earlier_checkpoint(self):
        issues = [issue(5, "M2 Capture"), issue(8, "M2 Capture", "type: checkpoint", "status: blocked")]
        self.assertEqual(pick_next(issues)[1][0]["number"], 5)

    def test_all_blocked_stops(self):
        issues = [issue(4, "M0 Foundation", "status: blocked"), issue(5, "M1 Core")]
        self.assertEqual(pick_next(issues), ("blocked", [issues[0]]))

    def test_ignores_issues_without_milestone(self):
        self.assertEqual(pick_next([issue(1)]), ("empty", []))


if __name__ == "__main__":
    unittest.main()
