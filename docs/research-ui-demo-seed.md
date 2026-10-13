# Research UI sample data

These scripts populate the current Event Manager and Dean Research pages with
clearly marked sample records. They use the app's MongoDB configuration and
the active research category schema.

The seed creates 125 records by default (25 per active category): Journal,
Conference, Patent, Book / Book Chapter, and Other Achievement. The records
are marked with a private `seed_batch` and `seed_generated_by` field, and the
visible title starts with `[RESEARCH UI SAMPLE]`. Existing teachers and an
Event Manager are referenced; user accounts and genuine research records are
not changed. All sample records are recorded by the Event Manager, so they
appear in the Event Manager list and the Dean's Event Manager submissions
view without entering an approval workflow. The records do not include
evidence files.

## Seed

From the `backend` directory, with the intended database configured in
`backend/.env`:

```powershell
python scripts/seed_research_ui_demo.py status
python scripts/seed_research_ui_demo.py seed
```

The script shows the sanitized server host and database name. It asks you to
type that exact database name before inserting. You can choose a count from
100 to 500:

```powershell
python scripts/seed_research_ui_demo.py seed --count 150
```

Writes to a target whose name/host does not look like local, test, dev, demo,
sandbox, or local require an explicit opt-in and exact database confirmation:

```powershell
python scripts/seed_research_ui_demo.py seed --allow-non-test-db --confirm-db <exact-database-name>
```

Use that option only when you intentionally want the sample records in that
shared database. Re-running seed while this batch exists is refused to avoid
duplicate sample rows.

## Cleanup

First run a dry run to see how many marked records would be removed:

```powershell
python scripts/cleanup_research_ui_demo.py
```

Then delete only this script's marked records (and any evidence files attached
to them):

```powershell
python scripts/cleanup_research_ui_demo.py --yes
```

Cleanup asks for the exact database name. For an intentionally selected
non-test database, use both explicit flags:

```powershell
python scripts/cleanup_research_ui_demo.py --yes --allow-non-test-db --confirm-db <exact-database-name>
```

The deletion query must match the batch marker, script marker, and sample
title prefix; it does not delete users, notifications, showcases, audit
entries, or unmarked research records.
