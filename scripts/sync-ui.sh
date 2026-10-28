#!/bin/sh
# Pull the latest shared console UI (@insighteye/ui) into frontend/packages/insighteye-ui.
# The source repo defaults to /home/ubuntu/insighteye-ui; pass another path or URL to override.
set -e
cd "$(git rev-parse --show-toplevel)"
git subtree pull --prefix frontend/packages/insighteye-ui "${1:-/home/ubuntu/insighteye-ui}" main --squash -m "Update @insighteye/ui"
