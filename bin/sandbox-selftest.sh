#!/usr/bin/env bash
# Prove, on this Mac, that each escape the seatbelt profile claims to close is refused.
#
#   bin/sandbox-selftest.sh
#
# Runs tests/infrastructure/sandboxProfile.test.ts (a fake home and checkout: nothing
# real is read or written) plus the shim and policy tests, and prints the result.
# Every escape is first shown open WITHOUT the sandbox, then refused inside it.
# Off macOS the profile tests skip themselves with a "SKIPPED sandbox profile tests" line.
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd -P)" || exit 1
[ "$(uname)" = Darwin ] || echo "not macOS: the profile tests will be SKIPPED (this is not a pass)"
exec bun test tests/infrastructure/sandboxProfile.test.ts tests/infrastructure/sandboxShims.test.ts tests/domain/proxyPolicy.test.ts tests/application/execProxy.test.ts
