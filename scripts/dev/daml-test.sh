#!/usr/bin/env bash
# Build PrivateLine's Daml packages and run the tests. Run inside WSL (Ubuntu), from anywhere.
# Needs the toolchain from scripts/dev/install-daml-toolchain.sh and the DARs in daml/dars/.
set -euo pipefail
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/jdk21}"
export PATH="$HOME/.dpm/bin:$JAVA_HOME/bin:$PATH"
cd "$(dirname "$0")/../../daml"
dpm build --all
cd privateline-test
dpm test "$@"
