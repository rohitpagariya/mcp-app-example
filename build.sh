#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGES=(server host e2e)

run_npm_script_if_present() {
  local package_dir="$1"
  local script_name="$2"

  if npm --prefix "$package_dir" run | grep -Eq "^[[:space:]]+$script_name$"; then
    echo "==> Running '$script_name' in $package_dir"
    npm --prefix "$package_dir" run "$script_name"
  else
    echo "==> Skipping '$script_name' in $package_dir (not defined)"
  fi
}

for package_name in "${PACKAGES[@]}"; do
  package_dir="$ROOT_DIR/$package_name"

  if [[ ! -f "$package_dir/package.json" ]]; then
    echo "Missing package.json in $package_dir" >&2
    exit 1
  fi

  echo "==> Installing dependencies in $package_name"
  npm --prefix "$package_dir" install
  run_npm_script_if_present "$package_dir" build
done

echo "Build completed. Installed dependencies for: ${PACKAGES[*]}"