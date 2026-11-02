#!/usr/bin/env bash
# Ghi packages/discord.js/{src,typings} của một ref upstream thành commit mới trên
# nhánh `upstream-vendor` — nhánh chỉ chứa mã gốc, không có patch selfbot nào.
#
# Không đụng vào cây làm việc: commit dựng bằng plumbing với index tạm, nên chạy
# lúc nào cũng được, kể cả khi đang sửa dở.
#
# Usage: ./scripts/sync-upstream.sh <git-ref>
#
# Xong thì merge sang nhánh làm việc:
#
#     git merge upstream-vendor
#
# Git có đủ ba điểm (gốc cũ, gốc mới, bản đã patch) nên tự áp lại patch selfbot.
# Conflict chỉ nổ ở file upstream sửa đúng dòng fork đã sửa — đúng danh sách trong
# bảng của UPSTREAM.md. Sau khi giải quyết: `npm test` rồi cập nhật bảng đó.
set -euo pipefail

REF="${1:?Thieu git-ref cua upstream}"
UPSTREAM_REPO="${UPSTREAM_REPO:-../discord.js}"
VENDOR_BRANCH="${VENDOR_BRANCH:-upstream-vendor}"

if [ ! -d "$UPSTREAM_REPO/.git" ]; then
  echo "Khong tim thay repo discord.js tai $UPSTREAM_REPO" >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "$VENDOR_BRANCH" >/dev/null; then
  echo "Khong co nhanh $VENDOR_BRANCH o local. No la merge base, khong tao lai duoc bang script nay." >&2
  echo "Clone chi lay main; lay nhanh ve truoc: git fetch origin $VENDOR_BRANCH:$VENDOR_BRANCH" >&2
  exit 1
fi

RESOLVED="$(git -C "$UPSTREAM_REPO" rev-parse --short "$REF")"
VERSION="$(git -C "$UPSTREAM_REPO" show "$REF:packages/discord.js/package.json" | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -1)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$UPSTREAM_REPO" archive "$REF" packages/discord.js/src packages/discord.js/typings | tar -x -C "$TMP"
mkdir "$TMP/root"
mv "$TMP/packages/discord.js/src" "$TMP/root/src"
mv "$TMP/packages/discord.js/typings" "$TMP/root/typings"

# Index tạm: `git add` ở đây không chạm index thật, cây làm việc giữ nguyên.
export GIT_INDEX_FILE="$TMP/index"
git --work-tree="$TMP/root" add -A
TREE="$(git write-tree)"
unset GIT_INDEX_FILE

if [ "$TREE" = "$(git rev-parse "$VENDOR_BRANCH^{tree}")" ]; then
  echo "$VENDOR_BRANCH da o dung noi dung cua $RESOLVED, khong tao commit moi."
  exit 0
fi

# commit-tree bỏ qua hook: pre-commit chạy lint-staged và sẽ format lại mã gốc,
# làm hỏng đúng cái nó cần giữ nguyên xi.
COMMIT="$(git commit-tree "$TREE" -p "$VENDOR_BRANCH" -m "vendor: discord.js ${VERSION:-?} ($RESOLVED) pristine")"
git branch -f "$VENDOR_BRANCH" "$COMMIT"

echo "Da ghi $VENDOR_BRANCH -> discord.js ${VERSION:-?} ($RESOLVED)"
echo "Buoc tiep: git merge $VENDOR_BRANCH"
