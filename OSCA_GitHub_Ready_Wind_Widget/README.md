# OSCA MeteoSwiss Wind Widget

Live wind and gust forecast for Arth (postcode 6415), designed for embedding in the OSCA ClubDesk website.

## Architecture

- `docs/` — static widget hosted with GitHub Pages
- `worker/` — Cloudflare Worker that retrieves and caches official MeteoSwiss Open Data
- `.github/workflows/pages.yml` — automatically publishes `docs/` to GitHub Pages

GitHub Pages hosts static HTML/JavaScript only. The Cloudflare Worker is necessary because the
official MeteoSwiss national forecast files are large and should not be downloaded separately by
every website visitor.

## A. Create the GitHub repository

Sign into GitHub using the OSCA account associated with `info@osca.ch`.

Create a repository named:

`osca-wind-widget`

Recommended settings:

- Visibility: **Public**
- Add README: **No** (this repository already contains one)
- Add `.gitignore`: **No**
- License: choose according to OSCA's preference

Upload the complete contents of this package and commit them to the `main` branch.

## B. Enable GitHub Pages

1. Open the repository.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, select **GitHub Actions**.
4. Open the **Actions** tab and confirm that `Deploy GitHub Pages` completes successfully.

The resulting URL will normally be:

`https://YOUR-GITHUB-USERNAME.github.io/osca-wind-widget/`

## C. Deploy the Cloudflare Worker

### Browser-only method

1. Create or sign into an OSCA Cloudflare account.
2. Open **Workers & Pages → Create → Worker**.
3. Copy the contents of `worker/src/index.js` into the editor.
4. Deploy.
5. Test:

`https://YOUR-WORKER.workers.dev/forecast?postcode=6415&hours=72`

### Command-line method

```bash
cd worker
npm install
npx wrangler login
npm run deploy
```

Wrangler will return the public Worker URL.

## D. Connect the widget to the Worker

Edit `docs/config.js`:

```javascript
window.OSCA_CONFIG = {
  workerUrl: "https://YOUR-WORKER.workers.dev"
};
```

Commit the change to `main`. The GitHub Actions workflow will republish the site automatically.

## E. Insert in ClubDesk

Add an HTML or external-content element containing:

```html
<iframe
  src="https://YOUR-GITHUB-USERNAME.github.io/osca-wind-widget/"
  title="Windprognose Arth"
  loading="lazy"
  style="width:100%;height:760px;border:0;border-radius:14px;overflow:hidden"
  referrerpolicy="no-referrer-when-downgrade">
</iframe>
```

## Optional OSCA subdomain

A cleaner address would be:

`wind.osca.ch`

In the GitHub repository, open **Settings → Pages → Custom domain** and enter `wind.osca.ch`.
At the DNS provider for `osca.ch`, add:

- Type: `CNAME`
- Name/host: `wind`
- Target: `YOUR-GITHUB-USERNAME.github.io`

After DNS resolves, enable **Enforce HTTPS** in GitHub Pages. Also verify the OSCA domain in the
GitHub organization/account settings to reduce domain-takeover risk.

Then use this ClubDesk iframe:

```html
<iframe
  src="https://wind.osca.ch/"
  title="Windprognose Arth"
  loading="lazy"
  style="width:100%;height:760px;border:0;border-radius:14px;overflow:hidden">
</iframe>
```
