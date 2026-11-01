.PHONY: test test-unit test-unit-bats test-unit-ts test-integration test-dev test-live lint hooks

test: lint test-unit test-integration test-dev

lint:
	shellcheck bin/mc bin/path-guard bin/install-hooks bin/dev hooks/pre-commit hooks/pre-push hooks/pre-merge-commit docker/entrypoint.sh test/unit/stub/rclone test/integration/setup_suite.bash test/dev/prime test/dev/egress-probe test/dev/setup_suite.bash
	npx tsc --noEmit

# bats and node --test side by side, to stay under 2s.
test-unit:
	$(MAKE) --no-print-directory -j2 test-unit-bats test-unit-ts

test-unit-bats:
	bats --print-output-on-failure --jobs 24 test/unit

test-unit-ts:
	node --test 'test/ts/**/*.test.ts'

# One SFTP container for the whole run (test/integration/setup_suite.bash).
# Serial on purpose: the server-root test would race with the per-directory tests.
test-integration:
	bats --print-output-on-failure test/integration

# Docker plus vanilla Purpur, downloaded once by test/dev/prime. Serial: the
# tests share one pod.
test-dev:
	bats --print-output-on-failure test/dev

# Read-only, against the real server from .env.
test-live:
	MC_LIVE=1 bats --print-output-on-failure test/live

# Path-guard stubs in the shared hooks dir; each checkout runs its own hooks/.
hooks:
	bin/install-hooks
