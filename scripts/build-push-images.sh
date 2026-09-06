#!/usr/bin/env bash
# Build linux/amd64 Hub images (DigitalOcean droplets). Optionally push.
#
#   ./scripts/build-push-images.sh
#   ./scripts/build-push-images.sh --push
#   IMAGE_TAG=2026-09-06 ./scripts/build-push-images.sh --push
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAMESPACE="${DOCKERHUB_NAMESPACE:-kacytunde}"
TAG="${IMAGE_TAG:-latest}"
PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
PUSH=0

for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    -h|--help)
      echo "Usage: $0 [--push]"
      echo "  DOCKERHUB_NAMESPACE (default kacytunde)"
      echo "  IMAGE_TAG           (default latest)"
      echo "  DOCKER_PLATFORM     (default linux/amd64)"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

CONSUMER="${NAMESPACE}/intelipump-consumer:${TAG}"
API="${NAMESPACE}/intelipump-api:${TAG}"
DASHBOARD="${NAMESPACE}/intelipump-dashboard:${TAG}"

build_one() {
  local context="$1"
  local image="$2"
  shift 2
  echo "Building ${image} (${PLATFORM}) from ${context}"
  docker buildx build \
    --platform "${PLATFORM}" \
    --tag "${image}" \
    --load \
    "$@" \
    "${context}"
}

build_one "${ROOT}/consumer" "${CONSUMER}"
build_one "${ROOT}/backend" "${API}"
build_one "${ROOT}/ui" "${DASHBOARD}" \
  --build-arg VITE_API_BASE_URL=/api \
  --build-arg VITE_APP_API_BASE_URL= \
  --build-arg VITE_USE_MOCK_DATA=false

echo
echo "Built:"
echo "  ${CONSUMER}"
echo "  ${API}"
echo "  ${DASHBOARD}"

if [[ "${PUSH}" -eq 1 ]]; then
  echo
  echo "Pushing to Docker Hub..."
  docker push "${CONSUMER}"
  docker push "${API}"
  docker push "${DASHBOARD}"
  echo "Pushed ${NAMESPACE}/intelipump-{consumer,api,dashboard}:${TAG}"
else
  echo
  echo "Images are local only. Push with:"
  echo "  $0 --push"
fi
