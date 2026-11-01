.PHONY: test test-unit test-integration test-live lint hooks

test: lint test-unit test-integration

lint:
	shellcheck bin/mc bin/path-guard hooks/pre-commit hooks/pre-push test/unit/stub/rclone test/integration/setup_suite.bash
	npx tsc --noEmit

test-unit:
	bats --print-output-on-failure --jobs 16 test/unit
	node --test 'test/ts/**/*.test.ts'

# One SFTP container for the whole run (test/integration/setup_suite.bash).
# Serial on purpose: the server-root test would race with the per-directory tests.
test-integration:
	bats --print-output-on-failure test/integration

# Read-only, against the real server from .env.
test-live:
	MC_LIVE=1 bats --print-output-on-failure test/live

# Path-guard hooks. Relative, so every worktree runs its own hooks/.
hooks:
	git config core.hooksPath hooks
