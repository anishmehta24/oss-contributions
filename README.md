# Open source contributions

A one-page site listing the pull requests I've had merged into open source projects:
https://anishmehta24.github.io/oss-contributions/

A GitHub Action runs every morning (06:00 IST). It queries the GitHub search API for my
merged and open PRs, writes `site/data/contributions.json`, commits it and redeploys the
page. PRs to my own repositories are not counted.

## Run locally

```sh
GITHUB_TOKEN=$(gh auth token) python scripts/fetch_contributions.py
python -m http.server -d site 8000
```

The site is plain HTML, CSS and JavaScript with no build step.
