# Plan 08: Transfers and pipelines

Moving a quantity from one app's result into another app's input. Milestone E4. First pipelines are **offline, one-way and acyclic**. Feedback is a later design ([plan 09](09-advanced-studies.md)).

## Why transfers are separate and gated

Temperature alone does not define convective heat transfer. Neutronics geometry alone does not define a reduced dynamics library. A coolant component alone does not define a fault tree. A transfer therefore needs an explicit recipe, a human decision (tier A3) and checks that run before the downstream case starts.

## Transfer recipe

Fields: source quantity (run, quantity, units, normalization), target input (app, field), unit conversion, normalization (source rate or power), spatial mapping (IDs and coordinates, mesh association, interpolation, extrapolation refused), time mapping (grid, interpolation), applicability range, provenance, approver and time, tolerance for conservation set in advance.

Normalization examples: OpenMC per-source-particle heating is not watts; record the score, units, source-rate or power normalization, volume and spatial mapping, uncertainty and provenance. W, W/m and W/m3 are distinct.

## First transfer: OpenMC heating to Fuel Performance Studio

| Check | Behaviour |
|---|---|
| Units | wrong or missing units refuse |
| Normalization | per-source-particle scores without a declared power normalization refuse |
| Coverage | tally bins must cover the target region; incomplete coverage refuses, never extrapolates |
| Conservation | total mapped power equals the source total within the tolerance fixed beforehand |
| Revision | a stale source or target revision refuses |
| Boundary | the fuel case's coolant boundary comes from an explicit choice: bulk temperature with heat-transfer coefficient, or prescribed surface temperature; bulk temperature alone is not a complete convective boundary |
| Invalidation | changing the source model invalidates the downstream run |

Depends on Fuel Performance Studio F3 (reviewed heating and boundary mappings) and an OpenMC result adapter, both outside this repo.

## Pipeline graph

- A DAG of runs and transfers. Edges are transfer recipes. A cycle is refused at definition.
- An edge is blocked until its checks pass. An incompatible edge produces a named refusal.
- Changing an upstream input invalidates everything downstream, visibly.
- Each downstream run records the transfer recipe and upstream run IDs.

## Agent role

An agent may propose a recipe (A2) and run a pipeline whose edges a human has approved (A3 approval, then A1 runs). It cannot enable an edge, edit a tolerance or choose a default for a missing quantity.

## Tests

- Fake apps with a scripted heating field: each refusal in the table fires, and the good case passes.
- Conservation: a deliberately lossy mapping fails the check.
- A cyclic definition is refused.
- Upstream change marks downstream stale and blocks reuse.
- Property: transfer of a uniform field to a uniform target reproduces the total exactly.

## Later pipelines

NODAL coolant conditions to the fuel case (needs an identified axial region and a selected boundary form); Virtual Reactor scenario outputs to PRA scenario inputs only when supported and never as an automatic scenario-to-probability conversion; PRA component links to NODAL component IDs and revisions, where a link does not supply failure semantics.

## Open

- Recipe file format and where it lives.
- Mesh and coordinate conventions shared across OpenMC, NODAL and the fuel case (declared per recipe until a common one is justified).
- How uncertainty from a Monte Carlo tally propagates into the downstream case.
