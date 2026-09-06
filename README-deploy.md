Deployment notes for Vercel
==========================

Overview
--------
This project contains a static frontend (`index.html`, `app.js`) and an Express-based proxy server (`server.js`). Vercel is optimized for static sites and serverless functions; a long-running Express server cannot be deployed to Vercel unchanged.

Quick deploy steps (static frontend only)
----------------------------------------
1. Ensure you have the Vercel CLI: `npm i -g vercel` (the supplied `deploy.bat` will try to install it).
2. From the project root run `deploy.bat` which will:
   - Optionally install Vercel CLI
   - List keys from `.env` for you to add to the Vercel project
   - Install `npm` deps (if `package.json` exists)
   - Deploy the static site with `vercel --prod`

Environment variables
---------------------
- If your app requires server-side environment variables (for the proxy), add them in the Vercel dashboard under Project → Settings → Environment Variables.
- Use `vercel env add <NAME> production` to add them via CLI.

Notes about the Express proxy
-----------------------------
- `server.js` is a stateful Express app that listens on a port; Vercel does not support persistent servers. To deploy the proxy on Vercel you must:
  1. Convert it into serverless endpoints under `/api/*` (create files under an `api/` folder and export handlers), or
  2. Host the Express server on a VPS or platform that supports persistent Node processes (Heroku, Fly, Render, Azure, etc.) and keep the client pointing to that host.

Converting to serverless (high level)
------------------------------------
1. Move route handlers into `api/` serverless function files (e.g., `api/airtable/[...].js`) and adapt Express logic to the function signature.
2. Use the same Airtable key stored as an environment variable in Vercel.
3. Test locally with `vercel dev` before pushing.

If you want, I can:
- Convert `server.js` into a Vercel-compatible serverless function skeleton, or
- Prepare a short script and `api/` handlers and test them locally.
