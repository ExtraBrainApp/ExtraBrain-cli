# Agent instructions

Before making a commit in this repository, set and verify the repository-local Git identity:

```sh
git config --local user.name 'ExtraBrain Developer'
git config --local user.email 'developer@extrabrain.app'
git config --local user.useConfigOnly true
git config --local --get user.name
git config --local --get user.email
```

Commit with this identity as both author and committer. Do not change global Git configuration or override this identity with `GIT_AUTHOR_*` or `GIT_COMMITTER_*` environment variables.
