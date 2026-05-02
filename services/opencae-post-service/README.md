# OpenCAE Post Service

`@opencae/post-service` builds immutable run reports from completed result summaries.

The local report provider writes:

- an HTML report with key performance indicators, result summary rows, transient settings when present, and assessment text
- a PDF report companion for browser/API download flows

Reports are stored through the object storage boundary under the project run artifacts. They summarize the completed run and should be reviewed with the model setup, material assumptions, boundary conditions, loads, and mesh quality.
