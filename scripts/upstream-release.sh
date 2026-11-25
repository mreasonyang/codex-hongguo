#!/usr/bin/env bash
set -euo pipefail

summary() {
  echo "$1"
  echo "$1" >> "$GITHUB_STEP_SUMMARY"
}

baseline() {
  local version published tag sha subject
  version=$(node -p "require('./package.json').version")
  published=$(node -p "require('./.agents/plugins/marketplace.json').plugins[0].source.version")
  if [[ "$version" == "$published" ]]; then
    echo 'ready=true' >> "$GITHUB_OUTPUT"
    return
  fi

  # Recover a successful atomic push followed by an interrupted workflow dispatch.
  tag="v$version"
  if sha=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}") &&
     git merge-base --is-ancestor "$sha" HEAD; then
    subject=$(git show -s --format=%s "$sha")
    if [[ "$subject" =~ ^chore:\ follow\ openhongguo\ v[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
       [[ "$(git show "$sha:package.json" | jq -r '.version')" == "$version" ]]; then
      echo "resume_sha=$sha" >> "$GITHUB_OUTPUT"
      echo "release_tag=$tag" >> "$GITHUB_OUTPUT"
      summary "等待 $tag 的发布回执，检查已有的 Publish 运行。"
      return
    fi
  fi
  summary "main 版本 $version 与市场版本 $published 不同，等待当前版本发布完成。"
}

stage() {
  local base branch date version
  base=$(git rev-parse HEAD)
  branch="automation/openhongguo/$base/$UPSTREAM_TAG"
  npm run version:patch
  version=$(node -p "require('./package.json').version")
  if git show-ref --verify --quiet "refs/tags/v$version"; then
    summary "v$version 标签已存在，候选版本需要人工核对。"
    return 1
  fi
  git add -- third_party/openhongguo/source.json package.json package-lock.json \
    plugin.json .codex-plugin/plugin.json .antigravity-plugin/plugin.json
  # The same base and pin reproduce the same commit on a retry.
  date=$(git show -s --format=%cI HEAD)
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -m "chore: follow openhongguo $UPSTREAM_TAG"
  git push origin "HEAD:refs/heads/$branch"
  echo "source_sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
  echo "branch=$branch" >> "$GITHUB_OUTPUT"
  echo "release_tag=v$version" >> "$GITHUB_OUTPUT"
}

promote() {
  local base remote_tag
  base=$(git rev-parse "$SOURCE_SHA^")
  if remote_tag=$(git rev-parse --verify --quiet "refs/tags/$RELEASE_TAG^{commit}"); then
    [[ "$remote_tag" == "$SOURCE_SHA" ]]
    git merge-base --is-ancestor "$SOURCE_SHA" origin/main
    return
  fi
  if [[ "$(git rev-parse origin/main)" != "$base" ]]; then
    summary '验收期间 main 已前进，等待下次检查在新基线上生成候选。'
    return 1
  fi
  [[ "$(git rev-parse "origin/$STAGE_BRANCH")" == "$SOURCE_SHA" ]]
  git push --atomic --force-with-lease="refs/heads/main:$base" --force-with-lease="refs/heads/$STAGE_BRANCH:$SOURCE_SHA" origin \
    "$SOURCE_SHA:refs/heads/main" "$SOURCE_SHA:refs/tags/$RELEASE_TAG" ":refs/heads/$STAGE_BRANCH"
}

dispatch() {
  local runs existing
  runs=$(gh run list --workflow publish.yml --event workflow_dispatch --commit "$SOURCE_SHA" \
    --branch "$RELEASE_TAG" --limit 100 --json displayTitle,url,conclusion)
  existing=$(jq -c --arg title "Publish $RELEASE_TAG" 'map(select(.displayTitle == $title)) | first // empty' <<< "$runs")
  if [[ -n "$existing" ]]; then
    summary "已有 Publish 运行 $(jq -r '.url' <<< "$existing")"
    # Retry the failed jobs in that run so the original qualified package can be reused.
    [[ "$(jq -r '.conclusion // ""' <<< "$existing")" =~ ^(success)?$ ]]
    return
  fi
  gh workflow run publish.yml --ref "$RELEASE_TAG" -f "tag=$RELEASE_TAG" -F publish=true
  summary "已将 $RELEASE_TAG 交给 Publish。"
}

case "$1" in
  baseline) baseline ;;
  stage) stage ;;
  promote) promote ;;
  dispatch) dispatch ;;
  *) exit 2 ;;
esac
