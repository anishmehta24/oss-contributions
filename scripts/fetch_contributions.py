"""Fetch my merged and open pull requests to other people's projects.

Writes site/data/contributions.json. Needs a GitHub token in GITHUB_TOKEN
(the Actions token is enough, everything queried is public).
"""

import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

AUTHOR = "anishmehta24"
# PRs to repos owned by these accounts are not counted: my own repos,
# plus friends' repos where I helped out.
EXCLUDE_OWNERS = ["anishmehta24", "saquibjawedbit", "Harshkumar76", "krrishrastogi05"]
FIRST_YEAR = 2025

OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "contributions.json"

QUERY = """
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt mergedAt additions deletions
        repository {
          nameWithOwner name url description stargazerCount
          primaryLanguage { name color }
          owner { login avatarUrl url ... on Organization { name } }
        }
      }
    }
  }
}
"""


def graphql(token, variables):
    body = json.dumps({"query": QUERY, "variables": variables}).encode()
    req = urllib.request.Request(
        "https://api.github.com/graphql",
        data=body,
        headers={
            "Authorization": f"bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "oss-contributions-site",
        },
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code in (502, 503, 504) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        if "errors" in data:
            raise RuntimeError(data["errors"])
        return data["data"]["search"]
    raise RuntimeError("GitHub API kept failing")


def search(token, query):
    nodes, after = [], None
    while True:
        page = graphql(token, {"q": query, "after": after})
        if page["issueCount"] > 1000:
            raise RuntimeError(f"{page['issueCount']} results for {query!r}; split the range")
        nodes += [n for n in page["nodes"] if n]
        if not page["pageInfo"]["hasNextPage"]:
            return nodes
        after = page["pageInfo"]["endCursor"]


def main():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("GITHUB_TOKEN is not set")

    base = f"is:pr author:{AUTHOR} " + " ".join(f"-user:{o}" for o in EXCLUDE_OWNERS)
    merged = []
    # Search returns at most 1000 hits per query, so ask one year at a time.
    for year in range(FIRST_YEAR, dt.date.today().year + 1):
        merged += search(token, f"{base} is:merged merged:{year}-01-01..{year}-12-31")
    open_prs = search(token, f"{base} is:open -is:draft")

    repos, prs = {}, []
    for status, items in (("merged", merged), ("open", open_prs)):
        for n in items:
            r = n["repository"]
            key = r["nameWithOwner"]
            if key not in repos:
                owner = r["owner"]
                repos[key] = {
                    "name": key,
                    "url": r["url"],
                    "description": r["description"] or "",
                    "stars": r["stargazerCount"],
                    "language": (r["primaryLanguage"] or {}).get("name"),
                    "languageColor": (r["primaryLanguage"] or {}).get("color"),
                    "owner": owner["login"],
                    "ownerName": owner.get("name") or owner["login"],
                    "ownerUrl": owner["url"],
                    "avatar": owner["avatarUrl"],
                }
            prs.append({
                "repo": key,
                "number": n["number"],
                "title": n["title"],
                "url": n["url"],
                "status": status,
                "createdAt": n["createdAt"],
                "mergedAt": n["mergedAt"],
                "additions": n["additions"],
                "deletions": n["deletions"],
            })

    prs.sort(key=lambda p: p["mergedAt"] or p["createdAt"], reverse=True)
    search_q = f"is:pr is:merged author:{AUTHOR} " + " ".join(f"-user:{o}" for o in EXCLUDE_OWNERS)
    data = {
        "author": AUTHOR,
        "updatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "searchUrl": "https://github.com/search?type=pullrequests&q="
        + urllib.parse.quote_plus(search_q),
        "repos": sorted(repos.values(), key=lambda r: r["name"].lower()),
        "prs": prs,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(merged)} merged, {len(open_prs)} open, {len(repos)} repos -> {OUT}")


if __name__ == "__main__":
    main()
