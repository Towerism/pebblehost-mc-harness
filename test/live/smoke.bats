# Read-only check against the real server; runs only with MC_LIVE=1 and the repo's .env.

@test "live server lists its root" {
  [ "${MC_LIVE:-}" = 1 ] || skip "set MC_LIVE=1 to run"
  run "$BATS_TEST_DIRNAME/../../bin/mc" ls .
  [ "$status" -eq 0 ]
  [[ $output == *server.properties* ]]
}
