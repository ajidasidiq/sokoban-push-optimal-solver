# Push-optimal Sokoban solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ajidasidiq/sokoban-push-optimal-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ajidasidiq/sokoban-push-optimal-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Push-optimal Sokoban solver using per-room push-based A* with a matching heuristic and deadlock detection.

Built for the make.fun bounty **"Build the best Sokoban solver, 21 November 2026"**. One program, `main.ts`, answers a whole set of 5 instances in a single run: `node /bot/main.ts` reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` for each instance.

## How it works

Every level is a 1-wide hallway with 1–4 rooms off it, each room entered through a single door. A box pushed out of a room can never come back, so rooms are independent: the solver detects the rooms, solves each one push-optimally from its door, and stitches the room solutions together with hallway walks.

Each room is solved with push-based A* (not plain player-step search):

- A state is the box positions plus the player's reachable region (canonicalised to its smallest cell), so equivalent player positions collapse into one state.
- The heuristic is the minimum-cost matching of boxes to goals over precomputed BFS distances — admissible, so the first solution found is push-optimal.
- Dead states are pruned with a liveness test (cells from which no goal is reachable by single-box pushes), a 2×2 freeze check, and the matching heuristic itself.
- The search is budgeted by a fixed expansion count per room, never by the wall clock, so two runs produce byte-identical output.

## Results

Practice set: push-optimal on all 5 instances (13, 16, 29, 47 and 60 pushes — exactly P*), for a practice score of **1,000,000 / 1,000,000**. The same holds on 8 further sets drawn from the kit's own generator with fresh seeds (all 1,000,000). Whole-set runtime is under 1 second, far inside the 60-second budget.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is plain TypeScript with erasable syntax only, no dependencies, no network, no clock reads. Node 22+.
