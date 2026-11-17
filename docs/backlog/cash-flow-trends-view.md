# A cash-flow Trends view whose two charts agree

## What it is

The Trends view of the Dashboard's Cash flow frame has two charts that pick their periods separately,
yet one drives the other, which is hard to follow:

- **The yearly chart** (top) runs from as far back as the history limit allows up to the latest data.
  Nothing on the page moves its end.
- **The monthly chart** (bottom) shows the window its own chooser picks, which can be a single year.
- **Clicking a year on the top chart** sets the bottom chart's window to that year. Nothing else ties
  them together.

The single-period trend and the Trends report's annual chart now end at the period the page shows, and
the history limit counts back from there (`data-model.md` → *Reporting assumptions*, the trend span).
This view should get a model as clear as theirs.

**Where it stands:** not started. No design has been agreed. Until it is, its yearly chart counts the
limit back from the data's last month.

## Questions to settle

- What sets the period the view reports on: the window chooser, the date filter at the top of the
  page, or one replacing the other.
- Whether the yearly chart ends at the year the monthly chart shows, as the Trends report's annual
  chart does (`TrendsPanel` in `pages/Dashboard.jsx`), or stays a whole-history overview.
- What clicking a year should do once the two charts share an end: move both, or only the monthly one.

The code is `CashFlowTrendsPanel` in `pages/Dashboard.jsx`, with the series shaping in
`lib/cashFlowTrend.js`.
