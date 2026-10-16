# Dean and Event Manager Research Test Report

**Date:** 2026-10-13  
**Scope:** Research workflows available to the Dean and Event Manager.  
**Code changes:** None. This report is the only file added for this investigation.

## Summary

No confirmed functional defect in the active Dean or Event Manager Research workflows was found in the tests that passed. The backend Research suite is currently red because six existing tests expect removed or outdated behavior; details are below. Frontend unit tests and the production build pass.

| Check | Result |
|---|---|
| Backend Research API suites (`test_research`, `test_research_tools`, `test_research_showcases`) | 79 tests run; 73 passed, 6 failed |
| Frontend unit tests | 140 passed across 13 files |
| Frontend production build | Passed |
| Frontend lint | Passed with warnings; none were errors |
| Browser end-to-end testing | Not run; the available Playwright spec covers Super Admin Settings, not Research |

## Workflows exercised by the passing backend tests

- Event Manager record creation for a teacher, draft editing, submission/recording without Dean approval, duplicate detection, evidence validation and configured evidence limits.
- Dean visibility of Event Manager records, category/date/search filtering, direct record details and protection against applying verification decisions to Event Manager records.
- Event Manager bulk record and delete permissions, including selection/eligibility rules.
- Dean and Event Manager showcase visibility, PDF generation and role restrictions.
- Research outcome reminders, DOI lookup and category behavior.

The backend tests use the repository's test harness and isolated test configuration; they do not use the application's configured production database.

## Test failures and their status

These failures reflect stale test expectations rather than confirmed failures in the active workflows:

1. `ResearchTest.test_malformed_details_are_refused` expects a patent `office` value of `"Moon"` to return HTTP 400. `office` is no longer a field in the current Patent category schema, so unknown legacy detail keys are discarded and the record is saved as a draft. Update or retire this test to match the current category schema if that behavior is intentional.
2. `ResearchTest.test_the_deans_overview_and_date_filter_cover_the_event_managers_submissions` passes its overview, category-count and date-filter assertions, then fails on its final request to `/dean/research/export.xlsx`. The Dean register-export endpoint was deliberately removed.
3. `ToolsTest.test_analytics_count_verified_unless_asked` expects the removed Dean Research Analytics endpoint to return 200; it now returns 404 as expected after Analytics was removed.
4. `ToolsTest.test_import_previews_then_creates_drafts` expects the removed Event Manager Excel-import template route to exist; it now returns 404.
5. `ToolsTest.test_import_refuses_what_is_not_a_template` expects the removed Event Manager Excel-import preview route to exist; it now returns 404.
6. `ToolsTest.test_register_export_respects_who_is_asking` expects the removed Dean register-export route to return an Excel file; it now returns 404.

The five removed-feature expectations should be removed or revised in the backend tests so future CI results reflect the requested product behavior.

## Frontend quality notes

`npm.cmd run test:unit` passed all 140 tests. `npm.cmd run build` completed successfully. `npm.cmd run lint` exited successfully with existing warnings, including `react(set-state-in-effect)` in the Dean and Event Manager Research pages and Event Manager Research Details page. These warnings were not observed as functional failures during the backend and unit checks.

## Coverage limitation

No signed-in browser test was performed for either role. No browser sessions were available in the current environment. The repository has no Research Playwright spec, and the available E2E spec is for Super Admin Settings. Live visual behavior, browser downloads, and click-through interaction still need a dedicated isolated Dean/Event Manager E2E setup.

## Continuation checks

The frontend checks were rerun during continuation of this audit:

- `npm.cmd run test:unit`: passed, 140 tests across 13 files.
- `npm.cmd run build`: passed.
- `npm.cmd run lint`: exited successfully with warnings; no lint errors.

The backend Research suites could not be rerun in this continuation. The `python` command was blocked by Windows, and the `py` launcher returned `Access is denied` when trying to start Python 3.13. The backend test results above are from the existing audit run recorded before this continuation. The application and backend test files were not changed.
