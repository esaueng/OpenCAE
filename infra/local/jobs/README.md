# Local Jobs

Local development uses an in-memory job queue and run-state provider.

Simulation runs are queued by the Fastify API, executed in the local process, and reported to the web app through Server-Sent Events. Run events include state, progress, log, completion, cancellation, and error messages.

This backend is intentionally local and ephemeral. It keeps the API, runner, and solver boundaries explicit so durable queue providers can replace it for hosted deployments.
