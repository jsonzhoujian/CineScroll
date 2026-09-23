# Identity module

This package owns the MVP login boundary for mainland phone verification and WeChat website QR login. `IdentityService` validates one-time challenges, normalizes mainland phone numbers, applies phone/IP/device rate limits, links an external identity to one user/workspace actor and delegates session creation to `SessionIssuer`.

Production adapters:

- `HttpPhoneVerificationProvider` calls an HTTPS SMS verification gateway through `/send` and `/verify`. The deployment gateway is responsible for the chosen mainland SMS SDK and credentials; this keeps vendor signing and secrets outside the domain.
- `WechatWebsiteLoginProvider` creates the website QR authorization URL and exchanges the callback code with WeChat from the server. The app secret never enters browser state or return values.

`InMemoryIdentityRepository`, `InMemoryLoginChallengeStore` and `InMemoryLoginRateLimiter` are deterministic adapters for tests and local composition. Production API composition must replace repository, challenge storage/rate limiting, and session issuance with persistent adapters before public deployment.

Run:

```bash
node --test packages/identity/test/*.test.ts
npm run typecheck
```
