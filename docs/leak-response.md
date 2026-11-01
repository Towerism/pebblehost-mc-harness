# Leak response

What to do when a server file, a backup, `.env` or anything else the path guard (`bin/path-guard`) should have refused reaches this public repo. Treat every leaked secret as known to others from the moment it was pushed: removing it from history limits further copies, it does not undo the exposure.

## 1. Rotate credentials first

Do this before cleaning history, because forks, clones and caches may already hold the file.

- **PebbleHost panel password.** It is also the SFTP password (`PEBBLE_PANEL_PASSWORD`). Change it in the PebbleHost panel, then update `.env`. Check the panel's activity and the server's files for changes you didn't make.
- **Plugin database passwords** in any leaked plugin config (`plugins/*/config.yml`, LuckPerms, CoreProtect, economy plugins): change them on the database host and in the server's config, then reload or restart.
- **Any other token** in the leaked files (Discord bot tokens, webhook URLs, API keys, RCON password in `server.properties`): revoke and reissue it at its provider.

## 2. Remove it from the branch

If the commit was only pushed to a feature branch and nobody else builds on it:

```bash
git rebase -i origin/main          # drop or edit the offending commit
bin/path-guard --range origin/main..HEAD
git push --force-with-lease origin <branch>
```

Use `--force-with-lease`, never plain `--force`: it refuses if someone pushed to the branch since your last fetch. If the commit already reached `main`, rewrite with `git filter-repo --path <path> --invert-paths` on a fresh clone, then coordinate the force-push to `main` with every collaborator.

## 3. Purge it from GitHub

Rewriting the branch does not remove the commit from GitHub: it stays reachable by its SHA, in pull request refs and in forks.

- Close or delete pull requests that reference the commit.
- Follow GitHub's guide [Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), then contact GitHub Support with the repository and the commit SHAs to have cached views and PR refs purged.
- Ask the owners of any fork made since the push to delete it or rewrite it.

## 4. Close the gap

- Run `make hooks` once in every clone you commit from. It installs stubs in the shared hooks directory, so all of that clone's worktrees run the guard, and a checkout without `hooks/` refuses to commit or push.
- Cherry-pick and rebase skip the commit hooks; `pre-push` and CI still check every new commit.
- If the guard let the path through, add a deny rule and a test for it in `src/guard/paths.ts` and `test/ts/guard.test.ts`.
