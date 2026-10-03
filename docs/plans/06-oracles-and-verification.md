# Plan 06: Oracles and verification

How SEED knows an adapter's output can be trusted, and how that gate works for both students and agents. Milestones E0 (schema), E2 (registry v1 with PRA), E4 (transfer oracles). Pattern follows Virtual Reactor's validation plan: define the metrics and decision process before looking at results.

## Levels

| Level | Question | Method | When |
|---|---|---|---|
| 1. Contract | Do messages and schemas conform? | Good and bad fixtures; validator; typed errors | E0, every change |
| 2. Adapter parity | Does SEED's run match running the app directly? | Same snapshot through SEED, MCP and the app's own entry point; compare | E2, every adapter or engine change |
| 3. Oracle | Is the engine right on cases with known answers? | Hand derivations, analytic formulas, published values | E2 onward |
| 4. Refusal | Does it refuse what it must? | Bad-input cases with expected error codes | E0 onward |
| 5. Limit | Does it say when it is out of its domain? | Known-limit cases expecting an out-of-domain verdict | E2 onward |
| 6. Transfer | Is mapped quantity conserved and correctly scaled? | Conservation, unit and coverage checks with tolerances fixed in advance | E4 |

**Independence:** parity (level 2) catches wrapper drift only. A mistake shared by the app and its direct entry point passes it. Levels 3 to 5 are what catch shared mistakes, so every real adapter must have at least one oracle derived independently of its engine.

## Oracle entry

Schema in [ARCHITECTURE interface 5](../ARCHITECTURE.md). The tolerance is hashed into the entry before the case runs. Changing a tolerance creates a new entry version, made by a human, with the reason; old verdicts stay attached to the old version.

Tags: `good` (must match), `bad-input` (must be refused with the named code), `known-limit` (must report out-of-domain).

## Coverage and `unverified`

Each adapter declares in `describe` the quantities and domains its oracles cover. A result outside that coverage is marked `unverified` in the run, the comparison and the report. SEED never upgrades it. An agent may run unverified cases but the study record and report say so on every affected figure.

## Registry layout

```
oracles/<adapter>/<id>.json      entries (inputs by reference, expected, tolerance, source, coverage)
oracles/<adapter>/results/       verdicts per adapter and engine version
```

Open: whether entries live here or in each app's repo with SEED indexing them. If in app repos, SEED pins the commit it ran.

## First entries (E2, PRA)

Synthetic probabilities only; independence stated.

| ID | Case | Expected | Source |
|---|---|---|---|
| pra-and | A=0.1, B=0.2, A AND B, independent | 0.02 | hand |
| pra-or | A OR B | 0.28 | hand |
| pra-aa | A AND A | 0.1 (not 0.01) | hand: repeated event identity |
| pra-oa | A OR A | 0.1 | hand |
| pra-shared | (A AND B) OR (A AND C), A=0.1, B=0.2, C=0.3 | 0.1 x (0.2 + 0.3 - 0.06) = 0.044 | hand, shared event |
| pra-bad-prob | probability 1.2 | refusal, code for out-of-range | bad-input |
| pra-cycle | gate referencing itself | refusal | bad-input |
| pra-unsupported | an Open-PSA construct outside the subset | refusal naming the construct, input preserved | known-limit |

Each is also run directly against SCRAM, and the two must agree (level 2). Check the arithmetic of every new hand oracle by a second method before it enters the registry.

## Later entries

- Fuel: constant conductivity, uniform heating, prescribed surface temperature gives the analytic radial profile; tolerance set before implementation; energy balance and mesh refinement. This verifies a limited thermal calculation, not fuel behaviour.
- OpenMC and NODAL and RAFT: take cases from each app's own validation sets; SEED indexes, it does not redefine them.
- Transfer (E4): total power in equals total power mapped, within a declared tolerance; wrong-unit and wrong-normalization cases must refuse.

## What blocks what

- A failing level 1, 2, 3 or 4 oracle blocks any study using that adapter until a human clears it.
- A failing level 5 or 6 blocks the affected quantity and is recorded, not hidden.
- A version bump of an adapter or engine re-runs its set and records which verdicts moved.

## Tests of the verifier itself

A gate that cannot fail is useless. For each level there is a test that feeds a deliberately wrong adapter and expects the gate to block: perturbed output, swapped units, a dropped refusal, a changed tolerance, a stale registry hash.

## Reports

`oracles/<adapter>/results/` feeds each run's `oracle` field and the study report's verification table. A worse result at levels 3 to 6 is recorded and flagged in TODO, not hidden.

## Honesty rules

- Never tune an oracle to fit a result. A changed expected value needs a source.
- Keep sourced, computed and assumed values apart and labelled.
- Say what an oracle does not cover.
