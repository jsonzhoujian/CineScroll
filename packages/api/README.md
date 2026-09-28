# Authenticated project import API

This NestJS module exposes the T04 project-import application seam without accepting an actor from request bodies. `SessionGuard` verifies the bearer token and resolves the actor's current workspace membership on every request through `SessionVerifier`.

Implemented endpoints:

- `POST /projects`
- `POST /projects/:projectId/imports/inspect`
- `POST /projects/:projectId/chapters/import`
- `POST /projects/:projectId/chapters/:chapterId/reimport`
- `GET /projects/:projectId/chapters/:chapterId`

Paste requests carry text directly. TXT and DOCX requests carry strict canonical Base64 in `contentBase64`; decoding failures return `MALFORMED_DOCUMENT`. Domain errors retain stable machine-readable codes, and cross-workspace project access uses the same `PROJECT_NOT_FOUND` response.

The module intentionally leaves concrete providers to the deployment composition root. Phone-code and WeChat HTTP endpoints, production adapter composition, and the import workbench UI are the next T04 slices.
