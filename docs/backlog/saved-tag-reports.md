# Managing and building tag reports

## What it is

Two independent improvements to the dashboard's tag reports:

- **A place to manage all saved reports**, so stale ones can be cleaned out in one go instead of one at a
  time from the dashboard picker.
- **A richer report builder** than the flat list of tag checkboxes.

**Where it stands:** not started; neither is pressing. Freezing filters with a report is already covered
by saved filters (`architecture.md` → *Saved filters*): apply the saved filter, then pick the report.

## A manager outside the dashboard

Saved reports are managed only from the dashboard picker: right-click or `⋯` on a saved report offers
Rename / Edit tags… / Delete (and on the unsaved custom report, Edit tags… / Save as…). Nothing lists all
saved reports in one place, which makes cleaning out stale ones a one-at-a-time job.

- List the user's saved reports (`ui.dashboard.tagReports`) with rename and delete, and each report's
  tags shown inline.
- **Where it goes is open.** Settings was the first thought. The Tags dialog on the Transactions page,
  where tags are created and edited, may be the better home.
- Worth building if the picker's menu turns out to be too easy to miss.

## A richer report builder

The builder is a flat list of tag checkboxes. Ideas raised: drag-to-bucket for comparing several
buckets, or a fill-in phrase ("compare [Alice] vs [Bob] for [Essential]"). Wait to see how the simple
version gets used; the patterns people reach for should decide the next step.
