# Homebase

This repository owns the Homebase dashboard UI, authenticated backend, and generic collectors.
Operator provisioning and deployment tools belong in the separate operator repository.

- Keep credentials, real application catalogues, account identities, private addresses, databases, and production configuration outside git.
- Do not read or copy private runtime files to build examples or screenshots. Use `scripts/demo-preview.mjs`, which contains only synthetic data.
- Preserve authentication, TLS verification, same-origin CSRF checks, and allowlisted application redirects.
- Calculate summaries from original finite observations before chart downsampling. Never invent missing production history.
- Report T3 session metadata only; do not export transcripts, prompts, tool arguments, or provider authentication state.
- Run `npm test` and `npm run build` for application changes. Visually check material UI changes using the isolated sample preview.
- The sample server is loopback-only and separate from the production entry point. Never deploy it as the live backend.
- Public routing changes require an explicit operator request. Homebase currently remains private.
