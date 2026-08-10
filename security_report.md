# Security Report and Hardening Plan

## 1. Critical Issues Found

### A. Secrets exposed in client-side code
- Airtable API keys and protection tokens were embedded directly in the frontend JavaScript.
- Impact: anyone who opens the browser devtools or source can extract and abuse these credentials.
- Fix: move secrets to a server-side proxy or environment variables and keep the frontend config minimal.

### B. Stored XSS risk from user-controlled data
- Some UI rendering used string HTML assembly with values from Airtable or user input.
- Impact: malicious content could execute in the browser if injected into the page.
- Fix: render text content safely and avoid direct HTML insertion for dynamic values.

### C. Unsafe external links
- Links from the protection system were injected directly into the DOM.
- Impact: could be abused for phishing or unsafe navigation.
- Fix: validate and restrict links to http/https only.

### D. Weak client-side authorization logic
- The doctor password and protection rules were checked in the browser.
- Impact: a determined attacker can bypass UI restrictions by editing the script or sending requests directly.
- Fix: enforce all protection and admin checks on the server side.

## 2. Immediate High-Priority Actions

1. Remove all secrets from the frontend source.
2. Move Airtable access behind a backend API.
3. Enforce server-side authentication for doctors and protection mode.
4. Sanitize all rendered user-generated or external data.
5. Disable inline event handlers and use event listeners instead.

## 3. Recommended Additional Hardening

- Add CSP (Content Security Policy) headers.
- Add rate limiting on login and API endpoints.
- Add CSRF protection for state-changing requests.
- Use HTTPS only.
- Add audit logging for admin actions and QR toggles.
- Rotate the exposed API keys immediately.

## 4. Suggested Architecture Improvement

Use a small backend such as Node.js/Express or Cloudflare Worker that:
- stores API keys server-side,
- validates doctor credentials,
- serves attendance data only to authorized users,
- performs all Airtable calls on the server.

## 5. Priority Order

- P0: rotate secrets and remove them from client code
- P1: move privileged logic to server-side
- P2: sanitize DOM rendering and links
- P3: add CSP and rate limiting
