#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGES=(server host e2e)
PIDS=()

has_npm_script() {
  local package_dir="$1"
  local script_name="$2"

  node -e '
    const fs = require("fs");
    const path = require("path");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.argv[1], "package.json"), "utf8")
    );
    process.exit(packageJson.scripts && packageJson.scripts[process.argv[2]] ? 0 : 1);
  ' "$package_dir" "$script_name"
}

cleanup() {
  local exit_code=$?

  if [[ ${#PIDS[@]} -gt 0 ]]; then
    echo
    echo "==> Stopping started processes"
    for pid in "${PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    done
    wait "${PIDS[@]}" 2>/dev/null || true
  fi

  trap - EXIT INT TERM
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

run_npm_script_if_present() {
  local package_dir="$1"
  local script_name="$2"

  if has_npm_script "$package_dir" "$script_name"; then
    echo "==> Starting '$script_name' in ${package_dir##*/}"
    npm --prefix "$package_dir" run "$script_name" &
    PIDS+=("$!")
  else
    echo "==> Skipping '$script_name' in ${package_dir##*/} (not defined)"
  fi
}

for package_name in "${PACKAGES[@]}"; do
  package_dir="$ROOT_DIR/$package_name"

  if [[ ! -f "$package_dir/package.json" ]]; then
    echo "Missing package.json in $package_dir" >&2
    exit 1
  fi

  run_npm_script_if_present "$package_dir" start
done

if [[ ${#PIDS[@]} -eq 0 ]]; then
  echo "No start scripts were found."
  exit 1
fi

echo "==> Started packages. Press Ctrl+C to stop all."
wait "${PIDS[@]}"