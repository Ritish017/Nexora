# Upstream Repository Lock

This document records the exact upstream repositories, verified commit hashes, license types, and attribution pins for Nexora.

## 1. Cloned Repositories

| Repository | Remote URL | Cloned Commit SHA | Branch / Tag | License | Upstream Attribution / NOTICE |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Perry** | `https://github.com/TheM1N9/perry.git` | `0a9ad7898221d0b9c3d910a9d08b516c9406518b` | `main` | MIT | Preserves MIT license; NOTICE credits Vercel `eve` (Apache 2.0) and CopilotKit `OpenDots` (MIT) for note editor & revision-checked saves |
| **OpenDots** | `https://github.com/CopilotKit/OpenDots.git` | `625452e06cde74cb25b0ce319e2c1be0488f5a5f` | `main` | MIT | MIT License (c) Atai Barkai. Contains OpenBot computer integration pinning revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` |
| **OpenBot** | `https://github.com/CopilotKit/OpenBot.git` | `bbd882c8a3471922f020e4cd3040c6161cbf8d69` | `main` (Release v0.1.2) | MIT | MIT License (c) CopilotKit. Governed computer service, supervisor, action-policy gateway, audit store |

## 2. Pinned Subsystem Revisions & Compatibility Policy

- **OpenDots / OpenBot Compatibility Pin:**
  - OpenDots (`625452e06cde74cb25b0ce319e2c1be0488f5a5f`) deployment contract pins OpenBot revision:
    `b6932d31a8d6e7896c15139dfc27a6c6911deb27`
  - Reason: OpenDots applies a fail-closed credential isolation patch to OpenBot's supervisor:
    `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)`
    which ensures each isolated computer gets a derived credential rather than the master token.
  - Policy: We maintain this pinned compatibility boundary for the container supervisor until migration contracts and integration tests pass against OpenBot v0.1.2 head.

## 3. License and Attribution Preservation Rules

1. All original license headers and files (`LICENSE`, `LICENSE.openbot`, `NOTICE`, `licenses/*`) within `repos/` remain untouched.
2. Code reused or adapted from upstreams into the orchestration packages (`packages/*`) must cite the upstream repository, original author, license, and source commit SHA in file headers.
3. Nested `repos/*` folders are tracked independently as Git repositories and excluded from the root repository index.
