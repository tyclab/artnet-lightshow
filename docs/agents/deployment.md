# Deployment and show safety

Read for this topic; paths below are relative to the repository root unless stated otherwise.

- Read the deployment owner's current image/build pin before changing it;
  concurrent work may have moved it. Build context commit and image tag move
  together; a Dockerfile-only rebuild uses a distinct tag. Token changes reach
  the running server at deployment.
- Follow that environment's normal guarded deployment job, including its party
  mode/armed-state checks and any required operator approval. Deployment leaves
  output disarmed. Verify the deployed revision and health; do not arm outputs
  just to test a documentation change.
- The server remains the show orchestrator. Screens are a separate video pipeline
  combined by clock or DMX input. New input adoption requires the existing voice
  and output safety controls. Do not restore retired integrations.
- Never publish source-application names or private deployment hosts, addresses,
  account names or paths in this repository, issues or pull requests.
- Do not open upstream PRs or make upstream-first changes. Review external
  changes by content; copies can carry different SHAs, so git cherry is not proof
  of equivalence. README records the last reviewed revision.
