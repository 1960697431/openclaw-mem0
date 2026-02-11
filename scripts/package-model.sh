#!/usr/bin/env bash
#
# package-model.sh
#
# Downloads the Qwen3-Embedding-0.6B-ONNX model (q8 quantized) from HuggingFace,
# packages it into a tar.gz archive, and optionally uploads it to a GitHub Release.
#
# Prerequisites:
#   - pip install huggingface_hub   (for huggingface-cli)
#   - gh (GitHub CLI, optional, for auto-uploading to releases)
#
# Usage:
#   ./scripts/package-model.sh              # Download + package only
#   ./scripts/package-model.sh --upload     # Download + package + upload to GitHub Release
#

set -euo pipefail

MODEL_ID="onnx-community/Qwen3-Embedding-0.6B-ONNX"
ARCHIVE_NAME="qwen3-embedding-0.6b-q8.tar.gz"
RELEASE_TAG="models-v1"
GITHUB_REPO="1960697431/openclaw-mem0"

WORK_DIR=$(mktemp -d)
MODEL_DIR="${WORK_DIR}/model"

echo "==> Downloading model: ${MODEL_ID} (q8 only)..."
echo "    Destination: ${MODEL_DIR}"

# Download only the files needed for q8 feature-extraction
# This avoids downloading the full-precision model (2.4GB)
huggingface-cli download "${MODEL_ID}" \
  --include "config.json" "tokenizer.json" "tokenizer_config.json" "special_tokens_map.json" "onnx/model_quantized.onnx" \
  --local-dir "${MODEL_DIR}"

# Remove .huggingface metadata if present
rm -rf "${MODEL_DIR}/.huggingface" "${MODEL_DIR}/.cache"

echo "==> Files downloaded:"
find "${MODEL_DIR}" -type f -exec ls -lh {} \;

echo ""
echo "==> Creating archive: ${ARCHIVE_NAME}..."
(cd "${MODEL_DIR}" && tar czf "${WORK_DIR}/${ARCHIVE_NAME}" .)

ARCHIVE_SIZE=$(du -h "${WORK_DIR}/${ARCHIVE_NAME}" | cut -f1)
echo "    Archive size: ${ARCHIVE_SIZE}"
echo "    Archive path: ${WORK_DIR}/${ARCHIVE_NAME}"

# Copy archive to current directory for convenience
cp "${WORK_DIR}/${ARCHIVE_NAME}" "./${ARCHIVE_NAME}"
echo "    Also copied to: ./${ARCHIVE_NAME}"

# Upload to GitHub Release if --upload flag is provided
if [[ "${1:-}" == "--upload" ]]; then
  echo ""
  echo "==> Uploading to GitHub Release: ${RELEASE_TAG}..."

  # Create the release if it doesn't exist
  if ! gh release view "${RELEASE_TAG}" --repo "${GITHUB_REPO}" &>/dev/null; then
    echo "    Creating release ${RELEASE_TAG}..."
    gh release create "${RELEASE_TAG}" \
      --repo "${GITHUB_REPO}" \
      --title "Model: Qwen3-Embedding-0.6B-ONNX (q8)" \
      --notes "Pre-packaged ONNX model for openclaw-mem0 plugin. Downloaded automatically on first run." \
      --latest=false
  fi

  # Upload the archive (overwrites if exists)
  gh release upload "${RELEASE_TAG}" \
    "./${ARCHIVE_NAME}" \
    --repo "${GITHUB_REPO}" \
    --clobber

  echo "    Upload complete!"
  echo ""
  echo "    Download URL:"
  echo "    https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}/${ARCHIVE_NAME}"
fi

# Cleanup
rm -rf "${WORK_DIR}"

echo ""
echo "==> Done!"
echo ""
echo "Next steps:"
echo "  1. If you haven't uploaded yet, run:  ./scripts/package-model.sh --upload"
echo "  2. Verify the download URL works:"
echo "     curl -LI https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}/${ARCHIVE_NAME}"
