export function renderPagesWorkflow(): string {
  return `name: publish Pages

on:
  workflow_dispatch:

concurrency:
  group: pages
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: 1.4.0
          no-cache: true
      - run: bun install --frozen-lockfile
      - name: Require release-phase documentation evidence
        run: bun run docs:check:publication
      - name: Assemble the static Pages artifact
        run: bun scripts/build-pages-artifact.ts
      - name: Check out the legacy Pages source branch
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: gh-pages
          path: published
          fetch-depth: 1
          persist-credentials: false
      - name: Publish the verified artifact to gh-pages
        env:
          GH_TOKEN: \${{ github.token }}
        shell: bash
        run: |
          gh auth setup-git
          git -C published config user.name "github-actions[bot]"
          git -C published config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git -C published rm -r --ignore-unmatch .
          cp -R _site/. published/
          git -C published add -A
          if git -C published diff --cached --quiet; then
            echo "PAGES_UP_TO_DATE"
            exit 0
          fi
          git -C published commit -m "docs: publish $GITHUB_SHA"
          git -C published push origin HEAD:gh-pages
`;
}
