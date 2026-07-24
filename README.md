# OSCA MeteoSwiss Wind Widget

GitHub-only version.

- GitHub Actions fetches the official MeteoSwiss forecast hourly.
- The workflow writes `docs/forecast.json`.
- GitHub Pages hosts the widget and forecast file.
- No Cloudflare Worker is required.

Enable GitHub Pages with **Settings → Pages → Source: GitHub Actions**.

The site URL is normally:

`https://oberseesegelclubarth.github.io/osca-wind-widget/`
