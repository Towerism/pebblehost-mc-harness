.PHONY: test test-unit test-integration test-live lint

test: lint test-unit test-integration

lint:
	shellcheck bin/mc test/unit/stub/rclone test/integration/setup_suite.bash

test-unit:
	bats --print-output-on-failure --jobs 8 test/unit

# One SFTP container for the whole run (test/integration/setup_suite.bash).
# Serial on purpose: the server-root test would race with the per-directory tests.
test-integration:
	bats --print-output-on-failure test/integration

# Read-only, against the real server from .env.
test-live:
	MC_LIVE=1 bats --print-output-on-failure test/live
