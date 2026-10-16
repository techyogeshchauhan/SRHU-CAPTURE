"""Research Showcases: curated, presented to the Dean."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from tests.test_research import DEAN_ID, OTHER_TEACHER_ID, SECOND_DEAN_ID, FakeCollection, ResearchFixture


class ShowcaseTest(ResearchFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.showcases = FakeCollection()
        patcher = patch("app.routers.research_showcases.research_showcases", self.showcases)
        patcher.start()
        self.addCleanup(patcher.stop)

    def verified(self, who="manager", **overrides):
        return self.accepted(who, **overrides)

    def new_showcase(self, who="manager", title="Annual Research Highlights 2025-26"):
        return self.call("POST", "/research/showcases", who, 201,
                         json={"title": title, "description": "Two national grants this year."})["showcase"]

    def test_a_showcase_holds_verified_records_only(self):
        verified = self.verified()
        pending = self.submitted()
        showcase = self.new_showcase()
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "manager", 400,
                  json={"record_ids": [verified["id"], pending["id"]]})
        saved = self.call("PATCH", f"/research/showcases/{showcase['id']}", "manager",
                          json={"record_ids": [verified["id"]], "highlight_ids": [verified["id"], pending["id"]]})["showcase"]
        self.assertEqual([r["id"] for r in saved["records"]], [verified["id"]])
        # A highlight is always one of the showcase's own records.
        self.assertEqual(saved["highlight_ids"], [verified["id"]])

    def test_new_showcases_cannot_add_retired_category_records(self):
        legacy = self.verified(title="Legacy project record")
        self.records.docs[0]["category"] = "project"
        showcase = self.new_showcase()
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "manager", 400,
                  json={"record_ids": [legacy["id"]]})

    def test_a_teacher_presents_only_their_own_work(self):
        theirs = self.verified(faculty_id=str(OTHER_TEACHER_ID), title="Arjun's patent on sterilising cabinets")
        mine = self.verified()
        showcase = self.new_showcase("teacher", "My research")
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "teacher", 400, json={"record_ids": [theirs["id"]]})
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "teacher", json={"record_ids": [mine["id"]]})
        # The Event Manager can open (and help with) any showcase; another teacher cannot.
        self.call("GET", f"/research/showcases/{showcase['id']}", "manager")
        self.call("GET", f"/research/showcases/{showcase['id']}", "other-teacher", 404)

    def test_sending_reaches_every_dean_and_drafts_stay_private(self):
        showcase = self.new_showcase()
        self.call("POST", f"/research/showcases/{showcase['id']}/send", "manager", 400)  # empty
        self.assertEqual(self.call("GET", "/dean/research/showcases", "dean")["showcases"], [])
        self.call("GET", f"/dean/research/showcases/{showcase['id']}", "dean", 404)

        record = self.verified()
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "manager", json={"record_ids": [record["id"]]})
        self.call("POST", f"/research/showcases/{showcase['id']}/send", "manager")
        self.assertEqual(len(self.notes_for(DEAN_ID, "research_showcase")), 1)
        self.assertEqual(len(self.notes_for(SECOND_DEAN_ID, "research_showcase")), 1)

        inbox = self.call("GET", "/dean/research/showcases", "dean")
        self.assertEqual(inbox["unviewed"], 1)
        opened = self.call("GET", f"/dean/research/showcases/{showcase['id']}", "dean")["showcase"]
        self.assertEqual(opened["stats"]["total"], 1)
        self.assertEqual(self.call("GET", "/dean/research/showcases", "dean")["unviewed"], 0)

    def test_a_withdrawn_verification_drops_out_of_the_deans_view(self):
        keep = self.verified()
        drop = self.verified("teacher")
        showcase = self.new_showcase()
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "manager", json={"record_ids": [keep["id"], drop["id"]]})
        self.call("POST", f"/research/showcases/{showcase['id']}/send", "manager")
        self.call("PATCH", f"/dean/research/records/{drop['id']}/unverify", "dean", json={"remarks": "Wrong grant number."})

        opened = self.call("GET", f"/dean/research/showcases/{showcase['id']}", "dean")["showcase"]
        self.assertEqual([r["id"] for r in opened["records"]], [keep["id"]])
        self.assertEqual(opened["withdrawn_count"], 1)
        # The author still sees it, flagged, and can reorder without tripping over it.
        mine = self.call("GET", f"/research/showcases/{showcase['id']}", "manager")["showcase"]
        self.assertEqual(len(mine["records"]), 2)
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "manager", json={"record_ids": [drop["id"], keep["id"]]})

    def test_showcase_pdf(self):
        record = self.verified()
        showcase = self.new_showcase()
        self.call("PATCH", f"/research/showcases/{showcase['id']}", "manager",
                  json={"record_ids": [record["id"]], "highlight_ids": [record["id"]]})
        response = self.client.get(f"/research/showcases/{showcase['id']}/pdf", headers={"Authorization": "Bearer manager"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.content.startswith(b"%PDF"))
        self.call("POST", f"/research/showcases/{showcase['id']}/send", "manager")
        response = self.client.get(f"/dean/research/showcases/{showcase['id']}/pdf", headers={"Authorization": "Bearer dean"})
        self.assertEqual(response.status_code, 200)

    def test_deleting(self):
        showcase = self.new_showcase()
        self.call("DELETE", f"/research/showcases/{showcase['id']}", "teacher", 404)
        self.call("DELETE", f"/research/showcases/{showcase['id']}", "manager")
        self.assertEqual(self.showcases.docs, [])


if __name__ == "__main__":
    unittest.main()
