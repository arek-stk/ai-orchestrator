# Changelog

## [0.3.0](https://github.com/arek-stk/ai-orchestrator/compare/v0.2.0...v0.3.0) (2026-09-15)


### Features

* platform operations, per-project access control and deployment ([ae9644c](https://github.com/arek-stk/ai-orchestrator/commit/ae9644cebd075f30666d62d29f22a93f9a31eb31))
* project health scan, agent output cache and specialist agents ([#12](https://github.com/arek-stk/ai-orchestrator/issues/12)) ([bf6375a](https://github.com/arek-stk/ai-orchestrator/commit/bf6375a69e7db9cb3aa8e5f95a8211ba683f496e))
* **server:** add Prometheus metrics endpoint, request ids and log redaction ([c27270e](https://github.com/arek-stk/ai-orchestrator/commit/c27270e27c4386514c8bea36735cf21db478ff53))
* **server:** enforce per-project access control on project_members ([3dbfc5d](https://github.com/arek-stk/ai-orchestrator/commit/3dbfc5de54666c4b976147c1177dd6512b893874))
* **server:** expire stale approvals and block their runs ([11ec7a8](https://github.com/arek-stk/ai-orchestrator/commit/11ec7a837c06aa5b8e61f74e8af0527436b2c87e))
* **server:** fan out events across instances with LISTEN/NOTIFY ([5add0cb](https://github.com/arek-stk/ai-orchestrator/commit/5add0cb5fdcdf5abe28855f141441a65b5d6de01))
* **web:** operations dashboard for the orchestrator ([#11](https://github.com/arek-stk/ai-orchestrator/issues/11)) ([2a6dc2f](https://github.com/arek-stk/ai-orchestrator/commit/2a6dc2f5564fad802c04969151c4e4b360e85312))


### Bug Fixes

* **deps:** force patched esbuild for drizzle-kit's loader ([#13](https://github.com/arek-stk/ai-orchestrator/issues/13)) ([fc71f20](https://github.com/arek-stk/ai-orchestrator/commit/fc71f204c1b740813b9904ee93c7815a6de7d258))

## [0.2.0](https://github.com/arek-stk/ai-orchestrator/compare/v0.1.0...v0.2.0) (2026-09-14)


### Features

* **server:** API server with auth, RBAC, live events and workers ([3eeaa3d](https://github.com/arek-stk/ai-orchestrator/commit/3eeaa3dfa8ec84ed041871e8c4c73c80b972bc7f))
* **server:** API server with auth, RBAC, live events and workers ([b7d1f54](https://github.com/arek-stk/ai-orchestrator/commit/b7d1f54c253aba65f24b614a8a481e9288805033))


### Bug Fixes

* **security:** admin-only project profile, restricted sandbox egress, secure cookies on HTTPS ([7d7c02a](https://github.com/arek-stk/ai-orchestrator/commit/7d7c02a98af5a0d079edcb04e392e93371567201))
* **security:** admin-only project profile, restricted sandbox egress, secure cookies on HTTPS ([64ed310](https://github.com/arek-stk/ai-orchestrator/commit/64ed310593a534bbeaa7a89fa832b8fdb454eec0))
* **server:** avoid file system race when creating the dev encryption key ([4153d12](https://github.com/arek-stk/ai-orchestrator/commit/4153d12929a294cbf25813ffead61c5447d7a57e))
