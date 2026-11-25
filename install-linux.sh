#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is required.' >&2
  exit 1
fi

source_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec node "$source_dir/manage.mjs" install "$source_dir" "$@"
