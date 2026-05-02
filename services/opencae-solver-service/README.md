# OpenCAE Solver Service

`@opencae/solver-service` contains deterministic local solver implementations used by the API and browser worker flows.

## Local Solver Paths

- General static studies use a heuristic surface-response solver that evaluates CAD-bound supports, loads, material properties, print settings, and mesh sample density.
- The Beam Demo can use an Euler-Bernoulli beam path for fast bending displacement and stress estimates.
- Dynamic structural studies use Newmark average-acceleration integration with lumped mass, stiffness, damping, timed result frames, and transient summary values.

The service writes solver input text, solver logs, result summaries, and result fields through the object storage boundary. Local results are deterministic engineering-preview estimates for workflow development, not certified analysis.

`LocalMockComputeBackend` remains as a compatibility class name, but it extends the current local heuristic compute backend.
