# Deploying suped.ai and suped.dev to Cloudflare Pages

Gitignored. Personal runbook, written 2026-09-07.

## Already done

- Both zones (`suped.ai`, `suped.dev`) are on the Cloudflare account
  `Webdensllc@gmail.com's Account` (id `8304d17a69515337aba56886ae914820`) and active.
- Two Pages projects exist, created with Wrangler as direct-upload projects:

  | Project     | Serves     | Source repo            | Preview URL                  |
  |-------------|------------|------------------------|------------------------------|
  | `suped-ai`  | suped.ai   | suped-ai/suped `site/` | https://suped-ai.pages.dev   |
  | `suped-dev` | suped.dev  | suped-ai/suped.dev     | https://suped-dev.pages.dev  |

- A `deploy` GitHub Actions workflow is in both repos. It builds on every push to
  `main` and deploys with Wrangler. Until the API token secret exists it builds,
  prints a notice, and skips the deploy, so CI stays green.
- `CLOUDFLARE_ACCOUNT_ID` is already set as a secret on both repos.
- Wrangler on this machine is logged in via OAuth as `webdensllc@gmail.com`.

## Step 1: first deploy from this machine (2 minutes)

The built output is already in each repo's `dist/`. This publishes it to the
`*.pages.dev` URLs so you can look before the domains are attached.

```powershell
cd c:\projects\suped\site
npm run build
npx wrangler pages deploy dist --project-name suped-ai --branch main

cd c:\projects\suped.dev
npm run build
npx wrangler pages deploy dist --project-name suped-dev --branch main
```

Open https://suped-ai.pages.dev and https://suped-dev.pages.dev.

Note: I created the projects and prepared everything, but the deploy command
itself was blocked by my permission sandbox, so this one is on you.

## Step 2: attach the custom domains (dashboard, 2 minutes)

Wrangler's OAuth token can't write DNS, so this is in the dashboard.

1. https://dash.cloudflare.com → Workers & Pages → `suped-ai` → **Custom domains** → **Set up a custom domain**.
2. Enter `suped.ai` → Continue → **Activate domain**. Cloudflare adds the CNAME
   to the zone for you (`suped.ai CNAME suped-ai.pages.dev`, proxied).
3. Repeat for `www.suped.ai` if you want it. Pages will serve the same site;
   add a Bulk Redirect later if you want www to bounce to the apex.
4. Same for `suped-dev` with `suped.dev`.

Certificates issue automatically. Usually live within a minute, occasionally
up to 15.

If the zone already has an `A` or `CNAME` record on the apex from a parked
page, the dashboard will offer to replace it. Say yes.

## Step 3: let GitHub deploy on push (5 minutes, once)

1. Create an API token: https://dash.cloudflare.com/profile/api-tokens →
   **Create Token** → template **Edit Cloudflare Workers** is more than needed;
   simpler to use **Create Custom Token** with:
   - Permissions: `Account` → `Cloudflare Pages` → `Edit`
   - Account Resources: Include → your account
   - Name it `github-pages-deploy`.
2. Copy the token and add it to both repos:

   ```powershell
   gh secret set CLOUDFLARE_API_TOKEN -R suped-ai/suped
   gh secret set CLOUDFLARE_API_TOKEN -R suped-ai/suped.dev
   ```

   (Each prompts for the value on stdin; paste and press Enter, then Ctrl+Z, Enter on Windows.)
3. Push anything to `main` on either repo, or run the `deploy` workflow from
   the Actions tab. It builds and deploys. Done from then on.

The `suped` repo's deploy only triggers on changes under `site/`, so CLI
commits don't redeploy the homepage.

## Verifying

- `https://suped.ai/` shows the chip; `https://suped.ai/og.png` returns the card.
- `https://suped.dev/docs/getting-started` loads without a `.html` suffix and
  `https://suped.dev/docs/getting-started.html` redirects to it (Cloudflare Pages
  does this by default; the Astro build relies on it).
- `https://suped.dev/sitemap-index.xml` and `/robots.txt` return 200.
- Share previews: paste each URL into https://cards-dev.twitter.com/validator
  or a Slack message and check the image. Cloudflare caches `og.png`; if you
  re-render it later, purge cache or bump the filename.

## Later, optional

- `supedai.com` and `suped.link` are also on the account. A Bulk Redirect rule
  (`Rules` → `Redirect Rules`) can point them at `https://suped.ai`.
- Preview deployments per PR: add a second job to `deploy.yml` on
  `pull_request` using `--branch ${{ github.head_ref }}`. Pages gives each
  branch its own `*.pages.dev` URL.
- If you'd rather have Cloudflare build from Git instead of GitHub Actions, that
  needs new projects (direct-upload projects can't be converted). Settings would
  be: root `site` / build `npm run build` / output `dist` for suped.ai; root `/`
  / `npm run build` / `dist` plus `NODE_VERSION=22` for suped.dev. The Actions
  route is already wired, so I'd stay with it.
