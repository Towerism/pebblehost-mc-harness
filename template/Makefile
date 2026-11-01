.PHONY: setup hooks test sync

# Once after a clone: the pinned harness, its dependencies and both repos' hooks.
setup:
	git submodule update --init
	cd harness && npm ci
	[ -f sync-rules ] || cp harness/templates/sync-rules sync-rules
	$(MAKE) --no-print-directory hooks

# This repo pushes only to its Gitea (harness/hooks/private-pre-push); the
# harness submodule keeps its own path guard, so no server file reaches GitHub.
hooks:
	ln -sfn "$(CURDIR)/harness/hooks/private-pre-push" "$$(git rev-parse --path-format=absolute --git-common-dir)/hooks/pre-push"
	cd harness && bin/install-hooks

# Every committed check: bare-text first, then one pod per fixture profile.
# Refused while either hook is missing.
test:
	@[ "$$(readlink "$$(git rev-parse --path-format=absolute --git-common-dir)/hooks/pre-push")" = "$(CURDIR)/harness/hooks/private-pre-push" ] || { echo "make test: this repo's pre-push hook is not installed; run make hooks" >&2; exit 2; }
	@grep -qxF '# path-guard stub (bin/install-hooks)' "$$(git -C harness rev-parse --path-format=absolute --git-common-dir)/hooks/pre-commit" 2>/dev/null || { echo "make test: the harness submodule's path-guard hooks are not installed; run make hooks" >&2; exit 2; }
	bin/check suite

sync:
	bin/dev sync
